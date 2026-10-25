import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { dateFormat, dayInZone, intlCacheSize } from "@/server/lib/intl-cache";
import { orgMemo, setMemoClock } from "@/server/lib/org-memo";
import { orgFieldDefs, orgStatuses, readCacheHas, READ_CACHE_TTL_MS } from "@/server/services/suite/read-cache";
import { listFields } from "@/server/services/suite/fields";
import { REVALIDATED_GETS } from "@/server/lib/http-cache";

/**
 * R25 API speed: the new read paths give the same answers as before, caches clear on writes,
 * 304s only ever answer the same caller, and another workspace never sees a cached entry.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let orgId: string;
let pid: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  orgId = (await c.get("/api/account/me")).body.organization.id;
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});
afterEach(() => setMemoClock());

const field = async (client: Client, projectId: string, name: string, type: string, config?: Record<string, unknown>) => {
  const r = await client.post("/api/fields", { projectId, name, type, ...(config ? { config } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.field as { id: string };
};
const list = async (client: Client, projectId: string) => (await client.get(`/api/tasks?projectId=${projectId}`)).body.tasks as { id: string; title: string; statusName: string; fields: Record<string, unknown> }[];

describe("intl cache", () => {
  it("hands back one formatter per locale and options, with the same days as a fresh formatter", () => {
    const a = dateFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
    const b = dateFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
    expect(a).toBe(b);
    const at = new Date("2026-11-04T15:30:00Z");
    for (const tz of ["UTC", "Australia/Sydney", "America/Los_Angeles", "Asia/Kolkata"]) {
      expect(dayInZone(at, tz)).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at));
    }
    expect(dayInZone(at, "Australia/Sydney")).toBe("2026-11-05");
    expect(intlCacheSize()).toBeGreaterThan(0);
  });
  it("still refuses an unknown zone, and My Work falls back to UTC for one", async () => {
    expect(() => dateFormat("en", { timeZone: "Mars/Olympus" })).toThrow(RangeError);
    const r = await c.get("/api/my-work?tz=Mars/Olympus");
    expect(r.status).toBe(200);
    expect(r.body.timeZone).toBe("UTC");
  });
});

describe("org memo", () => {
  it("caches per database and org, expires after the TTL, clears on invalidate and never caches a failure", async () => {
    let now = 1_000;
    setMemoClock(() => now);
    const memo = orgMemo<number>("test", 100);
    const dbA = {}; const dbB = {};
    let loads = 0;
    const load = () => Promise.resolve(++loads);
    expect(await memo.get(dbA, "org1", load)).toBe(1);
    expect(await memo.get(dbA, "org1", load)).toBe(1);
    expect(await memo.get(dbA, "org2", load)).toBe(2); // another org: its own entry
    expect(await memo.get(dbB, "org1", load)).toBe(3); // another database: its own entry
    now += 101;
    expect(await memo.get(dbA, "org1", load)).toBe(4); // expired
    memo.invalidate(dbA, "org1");
    expect(memo.has(dbA, "org1")).toBe(false);
    expect(await memo.get(dbA, "org1", load)).toBe(5);
    const failing = orgMemo<number>("fail", 100);
    await expect(failing.get(dbA, "o", () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    await Promise.resolve();
    expect(failing.has(dbA, "o")).toBe(false);
    expect(await failing.get(dbA, "o", () => Promise.resolve(7))).toBe(7);
  });
  it("runs a thenable query once, however many readers await it", async () => {
    const memo = orgMemo<string>("thenable", 1_000);
    let runs = 0;
    const thenable = { then(ok: (v: string) => void) { runs++; ok("rows"); } } as unknown as PromiseLike<string>;
    const db = {};
    const results = await Promise.all([memo.get(db, "o", () => thenable), memo.get(db, "o", () => thenable), memo.get(db, "o", () => thenable)]);
    expect(results).toEqual(["rows", "rows", "rows"]);
    expect(runs).toBe(1);
  });
});

describe("field definitions read cache", () => {
  it("gives the same definitions, in the same order, as the direct per project query", async () => {
    const other = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project.id;
    for (const [p, n] of [[pid, "Budget"], [other, "Cost"], [pid, "Stage"], [other, "Owner"], [pid, "Size"]] as const) await field(c, p, n, "text");
    const defs = await orgFieldDefs(ctx.deps, orgId);
    for (const p of [pid, other]) {
      const direct = (await listFields(ctx.deps, orgId, p)).map((f) => f.id);
      const cached = defs.filter((d) => d.projectId === p).sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()).map((d) => d.id);
      expect(cached).toEqual(direct);
    }
  });
  it("a formula change, a new field and a delete show on the very next list (the write clears the cache)", async () => {
    const t = (await c.post("/api/tasks", { title: "Ship", projectId: pid, points: 4 })).body.task as { id: string };
    const double = await field(c, pid, "Double", "formula", { expression: "points * 2" });
    expect((await list(c, pid)).find((x) => x.id === t.id)!.fields[double.id]).toBe(8);
    expect(readCacheHas.fields(ctx.deps, orgId)).toBe(true);
    expect((await c.patch(`/api/fields/${double.id}`, { config: { expression: "points * 3" } })).status).toBe(200);
    expect(readCacheHas.fields(ctx.deps, orgId)).toBe(false);
    expect((await list(c, pid)).find((x) => x.id === t.id)!.fields[double.id]).toBe(12);
    const plus = await field(c, pid, "Plus", "formula", { expression: "points + 1" });
    expect((await list(c, pid)).find((x) => x.id === t.id)!.fields[plus.id]).toBe(5);
    expect((await c.del(`/api/fields/${double.id}`)).status).toBe(200);
    expect((await list(c, pid)).find((x) => x.id === t.id)!.fields[double.id]).toBeUndefined();
  });
  it("other isolates catch up within the TTL", async () => {
    let now = Date.now();
    setMemoClock(() => now);
    await orgFieldDefs(ctx.deps, orgId);
    expect(readCacheHas.fields(ctx.deps, orgId)).toBe(true);
    now += READ_CACHE_TTL_MS + 1;
    expect(readCacheHas.fields(ctx.deps, orgId)).toBe(false);
  });
});

describe("status read cache", () => {
  it("a renamed status shows on the next task list", async () => {
    await c.post("/api/tasks", { title: "Ship", projectId: pid });
    expect((await list(c, pid))[0].statusName).toBe("To do");
    expect(readCacheHas.statuses(ctx.deps, orgId)).toBe(true);
    const project = (await c.get(`/api/projects/${pid}`)).body.project as { statuses: { id: string; name: string; category: string; color: string }[] };
    const statuses = project.statuses.map((s) => (s.name === "To do" ? { ...s, name: "Backlog" } : s));
    expect((await c.patch(`/api/projects/${pid}`, { statuses })).status).toBe(200);
    expect(readCacheHas.statuses(ctx.deps, orgId)).toBe(false);
    expect((await list(c, pid))[0].statusName).toBe("Backlog");
  });
  it("only ever holds the asking workspace's rows", async () => {
    const all = await orgStatuses(ctx.deps, orgId);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => s.orgId === orgId)).toBe(true);
  });
});

describe("another workspace", () => {
  it("is refused the first one's projects and fields, and its lists never carry the first one's cached rows", async () => {
    const budget = await field(c, pid, "Budget", "number");
    await c.post("/api/tasks", { title: "Secret plan", projectId: pid });
    await list(c, pid); // fills org one's caches
    const b = new Client(ctx.app);
    await b.signup("bob@other.io", "Bob Other", "Other");
    expect((await b.get(`/api/fields?projectId=${pid}`)).status).toBe(404);
    expect((await b.get(`/api/projects/${pid}`)).status).toBe(404);
    const theirs = (await b.get(`/api/tasks?projectId=${pid}`)).body.tasks as unknown[] | undefined;
    expect(theirs ?? []).toEqual([]);
    const bProject = (await b.post("/api/projects", { name: "Mine", key: "MIN" })).body.project.id;
    await b.post("/api/tasks", { title: "Bob task", projectId: bProject });
    const rows = await list(b, bProject);
    expect(rows.map((r) => r.title)).toEqual(["Bob task"]);
    expect(Object.keys(rows[0].fields ?? {})).not.toContain(budget.id);
    expect(rows[0].statusName).toBe("To do");
  });
});

describe("ETag and 304", () => {
  const withTag = (client: Client, path: string, tag: string) => client.call("GET", path, undefined, { "if-none-match": tag });
  async function raw(path: string, headers: Record<string, string> = {}) {
    return ctx.app.request(path, { headers: { host: "localhost", ...(c.cookie ? { cookie: c.cookie } : {}), ...headers } });
  }
  it("config: public, revalidated, 304 on a match", async () => {
    const first = await raw("/api/config");
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("public, no-cache");
    const again = await raw("/api/config", { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("cache-control")).toBe("public, no-cache");
  });
  it("member lists: private, vary on credentials, 304 on a match and 200 again once the list changes", async () => {
    for (const path of ["/api/team/people", "/api/tasks/assignees", "/api/projects", "/api/chat/channels"]) {
      const first = await raw(path);
      expect(first.status, path).toBe(200);
      expect(first.headers.get("cache-control"), path).toBe("private, no-cache");
      expect(first.headers.get("vary") ?? "", path).toMatch(/Cookie/);
      const tag = first.headers.get("etag")!;
      const again = await raw(path, { "if-none-match": tag });
      expect(again.status, path).toBe(304);
    }
    const before = (await raw("/api/projects")).headers.get("etag")!;
    await c.post("/api/projects", { name: "New one", key: "NEW" });
    const after = await raw("/api/projects", { "if-none-match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });
  it("never answers 304 to someone else, or to a signed out caller", async () => {
    const mine = (await raw("/api/team/people")).headers.get("etag")!;
    const b = new Client(ctx.app);
    await b.signup("bob@other.io", "Bob Other", "Other");
    const theirs = await withTag(b, "/api/team/people", mine);
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain("owner@acme.io");
    const anon = await ctx.app.request("/api/team/people", { headers: { host: "localhost", "if-none-match": mine } });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("etag")).toBeNull();
    expect(anon.headers.get("cache-control")).toBe("no-store");
  });
  it("everything else keeps no-store", async () => {
    const r = await raw("/api/my-work");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("etag")).toBeNull();
    expect(Object.keys(REVALIDATED_GETS)).not.toContain("/api/my-work");
  });
});

describe("0052 indexes", () => {
  it("replaces the two indexes and the hot reads use them", async () => {
    const idx = (await ctx.deps.db.all<{ name: string; tbl_name: string }>(sql`select name, tbl_name from sqlite_master where type = 'index' and tbl_name in ('messages', 'tasks')`)).map((r) => r.name);
    expect(idx).toContain("messages_org_folder_date_idx");
    expect(idx).toContain("tasks_org_project_cover_idx");
    expect(idx).not.toContain("messages_org_idx");
    expect(idx).not.toContain("tasks_org_project_idx");
    const inbox = await ctx.deps.db.all<{ detail: string }>(sql`explain query plan select id from messages where org_id = ${orgId} and folder = 'inbox' order by date desc limit 50`);
    expect(inbox.map((r) => r.detail).join(" ")).toContain("messages_org_folder_date_idx");
    const counts = await ctx.deps.db.all<{ detail: string }>(sql`explain query plan select project_id, status, count(*) from tasks where org_id = ${orgId} and deleted_at is null and triage_state is null group by project_id, status`);
    expect(counts.map((r) => r.detail).join(" ")).toMatch(/COVERING INDEX tasks_org_project_cover_idx/);
  });
});
