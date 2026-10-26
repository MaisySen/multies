import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** R26 (MB-85): checklists inside tasks, in the app, REST and MCP, with permissions following the task. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let taskId: string;
let wsKey: string;

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

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  taskId = (await c.post("/api/tasks", { title: "Ship the beta", projectId })).body.task.id;
  wsKey = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret;
});

describe("checklists in the app", () => {
  it("adds, ticks, renames, reorders, deletes and counts on the task", async () => {
    const add = await c.post(`/api/tasks/${taskId}/checklist`, { items: [{ title: "Write release notes" }, { title: "Tag the build" }, { title: "Tell support" }] });
    expect(add.status).toBe(201);
    const [a, b, d] = add.body.items as { id: string; position: number }[];
    expect(add.body.items.map((i: { position: number }) => i.position)).toEqual([1, 2, 3]);
    expect((await c.patch(`/api/checklist-items/${a.id}`, { done: true })).body.item.done).toBe(true);
    expect((await c.patch(`/api/checklist-items/${b.id}`, { title: "Tag the release build" })).body.item.title).toBe("Tag the release build");
    const list = (await c.get(`/api/tasks/${taskId}/checklist`)).body;
    expect(list).toMatchObject({ total: 3, done: 1 });
    const re = (await c.post(`/api/tasks/${taskId}/checklist/reorder`, { ids: [d.id, a.id, b.id] })).body;
    expect(re.items.map((i: { id: string }) => i.id)).toEqual([d.id, a.id, b.id]);
    expect((await c.post(`/api/tasks/${taskId}/checklist/reorder`, { ids: [d.id, a.id] })).status).toBe(422);
    // Cards and lists carry the counts for the "1/3" chip.
    const tasks = (await c.get("/api/tasks")).body.tasks as { id: string; checklist: { total: number; done: number } }[];
    expect(tasks.find((t) => t.id === taskId)!.checklist).toEqual({ total: 3, done: 1 });
    expect((await c.del(`/api/checklist-items/${d.id}`)).status).toBe(200);
    expect((await c.get(`/api/tasks/${taskId}/checklist`)).body.total).toBe(2);
    expect((await c.post(`/api/tasks/${taskId}/checklist`, { title: "  " })).status).toBe(422);
  });

  it("turns an item into a subtask and removes the item", async () => {
    const item = (await c.post(`/api/tasks/${taskId}/checklist`, { title: "Draft the FAQ", due: "2026-11-02" })).body.items[0];
    const r = await c.post(`/api/checklist-items/${item.id}/to-subtask`);
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ title: "Draft the FAQ", parentId: taskId });
    expect(r.body.task.due).toMatch(/^2026-11-02/);
    expect((await c.get(`/api/tasks/${taskId}/checklist`)).body.total).toBe(0);
    expect((await c.get(`/api/tasks/${taskId}`)).body.subtasks.length).toBe(1);
  });

  it("carries the checklist into a task template and back out, unticked", async () => {
    await c.post(`/api/tasks/${taskId}/checklist`, { items: [{ title: "Book the room", done: true }, { title: "Send the agenda" }] });
    const tpl = await c.post("/api/templates", { kind: "task", fromTaskId: taskId, name: "Launch task" });
    expect(tpl.status).toBe(201);
    const projectId = (await c.get(`/api/tasks/${taskId}`)).body.task.projectId;
    const used = await c.post(`/api/templates/${tpl.body.template.id}/use`, { projectId });
    expect(used.status).toBeLessThan(300);
    const copy = (await c.get(`/api/tasks/${used.body.task.id}/checklist`)).body;
    expect(copy.items.map((i: { title: string; done: boolean }) => `${i.title}:${i.done}`)).toEqual(["Book the room:false", "Send the agenda:false"]);
  });

  it("refuses another workspace's task and items, and hides items of a deleted task", async () => {
    const item = (await c.post(`/api/tasks/${taskId}/checklist`, { title: "Private step" })).body.items[0];
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    expect((await other.get(`/api/tasks/${taskId}/checklist`)).status).toBe(404);
    expect((await other.post(`/api/tasks/${taskId}/checklist`, { title: "x" })).status).toBe(404);
    expect((await other.patch(`/api/checklist-items/${item.id}`, { done: true })).status).toBe(404);
    expect((await other.del(`/api/checklist-items/${item.id}`)).status).toBe(404);
    expect((await other.post(`/api/checklist-items/${item.id}/to-subtask`)).status).toBe(404);
    const otherKey = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    expect((await api(otherKey, "GET", `/tasks/${taskId}/checklist`)).status).toBe(404);
    expect((await api(otherKey, "PATCH", `/checklist-items/${item.id}`, { done: true })).status).toBe(404);
    expect((await c.get(`/api/tasks/${taskId}/checklist`)).body.items[0].done).toBe(false);
    await c.del(`/api/tasks/${taskId}`);
    expect((await c.patch(`/api/checklist-items/${item.id}`, { done: true })).status).toBe(404);
  });

  it("lets a guest read their own project's checklists only", async () => {
    const projectId = (await c.get(`/api/tasks/${taskId}`)).body.task.projectId;
    await c.post(`/api/tasks/${taskId}/checklist`, { title: "Client signs off" });
    const otherProject = (await c.post("/api/projects", { name: "Internal", key: "INT" })).body.project.id;
    const hidden = (await c.post("/api/tasks", { title: "Salary review", projectId: otherProject })).body.task.id;
    await c.post(`/api/tasks/${hidden}/checklist`, { title: "Secret step" });
    const inv = await c.post("/api/guests", { projectId, email: "guest@client.io", name: "Gus" });
    expect(inv.status).toBe(201);
    const g = new Client(ctx.app);
    const token = (inv.body.inviteUrl as string).split("/g/")[1];
    expect(token).toBeTruthy();
    expect((await g.post("/api/guest/accept", { token })).status).toBe(200);
    const mine = await g.get(`/api/guest/r26/tasks/${taskId}/checklist`);
    expect(mine.status).toBe(200);
    expect(mine.body.items[0].title).toBe("Client signs off");
    expect((await g.get(`/api/guest/r26/tasks/${hidden}/checklist`)).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/guest/r26/tasks/${taskId}/checklist`)).status).toBe(401);
  });
});

describe("checklists over REST and MCP", () => {
  it("read only keys list but can't write; a full key writes", async () => {
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const add = await api(wsKey, "POST", `/tasks/${taskId}/checklist`, { title: "From the API" });
    expect(add.status).toBe(201);
    const id = add.body.items[0].id;
    expect((await api(ro, "GET", `/tasks/${taskId}/checklist`)).body.total).toBe(1);
    expect((await api(ro, "POST", `/tasks/${taskId}/checklist`, { title: "nope" })).status).toBe(403);
    expect((await api(ro, "PATCH", `/checklist-items/${id}`, { done: true })).status).toBe(403);
    expect((await api(ro, "DELETE", `/checklist-items/${id}`)).status).toBe(403);
    const sub = await api(wsKey, "POST", `/checklist-items/${id}/to-subtask`);
    expect(sub.status).toBe(201);
  });

  it("MCP tools tick through a checklist and refuse writes on a read only key", async () => {
    const mcp = await mcpFor(wsKey);
    const added = data(await mcp.callTool({ name: "add_checklist_items", arguments: { taskId: "LAU-1", items: [{ title: "One" }, { title: "Two" }] } }));
    expect(added.items.length).toBe(2);
    data(await mcp.callTool({ name: "update_checklist_item", arguments: { itemId: added.items[0].id, done: true } }));
    const list = data(await mcp.callTool({ name: "list_checklist", arguments: { taskId } }));
    expect(list).toMatchObject({ total: 2, done: 1 });
    const re = data(await mcp.callTool({ name: "reorder_checklist", arguments: { taskId, ids: [added.items[1].id, added.items[0].id] } }));
    expect(re.items[0].title).toBe("Two");
    const sub = data(await mcp.callTool({ name: "checklist_item_to_subtask", arguments: { itemId: added.items[1].id } }));
    expect(sub.task.title).toBe("Two");
    data(await mcp.callTool({ name: "delete_checklist_item", arguments: { itemId: added.items[0].id } }));
    expect(data(await mcp.callTool({ name: "list_checklist", arguments: { taskId } })).total).toBe(0);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const rmcp = await mcpFor(ro);
    const denied = await rmcp.callTool({ name: "add_checklist_items", arguments: { taskId, items: [{ title: "x" }] } });
    expect(denied.isError).toBe(true);
  });
});
