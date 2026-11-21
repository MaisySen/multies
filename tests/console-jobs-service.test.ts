import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { dataMoves, jobs, organizations } from "@/server/db/schema";
import { HttpError } from "@/server/lib/errors";
import {
  jobStatsByStatusAndType, listDataMoves, listJobsFiltered, markJobDead, redactError, redactPayload, replayJob, replayJobsByIds,
  JOB_SORT_FIELDS, MARKED_DEAD_ERROR, PAYLOAD_PREVIEW_MAX, type ConsoleCursor, type ConsolePage, type ConsolePageResult,
} from "@/server/services/console/jobs";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const MIN = 60_000, DAY = 86_400_000;

const page = <F extends string>(field: F, dir: "asc" | "desc" = "desc", limit = 50, cursor: ConsoleCursor | null = null): ConsolePage<F> => ({ limit, cursor, sort: { field, dir } });

async function walk<T>(fetch: (cursor: ConsoleCursor | null) => Promise<ConsolePageResult<T>>, id: (t: T) => string) {
  const out: string[] = [];
  let cursor: ConsoleCursor | null = null;
  for (let i = 0; i < 200; i++) {
    const r = await fetch(cursor);
    out.push(...r.items.map(id));
    if (!r.next) break;
    cursor = r.next;
  }
  return out;
}

async function expectHttp(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

/**
 * Sentinels: upper case with no underscore, so no generated id (lower case prefix_ids) can contain one. Each planted
 * value is a different sentinel, so a leak names the field it came from.
 */
const S = (n: string) => `QXZSENTINEL${n}QXZ`;
const PLANTED = "QXZSENTINEL";

/** A payload with a short secret under an innocent key, message content under the usual keys, and allowed ids. */
const plantedPayload = {
  // (a) a short secret under an innocent short key, and a few more under keys a deny-list would miss
  v: S("A1"), x: { y: S("A2") }, misc: S("A3"), label: `hi ${S("A4")}`,
  // (b) message-like content under the usual keys
  subject: S("B1"), body: S("B2"), text: S("B3"), to: [S("B4"), "victim@example.com"], cc: "other@example.com", html: `<p>${S("B5")}</p>`,
  nested: { from: S("B6"), list: [{ email: "x@example.com" }], deeper: { deepest: { value: S("B7") } } },
  // a map keyed by data: the keys themselves are hidden
  byAddress: { "keyed@example.com": 1 },
  // allowed: ids, operational fields, numbers and booleans
  id: "job_abcdefgh", messageId: "msg_01hxabcdefgh", thread_id: "thr_abcdefgh", orgId: "org_abcdefgh", type: "mail.deliver", kind: "reply", status: "queued", attempt: 3, urgent: true,
  // an allowed key whose value does not look like an id is still type and length only
  rfcId: `<${S("C1")}@mail.example.com>`,
};

let ctx: Ctx;
let alpha: string;
let beta: string;
const now = Date.now();

async function insertJob(id: string, over: Partial<typeof jobs.$inferInsert> = {}) {
  await ctx.db.insert(jobs).values({
    id, type: "mail.deliver", orgId: alpha, payload: JSON.stringify({ messageId: id }), status: "dead", attempts: 9, maxAttempts: 9,
    runAt: new Date(now - DAY), createdAt: new Date(now - 2 * DAY), updatedAt: new Date(now - DAY), ...over,
  });
}

beforeEach(async () => {
  ctx = await makeTestApp();
  await new Client(ctx.app).signup("owner@alpha.test", "Owner", "Alpha");
  await new Client(ctx.app).signup("owner@beta.test", "Owner", "Beta");
  alpha = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Alpha")).get())!.id;
  beta = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Beta")).get())!.id;
  await ctx.db.delete(jobs); // signup may queue mail; start from a known queue
});

describe("redaction", () => {
  it("shows the payload's structure only, keeping ids, operational fields, numbers and booleans", () => {
    const out = redactPayload(JSON.stringify(plantedPayload));
    expect(out).not.toContain(PLANTED);
    expect(out).not.toContain("@");
    expect(out).not.toContain("example.com");
    const parsed = JSON.parse(out);
    // Key names stay, values are type and size.
    expect(parsed).toMatchObject({
      v: `<string ${S("A1").length}>`, x: { y: `<string ${S("A2").length}>` }, misc: `<string ${S("A3").length}>`,
      subject: `<string ${S("B1").length}>`, body: `<string ${S("B2").length}>`, text: `<string ${S("B3").length}>`, to: "<array 2>",
      cc: `<string ${"other@example.com".length}>`, nested: { from: `<string ${S("B6").length}>`, list: "<array 1>", deeper: { deepest: "<object 1>" } },
      byAddress: { "<key 17>": 1 },
      id: "job_abcdefgh", messageId: "msg_01hxabcdefgh", thread_id: "thr_abcdefgh", orgId: "org_abcdefgh", type: "mail.deliver", kind: "reply", status: "queued", attempt: 3, urgent: true,
      rfcId: expect.stringMatching(/^<string \d+>$/),
    });
    expect(Object.keys(parsed)).toEqual(Object.keys(plantedPayload));
    expect(redactPayload("not json")).toBe("[not JSON, 8 chars]");
    expect(redactPayload(JSON.stringify(S("D1")))).toBe(`"<string ${S("D1").length}>"`);
    const big = redactPayload(JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, { a: { b: 1 } }]))));
    expect(big.length).toBeLessThanOrEqual(PAYLOAD_PREVIEW_MAX);
  });

  it("keeps errors readable but takes out a planted address, bearer token and long opaque token", () => {
    const opaque = "Zx9".repeat(16);
    const out = redactError(`550 rejected for victim@example.com; auth Bearer ${S("E1")}; token ${opaque}; key sk_live_${S("E2")}`)!;
    expect(out).toContain("550 rejected for");
    expect(out).not.toContain("victim@example.com");
    expect(out).not.toContain(PLANTED);
    expect(out).not.toContain(opaque);
    expect(out).toContain("[email]");
  });
});

