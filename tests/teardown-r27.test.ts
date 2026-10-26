import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** R27 (teardown): task watchers and duplicate, in the app, REST and MCP. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let taskId: string;
let ownerId: string;

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
const notes = async (cl: Client) => ((await cl.get("/api/notifications")).body.notifications as { type: string; title: string; entityId: string }[]);
const sqlite = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => Record<string, number> } } }).$client;

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = Date.parse("2026-10-26T01:00:00Z");
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  ownerId = (await c.get("/api/account/me")).body.user.id;
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  taskId = (await c.post("/api/tasks", { title: "Ship the beta", projectId })).body.task.id;
});

describe("task watchers", () => {
  it("the creator, a new assignee and anyone who comments start watching", async () => {
    const sam = await teammate();
    const kim = await teammate("kim@acme.io", "Kim Lee");
    let w = (await c.get(`/api/tasks/${taskId}/watchers`)).body;
    expect(w).toMatchObject({ taskId, watching: true, count: 1 });
    expect(w.watchers[0]).toMatchObject({ userId: ownerId, name: "Olive Owner", source: "auto" });
    await c.patch(`/api/tasks/${taskId}`, { assignee: `member:${sam.id}` });
    await kim.client.post(`/api/tasks/${taskId}/comments`, { body: "I can help with the screenshots." });
    w = (await c.get(`/api/tasks/${taskId}/watchers`)).body;
    expect(w.watchers.map((x: { userId: string }) => x.userId).sort()).toEqual([ownerId, sam.id, kim.id].sort());
    expect((await kim.client.get(`/api/tasks/${taskId}/watchers`)).body.watching).toBe(true);
    // A task made with an assignee: both watch.
    const t2 = (await c.post("/api/tasks", { title: "Write the FAQ", projectId, assignee: `member:${kim.id}` })).body.task.id;
    expect((await c.get(`/api/tasks/${t2}/watchers`)).body.count).toBe(2);
  });

  it("watchers hear about comments and status changes once, and never about their own", async () => {
    const sam = await teammate();
    const kim = await teammate("kim@acme.io", "Kim Lee");
    await c.patch(`/api/tasks/${taskId}`, { assignee: `member:${sam.id}` });
    expect((await kim.client.post(`/api/tasks/${taskId}/watchers`, {})).status).toBe(200);
    await kim.client.post(`/api/tasks/${taskId}/comments`, { body: "Looks close." });
    // The owner (watcher) hears it as a watcher; Sam (assignee) hears it once, as the assignee.
    expect((await notes(c)).filter((n) => n.type === "task.watch_comment")).toHaveLength(1);
    const samNotes = await notes(sam.client);
    expect(samNotes.filter((n) => n.type === "task.commented")).toHaveLength(1);
    expect(samNotes.filter((n) => n.type === "task.watch_comment")).toHaveLength(0);
    expect((await notes(kim.client)).filter((n) => n.type.startsWith("task.watch"))).toHaveLength(0);
    // A mention is told once, as a mention.
    await c.post(`/api/tasks/${taskId}/comments`, { body: "@Kim can you check the copy?" });
    const kimNotes = await notes(kim.client);
    expect(kimNotes.filter((n) => n.type === "task.mentioned")).toHaveLength(1);
    expect(kimNotes.filter((n) => n.type === "task.watch_comment")).toHaveLength(0);
    // A status change reaches every watcher but the person who made it.
    await c.patch(`/api/tasks/${taskId}`, { status: "done" });
    for (const p of [sam, kim]) {
      const s = (await notes(p.client)).filter((n) => n.type === "task.watch_status");
      expect(s).toHaveLength(1);
      expect(s[0].title).toMatch(/^LAU-1 moved to .+: Ship the beta$/);
      expect(s[0].entityId).toBe(taskId);
    }
    expect((await notes(c)).filter((n) => n.type === "task.watch_status")).toHaveLength(0);
  });

  it("watches and unwatches by hand, for me or another member, and comments bring a watcher back", async () => {
    const sam = await teammate();
    expect((await sam.client.post(`/api/tasks/${taskId}/watchers`)).body).toMatchObject({ watching: true, count: 2 });
    expect((await sam.client.post(`/api/tasks/${taskId}/watchers`)).body.count).toBe(2); // twice changes nothing
    const out = (await sam.client.del(`/api/tasks/${taskId}/watchers/me`)).body;
    expect(out).toMatchObject({ watching: false, count: 1 });
    expect((await sam.client.del(`/api/tasks/${taskId}/watchers/me`)).status).toBe(200);
    // The owner adds Sam back by id; the row says manual.
    const added = (await c.post(`/api/tasks/LAU-1/watchers`, { userId: sam.id })).body;
    expect(added.watchers.find((x: { userId: string }) => x.userId === sam.id).source).toBe("manual");
    await c.del(`/api/tasks/${taskId}/watchers/${sam.id}`);
    // The owner stops watching and then comments: watching again.
    await c.del(`/api/tasks/${taskId}/watchers/me`);
    expect((await c.get(`/api/tasks/${taskId}/watchers`)).body.count).toBe(0);
    await c.post(`/api/tasks/${taskId}/comments`, { body: "Back on this." });
    expect((await c.get(`/api/tasks/${taskId}/watchers`)).body.watching).toBe(true);
    // Not a member: refused. Unknown task: 404. The activity says who was added.
    expect((await c.post(`/api/tasks/${taskId}/watchers`, { userId: "usr_nobody" })).status).toBe(422);
    expect((await c.post(`/api/tasks/tsk_missing/watchers`)).status).toBe(404);
    const detail = (await c.get(`/api/tasks/${taskId}`)).body;
    expect(JSON.stringify(detail.activity)).toContain("task.watch_added");
  });

  it("keeps workspaces apart and lists a long watcher list under D1's variable limit", async () => {
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    expect((await other.get(`/api/tasks/${taskId}/watchers`)).status).toBe(404);
    expect((await other.post(`/api/tasks/${taskId}/watchers`)).status).toBe(404);
    expect((await other.del(`/api/tasks/${taskId}/watchers/me`)).status).toBe(404);
    const eveId = (await other.get("/api/account/me")).body.user.id;
    expect((await c.post(`/api/tasks/${taskId}/watchers`, { userId: eveId })).status).toBe(422);
    // 150 watcher rows (149 of them people no longer in the workspace): one list read, chunked.
    const orgId = (sqlite().prepare("select org_id as o from tasks where id = ?").get(taskId) as unknown as { o: string }).o;
    const ins = sqlite().prepare("insert into task_watchers (task_id, user_id, org_id, source, created_at) values (?, ?, ?, 'auto', ?)");
    for (let i = 0; i < 149; i++) ins.run(taskId, `usr_gone_${i}`, orgId, Date.now());
    const w = await c.get(`/api/tasks/${taskId}/watchers`);
    expect(w.status).toBe(200);
    expect(w.body.count).toBe(1);
    // Comments fan out over the same rows without tripping the limit.
    expect((await c.post(`/api/tasks/${taskId}/comments`, { body: "Still fine." })).status).toBeLessThan(300);
  });

  it("works over REST and MCP, with read only keys limited to the list", async () => {
    const sam = await teammate();
    const key = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    expect((await api(key, "GET", `/tasks/LAU-1/watchers`)).body.count).toBe(1);
    expect((await api(key, "POST", `/tasks/${taskId}/watchers`, { userId: sam.id })).body.count).toBe(2);
    expect((await api(key, "DELETE", `/tasks/${taskId}/watchers/${sam.id}`)).body.count).toBe(1);
    expect((await api(ro, "GET", `/tasks/${taskId}/watchers`)).status).toBe(200);
    expect((await api(ro, "POST", `/tasks/${taskId}/watchers`, { userId: sam.id })).status).toBe(403);
    const m = await mcpFor(key);
    const names = (await m.listTools()).tools.map((t) => t.name);
    for (const n of ["list_task_watchers", "watch_task", "unwatch_task", "duplicate_task"]) expect(names).toContain(n);
    expect(data(await m.callTool({ name: "watch_task", arguments: { taskId: "LAU-1", userId: sam.id } })).count).toBe(2);
    expect(data(await m.callTool({ name: "list_task_watchers", arguments: { taskId } })).watchers.map((w: { name: string }) => w.name)).toContain("Sam Mate");
    expect(data(await m.callTool({ name: "unwatch_task", arguments: { taskId, userId: sam.id } })).count).toBe(1);
    const mro = await mcpFor(ro);
    expect((await mro.callTool({ name: "watch_task", arguments: { taskId, userId: sam.id } })).isError).toBe(true);
  });
});

