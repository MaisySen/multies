/**
 * OPS1: /api/console/jobs routes. Lists page with nextCursor and filter; a bad sort is a 4xx; every change needs a
 * reason, is refused for roles without jobs.manage, and writes a platform audit row (and the workspace's own row for a
 * one-job change). Payload content never reaches the list (structure only).
 */
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { resetDeniedLog } from "@/server/auth/operator";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { auditLogs, dataMoves, jobs, organizations, platformAuditLogs } from "@/server/db/schema";

const DAY = 86_400_000;
const SECRET = "QXZJOBSROUTESENTINELPAYLOADQXZ";

let ctx: Ctx;
let admin: Client;
let support: Client;
let readonly: Client;
let customer: Client;
let alpha: string;
let base: number;

async function insertJob(id: string, over: Partial<typeof jobs.$inferInsert> = {}) {
  await ctx.db.insert(jobs).values({
    id, type: "mail.deliver", orgId: alpha, payload: JSON.stringify({ messageId: id, body: SECRET }), status: "dead", attempts: 8, maxAttempts: 8,
    runAt: new Date(base - DAY), createdAt: new Date(base - 2 * DAY), updatedAt: new Date(base - DAY), lastError: "boom", ...over,
  });
}

beforeAll(async () => {
  ctx = await makeTestApp();
  admin = (await signUpAs(ctx, "admin@ops.test", "ops_admin", "Alpha")).c;
  support = (await signUpAs(ctx, "support@ops.test", "ops_support")).c;
  readonly = (await signUpAs(ctx, "readonly@ops.test", "ops_readonly")).c;
  customer = (await signUpAs(ctx, "customer@else.test", null)).c;
  alpha = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Alpha")).get())!.id;
}, 120_000);

beforeEach(async () => {
  base = ctx.deps.now().getTime();
  await ctx.db.delete(jobs);
  await ctx.db.delete(platformAuditLogs);
  resetDeniedLog(); // OPS1 security (L4): the access.denied rate limit starts fresh per test
}, 60_000);