describe("listJobsFiltered", () => {
  beforeEach(async () => {
    for (let i = 0; i < 25; i++) {
      // Several share an updated_at, so the id tie-break is exercised.
      await insertJob(`job_dead_${String(i).padStart(2, "0")}`, { orgId: i % 5 === 0 ? beta : alpha, type: i % 2 ? "mail.deliver" : "push.send", updatedAt: new Date(now - Math.floor(i / 3) * MIN) });
    }
    await insertJob("job_planted", { payload: JSON.stringify(plantedPayload), lastError: `550 rejected victim@example.com token sk_live_${S("L1")}xyz`, updatedAt: new Date(now - 30 * MIN) });
    await insertJob("job_pending", { status: "pending", attempts: 1, runAt: new Date(now - MIN), updatedAt: new Date(now - MIN) });
    await insertJob("job_done", { status: "done", updatedAt: new Date(now - MIN) });
    await insertJob("job_system", { orgId: null, type: "system-mail.send" });
  });

  it("defaults to dead jobs, with workspace names, and never returns a planted secret", async () => {
    const r = await listJobsFiltered(ctx.deps, {}, page("updatedAt", "desc", 200));
    expect(r.items).toHaveLength(27);
    expect(r.items.every((j) => j.status === "dead")).toBe(true);
    const planted = r.items.find((j) => j.id === "job_planted")!;
    expect(planted).toMatchObject({ orgId: alpha, workspaceName: "Alpha", type: "mail.deliver" });
    expect(r.items.find((j) => j.id === "job_system")).toMatchObject({ orgId: null, workspaceName: null });
    const text = JSON.stringify(r);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("victim@example.com");
    expect(text).not.toContain("other@example.com");
    expect(planted.lastError).toContain("[email]");
  });

  it("filters by status, type and workspace", async () => {
    expect((await listJobsFiltered(ctx.deps, { status: "pending" }, page("runAt"))).items.map((j) => j.id)).toEqual(["job_pending"]);
    expect((await listJobsFiltered(ctx.deps, { status: "done" }, page("updatedAt"))).items.map((j) => j.id)).toEqual(["job_done"]);
    const push = await listJobsFiltered(ctx.deps, { type: "push.send" }, page("updatedAt", "desc", 200));
    expect(push.items).toHaveLength(13);
    expect(push.items.every((j) => j.type === "push.send")).toBe(true);
    const betaJobs = await listJobsFiltered(ctx.deps, { orgId: beta }, page("updatedAt", "desc", 200));
    expect(betaJobs.items.map((j) => j.id).sort()).toEqual(["job_dead_00", "job_dead_05", "job_dead_10", "job_dead_15", "job_dead_20"]);
    expect(betaJobs.items.every((j) => j.workspaceName === "Beta")).toBe(true);
    await expectHttp(listJobsFiltered(ctx.deps, { status: "lost" as never }, page("updatedAt")), 422);
  });

  it("pages without duplicates or gaps on every whitelisted field, both directions", async () => {
    for (const field of JOB_SORT_FIELDS) {
      const all = (await listJobsFiltered(ctx.deps, {}, page(field, "desc", 200))).items.map((j) => j.id);
      for (const dir of ["desc", "asc"] as const) {
        const ids = await walk((cursor) => listJobsFiltered(ctx.deps, {}, page(field, dir, 4, cursor)), (j) => j.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(dir === "desc" ? all : [...all].reverse());
      }
    }
  });

  it("rejects a sort field outside the whitelist and a bad cursor", async () => {
    await expectHttp(listJobsFiltered(ctx.deps, {}, page("payload" as never)), 422, "invalid_sort");
    await expectHttp(listJobsFiltered(ctx.deps, {}, page("updatedAt", "desc", 5, { v: "yesterday", id: "job_x" })), 400, "bad_cursor");
    await expectHttp(listJobsFiltered(ctx.deps, {}, page("updatedAt", "desc", 5, { v: 1, id: "" })), 400, "bad_cursor");
  });
});

describe("job actions", () => {
  it("replays one dead job and refuses one that is not dead", async () => {
    await insertJob("job_a");
    await insertJob("job_p", { status: "pending" });
    expect(await replayJob(ctx.deps, "job_a")).toEqual({ requested: 1, replayed: 1, previousStatus: "dead" });
    const row = await ctx.db.select().from(jobs).where(eq(jobs.id, "job_a")).get();
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    await expectHttp(replayJob(ctx.deps, "job_p"), 409, "job_not_dead");
    await expectHttp(replayJob(ctx.deps, "job_nope"), 404);
  });

  it("replays the selected dead jobs in one statement, past the D1 variable limit, leaving others alone", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) { const id = `job_sel_${String(i).padStart(3, "0")}`; ids.push(id); await insertJob(id); }
    await insertJob("job_other_dead");
    await insertJob("job_running", { status: "running", lockedUntil: new Date(now + MIN) });
    const r = await replayJobsByIds(ctx.deps, [...ids, ids[0], "job_running", "job_missing"]);
    // 120 distinct selected ids plus the running job and a missing id; the duplicate counts once.
    expect(r).toEqual({ requested: 122, replayed: 120 });
    expect((await ctx.db.select().from(jobs).where(eq(jobs.id, "job_other_dead")).get())?.status).toBe("dead");
    expect((await ctx.db.select().from(jobs).where(eq(jobs.id, "job_running")).get())?.status).toBe("running");
    expect((await jobStatsByStatusAndType(ctx.deps)).byStatus).toMatchObject({ pending: 120, dead: 1, running: 1 });
    expect(await replayJobsByIds(ctx.deps, [])).toEqual({ requested: 0, replayed: 0 });
    await expectHttp(replayJobsByIds(ctx.deps, Array.from({ length: 501 }, (_, i) => `job_${i}`)), 422);
  });

  it("marks a pending job dead, refuses a running or finished one", async () => {
    await insertJob("job_p", { status: "pending", lastError: "timeout" });
    await insertJob("job_r", { status: "running", lockedUntil: new Date(now + 5 * MIN) });
    await insertJob("job_stale", { status: "running", lockedUntil: new Date(now - 5 * MIN) });
    await insertJob("job_d", { status: "done" });
    expect(await markJobDead(ctx.deps, "job_p")).toEqual({ id: "job_p", previousStatus: "pending", status: "dead" });
    const row = await ctx.db.select().from(jobs).where(eq(jobs.id, "job_p")).get();
    expect(row?.status).toBe("dead");
    expect(row?.lastError).toBe(`${MARKED_DEAD_ERROR} Last error: timeout`);
    expect((await markJobDead(ctx.deps, "job_stale")).previousStatus).toBe("running");
    await expectHttp(markJobDead(ctx.deps, "job_r"), 409, "job_running");
    await expectHttp(markJobDead(ctx.deps, "job_d"), 409, "job_done");
    expect((await markJobDead(ctx.deps, "job_p")).previousStatus).toBe("dead");
    await expectHttp(markJobDead(ctx.deps, "job_nope"), 404);
  });

  it("counts jobs by status and type", async () => {
    await insertJob("job_1");
    await insertJob("job_2", { type: "push.send" });
    await insertJob("job_3", { status: "pending", runAt: new Date(now - 10 * MIN) });
    await insertJob("job_4", { status: "pending", runAt: new Date(now + 10 * MIN) });
    const s = await jobStatsByStatusAndType(ctx.deps);
    expect(s.byStatus).toEqual({ pending: 2, running: 0, done: 0, dead: 2 });
    expect(s.byStatusAndType).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "dead", type: "mail.deliver", count: 1 }),
      expect.objectContaining({ status: "dead", type: "push.send", count: 1 }),
      expect.objectContaining({ status: "pending", type: "mail.deliver", count: 2 }),
    ]));
    expect(s.oldestPendingAgeMs).toBeGreaterThanOrEqual(10 * MIN - 1000);
  });
});

