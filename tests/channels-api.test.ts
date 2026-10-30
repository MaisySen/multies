import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { mockAdapter, mockInboundPayload } from "@/server/services/channels/mock";
import { hmacSha256Hex } from "@/server/lib/crypto";
import { msgChannels, msgMessages } from "@/server/db/schema";
import { eq } from "drizzle-orm";

/** C1: chat channels through the API, on the local test provider (and the Meta webhook route with its signature). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;

async function setup(env: Record<string, string> = { CHANNELS_MOCK: "on" }) {
  ctx = await makeTestApp(env);
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
}
async function connectAndEnable() {
  expect((await owner.put("/api/channels/settings", { enabled: true })).status).toBe(200);
  const r = await owner.post("/api/channels/connect-mock", { name: "Shop WhatsApp" });
  expect(r.status).toBe(201);
  return r.body.channel.id as string;
}
async function customerWrites(channelId: string, text: string, from = "61400111222") {
  const r = await owner.post("/api/channels/mock/inbound", { channelId, from, name: "Priya Shah", text });
  expect(r.status).toBe(200);
}

describe("channels: server without Meta config", () => {
  beforeEach(() => setup({}));
  it("says Coming soon and refuses to switch on", async () => {
    const s = await owner.get("/api/channels/status");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ available: false, mock: false, enabled: false, embeddedSignup: null, channels: [] });
    expect((await owner.put("/api/channels/settings", { enabled: true })).status).toBe(409);
    expect((await owner.post("/api/channels/connect-mock", {})).status).toBe(404);
    expect((await owner.get("/api/channels/conversations")).status).toBe(404);
  });
  it("the webhook refuses every delivery and the handshake", async () => {
    const res = await ctx.app.request("/api/webhooks/meta", { method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: "{}" });
    expect(res.status).toBe(401);
    expect((await ctx.app.request("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123", { headers: { host: "localhost" } })).status).toBe(403);
  });
});

describe("channels: Meta app configured", () => {
  const META = { META_APP_ID: "1234", META_APP_SECRET: "app-secret-for-tests", META_VERIFY_TOKEN: "verify-me", META_ES_CONFIG_ID: "5678" };
  beforeEach(() => setup(META));
  it("status hands the Embedded Signup values (never the secret)", async () => {
    const s = await owner.get("/api/channels/status");
    expect(s.body.available).toBe(true);
    expect(s.body.embeddedSignup).toEqual({ appId: "1234", configId: "5678", graphVersion: "v24.0" });
    expect(JSON.stringify(s.body)).not.toContain("app-secret-for-tests");
  });
  it("answers the subscribe handshake only with the right token", async () => {
    const ok = await ctx.app.request("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444", { headers: { host: "localhost" } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    const bad = await ctx.app.request("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1158201444", { headers: { host: "localhost" } });
    expect(bad.status).toBe(403);
  });
  it("checks X-Hub-Signature-256 against the app secret and answers 200 fast", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const good = `sha256=${await hmacSha256Hex("app-secret-for-tests", body)}`;
    const post = (sig?: string) => ctx.app.request("/api/webhooks/meta", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) }, body });
    expect((await post(good)).status).toBe(200);
    expect((await post()).status).toBe(401);
    expect((await post(`sha256=${await hmacSha256Hex("wrong", body)}`)).status).toBe(401);
    // The local test secret is never accepted when the test provider is off.
    const mock = await mockInboundPayload({ endpointId: "1", from: "61400111222", text: "hi" });
    const r = await ctx.app.request("/api/webhooks/meta", { method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-hub-signature-256": mock.signature }, body: mock.body });
    expect(r.status).toBe(401);
  });
});

describe("channels: the inbox on the test provider", () => {
  beforeEach(() => setup());

  it("is off until an admin switches it on; members cannot connect", async () => {
    const s = await owner.get("/api/channels/status");
    expect(s.body).toMatchObject({ available: true, mock: true, enabled: false, canManage: true });
    expect((await owner.get("/api/channels/conversations")).status).toBe(404);
    const inv = await owner.post("/api/team/invites", { email: "mia@acme.io", role: "member" });
    const mia = new Client(ctx.app);
    await mia.signup("mia@acme.io", "Mia Member");
    expect((await mia.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await mia.put("/api/channels/settings", { enabled: true })).status).toBe(403);
    expect((await mia.post("/api/channels/connect-mock", {})).status).toBe(403);
    expect((await mia.get("/api/channels/status")).body.canManage).toBe(false);
  });

  it("receives, assigns, replies once per key, closes the window, sends a template, notes and makes a task", async () => {
    const channelId = await connectAndEnable();
    // The token is stored encrypted, never in plain text.
    const row = await ctx.db.select().from(msgChannels).where(eq(msgChannels.id, channelId)).get();
    expect(row!.tokenEnc).toMatch(/^v1:/);
    expect(row!.tokenEnc).not.toContain("mock_");

    await customerWrites(channelId, "Hi, is the blue jacket in stock?");
    await customerWrites(channelId, "Size M please");
    const list = await owner.get("/api/channels/conversations");
    expect(list.body.data).toHaveLength(1);
    const conv = list.body.data[0];
    expect(conv).toMatchObject({ contactName: "Priya Shah", contactHandle: "61400111222", unreadCount: 2, status: "open", provider: "mock", snippet: "Size M please" });

    expect((await owner.get("/api/channels/conversations?q=jacket")).body.data).toHaveLength(1);
    expect((await owner.get("/api/channels/conversations?q=umbrella")).body.data).toHaveLength(0);

    const me = (await owner.get("/api/account/me")).body;
    const userId = me.user?.id ?? me.id;
    const p = await owner.patch(`/api/channels/conversations/${conv.id}`, { assigneeUserId: userId, labels: ["sales", "sales", " vip "] });
    expect(p.status).toBe(200);
    expect(p.body.conversation.assignee.name).toBe("Olive Owner");
    expect(p.body.conversation.labels).toEqual(["sales", "vip"]);
    expect((await owner.get("/api/channels/conversations?assignee=me")).body.data).toHaveLength(1);
    expect((await owner.get("/api/channels/conversations?assignee=none")).body.data).toHaveLength(0);

    const before = mockAdapter().sent.length;
    const key = { "idempotency-key": `reply-${conv.id}-1` };
    const send1 = await owner.call("POST", `/api/channels/conversations/${conv.id}/messages`, { text: "Yes, we have size M." }, key);
    expect(send1.status).toBe(201);
    expect(send1.body.message).toMatchObject({ direction: "out", delivery: "sent", text: "Yes, we have size M." });
    const send2 = await owner.call("POST", `/api/channels/conversations/${conv.id}/messages`, { text: "Yes, we have size M." }, key);
    expect(send2.body.message.id).toBe(send1.body.message.id);
    expect(mockAdapter().sent.length).toBe(before + 1);

    const detail = await owner.get(`/api/channels/conversations/${conv.id}`);
    expect(detail.body.messages.map((m: { direction: string }) => m.direction)).toEqual(["in", "in", "out"]);
    expect(detail.body.window.open).toBe(true);

    // A status from Meta moves the message forward, never back.
    const out = await ctx.db.select().from(msgMessages).where(eq(msgMessages.id, send1.body.message.id)).get();
    const statusBody = (st: string) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "0", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: row!.externalId }, statuses: [{ id: out!.externalId, status: st, timestamp: "1730000000", recipient_id: "61400111222" }] } }] }] });
    const { handleWebhookPost } = await import("@/server/services/channels/receive");
    const { MOCK_APP_SECRET } = await import("@/server/services/channels/webhook");
    for (const st of ["read", "delivered"]) {
      const b = statusBody(st);
      const r = await handleWebhookPost(ctx.deps, b, `sha256=${await hmacSha256Hex(MOCK_APP_SECRET, b)}`);
      await r.work;
    }
    expect((await ctx.db.select().from(msgMessages).where(eq(msgMessages.id, out!.id)).get())!.delivery).toBe("read");

    // 25 hours later the window is closed: free text is refused in plain words, templates are offered.
    expect((await owner.post("/api/channels/mock/age", { conversationId: conv.id, hours: 25 })).status).toBe(200);
    const closed = await owner.post(`/api/channels/conversations/${conv.id}/messages`, { text: "Still there?" });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("window_closed");
    expect((await owner.get(`/api/channels/conversations/${conv.id}`)).body.window.open).toBe(false);
    const tpl = await owner.get(`/api/channels/conversations/${conv.id}/templates`);
    expect(tpl.body.templates).toHaveLength(2);
    expect((await owner.post(`/api/channels/conversations/${conv.id}/template`, { name: "follow_up", language: "en", params: [] })).status).toBe(422);
    const sentTpl = await owner.call("POST", `/api/channels/conversations/${conv.id}/template`, { name: "follow_up", language: "en", params: ["Priya"] }, { "idempotency-key": `tpl-${conv.id}-1` });
    expect(sentTpl.status).toBe(201);
    expect(sentTpl.body.message).toMatchObject({ kind: "template", templateName: "follow_up", text: "Hi Priya, just checking in. Reply here any time." });

    const n = await owner.post(`/api/channels/conversations/${conv.id}/notes`, { body: "VIP, offer free shipping" });
    expect(n.status).toBe(201);
    expect((await owner.get(`/api/channels/conversations/${conv.id}/notes`)).body.notes[0]).toMatchObject({ body: "VIP, offer free shipping", author: { name: "Olive Owner" } });

    const firstIn = detail.body.messages[0].id;
    const t = await owner.post(`/api/channels/messages/${firstIn}/task`, {});
    expect(t.status).toBe(201);
    expect(t.body.task.title).toBe("Follow up with Priya Shah");
    const linked = await owner.get(`/api/tasks?threadId=${conv.id}`);
    expect(linked.body.tasks.map((x: { id: string }) => x.id)).toContain(t.body.task.id);

    expect((await owner.post(`/api/channels/conversations/${conv.id}/read`, {})).status).toBe(200);
    expect((await owner.get("/api/channels/conversations")).body.data[0].unreadCount).toBe(0);
  });

  it("dedupes Meta's resends by message id and reopens a done conversation", async () => {
    const channelId = await connectAndEnable();
    const row = await ctx.db.select().from(msgChannels).where(eq(msgChannels.id, channelId)).get();
    const { handleWebhookPost } = await import("@/server/services/channels/receive");
    const p = await mockInboundPayload({ endpointId: row!.externalId, from: "61400999888", text: "Hello", id: "wamid.SAME" });
    for (let i = 0; i < 3; i++) await (await handleWebhookPost(ctx.deps, p.body, p.signature)).work;
    const list = (await owner.get("/api/channels/conversations")).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].unreadCount).toBe(1);
    await owner.patch(`/api/channels/conversations/${list[0].id}`, { status: "done" });
    await customerWrites(channelId, "One more thing", "61400999888");
    expect((await owner.get("/api/channels/conversations")).body.data[0].status).toBe("open");
  });

  it("stores an inbound photo at once and serves it to the team only", async () => {
    const channelId = await connectAndEnable();
    expect((await owner.post("/api/channels/mock/inbound", { channelId, from: "61400777666", text: "Like this one", image: true })).status).toBe(200);
    const conv = (await owner.get("/api/channels/conversations")).body.data[0];
    const d = await owner.get(`/api/channels/conversations/${conv.id}`);
    const m = d.body.messages[0];
    expect(m.kind).toBe("image");
    expect(m.media).toMatchObject({ contentType: "image/png" });
    const res = await ctx.app.request(m.media.url, { headers: { host: "localhost", cookie: owner.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await ctx.app.request(m.media.url, { headers: { host: "localhost" } })).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve", "Else");
    expect((await ctx.app.request(m.media.url, { headers: { host: "localhost", cookie: other.cookie } })).status).toBe(404);
  });

  it("a failed send is stored as failed with plain words; disconnect keeps history", async () => {
    const channelId = await connectAndEnable();
    await customerWrites(channelId, "Hi");
    const conv = (await owner.get("/api/channels/conversations")).body.data[0];
    const { ProviderError } = await import("@/server/services/channels/provider");
    mockAdapter().failNext = new ProviderError("This number cannot receive WhatsApp messages.", 131026);
    const r = await owner.post(`/api/channels/conversations/${conv.id}/messages`, { text: "Hello?" });
    expect(r.status).toBe(201);
    expect(r.body.message).toMatchObject({ delivery: "failed", error: "This number cannot receive WhatsApp messages." });
    const dc = await owner.post(`/api/channels/${channelId}/disconnect`, {});
    expect(dc.body.channel.status).toBe("disconnected");
    expect((await ctx.db.select().from(msgChannels).where(eq(msgChannels.id, channelId)).get())!.tokenEnc).toBeNull();
    expect((await owner.get(`/api/channels/conversations/${conv.id}`)).body.messages).toHaveLength(2);
    expect((await owner.post(`/api/channels/conversations/${conv.id}/messages`, { text: "x" })).status).toBe(409);
  });
});
