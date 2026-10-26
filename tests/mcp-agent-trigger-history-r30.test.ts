import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/** R30: agent_trigger_history over MCP returns the rows GET /api/v1/agent-triggers/{id}/history returns, with its rules. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let wsKey: string;
let builder: { id: string; key: string };

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const errorText = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id;
  const made = (await c.post("/api/team/agents", { name: "Builder" })).body;
  builder = { id: made.member.userId, key: made.secret };
  wsKey = (await c.post("/api/developer/keys", { name: "ops" })).body.secret;
});

/** A webhook trigger on the project, fired by hand `fires` times (each makes a new task and a queued run). */
async function firedTrigger(fires: number) {
  const id = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "webhook", name: "Deploy failed", projectId, titleTemplate: "Deploy {datetime}" })).body.trigger.id as string;
  for (let i = 0; i < fires; i++) {
    const r = await c.post(`/api/agent-triggers/${id}/run`, {});
    // The agent's queue holds 3; finish each queued run so the next fire is a fire, not a refusal.
    if (r.body.fired?.id) await c.post(`/api/agent-runs/${r.body.fired.id}/cancel`);
  }
  return id;
}

describe("MCP agent_trigger_history (R30)", () => {
  it("is listed for workspace keys and returns the same rows as the v1 route", async () => {
    const id = await firedTrigger(2);
    // A refusal too: a paused agent is refused when fired.
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    await c.post(`/api/agent-triggers/${id}/run`, {});
    const mcp = await mcpFor(wsKey);
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("agent_trigger_history");
    const got = data(await mcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id } }));
    const rest = (await v1(wsKey, "GET", `/agent-triggers/${id}/history`)).body;
    expect(got.triggerId).toBe(id);
    expect(got.entries.length).toBeGreaterThanOrEqual(3);
    expect(got.entries).toEqual(rest.entries);
    expect(got.limit).toBe(20);
    const fired = got.entries.find((e: { outcome: string }) => e.outcome === "fired");
    expect(fired).toMatchObject({ source: "manual", run: { id: expect.any(String), taskRef: expect.stringMatching(/^MB-/) } });
    expect(got.entries[0].outcome).toBe("refused");
    await mcp.close();
  });

  it("bounds limit to 1 to 50 and applies it", async () => {
    const id = await firedTrigger(3);
    const mcp = await mcpFor(wsKey);
    const one = data(await mcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id, limit: 1 } }));
    expect(one.entries).toHaveLength(1);
    expect(one.limit).toBe(1);
    expect((await mcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id, limit: 0 } })).isError).toBe(true);
    expect((await mcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id, limit: 51 } })).isError).toBe(true);
    expect(data(await mcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id, limit: 50 } })).limit).toBe(50);
    await mcp.close();
  });

  it("refuses another workspace's trigger and agent keys, like the route", async () => {
    const id = await firedTrigger(1);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    const evilKey = (await other.post("/api/developer/keys", { name: "x" })).body.secret;
    const evil = await mcpFor(evilKey);
    const refused = await evil.callTool({ name: "agent_trigger_history", arguments: { triggerId: id } });
    expect(refused.isError).toBe(true);
    expect(errorText(refused)).toMatch(/not.?found/i);
    expect((await v1(evilKey, "GET", `/agent-triggers/${id}/history`)).status).toBe(404);
    await evil.close();
    const agentMcp = await mcpFor(builder.key);
    expect((await agentMcp.callTool({ name: "agent_trigger_history", arguments: { triggerId: id } })).isError).toBe(true);
    await agentMcp.close();
  });
});
