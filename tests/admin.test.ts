/**
 * The operator console basics. OPS1 security: the older /api/admin changes were retired; these cases moved to the
 * console routes (/api/console/*) and keep proving the same behaviour (who may open it, bootstrap promotion, Sentry
 * test, suspend, caps and restore with audit rows, dead jobs and replay). The retired paths answer 404 for everyone.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";
import { enqueue, runDueJobs } from "@/server/services/jobs";
import { recordAbuse } from "@/server/services/abuse";

describe("operator console", () => {
  it("is for platform admins only, and lists every workspace", async () => {
    const ctx = await makeTestApp();
    const a = new Client(ctx.app);
    await a.signup("ops@acme.io");
    await new Client(ctx.app).signup("customer@else.io", "Cus Tomer", "Else Inc");
    expect((await a.get("/api/console/overview")).status).toBe(403);
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const r = await a.get("/api/console/overview");
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ users: 2, workspaces: 2 });
    const list = await a.get("/api/console/workspaces?sort=name:asc");
    expect(list.body.items.map((t: { name: string }) => t.name).sort()).toEqual(["Acme", "Else Inc"]);
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(true);
  }, 60_000);

  it("promotes listed user ids, and listed emails only once verified", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "boss@acme.io" });
    const a = new Client(ctx.app);
    await a.signup("boss@acme.io");
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(false);
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "boss@acme.io"));
    expect((await a.get("/api/account/me")).body.user.platformAdmin).toBe(true);

    const ctx2 = await makeTestApp();
    const b = new Client(ctx2.app);
    await b.signup("someone@acme.io");
    const id = (await b.get("/api/account/me")).body.user.id;
    ctx2.deps.config.platformAdmins.push(id.toLowerCase());
    expect((await b.get("/api/account/me")).body.user.platformAdmin).toBe(true);
  }, 60_000);

  it("sends a Sentry test event when error tracking is configured", async () => {
    const ctx = await makeTestApp({ SENTRY_DSN_API: "https://key@o1.ingest.sentry.io/1" });
    const reported: unknown[] = [];
    ctx.deps.reportError = (err) => { reported.push(err); return "evt_123"; };
    const a = new Client(ctx.app);
    await a.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    expect((await a.post("/api/console/system/sentry-test", { reason: "Check error tracking" })).body).toEqual({ configured: true, eventId: "evt_123" });
    expect(String(reported[0])).toContain("Multies API test event");
  }, 60_000);

  it("suspends, caps and restores a workspace, with every action audited", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const cus = new Client(ctx.app);
    await cus.signup("customer@else.io", "Cus Tomer", "Else Inc");
    const orgId = (await cus.get("/api/account/me")).body.organization.id;
    await recordAbuse(ctx.deps, orgId, "message_held", 12, "Spam score 12");

    const abuse = await ops.get("/api/console/moderation/abuse");
    expect(abuse.body.items[0]).toMatchObject({ workspaceName: "Else Inc", kind: "message_held", score: 12 });
    expect((await cus.get("/api/console/moderation/abuse")).status).toBe(403);

    expect((await ops.post(`/api/console/workspaces/${orgId}/suspend`, { reason: "" })).status).toBe(422);
    expect((await ops.post(`/api/console/workspaces/${orgId}/suspend`, { reason: "Phishing reports" })).status).toBe(200);
    expect((await ops.put(`/api/console/workspaces/${orgId}/send-cap`, { cap: 10, reason: "Slow it down" })).body.sendCapDaily).toBe(10);
    const detail = (await ops.get(`/api/console/workspaces/${orgId}`)).body;
    expect(detail.org).toMatchObject({ suspendedReason: "Phishing reports", sendCapDaily: 10 });
    expect(detail.counts.members).toBe(1);

    expect((await ops.post(`/api/console/workspaces/${orgId}/unsuspend`, { reason: "Cleared after review" })).status).toBe(200);
    expect((await ops.get("/api/console/moderation/abuse")).body.items).toHaveLength(0);
    const audit = (await cus.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["workspace.suspended", "workspace.send_cap_changed", "workspace.unsuspended"]));
  }, 60_000);

  it("shows dead jobs and replays them", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    await enqueue(ctx.deps, "test.unknown" as never, {}, { maxAttempts: 1 });
    await runDueJobs(ctx.deps, 10);
    const jobs = await ops.get("/api/console/jobs?status=dead");
    expect(jobs.body.items).toHaveLength(1);
    expect((await ops.post("/api/console/jobs/replay", { ids: [jobs.body.items[0].id], reason: "Provider is back" })).body.replayed).toBe(1);
    expect((await ops.get("/api/console/jobs?status=dead")).body.items).toHaveLength(0);
  }, 60_000);

  it("the retired /api/admin changes answer 404, for operators too; the kept reads still work", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const anon = new Client(ctx.app);
    const gone: [string, string][] = [
      ["GET", "/api/admin/overview"], ["GET", "/api/admin/users"], ["DELETE", "/api/admin/users/usr_x"], ["GET", "/api/admin/abuse"],
      ["POST", "/api/admin/abuse/resolve"], ["POST", "/api/admin/workspaces/org_x/suspend"], ["POST", "/api/admin/workspaces/org_x/unsuspend"],
      ["PUT", "/api/admin/workspaces/org_x/send-cap"], ["PUT", "/api/admin/workspaces/org_x/sending"], ["GET", "/api/admin/workspaces/org_x/queued-sends"],
      ["POST", "/api/admin/workspaces/org_x/queued-sends/s_x/send"], ["PUT", "/api/admin/workspaces/org_x/meeting-cap"], ["GET", "/api/admin/jobs"],
      ["POST", "/api/admin/jobs/replay"], ["POST", "/api/admin/sentry-test"], ["GET", "/api/admin/reports"], ["POST", "/api/admin/reports/rpt_x/action"],
      ["GET", "/api/admin/app-config"], ["PUT", "/api/admin/app-config"], ["POST", "/api/admin"],
    ];
    for (const [m, p] of gone) {
      expect((await ops.call(m, p, m === "GET" ? undefined : { reason: "testing the retired path" })).status, `${m} ${p} operator`).toBe(404);
      expect((await anon.call(m, p, m === "GET" ? undefined : {})).status, `${m} ${p} anonymous`).toBe(404);
    }
    expect((await ops.get("/api/admin/reports/count")).status).toBe(200);
    expect((await ops.get("/api/admin/health")).status).toBe(200);
    expect((await ops.get("/api/admin/status")).status).toBe(200);
    expect((await anon.get("/api/admin/reports/count")).status).toBe(401);
  }, 60_000);
});
