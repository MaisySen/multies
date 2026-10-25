import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { WEBHOOK_EVENTS } from "@/server/services/developer/webhooks";
import { CATALOGUE, eventText } from "@/server/services/suite/integrations";
import { epicColumns, epicKey, NO_VALUE } from "@/web/pages/app/work/board";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
async function deliveries() {
  const { webhookDeliveries } = await import("@/server/db/schema");
  return (await ctx.deps.db.select({ t: webhookDeliveries.eventType, p: webhookDeliveries.payload }).from(webhookDeliveries)).map((r) => ({ type: r.t, data: JSON.parse(r.p).data }));
}
async function apiKey() {
  return (await c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}

describe("R22 leftovers: chat messages into Triage", () => {
  it("sends a chat message to Triage instead of making a normal task", async () => {
    const g = await general();
    const msg = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Customer asked for a refund on order 1182" })).body.message;
    const r = await c.post(`/api/chat/messages/${msg.id}/task`, { triage: true });
    expect(r.status).toBe(201);
    expect(r.body.task.triage).toMatchObject({ state: "pending", source: "chat" });
    expect(r.body.task.title).toBe("Customer asked for a refund on order 1182");
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(0);
    const q = (await c.get("/api/triage")).body;
    expect(q.items.map((t: { id: string }) => t.id)).toEqual([r.body.task.id]);
    // The message still shows the item it made.
    const back = (await c.get(`/api/chat/messages/${msg.id}`)).body;
    expect(JSON.stringify(back)).toContain(r.body.task.id);
    // Without the switch, Make task is unchanged.
    const plain = await c.post(`/api/chat/messages/${msg.id}/task`, {});
    expect(plain.body.task.triage).toBeNull();
    expect((await c.get("/api/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([plain.body.task.id]);
  });

  it("works over the public API and MCP, and read only keys can't", async () => {
    const g = await general();
    const msg = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Bug: export button greyed out" })).body.message;
    const key = await apiKey();
    const res = await ctx.app.request(`/api/v1/chat/messages/${msg.id}/task`, { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ triage: true }) });
    expect(res.status).toBe(201);
    expect((await res.json() as { task: { triage: { source: string } } }).task.triage.source).toBe("chat");
    const mcp = await mcpFor(key);
    const out = await mcp.callTool({ name: "message_to_task", arguments: { messageId: msg.id, triage: true } });
    expect(out.isError).toBeFalsy();
    expect((await c.get("/api/triage")).body.count).toBe(2);
    await mcp.close();
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const denied = await ctx.app.request(`/api/v1/chat/messages/${msg.id}/task`, { method: "POST", headers: { authorization: `Bearer ${ro}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ triage: true }) });
    expect(denied.status).toBe(403);
    const roMcp = await mcpFor(ro);
    expect((await roMcp.callTool({ name: "message_to_task", arguments: { messageId: msg.id, triage: true } })).isError).toBe(true);
    await roMcp.close();
    expect((await c.get("/api/triage")).body.count).toBe(2);
  });
});

describe("R22 leftovers: triage webhook events", () => {
  it("lists the four triage events and labels them for chat apps", () => {
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["triage.created", "triage.accepted", "triage.declined", "triage.merged"]));
    expect(CATALOGUE.find((x) => x.id === "slack")!.events).toContain("triage.created");
    expect(eventText({ type: "triage.created", data: { task: { title: "Refund for 1182", ref: "SUP-4" } } })).toContain("New in Triage");
  });

  it("sends triage.created, accepted, declined and merged to subscribed endpoints only", async () => {
    const hook = await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/triage", events: ["triage.created", "triage.accepted", "triage.declined", "triage.merged"] });
    expect(hook.status).toBeLessThan(300);
    const g = await general();
    const mk = async (body: string) => {
      const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body })).body.message;
      return (await c.post(`/api/chat/messages/${m.id}/task`, { triage: true })).body.task.id as string;
    };
    const a = await mk("Accept me"), d = await mk("Decline me"), m = await mk("Merge me");
    const target = (await c.post("/api/tasks", { title: "Existing task" })).body.task;
    expect((await c.post(`/api/triage/${a}/accept`, {})).status).toBe(200);
    expect((await c.post(`/api/triage/${d}/decline`, { reason: "Not ours" })).status).toBe(200);
    expect((await c.post(`/api/triage/${m}/merge`, { targetId: target.id })).status).toBe(200);
    const got = await deliveries();
    expect(got.filter((x) => x.type === "triage.created")).toHaveLength(3);
    expect(got.find((x) => x.type === "triage.created")!.data).toMatchObject({ source: "chat", task: { triage: { state: "pending" } }, actor: { type: "member" } });
    expect(got.find((x) => x.type === "triage.accepted")!.data.task.id).toBe(a);
    expect(got.find((x) => x.type === "triage.declined")!.data).toMatchObject({ id: d, reason: "Not ours", source: "chat", replied: false });
    expect(got.find((x) => x.type === "triage.merged")!.data).toMatchObject({ id: m, into: { id: target.id } });
    // Plain tasks never send triage events, and nothing goes out for events nobody subscribed to.
    await c.post("/api/tasks", { title: "Plain" });
    expect((await deliveries()).filter((x) => x.type.startsWith("triage."))).toHaveLength(6);
    expect((await deliveries()).some((x) => x.type === "task.created")).toBe(false);
  });

  it("costs no writes when no endpoint listens", async () => {
    const g = await general();
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Quiet" })).body.message;
    await c.post(`/api/chat/messages/${m.id}/task`, { triage: true });
    expect(await deliveries()).toHaveLength(0);
  });
});

describe("R22 leftovers: board grouped by epic", () => {
  const t = (id: string, extra: Partial<{ type: "task" | "epic" | "bug" | "story"; parentId: string | null; position: number; title: string }> = {}) =>
    ({ id, title: extra.title ?? id, type: extra.type ?? "task", parentId: extra.parentId ?? null, position: extra.position ?? 0 });

  it("makes one column per epic in board order, then No epic", () => {
    const cols = epicColumns([t("e2", { type: "epic", title: "Onboarding", position: 2 }), t("x"), t("e1", { type: "epic", title: "Checkout", position: 1 })]);
    expect(cols.map((c) => c.name)).toEqual(["Checkout", "Onboarding", "No epic"]);
    expect(cols.at(-1)!.id).toBe(NO_VALUE);
    expect(epicColumns([t("a")]).map((c) => c.name)).toEqual(["No epic"]);
  });

  it("puts a card under its epic, and anything else under No epic", () => {
    const cols = epicColumns([t("e1", { type: "epic" })]);
    expect(epicKey(t("a", { parentId: "e1" }), cols)).toBe("e1");
    expect(epicKey(t("b", { parentId: "some-task" }), cols)).toBe(NO_VALUE);
    expect(epicKey(t("c"), cols)).toBe(NO_VALUE);
  });

  it("moving a card between epic columns uses the epic items API", async () => {
    const project = (await c.post("/api/projects", { name: "App" })).body.project;
    const e1 = (await c.post("/api/tasks", { title: "Checkout", type: "epic", projectId: project.id })).body.task;
    const e2 = (await c.post("/api/tasks", { title: "Onboarding", type: "epic", projectId: project.id })).body.task;
    const card = (await c.post("/api/tasks", { title: "Pay button", projectId: project.id })).body.task;
    expect((await c.post(`/api/epics/${e1.id}/items`, { ids: [card.id] })).status).toBe(200);
    expect((await c.post(`/api/epics/${e2.id}/items`, { ids: [card.id] })).status).toBe(200);
    const list = (await c.get(`/api/tasks?projectId=${project.id}`)).body.tasks as { id: string; parentId: string | null; type: "task" | "story" | "bug" | "epic"; title: string; position: number }[];
    const cols = epicColumns(list);
    expect(epicKey(list.find((x) => x.id === card.id)!, cols)).toBe(e2.id);
    expect((await c.call("DELETE", `/api/epics/${e2.id}/items`, { ids: [card.id] })).status).toBe(200);
    const after = (await c.get(`/api/tasks?projectId=${project.id}`)).body.tasks as { id: string; parentId: string | null }[];
    expect(epicKey(after.find((x) => x.id === card.id)!, cols)).toBe(NO_VALUE);
  });
});