describe("duplicate a task", () => {
  it("copies the task, its subtasks and checklist (unticked), fields and labels, into to-do, and links back", async () => {
    const sam = await teammate();
    const field = (await c.post("/api/fields", { projectId, name: "Budget", type: "number" })).body.field;
    await c.patch(`/api/tasks/${taskId}`, { assignee: `member:${sam.id}`, priority: "high", due: "2026-11-02", labels: ["launch"], notes: "Ship it.", fields: { [field.id]: 1200 } });
    const sub = (await c.post("/api/tasks", { title: "Screenshots", parentId: taskId })).body.task.id;
    await c.post("/api/tasks", { title: "Store copy", parentId: sub });
    await c.post(`/api/tasks/${taskId}/checklist`, { items: [{ title: "Tag the build", done: true }, { title: "Tell support" }] });
    await c.post(`/api/tasks/${taskId}/comments`, { body: "Not copied." });
    await c.patch(`/api/tasks/${taskId}`, { status: "done" });

    const r = await c.post(`/api/tasks/LAU-1/duplicate`, {});
    expect(r.status).toBe(201);
    const copy = r.body.task;
    expect(r.body.from).toEqual({ id: taskId, ref: "LAU-1" });
    expect(r.body.copied).toEqual({ tasks: 3, subtasks: 2, checklistItems: 2, dependencies: 0 });
    expect(copy).toMatchObject({ title: "Ship the beta (copy)", status: "todo", priority: "high", labels: ["launch"], notes: "Ship it.", projectId });
    expect(copy.ref).not.toBe("LAU-1");
    expect(copy.assignee).toMatchObject({ type: "member", id: sam.id });
    expect(copy.due).toMatch(/^2026-11-02/);
    expect(copy.fields[field.id]).toBe(1200);
    const detail = (await c.get(`/api/tasks/${copy.id}`)).body;
    expect(detail.subtasks.map((s: { title: string }) => s.title)).toEqual(["Screenshots"]);
    expect(detail.comments).toHaveLength(0);
    expect(JSON.stringify(detail.activity)).toContain("duplicated");
    const subCopy = detail.subtasks[0].id;
    expect((await c.get(`/api/tasks/${subCopy}`)).body.subtasks.map((s: { title: string }) => s.title)).toEqual(["Store copy"]);
    const list = (await c.get(`/api/tasks/${copy.id}/checklist`)).body;
    expect(list.items.map((i: { title: string; done: boolean }) => `${i.title}:${i.done}`)).toEqual(["Tag the build:false", "Tell support:false"]);
    // The original is untouched.
    const orig = (await c.get(`/api/tasks/${taskId}`)).body;
    expect(orig.task.status).toBe("done");
    expect(orig.subtasks).toHaveLength(1);
    // The copy is linked to the original.
    const link = sqlite().prepare("select count(*) n from entity_links where from_id = ? and to_id = ? and relation = 'duplicate_of'").get(copy.id, taskId);
    expect(link.n).toBe(1);
  });

  it("takes options: title, no subtasks, no checklist, no assignee, another project, dependencies", async () => {
    const sam = await teammate();
    const field = (await c.post("/api/fields", { projectId, name: "Budget", type: "number" })).body.field;
    const blocker = (await c.post("/api/tasks", { title: "Legal sign off", projectId })).body.task.id;
    await c.post(`/api/tasks/${taskId}/dependencies`, { blockedBy: blocker });
    await c.patch(`/api/tasks/${taskId}`, { assignee: `member:${sam.id}`, fields: { [field.id]: 5 } });
    await c.post("/api/tasks", { title: "Screenshots", parentId: taskId });
    await c.post(`/api/tasks/${taskId}/checklist`, { title: "Tag the build" });
    const r = (await c.post(`/api/tasks/${taskId}/duplicate`, { title: "Ship the beta, Android", subtasks: false, checklist: false, assignee: false, dependencies: true })).body;
    expect(r.copied).toEqual({ tasks: 1, subtasks: 0, checklistItems: 0, dependencies: 1 });
    expect(r.task).toMatchObject({ title: "Ship the beta, Android", assignee: null });
    const d = (await c.get(`/api/tasks/${r.task.id}`)).body;
    expect(d.blockedBy.map((b: { id: string }) => b.id)).toEqual([blocker]);
    expect(d.subtasks).toHaveLength(0);
    // Another project: new key and number, no custom field values from the old project.
    const ops = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project.id;
    const moved = (await c.post(`/api/tasks/${taskId}/duplicate`, { projectId: ops })).body.task;
    expect(moved.ref).toBe("OPS-1");
    expect(moved.fields).toEqual({});
    // Checks.
    expect((await c.post(`/api/tasks/${taskId}/duplicate`, { title: "  " })).status).toBe(422);
    expect((await c.post(`/api/tasks/${taskId}/duplicate`, { colour: "red" })).status).toBe(422);
  });

  it("adds 50 checklist items at once and copies a long checklist, both under D1's variable limit, and keeps workspaces apart", async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ title: `Step ${i + 1}` }));
    for (let i = 0; i < items.length; i += 50) expect((await c.post(`/api/tasks/${taskId}/checklist`, { items: items.slice(i, i + 50) })).status).toBe(201);
    const r = await c.post(`/api/tasks/${taskId}/duplicate`, {});
    expect(r.status).toBe(201);
    expect(r.body.copied.checklistItems).toBe(150);
    expect((await c.get(`/api/tasks/${r.body.task.id}/checklist`)).body.total).toBe(150);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    expect((await other.post(`/api/tasks/${taskId}/duplicate`, {})).status).toBe(404);
  });

  it("works over REST and MCP; read only keys can't duplicate", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    const r = await api(key, "POST", `/tasks/LAU-1/duplicate`, { title: "Ship the beta again" });
    expect(r.status).toBe(201);
    expect(r.body.task.title).toBe("Ship the beta again");
    expect((await api(key, "POST", `/tasks/LAU-1/duplicate`)).status).toBe(201);
    expect((await api(ro, "POST", `/tasks/LAU-1/duplicate`, {})).status).toBe(403);
    const m = await mcpFor(key);
    const out = data(await m.callTool({ name: "duplicate_task", arguments: { taskId: "LAU-1", checklist: false } }));
    expect(out.task.title).toBe("Ship the beta (copy)");
    expect((await mcpFor(ro).then((x) => x.callTool({ name: "duplicate_task", arguments: { taskId } }))).isError).toBe(true);
  });
});
