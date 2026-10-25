import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { activity, changes, tasks } from "@/server/db/schema";
import { bulkUpdateTasks } from "@/server/services/suite/bulk";
import { resetWriteBudgetCache, writeBudget } from "@/server/services/write-budget";

/** Round 21 (R21.2): bulk task changes for the table view, REST and MCP. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let me: { organization: { id: string }; user: { id: string; email: string; name: string } };

async function setup(env: Record<string, string> = {}, opts: Parameters<typeof makeTestApp>[1] = {}) {
  resetWriteBudgetCache();
  ctx = await makeTestApp(env, opts);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Owner Person");
  me = (await c.get("/api/account/me")).body;
}
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const project = async (name = "Web") => (await c.post("/api/projects", { name })).body.project as { id: string; key: string; statuses: { id: string; name: string; category: string }[] };
const task = async (projectId: string, title: string, extra: Record<string, unknown> = {}) => (await c.post("/api/tasks", { title, projectId, ...extra })).body.task as { id: string; ref: string };
const row = async (id: string) => (await ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get())!;

describe("bulk task changes", () => {
  beforeEach(() => setup());

  it("sets status, assignee, due date, priority and start for many tasks in one call, by id or reference", async () => {
    const p = await project();
    const ts = [await task(p.id, "One"), await task(p.id, "Two"), await task(p.id, "Three")];
    const r = await c.post("/api/tasks/bulk", { ids: [ts[0].id, ts[1].ref, ts[2].ref.toLowerCase()], patch: { status: "done", assignee: `member:${me.user.id}`, dueAt: "2026-11-03", priority: "high", startAt: "2026-11-01" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 3, unchanged: 0 });
    for (const t of r.body.tasks) {
      expect(t).toMatchObject({ status: "done", statusName: "Done", priority: "high", due: "2026-11-03T00:00:00.000Z", start: "2026-11-01T00:00:00.000Z", assigneeId: `member:${me.user.id}` });
      expect(t.completedAt).toBeTruthy();
      expect(t.version).toBe(2);
    }
    // Positions at the bottom of Done, in order, and distinct.
    const rows = await Promise.all(ts.map((t) => row(t.id)));
    expect(new Set(rows.map((x) => x.position)).size).toBe(3);
    // Clearing the due date, then back to to do clears completedAt.
    const back = await c.post("/api/tasks/bulk", { ids: ts.map((t) => t.id), patch: { dueAt: null, status: "todo" } });
    expect(back.body.tasks.every((t: { due: string | null; completedAt: string | null }) => t.due === null && t.completedAt === null)).toBe(true);
    // A patch that changes nothing writes nothing.
    const same = await c.post("/api/tasks/bulk", { ids: ts.map((t) => t.id), patch: { priority: "high" } });
    expect(same.body).toMatchObject({ updated: 0, unchanged: 3 });
    // One sync feed change per task per action, one summary activity row per action.
    const feed = await ctx.deps.db.select().from(changes).where(eq(changes.entityId, ts[0].id));
    expect(feed.filter((f) => f.op === "update")).toHaveLength(2);
    const acts = await ctx.deps.db.select().from(activity).where(eq(activity.verb, "tasks.bulk_updated"));
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ entityType: "project", entityId: p.id });
  });

  it("adds and removes labels idempotently", async () => {
    const p = await project();
    const a = await task(p.id, "A", { labels: ["red"] });
    const b = await task(p.id, "B");
    const add = await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { addLabels: ["blue", "red"] } });
    expect(add.body.tasks.map((t: { labels: string[] }) => t.labels)).toEqual([["red", "blue"], ["blue", "red"]]);
    const again = await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { addLabels: ["blue"] } });
    expect(again.body).toMatchObject({ updated: 0, unchanged: 2 });
    const rm = await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { removeLabels: ["red"] } });
    expect(rm.body.tasks.map((t: { labels: string[] }) => t.labels)).toEqual([["blue"], ["blue"]]);
    expect((await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { removeLabels: ["red"] } })).body.updated).toBe(0);
  });

  it("moves tasks to another project with new numbers and the matching status group", async () => {
    const from = await project("Web");
    const to = await project("Ops");
    const a = await task(from.id, "A");
    const b = await task(from.id, "B", { status: "doing" });
    const d = await task(from.id, "D", { status: "done" });
    await task(to.id, "Already there");
    const r = await c.post("/api/tasks/bulk", { ids: [a.id, b.id, d.id], patch: { projectId: to.id } });
    expect(r.status).toBe(200);
    const byTitle = Object.fromEntries(r.body.tasks.map((t: { title: string }) => [t.title, t]));
    expect(byTitle.A).toMatchObject({ projectId: to.id, status: "todo", statusName: "To do" });
    expect(byTitle.B).toMatchObject({ projectId: to.id, status: "doing", statusName: "In progress" });
    expect(byTitle.D).toMatchObject({ projectId: to.id, status: "done" });
    const refs = r.body.tasks.map((t: { ref: string }) => t.ref).sort();
    expect(refs).toEqual([`${to.key}-2`, `${to.key}-3`, `${to.key}-4`]);
    const toStatusIds = new Set(to.statuses.map((s) => s.id));
    expect(r.body.tasks.every((t: { statusId: string }) => toStatusIds.has(t.statusId))).toBe(true);
    // The next task made in Ops does not collide with the moved numbers.
    expect((await task(to.id, "Next")).ref).toBe(`${to.key}-5`);
  });

  it("refuses a status id from another project, more than 500 tasks, and an empty patch", async () => {
    const p = await project("Web");
    const q = await project("Ops");
    const a = await task(p.id, "A");
    const b = await task(q.id, "B");
    expect((await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { statusId: p.statuses[1].id } })).status).toBe(422);
    expect((await c.post("/api/tasks/bulk", { ids: [a.id], patch: {} })).status).toBe(422);
    const many = Array.from({ length: 501 }, (_, i) => `tsk_${i}`);
    const big = await c.post("/api/tasks/bulk", { ids: many, patch: { priority: "low" } });
    expect(big.status).toBe(413);
    expect(big.body.error.message).toContain("500");
    expect((await c.post("/api/tasks/bulk-delete", { ids: many })).status).toBe(413);
  });

  it("never touches another workspace's tasks: a mixed list is refused whole", async () => {
    const p = await project();
    const mine = await task(p.id, "Mine");
    const other = new Client(ctx.app);
    await other.signup("other@else.io", "Other Person", "Else");
    const op = (await other.post("/api/projects", { name: "Theirs" })).body.project;
    const theirs = (await other.post("/api/tasks", { title: "Theirs", projectId: op.id })).body.task;
    const r = await c.post("/api/tasks/bulk", { ids: [mine.id, theirs.id], patch: { priority: "urgent" } });
    expect(r.status).toBe(404);
    expect((await row(theirs.id)).priority).toBe("none");
    expect((await row(mine.id)).priority).toBe("none");
    expect((await c.post("/api/tasks/bulk-delete", { ids: [theirs.id] })).status).toBe(404);
    expect((await row(theirs.id)).deletedAt).toBeNull();
    // A reference resolves only inside the caller's workspace.
    expect((await other.post("/api/tasks/bulk", { ids: [mine.ref], patch: { priority: "urgent" } })).status).toBe(404);
    // Assigning to someone outside the workspace is refused.
    expect((await c.post("/api/tasks/bulk", { ids: [mine.id], patch: { assignee: `member:${(await other.get("/api/account/me")).body.user.id}` } })).status).toBe(422);
    // Moving into another workspace's project is refused.
    expect((await c.post("/api/tasks/bulk", { ids: [mine.id], patch: { projectId: op.id } })).status).toBe(404);
  });

  it("deletes many tasks and their subtasks in one call", async () => {
    const p = await project();
    const a = await task(p.id, "A");
    const sub = (await c.post("/api/tasks", { title: "Sub", parentId: a.id })).body.task;
    const b = await task(p.id, "B");
    const keep = await task(p.id, "Keep");
    const r = await c.post("/api/tasks/bulk-delete", { ids: [a.ref, b.id] });
    expect(r.body).toMatchObject({ deleted: 2 });
    expect((await row(sub.id)).deletedAt).not.toBeNull();
    expect((await row(keep.id)).deletedAt).toBeNull();
    expect((await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks.map((t: { title: string }) => t.title)).toEqual(["Keep"]);
  });

  it("REST and MCP: workspace and agent keys can bulk update, read only keys and guests cannot", async () => {
    const p = await project();
    const ts = [await task(p.id, "A"), await task(p.id, "B")];
    const wsKey = (await c.post("/api/developer/keys", { name: "Full" })).body.secret;
    const readKey = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    const r = await api(wsKey, "POST", "/tasks/bulk", { ids: ts.map((t) => t.ref), patch: { status: "doing", addLabels: ["api"] } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    expect((await api(readKey, "POST", "/tasks/bulk", { ids: [ts[0].id], patch: { priority: "low" } })).status).toBe(403);
    expect((await api(readKey, "POST", "/tasks/bulk-delete", { ids: [ts[0].id] })).status).toBe(403);
    expect((await api(wsKey, "POST", "/tasks/bulk", { ids: [ts[0].id], patch: { nope: 1 } })).status).toBe(422);
    const spec = (await (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/tasks/bulk", "/tasks/bulk-delete"]));

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcpFor = async (key: string) => {
      const client = new McpClient({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return client;
    };
    const mcp = await mcpFor(wsKey);
    const out = await mcp.callTool({ name: "bulk_update_tasks", arguments: { ids: ts.map((t) => t.id), priority: "urgent", dueAt: "2026-11-05" } });
    const body = JSON.parse((out as { content: { text: string }[] }).content[0].text);
    expect(body).toMatchObject({ updated: 2 });
    expect(body.tasks[0]).toMatchObject({ priority: "urgent", due: "2026-11-05T00:00:00.000Z", labels: ["api"] });
    const ro = await mcpFor(readKey);
    const denied = await ro.callTool({ name: "bulk_update_tasks", arguments: { ids: [ts[0].id], priority: "low" } });
    expect((denied as { isError?: boolean }).isError).toBe(true);
    expect((await row(ts[0].id)).priority).toBe("urgent");

    // An agent key acts inside its workspace too.
    const created = (await c.post("/api/agents", { name: "Ops bot", localPart: "ops" })).body;
    if (created.apiKey?.secret) {
      const ar = await api(created.apiKey.secret, "POST", "/tasks/bulk", { ids: [ts[1].id], patch: { assignee: `agent:${created.agent.id}` } });
      expect(ar.status).toBe(200);
      expect(ar.body.tasks[0].assignee).toMatchObject({ type: "agent", id: created.agent.id });
    }

    // No session (a guest's cookie is not a workspace session) gets nothing.
    const g = new Client(ctx.app);
    expect((await g.post("/api/tasks/bulk", { ids: [ts[0].id], patch: { priority: "low" } })).status).toBe(401);
    expect((await g.post("/api/tasks/bulk-delete", { ids: [ts[0].id] })).status).toBe(401);
  });
});

describe("bulk task changes and the write budget", () => {
  const answer = (rows: number) => async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "db", date: "2026-10-25" } }] }] } } }), { status: 200 });
  let rows = 1_000;
  beforeEach(() => setup({ CF_ANALYTICS_TOKEN: "x", CF_ACCOUNT_ID: "acc" }, { fetch: (async () => answer(rows)()) as unknown as typeof fetch }));

  it("refuses at shed, and at warn writes the tasks and the sync feed but skips the summary activity row", async () => {
    const p = await project();
    const t = await task(p.id, "A");
    const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    rows = 99_000;
    resetWriteBudgetCache();
    expect((await writeBudget(ctx.deps)).level).toBe("shed");
    const shed = await c.post("/api/tasks/bulk", { ids: [t.id], patch: { priority: "low" } });
    expect(shed.status).toBe(503);
    expect((await row(t.id)).priority).toBe("none");
    rows = 75_000;
    resetWriteBudgetCache();
    const level = (await writeBudget(ctx.deps)).level;
    expect(level).toBe("warn");
    const r = await bulkUpdateTasks(ctx.deps, actor, [t.id], { priority: "low" });
    expect(r.updated).toBe(1);
    expect(await ctx.deps.db.select().from(activity).where(eq(activity.verb, "tasks.bulk_updated"))).toHaveLength(0);
    expect((await ctx.deps.db.select().from(changes).where(eq(changes.entityId, t.id))).length).toBeGreaterThanOrEqual(2);
  });
});
