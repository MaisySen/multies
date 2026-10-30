import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { mockAdapter } from "@/server/services/channels/mock";

/** C1: chat channel tools on MCP (the local test provider stands in for WhatsApp). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let key: string;
let convId: string;

async function connect(k: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
  return client;
}
const call = async (m: McpClient, name: string, args: Record<string, unknown>) => {
  const r = await m.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { error: !!r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

beforeEach(async () => {
  ctx = await makeTestApp({ CHAT_CHANNELS: "on", CHANNELS_MOCK: "on" });
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.put("/api/channels/settings", { enabled: true });
  const channelId = (await owner.post("/api/channels/connect-mock", { name: "Shop WhatsApp" })).body.channel.id;
  await owner.post("/api/channels/mock/inbound", { channelId, from: "61400111222", name: "Priya Shah", text: "Do you deliver on Sundays?" });
  await owner.post("/api/channels/mock/inbound", { channelId, from: "61400333444", name: "Sam Lee", text: "Thanks!" });
  convId = (await owner.get("/api/channels/conversations?q=Priya")).body.data[0].id;
  key = (await owner.post("/api/developer/keys", { name: "Agent" })).body.secret;
});

describe("chat channel MCP tools", () => {
  it("lists and filters chats, reads one with its window", async () => {
    const m = await connect(key);
    const all = await call(m, "list_chat_conversations", {});
    expect(all.data.conversations.map((c: { contactName: string }) => c.contactName).sort()).toEqual(["Priya Shah", "Sam Lee"]);
    expect((await call(m, "list_chat_conversations", { q: "Sunday" })).data.conversations).toHaveLength(1);
    await owner.post(`/api/channels/conversations/${convId}/read`, {});
    expect((await call(m, "list_chat_conversations", { unread: true })).data.conversations.map((c: { contactName: string }) => c.contactName)).toEqual(["Sam Lee"]);
    const one = await call(m, "get_chat_conversation", { conversationId: convId });
    expect(one.data.window.open).toBe(true);
    expect(one.data.messages[0]).toMatchObject({ direction: "in", text: "Do you deliver on Sundays?" });
  });

  it("an agent reply waits as a draft by default; a person approves it with one tap and it is sent once", async () => {
    const m = await connect(key);
    const before = mockAdapter().sent.length;
    const r = await call(m, "reply_chat", { conversationId: convId, text: "Yes, every Sunday until 2 pm." });
    expect(r.data).toMatchObject({ draft: true, message: { delivery: "draft", agent: { name: "Olive Owner" } } });
    expect(mockAdapter().sent.length).toBe(before);
    const detail = (await owner.get(`/api/channels/conversations/${convId}`)).body;
    const draft = detail.messages.find((x: { delivery: string }) => x.delivery === "draft");
    expect(draft.agent).toBeTruthy();
    const ok = await owner.post(`/api/channels/messages/${draft.id}/approve`, {});
    expect(ok.body.message).toMatchObject({ delivery: "sent" });
    expect(mockAdapter().sent.slice(before)).toEqual([expect.objectContaining({ kind: "text", text: "Yes, every Sunday until 2 pm." })]);
    // A second tap does not send again.
    expect((await owner.post(`/api/channels/messages/${draft.id}/approve`, {})).body.message.delivery).toBe("sent");
    expect(mockAdapter().sent.length).toBe(before + 1);
  });

  it("a discarded draft never reaches the customer; an API key cannot approve", async () => {
    const m = await connect(key);
    const r = await call(m, "reply_chat", { conversationId: convId, text: "Draft to drop" });
    const res = await ctx.app.request(`/api/v1/channels/messages/${r.data.message.id}/approve`, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}` } });
    expect(res.status).not.toBe(200);
    expect((await owner.post(`/api/channels/messages/${r.data.message.id}/discard`, {})).body).toEqual({ ok: true });
    const msgs = (await owner.get(`/api/channels/conversations/${convId}`)).body.messages;
    expect(msgs.some((x: { text: string }) => x.text === "Draft to drop")).toBe(false);
  });

  it("with agent auto send on, the reply goes straight out, marked as written by the agent", async () => {
    expect((await owner.put("/api/channels/settings", { agentAutoSend: true })).body.agentAutoSend).toBe(true);
    const m = await connect(key);
    const before = mockAdapter().sent.length;
    const r = await call(m, "reply_chat", { conversationId: convId, text: "On its way." });
    expect(r.data).toMatchObject({ draft: false, message: { delivery: "sent", agent: { id: null } } });
    expect(mockAdapter().sent.length).toBe(before + 1);
  });

  it("refuses a free reply after 24 hours with window_closed and offers templates; a template draft is approved later", async () => {
    await owner.post("/api/channels/mock/age", { conversationId: convId, hours: 25 });
    const m = await connect(key);
    const r = await call(m, "reply_chat", { conversationId: convId, text: "Hello again" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^window_closed:/);
    const t = await call(m, "list_chat_templates", { conversationId: convId });
    expect(t.data.templates.map((x: { name: string }) => x.name)).toContain("order_update");
    const missing = await call(m, "send_chat_template", { conversationId: convId, name: "order_update", language: "en", params: ["Priya"] });
    expect(missing.error).toBe(true);
    const sent = await call(m, "send_chat_template", { conversationId: convId, name: "order_update", language: "en", params: ["Priya", "#1042"] });
    expect(sent.data.message).toMatchObject({ delivery: "draft", kind: "template", text: "Hi Priya, your order #1042 is on its way." });
    const before = mockAdapter().sent.length;
    expect((await owner.post(`/api/channels/messages/${sent.data.message.id}/approve`, {})).body.message.delivery).toBe("sent");
    expect(mockAdapter().sent.slice(before)).toEqual([expect.objectContaining({ kind: "template", text: "order_update:Priya|#1042" })]);
  });

  it("assigns, sets status, labels and adds a note; a read only key cannot change anything", async () => {
    const m = await connect(key);
    const me = (await owner.get("/api/account/me")).body;
    const userId = me.user?.id ?? me.id;
    const u = await call(m, "update_chat_conversation", { conversationId: convId, assigneeUserId: userId, status: "waiting", labels: ["delivery"] });
    expect(u.data.conversation).toMatchObject({ status: "waiting", labels: ["delivery"], assignee: { userId } });
    const n = await call(m, "add_chat_note", { conversationId: convId, text: "Customer asked about Sundays." });
    expect(n.data.note.body).toBe("Customer asked about Sundays.");
    const roKey = (await owner.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    const ro = await connect(roKey);
    const denied = await call(ro, "reply_chat", { conversationId: convId, text: "x" });
    expect(denied.error).toBe(true);
    expect((await call(ro, "list_chat_conversations", {})).error).toBe(false);
  });
});
