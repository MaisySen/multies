import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meter } from "./d1-meter";
import { activity, changes, projectCounters, projects } from "@/server/db/schema";

/**
 * R33 (migration 0073): one change row per tracked write (it carries the activity fields), the task number claim on
 * the narrow project_counters table, and project keys unique on edit (any case) over the app, API v1 and MCP.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let actor: { orgId: string; userId: string; email: string; name: string; role: "owner" };

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.test", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" };
});

const raw = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } } }).$client;

describe("R33 one row per change", () => {
  it("a task write adds one change row with the activity fields and no activity row; the timeline still reads it", async () => {
    const pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    const { createTask, updateTask, taskDetail } = await import("@/server/services/suite/tasks");
    const before = (await ctx.db.select().from(activity)).length;
    const t = await createTask(ctx.deps, actor, { title: "Ship it", projectId: pid });
    await updateTask(ctx.deps, actor, t.id, { title: "Ship it now" } as never);
    expect((await ctx.db.select().from(activity)).length).toBe(before);
    const rows = await ctx.db.select().from(changes).where(eq(changes.entityId, t.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !!r.verb)).toBe(true);
    expect(rows[0]).toMatchObject({ actorType: "member", actorId: actor.userId, actorName: "Olive Owner", op: "create" });
    const detail = await taskDetail(ctx.deps, actor, t.id) as unknown as { activity: { verb: string; actor: { name: string }; id: string }[] };
    expect(detail.activity.length).toBe(2);
    expect(detail.activity[0].actor.name).toBe("Olive Owner");
    expect(detail.activity.every((a) => a.id.startsWith("chg_"))).toBe(true);
  });

  it("old activity rows written before 0073 still show on the timeline, in time order with new ones", async () => {
    const pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    const { createTask, updateTask, taskDetail } = await import("@/server/services/suite/tasks");
    const t = await createTask(ctx.deps, actor, { title: "Old one", projectId: pid });
    await ctx.db.insert(activity).values({ id: "act_legacy1", orgId: actor.orgId, actorType: "member", actorId: actor.userId, actorName: "Before 0073", verb: "legacy_edit", entityType: "task", entityId: t.id, data: "{\"x\":1}", createdAt: new Date(Date.now() - 60_000) });
    await updateTask(ctx.deps, actor, t.id, { title: "Old one renamed" } as never);
    const detail = await taskDetail(ctx.deps, actor, t.id) as unknown as { activity: { verb: string; data: Record<string, unknown> }[] };
    expect(detail.activity.map((a) => a.verb)).toContain("legacy_edit");
    expect(detail.activity[detail.activity.length - 1].verb).toBe("legacy_edit");
    expect(detail.activity.find((a) => a.verb === "legacy_edit")!.data).toEqual({ x: 1 });
  });

  it("the sync feed is unchanged: one change per write, in seq order", async () => {
    const { createTask } = await import("@/server/services/suite/tasks");
    const { changesSince } = await import("@/server/services/suite/common");
    const start = (await changesSince(ctx.deps, actor.orgId, 0, 5000)).cursor;
    const a = await createTask(ctx.deps, actor, { title: "A" });
    const b = await createTask(ctx.deps, actor, { title: "B" });
    const feed = await changesSince(ctx.deps, actor.orgId, start);
    expect(feed.changes.filter((x) => x.entity === "task").map((x) => x.id)).toEqual([a.id, b.id]);
    expect(Object.keys(feed.changes[0]).sort()).toEqual(["at", "entity", "id", "op", "seq", "version"]);
  });

  it("the timeline query uses the partial entity index (EXPLAIN QUERY PLAN), and the index holds only rows with a verb", async () => {
    const plan = (raw().prepare("explain query plan select * from activity_feed where org_id = ? and entity_type = ? and entity_id = ? order by created_at desc limit 100").all("o", "task", "t") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toContain("changes_entity_idx");
    const sql = (raw().prepare("select sql from sqlite_master where name = 'changes_entity_idx'").get() as { sql: string }).sql;
    expect(sql).toMatch(/WHERE "changes"\."verb" IS NOT NULL/);
  });
});

describe("R33 task numbers on project_counters", () => {
  it("numbers continue from projects.next_number for a project made before 0073, and the projects row is not written", async () => {
    const pid = (await c.post("/api/projects", { name: "Legacy", key: "LEG" })).body.project.id;
    await ctx.db.update(projects).set({ nextNumber: 41 }).where(eq(projects.id, pid));
    const { createTask } = await import("@/server/services/suite/tasks");
    const take = meter(ctx.db);
    const a = await createTask(ctx.deps, actor, { title: "A", projectId: pid });
    const by = take.byTable();
    take();
    expect(a.number).toBe(41);
    expect(by.projects).toBeUndefined();
    expect(by.project_counters).toBe(1);
    const b = await createTask(ctx.deps, actor, { title: "B", projectId: pid });
    expect(b.number).toBe(42);
    expect((await ctx.db.select().from(projectCounters).where(eq(projectCounters.projectId, pid)).get())!.nextNumber).toBe(43);
    // The old column is kept and no longer written (rollback reads it).
    expect((await ctx.db.select().from(projects).where(eq(projects.id, pid)).get())!.nextNumber).toBe(41);
  });

  it("a move and a bulk move claim numbers in the target project without gaps or repeats", async () => {
    const p1 = (await c.post("/api/projects", { name: "One", key: "ONE" })).body.project.id;
    const p2 = (await c.post("/api/projects", { name: "Two", key: "TWO" })).body.project.id;
    const { createTask, updateTask } = await import("@/server/services/suite/tasks");
    const first = await createTask(ctx.deps, actor, { title: "in two", projectId: p2 });
    const ts = [];
    for (const title of ["a", "b", "c"]) ts.push(await createTask(ctx.deps, actor, { title, projectId: p1 }));
    const moved = await updateTask(ctx.deps, actor, ts[0].id, { projectId: p2 } as never) as unknown as { number: number };
    expect(moved.number).toBe(first.number + 1);
    const bm = await c.post("/api/tasks/bulk", { ids: [ts[1].id, ts[2].id], patch: { projectId: p2 } });
    expect(bm.status).toBe(200);
    const nums = (bm.body.tasks as { number: number }[]).map((x) => x.number).sort();
    expect(nums).toEqual([first.number + 2, first.number + 3]);
    const next = await createTask(ctx.deps, actor, { title: "after", projectId: p2 });
    expect(next.number).toBe(first.number + 4);
  });

  it("a deleted project takes its counter with it (cascade)", async () => {
    const pid = (await c.post("/api/projects", { name: "Gone", key: "GON" })).body.project.id;
    const { createTask } = await import("@/server/services/suite/tasks");
    await createTask(ctx.deps, actor, { title: "x", projectId: pid });
    raw().prepare("pragma foreign_keys = on").run();
    raw().prepare("delete from tasks where project_id = ?").run(pid);
    raw().prepare("delete from project_statuses where project_id = ?").run(pid);
    raw().prepare("delete from projects where id = ?").run(pid);
    expect(await ctx.db.select().from(projectCounters).where(eq(projectCounters.projectId, pid))).toHaveLength(0);
  });
});

describe("R33 project key unique on edit", () => {
  it("app: changing a key to one another project uses answers 409 key_taken, in any case; own key and free keys save", async () => {
    await c.post("/api/projects", { name: "Ops", key: "OPS" });
    const mine = (await c.post("/api/projects", { name: "Sales", key: "SAL" })).body.project;
    const clash = await c.patch(`/api/projects/${mine.id}`, { key: "OPS" });
    expect(clash.status).toBe(409);
    expect(clash.body.error?.code ?? clash.body.code).toBe("key_taken");
    expect(JSON.stringify(clash.body)).toContain("The key OPS is already used by Ops");
    expect((await c.patch(`/api/projects/${mine.id}`, { key: "ops" })).status).toBe(409);
    expect((await c.patch(`/api/projects/${mine.id}`, { key: "sal" })).status).toBe(200);
    const ok = await c.patch(`/api/projects/${mine.id}`, { key: "rev" });
    expect(ok.status).toBe(200);
    expect(ok.body.project.key).toBe("REV");
    // Renaming alone keeps the key and never clashes.
    expect((await c.patch(`/api/projects/${mine.id}`, { name: "Ops" })).body.project.key).toBe("REV");
    expect((await c.patch(`/api/projects/${mine.id}`, { key: "bad-key" })).status).toBe(422);
  });

  it("after a key edit the old ref still opens the task, and no other project can take the old key", async () => {
    const p = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project;
    const other = (await c.post("/api/projects", { name: "Sales", key: "SAL" })).body.project;
    const t = (await c.post("/api/tasks", { projectId: p.id, title: "Keep my link" })).body.task;
    expect(t.ref).toBe("OPS-1");
    const take = meter(ctx.db);
    expect((await c.patch(`/api/projects/${p.id}`, { key: "OPR" })).status).toBe(200);
    expect(take.byTable().project_key_aliases).toBe(1);
    const byNew = await c.get("/api/tasks/OPR-1");
    expect(byNew.status).toBe(200);
    const byOld = await c.get("/api/tasks/OPS-1");
    expect(byOld.status).toBe(200);
    expect(byOld.body.task.id).toBe(t.id);
    expect(byOld.body.task.ref).toBe("OPR-1");
    const taken = await c.patch(`/api/projects/${other.id}`, { key: "ops" });
    expect(taken.status).toBe(409);
    expect(JSON.stringify(taken.body)).toContain("old task links still open there");
    // The project itself may go back to its old key.
    expect((await c.patch(`/api/projects/${p.id}`, { key: "OPS" })).body.project.key).toBe("OPS");
    expect((await c.get("/api/tasks/OPR-1")).body.task.id).toBe(t.id);
  });

  it("a key held by a legacy lower case row still blocks (case-insensitive compare)", async () => {
    const a = (await c.post("/api/projects", { name: "Alpha", key: "ALP" })).body.project.id;
    const b = (await c.post("/api/projects", { name: "Beta", key: "BET" })).body.project.id;
    await ctx.db.update(projects).set({ key: "alp" }).where(eq(projects.id, a));
    expect((await c.patch(`/api/projects/${b}`, { key: "ALP" })).status).toBe(409);
  });

  it("API v1 and MCP refuse a taken key the same way", async () => {
    await c.post("/api/projects", { name: "Ops", key: "OPS" });
    const mine = (await c.post("/api/projects", { name: "Sales", key: "SAL" })).body.project;
    const key = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
    const res = await ctx.app.request(`/api/v1/projects/${mine.id}`, { method: "PATCH", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ key: "Ops" }) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("key_taken");
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const refused = await mcp.callTool({ name: "update_project", arguments: { projectId: mine.id, key: "ops" } }) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("already used by Ops");
    const saved = await mcp.callTool({ name: "update_project", arguments: { projectId: mine.id, key: "rev", name: "Revenue" } }) as { content: { text: string }[] };
    expect(JSON.parse(saved.content[0].text).project).toMatchObject({ key: "REV", name: "Revenue" });
  });
});