describe("GET /api/console/jobs", () => {
  it("lists dead jobs by default, pages with nextCursor and filters by status, type and workspace", async () => {
    for (let i = 0; i < 5; i++) await insertJob(`job_d${i}`, { updatedAt: new Date(base - DAY - i * 1000) });
    await insertJob("job_other", { type: "webhook.deliver", orgId: null, updatedAt: new Date(base - 2 * DAY) });
    await insertJob("job_wait", { status: "pending", attempts: 0 });

    const first = await readonly.get("/api/console/jobs?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items.map((j: { id: string }) => j.id)).toEqual(["job_d0", "job_d1"]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const seen: string[] = first.body.items.map((j: { id: string }) => j.id);
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const r = await readonly.get(`/api/console/jobs?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((j: { id: string }) => j.id));
      cursor = r.body.nextCursor;
    }
    expect(seen.sort()).toEqual(["job_d0", "job_d1", "job_d2", "job_d3", "job_d4", "job_other"]);

    expect((await readonly.get("/api/console/jobs?status=pending")).body.items.map((j: { id: string }) => j.id)).toEqual(["job_wait"]);
    expect((await readonly.get("/api/console/jobs?type=webhook.deliver")).body.items.map((j: { id: string }) => j.id)).toEqual(["job_other"]);
    const ws = await readonly.get(`/api/console/jobs?workspace=${alpha}`);
    expect(ws.body.items).toHaveLength(5);
    expect(ws.body.items[0]).toMatchObject({ workspaceName: "Alpha", orgId: alpha, attempts: 8, lastError: "boom" });
    expect(JSON.stringify(ws.body)).not.toContain(SECRET);
    expect(ws.body.items[0].payloadPreview).toContain("messageId");

    const asc = await readonly.get("/api/console/jobs?sort=updatedAt:asc&limit=1");
    expect(asc.body.items[0].id).toBe("job_other");
  }, 60_000);

  it("refuses a bad sort, a bad status and a bad cursor", async () => {
    expect((await readonly.get("/api/console/jobs?sort=payload:desc")).status).toBe(422);
    expect((await readonly.get("/api/console/jobs?sort=updatedAt:sideways")).status).toBe(422);
    expect((await readonly.get("/api/console/jobs?status=exploded")).status).toBe(422);
    expect((await readonly.get("/api/console/jobs?cursor=not-a-cursor")).status).toBe(400);
  }, 60_000);

  it("is for operators only", async () => {
    expect((await new Client(ctx.app).get("/api/console/jobs")).status).toBe(401);
    expect((await customer.get("/api/console/jobs")).status).toBe(403);
    expect((await customer.get("/api/console/jobs/stats")).status).toBe(403);
    expect((await customer.get("/api/console/jobs/data-moves")).status).toBe(403);
  }, 60_000);
});

describe("GET /api/console/jobs/stats", () => {
  it("counts by status and type, with the oldest waiting age", async () => {
    await insertJob("job_a");
    await insertJob("job_b", { type: "webhook.deliver" });
    await insertJob("job_c", { status: "pending", attempts: 0, runAt: new Date(base - 60_000) });
    const r = await readonly.get("/api/console/jobs/stats");
    expect(r.status).toBe(200);
    expect(r.body.byStatus).toEqual({ pending: 1, running: 0, done: 0, dead: 2 });
    expect(r.body.byStatusAndType).toEqual(expect.arrayContaining([expect.objectContaining({ status: "dead", type: "webhook.deliver", count: 1 })]));
    expect(r.body.oldestPendingAgeMs).toBeGreaterThanOrEqual(60_000);
  }, 60_000);
});

describe("GET /api/console/jobs/data-moves", () => {
  beforeEach(async () => {
    await ctx.db.delete(dataMoves);
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(dataMoves).values({
        id: `dm_${i}`, orgId: alpha, kind: i === 2 ? "export" : "import", source: "csv", fileName: "secret-file-name.csv", status: i === 0 ? "failed" : "done",
        total: 10, done: i === 0 ? 4 : 10, error: i === 0 ? "bad row" : null, createdAt: new Date(base - (i + 1) * 60_000), updatedAt: new Date(base - (i + 1) * 60_000),
      });
    }
  }, 60_000);

  it("pages, filters by kind and status, and refuses a bad sort", async () => {
    const first = await readonly.get("/api/console/jobs/data-moves?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items.map((m: { id: string }) => m.id)).toEqual(["dm_0", "dm_1"]);
    const next = await readonly.get(`/api/console/jobs/data-moves?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(next.body.items.map((m: { id: string }) => m.id)).toEqual(["dm_2"]);
    expect(next.body.nextCursor).toBeNull();
    expect((await readonly.get("/api/console/jobs/data-moves?kind=export")).body.items.map((m: { id: string }) => m.id)).toEqual(["dm_2"]);
    const failed = await readonly.get("/api/console/jobs/data-moves?status=failed");
    expect(failed.body.items).toEqual([expect.objectContaining({ id: "dm_0", workspaceName: "Alpha", done: 4, total: 10, error: "bad row" })]);
    expect(JSON.stringify(failed.body)).not.toContain("secret-file-name");
    expect((await readonly.get("/api/console/jobs/data-moves?sort=fileName:desc")).status).toBe(422);
    expect((await readonly.get("/api/console/jobs/data-moves?kind=teleport")).status).toBe(422);
  }, 60_000);
});

describe("job changes", () => {
  // OPS1 security (L4): refused attempts write access.denied rows of their own; these tests read the change rows.
  const audits = async () => (await ctx.db.select().from(platformAuditLogs).all()).filter((r) => r.action !== "access.denied");
  const denied = async () => (await ctx.db.select().from(platformAuditLogs).all()).filter((r) => r.action === "access.denied");

  it("replays one dead job with a reason, audited on the platform and in the workspace", async () => {
    await insertJob("job_one");
    expect((await admin.post("/api/console/jobs/job_one/replay", {})).status).toBe(422);
    expect((await admin.post("/api/console/jobs/job_one/replay", { reason: "x" })).status).toBe(422);
    expect((await support.post("/api/console/jobs/job_one/replay", { reason: "Retry after the fix" })).status).toBe(403);
    expect((await readonly.post("/api/console/jobs/job_one/replay", { reason: "Retry after the fix" })).status).toBe(403);
    expect((await customer.post("/api/console/jobs/job_one/replay", { reason: "Retry after the fix" })).status).toBe(403);
    expect((await new Client(ctx.app).post("/api/console/jobs/job_one/replay", { reason: "Retry after the fix" })).status).toBe(401);
    expect(await audits()).toHaveLength(0);
    // The two refused operators (support, read only) are on the log as access.denied; the customer and the anonymous call are not.
    expect((await denied()).map((r) => r.actorRole).sort()).toEqual(["ops_readonly", "ops_support"]);

    const r = await admin.post("/api/console/jobs/job_one/replay", { reason: "Retry after the fix" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replayed: 1 });
    expect((await ctx.db.select().from(jobs).where(eq(jobs.id, "job_one")).get())!.status).toBe("pending");
    const [row] = await audits();
    expect(row).toMatchObject({ action: "jobs.replayed", targetType: "job", targetId: "job_one", orgId: alpha, reason: "Retry after the fix", actorRole: "ops_admin" });
    expect(JSON.parse(row.before!)).toEqual({ status: "dead", attempts: 8 });
    const ws = await ctx.db.select().from(auditLogs).where(eq(auditLogs.targetId, "job_one")).all();
    expect(ws.map((w) => w.action)).toContain("jobs.replayed");

    expect((await admin.post("/api/console/jobs/job_one/replay", { reason: "Again please" })).status).toBe(409);
    expect((await admin.post("/api/console/jobs/job_nope/replay", { reason: "Retry after the fix" })).status).toBe(404);
  }, 60_000);

  it("replays the selected jobs and every dead job, with the count in the audit row", async () => {
    for (const id of ["job_s1", "job_s2", "job_s3"]) await insertJob(id);
    await insertJob("job_s4", { status: "pending", attempts: 0 });
    expect((await admin.post("/api/console/jobs/replay", { ids: ["job_s1"] })).status).toBe(422);
    expect((await admin.post("/api/console/jobs/replay", { ids: [], reason: "Retry these" })).status).toBe(422);
    expect((await admin.post("/api/console/jobs/replay", { ids: Array.from({ length: 501 }, (_, i) => `job_${i}`), reason: "Retry these" })).status).toBe(422);
    expect((await support.post("/api/console/jobs/replay", { ids: ["job_s1"], reason: "Retry these" })).status).toBe(403);

    const sel = await admin.post("/api/console/jobs/replay", { ids: ["job_s1", "job_s4"], reason: "Retry these" });
    expect(sel.status).toBe(200);
    expect(sel.body).toEqual({ requested: 2, replayed: 1 });

    expect((await admin.post("/api/console/jobs/replay-all", {})).status).toBe(422);
    expect((await support.post("/api/console/jobs/replay-all", { reason: "Retry everything" })).status).toBe(403);
    const all = await admin.post("/api/console/jobs/replay-all", { reason: "Retry everything" });
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ requested: 2, replayed: 2 });
    expect(await ctx.db.select().from(jobs).where(eq(jobs.status, "dead")).all()).toHaveLength(0);

    const rows = await audits();
    const selected = rows.find((r) => r.action === "jobs.replayed")!;
    expect(selected).toMatchObject({ targetType: "job", reason: "Retry these" });
    expect(JSON.parse(selected.metadata!)).toEqual({ ids: ["job_s1", "job_s4"], count: 2 });
    const everything = rows.find((r) => r.action === "jobs.replayed_all")!;
    expect(everything).toMatchObject({ reason: "Retry everything", actorRole: "ops_admin" });
    expect(JSON.parse(everything.after!)).toEqual({ requested: 2, replayed: 2 });
  }, 60_000);

  it("marks a waiting job as failed for good, and refuses one inside its lease with the service's message", async () => {
    await insertJob("job_wait", { status: "pending", attempts: 1 });
    await insertJob("job_run", { status: "running", lockedUntil: new Date(base + 10 * 60_000) });
    await insertJob("job_dead");
    expect((await admin.post("/api/console/jobs/job_wait/mark-dead", {})).status).toBe(422);
    expect((await support.post("/api/console/jobs/job_wait/mark-dead", { reason: "Stuck forever" })).status).toBe(403);

    const r = await admin.post("/api/console/jobs/job_wait/mark-dead", { reason: "Stuck forever" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "job_wait", previousStatus: "pending", status: "dead" });
    const [row] = await audits();
    expect(row).toMatchObject({ action: "jobs.marked_dead", targetId: "job_wait", orgId: alpha, reason: "Stuck forever" });

    const running = await admin.post("/api/console/jobs/job_run/mark-dead", { reason: "Stuck forever" });
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe("job_running");
    expect(running.body.error.message).toBe("This job is running now. Try again when its run ends.");
    expect((await admin.post("/api/console/jobs/job_dead/mark-dead", { reason: "Stuck forever" })).status).toBe(409);
    expect((await admin.post("/api/console/jobs/job_nope/mark-dead", { reason: "Stuck forever" })).status).toBe(404);
    expect(await audits()).toHaveLength(1);
  }, 60_000);
});
