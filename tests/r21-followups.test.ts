import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** Round 21 follow-ups after the merge: bulk type, MCP estimates and sprints, saved Sprints views, epic points. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId = "";

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  projectId = (await c.post("/api/projects", { name: "Launch" })).body.project.id;
});
const task = async (title: string, extra: Record<string, unknown> = {}) => (await c.post("/api/tasks", { title, projectId, ...extra })).body.task as { id: string; ref: string; type: string; points: number | null; sprintId: string | null };
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe("bulk type", () => {
  it("sets story or bug on many tasks in one call, and leaves epics to be changed one at a time", async () => {
    const a = await task("A"), b = await task("B");
    const r = await c.post("/api/tasks/bulk", { ids: [a.id, b.ref], patch: { type: "bug" } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    expect((await c.get(`/api/tasks/${a.id}`)).body.task.type).toBe("bug");
    // Setting the same type again writes nothing.
    expect((await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { type: "bug" } })).body).toMatchObject({ updated: 0, unchanged: 2 });
    const epic = await task("Epic", { type: "epic" });
    const refused = await c.post("/api/tasks/bulk", { ids: [a.id, epic.id], patch: { type: "story" } });
    expect(refused.status).toBe(422);
    expect((await c.get(`/api/tasks/${a.id}`)).body.task.type).toBe("bug");
    expect((await c.post("/api/tasks/bulk", { ids: [a.id], patch: { type: "epic" } })).status).toBe(422);
  });

  it("works through REST and MCP with a write key and is refused for a read only key", async () => {
    const a = await task("A");
    const full = (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const rest = await ctx.app.request("/api/v1/tasks/bulk", { method: "POST", headers: { authorization: `Bearer ${full}`, "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ ids: [a.id], patch: { type: "story" } }) });
    expect(rest.status).toBe(200);
    const mcp = await mcpFor(full);
    expect(data(await mcp.callTool({ name: "bulk_update_tasks", arguments: { ids: [a.id], type: "bug" } })).updated).toBe(1);
    const reader = await mcpFor(ro);
    expect((await reader.callTool({ name: "bulk_update_tasks", arguments: { ids: [a.id], type: "task" } })).isError).toBe(true);
  });
});

describe("MCP tasks carry estimates and sprints", () => {
  it("create_task and update_task take points and sprintId; null moves back to the backlog", async () => {
    const sprint = (await c.post("/api/sprints", { projectId })).body.sprint as { id: string };
    const key = (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
    const mcp = await mcpFor(key);
    const made = data(await mcp.callTool({ name: "create_task", arguments: { title: "Agent task", projectId, points: 3, sprintId: sprint.id, type: "story" } })).task;
    expect(made).toMatchObject({ points: 3, sprintId: sprint.id, type: "story" });
    const moved = data(await mcp.callTool({ name: "update_task", arguments: { id: made.id, points: 5, sprintId: null } })).task;
    expect(moved).toMatchObject({ points: 5, sprintId: null });
    const bad = await mcp.callTool({ name: "update_task", arguments: { id: made.id, sprintId: "spr_nope" } });
    expect(bad.isError).toBe(true);
  });
});

describe("saved views and epics with estimates", () => {
  it("saves a view on the Sprints board", async () => {
    const r = await c.post("/api/tasks/views", { projectId, name: "This sprint", view: "sprints", filters: {} });
    expect(r.status).toBe(201);
    expect(r.body.view.view).toBe("sprints");
  });

  it("weights epic progress by estimates once tasks carry points", async () => {
    const epic = await task("Launch epic", { type: "epic" });
    const big = await task("Big", { points: 8 });
    const small = await task("Small", { points: 2 });
    expect((await c.post(`/api/epics/${epic.id}/items`, { ids: [big.id, small.id] })).status).toBeLessThan(300);
    await c.patch(`/api/tasks/${small.id}`, { status: "done" });
    const got = (await c.get(`/api/epics/${epic.id}`)).body;
    const p = got.progress ?? got.epic?.progress;
    expect(p).toMatchObject({ done: 1, total: 2, percent: 50 });
    // By count it is half done; by estimate only 2 of 10 points are done.
    expect(p.points).toEqual({ done: 2, total: 10, percent: 20 });
  });
});