describe("listDataMoves", () => {
  beforeEach(async () => {
    const move = (id: string, orgId: string, over: Partial<typeof dataMoves.$inferInsert> = {}) => ({
      id, orgId, kind: "import" as const, source: "csv", status: "done" as const, fileName: `${PLANTED}.csv`, tokenHash: PLANTED, createdByEmail: "who@example.com",
      createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY), ...over,
    });
    for (let i = 0; i < 9; i++) await ctx.db.insert(dataMoves).values(move(`dmv_a_${i}`, alpha, { createdAt: new Date(now - (i + 1) * 3_600_000), status: i < 3 ? "failed" : "done", error: i < 3 ? `Could not read row for victim@example.com` : null }));
    await ctx.db.insert(dataMoves).values(move("dmv_b_export", beta, { kind: "export", status: "ready" }));
    await ctx.db.insert(dataMoves).values(move("dmv_old", alpha, { createdAt: new Date(now - 60 * DAY), updatedAt: new Date(now - 60 * DAY) }));
  });

  it("lists recent moves with workspace names, filters, pages and hides file names, tokens and addresses", async () => {
    const r = await listDataMoves(ctx.deps, {}, page("createdAt", "desc", 200));
    expect(r.items).toHaveLength(10);
    expect(r.items.map((x) => x.id)).not.toContain("dmv_old");
    const text = JSON.stringify(r);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("@example.com");
    expect(r.items.find((x) => x.id === "dmv_b_export")).toMatchObject({ orgId: beta, workspaceName: "Beta", kind: "export", status: "ready" });
    expect((await listDataMoves(ctx.deps, { status: "failed" }, page("createdAt"))).items.map((x) => x.id)).toEqual(["dmv_a_0", "dmv_a_1", "dmv_a_2"]);
    expect((await listDataMoves(ctx.deps, { kind: "export" }, page("createdAt"))).items.map((x) => x.id)).toEqual(["dmv_b_export"]);
    expect((await listDataMoves(ctx.deps, { orgId: beta }, page("createdAt"))).items.map((x) => x.id)).toEqual(["dmv_b_export"]);
    expect((await listDataMoves(ctx.deps, { days: 90 }, page("createdAt", "desc", 200))).items.map((x) => x.id)).toContain("dmv_old");
    const ids = await walk((cursor) => listDataMoves(ctx.deps, {}, page("createdAt", "asc", 3, cursor)), (x) => x.id);
    expect(ids).toEqual(r.items.map((x) => x.id).reverse());
    await expectHttp(listDataMoves(ctx.deps, {}, page("fileName" as never)), 422, "invalid_sort");
    await expectHttp(listDataMoves(ctx.deps, { status: "lost" as never }, page("createdAt")), 422);
  });
});
