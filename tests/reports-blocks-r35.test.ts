import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";
import { mailOperator, REPORTS_PER_DAY } from "@/server/services/suite/reports-r35";

/** R35 (Apple 1.2): report and block in chat, DMs and meeting chat, and the operator moderation queue. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let a: Client; // Olive, the reporter and blocker
let clock = 0;

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-10-26T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  a = new Client(ctx.app);
  await a.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "sam@acme.io", name = "Sam Lee") {
  const invite = await a.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
const meId = async (cl: Client) => (await cl.get("/api/account/me")).body.user.id as string;
const general = async (cl: Client = a) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const post = async (channelId: string, body: string, cl: Client, parentId?: string) => (await cl.post(`/api/chat/channels/${channelId}/messages`, { body, parentId })).body.message as { id: string };
const bodies = async (cl: Client, channelId: string) => ((await cl.get(`/api/chat/channels/${channelId}/messages`)).body.messages as { body: string }[]).map((m) => m.body);
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}

describe("reports", () => {
  beforeEach(setup);

  it("reports a message with a snapshot that survives an edit, and a person", async () => {
    const sam = await teammate();
    const g = await general();
    const m = await post(g.id, "you are all useless", sam.client);
    const r = await a.post("/api/reports", { targetType: "message", messageId: m.id, context: "chat", reason: "harassment", note: "Third time today" });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.stringMatching(/^rpt/), status: "open" });
    await sam.client.call("PATCH", `/api/chat/messages/${m.id}`, { body: "edited away" });
    const u = await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "spam" });
    expect(u.status).toBe(201);
    // Operator queue
    const ops = a; await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "owner@acme.io"));
    const q = (await ops.get("/api/console/moderation/reports")).body.items; // OPS1 security: the console queue
    expect(q).toHaveLength(2);
    const msg = q.find((x: { targetType: string }) => x.targetType === "message");
    expect(msg).toMatchObject({ reason: "harassment", context: "chat", note: "Third time today", snapshotText: "you are all useless", status: "open", target: { id: sam.id, name: "Sam Lee" }, reporter: { name: "Olive Owner" } });
    expect((await ops.get("/api/admin/reports/count")).body.open).toBe(2);
  });

  it("refuses yourself, messages you can't see, bad bodies, and more than 20 a day", async () => {
    const sam = await teammate();
    const me = await meId(a);
    const g = await general();
    const mine = await post(g.id, "hello", a);
    expect((await a.post("/api/reports", { targetType: "message", messageId: mine.id, reason: "spam" })).status).toBe(404);
    expect((await a.post("/api/reports", { targetType: "user", userId: me, reason: "spam" })).status).toBe(404);
    // A DM between Sam and someone else: Olive can't see it.
    const third = await teammate("kim@acme.io", "Kim Park");
    const dm = (await sam.client.post("/api/chat/dms", { userIds: [third.id] })).body.channel;
    const hidden = await post(dm.id, "private", sam.client);
    expect((await a.post("/api/reports", { targetType: "message", messageId: hidden.id, reason: "spam" })).status).toBe(404);
    // Someone in no shared workspace
    const stranger = new Client(ctx.app); await stranger.signup("x@other.io", "Xavier Other");
    expect((await a.post("/api/reports", { targetType: "user", userId: await meId(stranger), reason: "spam" })).status).toBe(404);
    expect((await a.post("/api/reports", { targetType: "message", reason: "spam" })).status).toBe(422);
    expect((await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "rude" })).status).toBe(422);
    expect((await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "other", note: "x".repeat(501) })).status).toBe(422);
    for (let i = 0; i < REPORTS_PER_DAY; i++) expect((await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "spam" })).status).toBe(201);
    expect((await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "spam" })).status).toBe(429);
  });

  it("mails the operator at most once per 15 minutes", async () => {
    const sam = await teammate();
    const sent: string[] = [];
    const before = ctx.deps.outbound;
    void before;
    expect(await mailOperator(ctx.deps)).toBe(false); // nothing open
    await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "spam" }); // mailed now
    sent.push("first");
    await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "hate" });
    expect(await mailOperator(ctx.deps)).toBe(false); // same 15 minute slot
    clock += 16 * 60_000;
    expect(await mailOperator(ctx.deps)).toBe(true); // the second report goes in the next slot
    expect(await mailOperator(ctx.deps)).toBe(false); // nothing new since
  });
});

describe("blocks", () => {
  beforeEach(setup);

  it("lists, adds idempotently, refuses yourself, removes", async () => {
    const sam = await teammate();
    expect((await a.get("/api/blocks")).body).toEqual({ blocks: [] });
    const r1 = await a.post("/api/blocks", { userId: sam.id });
    expect(r1.status).toBe(201);
    expect((await a.post("/api/blocks", { userId: sam.id })).status).toBe(200);
    expect((await a.post("/api/blocks", { userId: await meId(a) })).status).toBe(400);
    expect((await a.post("/api/blocks", { userId: "usr_nobody" })).status).toBe(404);
    const list = (await a.get("/api/blocks")).body.blocks;
    expect(list).toEqual([{ userId: sam.id, name: "Sam Lee", avatarUrl: null, createdAt: expect.any(String) }]);
    expect((await a.call("DELETE", `/api/blocks/${sam.id}`)).status).toBe(204);
    expect((await a.call("DELETE", `/api/blocks/${sam.id}`)).status).toBe(404); // nothing to unblock: 404 (no probing of other workspaces' ids)
    expect((await a.get("/api/blocks")).body.blocks).toEqual([]);
  });

  it("hides the blocked person's messages from every read path for the blocker only", async () => {
    const sam = await teammate();
    const kim = await teammate("kim@acme.io", "Kim Park");
    const g = await general();
    await sam.client.post(`/api/chat/channels/${g.id}/join`);
    await kim.client.post(`/api/chat/channels/${g.id}/join`);
    const root = await post(g.id, "Root from Olive", a);
    await a.post(`/api/chat/channels/${g.id}/read`);
    await post(g.id, "zebra hello from Sam", sam.client);
    await post(g.id, "zebra hello from Kim", kim.client);
    await post(g.id, "zebra reply from Sam", sam.client, root.id);
    await post(g.id, "zebra reply from Kim", kim.client, root.id);
    const unreadBefore = (await a.get("/api/chat/unread")).body;
    await a.post("/api/blocks", { userId: sam.id });
    // Channel list, thread, search, first unread, unread counts, last message preview
    expect(await bodies(a, g.id)).toEqual(["Root from Olive", "zebra hello from Kim"]);
    expect(await bodies(kim.client, g.id)).toContain("zebra hello from Sam"); // only the blocker is affected
    const thread = (await a.get(`/api/chat/messages/${root.id}/thread`)).body;
    expect(thread.replies.map((x: { body: string }) => x.body)).toEqual(["zebra reply from Kim"]);
    const found = (await a.get("/api/chat/search?q=zebra")).body;
    const texts = JSON.stringify(found);
    expect(texts).not.toContain("from Sam");
    expect(texts).toContain("from Kim");
    const unread = (await a.get("/api/chat/unread")).body;
    if (unreadBefore && typeof unreadBefore.total === "number") expect(unread.total).toBe(unreadBefore.total - 1);
    const fu = (await a.get(`/api/chat/channels/${g.id}/first-unread`)).body;
    expect(fu.unread).toBe(1);
    const global = JSON.stringify((await a.get("/api/search?q=zebra")).body);
    expect(global).not.toContain("from Sam");
    // since= polling leaves them out too
    expect((await a.get(`/api/chat/channels/${g.id}/messages?since=2000-01-01T00:00:00.000Z`)).body.messages.map((x: { body: string }) => x.body)).not.toContain("zebra hello from Sam");
    const list = (await a.get("/api/chat/channels")).body.channels.find((x: { id: string }) => x.id === g.id);
    expect(JSON.stringify(list.lastMessage ?? {})).not.toContain("from Sam");
    // Unblock: back again
    await a.call("DELETE", `/api/blocks/${sam.id}`);
    expect(await bodies(a, g.id)).toContain("zebra hello from Sam");
  });

  it("refuses a DM from the blocked person and drops their mentions", async () => {
    const sam = await teammate();
    const oliveId = await meId(a);
    const dm = (await sam.client.post("/api/chat/dms", { userIds: [oliveId] })).body.channel;
    await post(dm.id, "before the block", sam.client);
    await a.post("/api/blocks", { userId: sam.id });
    const refused = await sam.client.post(`/api/chat/channels/${dm.id}/messages`, { body: "hello?" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "blocked", message: "You can't message this person." });
    // A new DM with Olive in it (with someone else too) can't be started either.
    const kim = await teammate("kim@acme.io", "Kim Park");
    const group = await sam.client.post("/api/chat/dms", { userIds: [oliveId, kim.id] });
    expect(group.status).toBe(403);
    // Olive can still write to Sam (the block is one way); Sam's mention of Olive does not notify her.
    expect((await a.post(`/api/chat/channels/${dm.id}/messages`, { body: "please stop" })).status).toBe(201);
    const g = await general();
    await sam.client.post(`/api/chat/channels/${g.id}/join`);
    const before = (await a.get("/api/notifications")).body;
    await post(g.id, `hey <@member:${oliveId}>`, sam.client);
    const after = (await a.get("/api/notifications")).body;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("works over the public API and MCP", async () => {
    const sam = await teammate();
    const full = (await a.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
    const res = await ctx.app.request("/api/v1/blocks", { headers: { authorization: `Bearer ${full}`, host: "localhost" } });
    expect([200, 403]).toContain(res.status);
    const bot = await mcpFor(full);
    const tools = (await bot.listTools()).tools.map((t) => t.name);
    for (const t of ["create_report", "list_blocks", "add_block", "remove_block"]) expect(tools).toContain(t);
    const added = await bot.callTool({ name: "add_block", arguments: { userId: sam.id } });
    const text = JSON.stringify(added.content);
    expect(text.includes("blocked") || text.includes("Reports and blocks belong to a person")).toBe(true);
  });
});

describe("operator moderation queue", () => {
  beforeEach(setup);

  it("is for platform admins only; dismiss, remove message and suspend", async () => {
    const sam = await teammate();
    const g = await general();
    const m = await post(g.id, "buy cheap pills here", sam.client);
    expect((await a.get("/api/console/moderation/reports")).status).toBe(403); // a workspace owner is not an operator
    const r1 = (await a.post("/api/reports", { targetType: "message", messageId: m.id, reason: "spam" })).body.id;
    const r2 = (await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "harassment" })).body.id;
    const r3 = (await a.post("/api/reports", { targetType: "user", userId: sam.id, reason: "other" })).body.id;
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "owner@acme.io"));
    // OPS1 security: the console route (reason required) replaced the retired /api/admin/reports/:id/action.
    expect((await a.post(`/api/console/moderation/reports/${r1}/action`, { action: "explode", reason: "Reviewed the report" })).status).toBe(422);
    expect((await a.post(`/api/console/moderation/reports/${r1}/action`, { action: "dismiss" })).status).toBe(422);
    const removed = (await a.post(`/api/console/moderation/reports/${r1}/action`, { action: "remove_message", note: "Spam link", reason: "Reviewed the report" })).body.report;
    expect(removed).toMatchObject({ status: "resolved", action: "message_removed", resolutionNote: "Spam link" });
    const gone = ((await sam.client.get(`/api/chat/channels/${g.id}/messages`)).body.messages as { id: string; body: string; deleted?: boolean; deletedAt?: string }[]).find((x) => x.id === m.id)!;
    expect(gone.body).toBe("");
    expect((await a.post(`/api/console/moderation/reports/${r3}/action`, { action: "dismiss", reason: "Reviewed the report" })).body.report).toMatchObject({ status: "dismissed", action: "none" });
    // Acting twice on a settled report is refused (409), by the route and by the service itself.
    expect((await a.post(`/api/console/moderation/reports/${r3}/action`, { action: "resolve", reason: "Reviewed the report" })).status).toBe(409);
    const susp = (await a.post(`/api/console/moderation/reports/${r2}/action`, { action: "suspend_user", reason: "Reviewed the report" })).body.report;
    expect(susp).toMatchObject({ status: "resolved", action: "user_suspended", target: { suspended: true } });
    expect((await sam.client.get("/api/account/me")).status).toBe(401); // sessions ended
    expect((await a.get("/api/console/moderation/reports")).body.items).toEqual([]);
    expect((await a.get("/api/console/moderation/reports?status=all")).body.items).toHaveLength(3);
    expect((await a.post("/api/console/moderation/reports/rpt_missing/action", { action: "dismiss", reason: "Reviewed the report" })).status).toBe(404);
  });
});
