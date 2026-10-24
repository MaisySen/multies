import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { eventText, mapFields } from "@/server/services/suite/integrations";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let sent: { url: string; body: string; headers: Record<string, string> }[] = [];

async function setup(env: Record<string, string> = {}) {
  sent = [];
  const fetchMock = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? ""), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  ctx = await makeTestApp(env, { fetch: fetchMock });
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function hookPost(token: string, body: string, contentType = "application/json", extra: Record<string, string> = {}) {
  const res = await ctx.app.request(`/api/hooks/in/${token}`, { method: "POST", headers: { "content-type": contentType, host: "localhost", ...extra }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const tokenOf = (url: string) => url.split("/api/hooks/in/")[1];

describe("integration helpers", () => {
  it("writes a chat line for an event and maps hook fields", () => {
    expect(eventText({ type: "task.created", data: { task: { ref: "OPS-4", title: "Ship it" }, actor: { name: "Sam" } } })).toBe("Multies: New task: OPS-4 Ship it (by Sam)");
    expect(eventText({ type: "webhook.test" })).toContain("connected");
    expect(mapFields("task", { subject: "Hello", description: "Body", deadline: "2026-11-01" })).toEqual({ title: "Hello", notes: "Body", due: "2026-11-01" });
    expect(mapFields("task", { data: { name: "Deep" } }, { title: "data.name" })).toEqual({ title: "Deep" });
    expect(mapFields("contact", { email_address: "a@b.co", first_name: "Ann", last_name: "Lee" })).toEqual({ email: "a@b.co", name: "Ann Lee" });
  });
});

describe("outgoing connectors", () => {
  beforeEach(() => setup());

  it("lists the catalogue, connects Slack with a message body, tests, pauses and deletes", async () => {
    const list = await c.get("/api/connectors");
    expect(list.status).toBe(200);
    expect(list.body.catalogue.map((x: { id: string }) => x.id)).toEqual(["slack", "discord", "teams", "zapier", "make", "n8n", "sheets", "custom"]);
    const r = await c.post("/api/connectors", { connector: "slack", url: "https://hooks.slack.com/services/T0/B0/xyz", events: ["task.created"] });
    expect(r.status).toBe(201);
    expect(r.body.connection.format).toBe("slack");
    expect(r.body.secret).toBeUndefined();
    const id = r.body.connection.id;
    const t = await c.post(`/api/connectors/${id}/test`);
    expect(t.body.delivery.status).toBe("delivered");
    expect(JSON.parse(sent[0].body)).toEqual({ text: expect.stringContaining("connected") });
    await c.post("/api/tasks", { title: "Call Jo" });
    const last = JSON.parse(sent[sent.length - 1].body);
    expect(last.text).toContain("New task");
    expect(last.text).toContain("Call Jo");
    expect((await c.patch(`/api/connectors/${id}`, { enabled: false })).body.connection.enabled).toBe(false);
    expect((await c.del(`/api/connectors/${id}`)).status).toBe(200);
    expect((await c.get("/api/connectors")).body.connections).toEqual([]);
  });

  it("sends Discord content, and our signed JSON to Zapier with a secret", async () => {
    await c.post("/api/connectors", { connector: "discord", url: "https://discord.com/api/webhooks/1/abc", events: ["task.created"] });
    const z = await c.post("/api/connectors", { connector: "zapier", url: "https://hooks.zapier.com/hooks/catch/1/abc/", events: ["task.created"] });
    expect(z.body.secret).toMatch(/^whsec_/);
    await c.post("/api/tasks", { title: "Quote for Kim" });
    const discord = sent.find((s) => s.url.includes("discord.com"))!;
    expect(JSON.parse(discord.body).content).toContain("Quote for Kim");
    const zap = sent.find((s) => s.url.includes("zapier.com"))!;
    expect(JSON.parse(zap.body).type).toBe("task.created");
    expect(zap.headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("refuses an unknown connector, a private address and members", async () => {
    expect((await c.post("/api/connectors", { connector: "nope", url: "https://example.com/x" })).status).toBe(422);
    const invite = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("mate@acme.io", "Sam Mate", "");
    await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    expect((await m.post("/api/connectors", { connector: "slack", url: "https://hooks.slack.com/services/a" })).status).toBe(403);
    expect((await m.get("/api/connectors")).status).toBe(200);
  });
});

describe("incoming webhooks", () => {
  beforeEach(() => setup());

  it("turns JSON and form posts into tasks, records calls, and revokes", async () => {
    const r = await c.post("/api/incoming-hooks", { name: "Website", action: "task" });
    expect(r.status).toBe(201);
    const token = tokenOf(r.body.url);
    expect(token).toMatch(/^mih_/);
    expect(JSON.stringify((await c.get("/api/incoming-hooks")).body)).not.toContain(token);

    const ok = await hookPost(token, JSON.stringify({ subject: "Quote request", message: "Two rooms", due: "2026-11-02", assignee: "owner@acme.io", budget: 900 }));
    expect(ok.status).toBe(201);
    expect(ok.body.result.type).toBe("task");
    const task = (await c.get(`/api/tasks/${ok.body.result.id}`)).body.task;
    expect(task.title).toBe("Quote request");
    expect(task.notes ?? task.description).toContain("Two rooms");
    expect(task.assignee?.id).toBeTruthy();

    const form = await hookPost(token, "title=From+a+form&extra=1", "application/x-www-form-urlencoded");
    expect(form.status).toBe(201);
    const bad = await hookPost(token, JSON.stringify({ nothing: "here" }));
    expect(bad.status).toBe(422);
    expect((await hookPost(token, "x".repeat(70_000), "text/plain")).status).toBe(413);

    const hook = (await c.get(`/api/incoming-hooks/${r.body.hook.id}`)).body.hook;
    expect(hook.callCount).toBe(3);
    expect(hook.recent.map((x: { status: number }) => x.status)).toEqual([422, 201, 201]);

    expect((await hookPost("mih_doesnotexist0000000000", "{}")).status).toBe(404);
    await c.patch(`/api/incoming-hooks/${r.body.hook.id}`, { enabled: false });
    expect((await hookPost(token, JSON.stringify({ title: "x" }))).status).toBe(404);
    await c.del(`/api/incoming-hooks/${r.body.hook.id}`);
    expect((await c.get("/api/incoming-hooks")).body.hooks).toEqual([]);
  });

  it("posts chat messages and creates contacts, and emits incoming_hook.received", async () => {
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    expect((await c.post("/api/incoming-hooks", { name: "No channel", action: "chat" })).status).toBe(422);
    await c.post("/api/connectors", { connector: "custom", url: "https://receiver.example.com/in", events: ["incoming_hook.received"] });
    const chat = await c.post("/api/incoming-hooks", { name: "Deploys", action: "chat", config: { channelId: general.id } });
    const res = await hookPost(tokenOf(chat.body.url), JSON.stringify({ text: "Deploy finished" }));
    expect(res.status).toBe(201);
    const msgs = (await c.get(`/api/chat/channels/${general.id}/messages`)).body.messages as { body: string }[];
    expect(msgs.some((m) => m.body === "Deploy finished")).toBe(true);
    expect(sent.some((s) => JSON.parse(s.body).type === "incoming_hook.received")).toBe(true);

    const contact = await c.post("/api/incoming-hooks", { name: "Leads", action: "contact" });
    const lead = await hookPost(tokenOf(contact.body.url), JSON.stringify({ email: "Lead@Example.com", first_name: "Lea", last_name: "Ng" }));
    expect(lead.status).toBe(201);
    expect(lead.body.result.type).toBe("contact");
  });

  it("works over REST and MCP with an API key", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Zap" })).body.secret;
    expect((await api("mm_bad", "GET", "/integrations/catalogue")).status).toBe(401);
    const cat = await api(key, "GET", "/integrations/catalogue");
    expect(cat.status).toBe(200);
    expect(cat.body.catalogue).toHaveLength(8);
    const made = await api(key, "POST", "/incoming-hooks", { name: "Script", action: "task" });
    expect(made.status).toBe(201);
    expect((await api(key, "GET", "/incoming-hooks")).body.hooks).toHaveLength(1);
    expect((await api(key, "PATCH", `/incoming-hooks/${made.body.hook.id}`, { name: "Renamed" })).body.hook.name).toBe("Renamed");
    expect((await api(key, "POST", "/integrations", { connector: "n8n", url: "https://n8n.example.com/webhook/1" })).status).toBe(201);
    expect((await api(key, "DELETE", `/incoming-hooks/${made.body.hook.id}`)).status).toBe(200);

    const mcp = await mcpFor(key);
    const created = data(await mcp.callTool({ name: "create_incoming_hook", arguments: { name: "From MCP", action: "task" } }));
    expect(created.url).toContain("/api/hooks/in/mih_");
    const listed = data(await mcp.callTool({ name: "list_integrations", arguments: {} }));
    expect(listed.connections).toHaveLength(1);
    expect(listed.incomingHooks).toHaveLength(1);
    await mcp.close();
  });
});
