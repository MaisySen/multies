import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { cleanEmoji, likeContains, MAX_EMOJI_PER_MESSAGE } from "@/server/services/suite/chat-reactions";

/** Round 20 chat polish: reactions, chat search, first unread and calls from a channel. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const post = async (channelId: string, body: string, cl: Client = c, parentId?: string) => (await cl.post(`/api/chat/channels/${channelId}/messages`, { body, parentId })).body.message as { id: string };
const react = (cl: Client, id: string, emoji: string) => cl.post(`/api/chat/messages/${id}/reactions`, { emoji });
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const reactionRows = async () => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare("select count(*) n from chat_reactions").get().n;

describe("emoji checks", () => {
  it("accepts one emoji and refuses words, markup and long strings", () => {
    for (const e of ["\u{1F44D}", "\u2764\uFE0F", "\u{1F44D}\u{1F3FD}", "\u{1F1E6}\u{1F1FA}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "1\uFE0F\u20E3", " \u{1F389} "]) expect(() => cleanEmoji(e)).not.toThrow();
    expect(cleanEmoji(" \u{1F389} ")).toBe("\u{1F389}");
    for (const e of ["", "ok", "123", "<b>", "\u{1F44D} hi", "\u{1F44D}".repeat(20), 5, null]) expect(() => cleanEmoji(e)).toThrow();
  });
  it("escapes LIKE wildcards", () => {
    expect(likeContains("50%_off\\x")).toBe("%50\\%\\_off\\\\x%");
  });
});

describe("chat reactions", () => {
  beforeEach(setup);

  it("toggles: adding twice leaves none, counts per emoji, names who reacted", async () => {
    const mate = await teammate();
    const g = await general();
    const m = await post(g.id, "Shipped the new site");
    const up = "\u{1F44D}", party = "\u{1F389}";
    const r1 = await react(c, m.id, up);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ added: true, reactions: [{ emoji: up, count: 1 }] });
    await react(mate.client, m.id, up);
    await react(mate.client, m.id, party);
    const seen = (await mate.client.get(`/api/chat/channels/${g.id}/messages`)).body.messages.find((x: { id: string }) => x.id === m.id);
    expect(seen.reactions).toEqual([
      { emoji: up, count: 2, reactors: [{ id: expect.stringMatching(/^member:/), name: "Olive Owner" }, { id: `member:${mate.id}`, name: "Sam Mate" }] },
      { emoji: party, count: 1, reactors: [{ id: `member:${mate.id}`, name: "Sam Mate" }] },
    ]);
    const off = await react(c, m.id, up);
    expect(off.body).toMatchObject({ added: false, reactions: [{ emoji: up, count: 1 }, { emoji: party, count: 1 }] });
    await react(mate.client, m.id, up);
    await react(mate.client, m.id, party);
    expect(await reactionRows()).toBe(0);
    expect((await c.get(`/api/chat/messages/${m.id}`)).body.message.reactions).toEqual([]);
  });

  it("works on thread replies and shows them in the thread", async () => {
    const g = await general();
    const root = await post(g.id, "Question for the team");
    const reply = await post(g.id, "Answer here", c, root.id);
    expect((await react(c, reply.id, "\u{1F440}")).status).toBe(200);
    const t = (await c.get(`/api/chat/messages/${root.id}/thread`)).body;
    expect(t.message.reactions).toEqual([]);
    expect(t.replies[0].reactions).toMatchObject([{ emoji: "\u{1F440}", count: 1 }]);
  });

  it("validates the emoji and caps distinct emoji per message", async () => {
    const g = await general();
    const m = await post(g.id, "Vote");
    expect((await react(c, m.id, "lol")).status).toBe(422);
    expect((await react(c, m.id, "<script>")).status).toBe(422);
    const pool = [..."\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}\u{1F605}\u{1F606}\u{1F607}\u{1F608}\u{1F609}\u{1F60A}\u{1F60B}\u{1F60C}\u{1F60D}\u{1F60E}\u{1F60F}\u{1F610}\u{1F611}\u{1F612}\u{1F613}\u{1F614}"];
    for (const e of pool.slice(0, MAX_EMOJI_PER_MESSAGE)) expect((await react(c, m.id, e)).status).toBe(200);
    expect((await react(c, m.id, pool[MAX_EMOJI_PER_MESSAGE])).status).toBe(422);
    // Taking one off still works at the cap, and an emoji already used can still be added by someone else.
    expect((await react(c, m.id, pool[0])).body.added).toBe(false);
    const deleted = await post(g.id, "gone");
    await c.del(`/api/chat/messages/${deleted.id}`);
    expect((await react(c, deleted.id, "\u{1F44D}")).status).toBe(404);
  });

  it("keeps reactions to people who can read the message: DMs, other workspaces, read-only keys, guests", async () => {
    const mate = await teammate();
    const other = await teammate("third@acme.io", "Tia Third");
    const dm = (await c.post("/api/chat/dms", { userIds: [mate.id] })).body.channel;
    const secret = await post(dm.id, "Just us");
    expect((await react(other.client, secret.id, "\u{1F44D}")).status).toBe(404);
    expect((await react(mate.client, secret.id, "\u{1F44D}")).status).toBe(200);
    // Another workspace can't see the message at all.
    const stranger = new Client(ctx.app);
    await stranger.signup("eve@else.io", "Eve Else");
    expect((await react(stranger, secret.id, "\u{1F44D}")).status).toBe(404);
    const g = await general();
    const pub = await post(g.id, "Public news");
    expect((await react(stranger, pub.id, "\u{1F44D}")).status).toBe(404);

    // MCP: a full key reacts in public channels only; a read only key can't react.
    const full = (await c.post("/api/developer/keys", { name: "Bot" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    const bot = await mcpFor(full);
    const ok = await bot.callTool({ name: "react_to_chat_message", arguments: { messageId: pub.id, emoji: "\u2705" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok as { content: { text: string }[] }).content[0].text)).toMatchObject({ added: true, reactions: [{ emoji: "\u2705", count: 1 }] });
    const dmTry = await bot.callTool({ name: "react_to_chat_message", arguments: { messageId: secret.id, emoji: "\u2705" } });
    expect(dmTry.isError).toBe(true);
    const reader = await mcpFor(ro);
    const roTry = await reader.callTool({ name: "react_to_chat_message", arguments: { messageId: pub.id, emoji: "\u{1F44D}" } });
    expect(roTry.isError).toBe(true);
    expect((roTry as { content: { text: string }[] }).content[0].text).toContain("only read");
  });

  it("lets guests react only in channels shared with their project", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const shared = (await c.post("/api/chat/channels", { name: "harbour-client", projectId: p.id, guestAccess: true })).body.channel;
    const internal = (await c.post("/api/chat/channels", { name: "harbour-internal", projectId: p.id })).body.channel;
    await c.patch(`/api/chat/channels/${internal.id}`, { guestAccess: false });
    const welcome = await post(shared.id, "Welcome Mia");
    const budget = await post(internal.id, "Budget is tight");
    await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((x) => x.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
    const g = new Client(ctx.app);
    expect((await g.post(`/api/guest/chat/messages/${welcome.id}/reactions`, { emoji: "\u2764\uFE0F" })).status).toBe(401);
    expect((await g.post("/api/guest/accept", { token })).status).toBe(200);
    const ok = await g.post(`/api/guest/chat/messages/${welcome.id}/reactions`, { emoji: "\u2764\uFE0F" });
    expect(ok.status).toBe(200);
    expect(ok.body.reactions).toEqual([{ emoji: "\u2764\uFE0F", count: 1, reactors: [{ id: expect.stringMatching(/^guest:/), name: "Mia (guest)" }] }]);
    expect((await g.post(`/api/guest/chat/messages/${budget.id}/reactions`, { emoji: "\u{1F44D}" })).status).toBe(404);
    // The guest sees the reaction in their own read of the channel, and the session route stays closed to them.
    const msgs = (await g.get(`/api/guest/chat/channels/${shared.id}/messages`)).body.messages;
    expect(msgs[0].reactions[0]).toMatchObject({ count: 1 });
    expect((await g.post(`/api/chat/messages/${welcome.id}/reactions`, { emoji: "\u{1F44D}" })).status).toBe(401);
  });
});

describe("chat search", () => {
  beforeEach(setup);

  it("finds text in a channel and across channels the person can read, newest first, with wildcards taken literally", async () => {
    const mate = await teammate();
    const g = await general();
    const sales = (await c.post("/api/chat/channels", { name: "sales" })).body.channel;
    const priv = (await c.post("/api/chat/channels", { name: "board", private: true })).body.channel;
    await post(g.id, "The invoice for Harbour is out");
    await post(sales.id, "Harbour invoice paid, 100% done");
    const reply = await post(sales.id, "invoice_final.pdf attached", c, (await post(sales.id, "Thread root")).id);
    await post(priv.id, "Board invoice notes");
    const all = (await c.get("/api/chat/search?q=invoice")).body.results as { id: string; preview: string; channel: string; parentId: string | null }[];
    expect(all.map((r) => r.preview)).toEqual(["Board invoice notes", "invoice_final.pdf attached", "Harbour invoice paid, 100% done", "The invoice for Harbour is out"]);
    expect(all[1]).toMatchObject({ id: reply.id, channel: "#sales" });
    expect(all[1].parentId).toBeTruthy();
    // Sam isn't in #board.
    const theirs = (await mate.client.get("/api/chat/search?q=invoice")).body.results as { preview: string }[];
    expect(theirs.map((r) => r.preview)).not.toContain("Board invoice notes");
    expect(theirs).toHaveLength(3);
    expect((await mate.client.get(`/api/chat/search?q=invoice&channelId=${priv.id}`)).status).toBe(404);
    // In one channel.
    expect(((await c.get(`/api/chat/search?q=invoice&channelId=${g.id}`)).body.results as unknown[]).length).toBe(1);
    // % and _ match only themselves.
    expect(((await c.get(`/api/chat/search?q=${encodeURIComponent("100%")}`)).body.results as unknown[]).length).toBe(1);
    expect(((await c.get(`/api/chat/search?q=${encodeURIComponent("e_f")}`)).body.results as unknown[]).length).toBe(1);
    expect(((await c.get(`/api/chat/search?q=${encodeURIComponent("%%")}`)).body.results as unknown[]).length).toBe(0);
    expect((await c.get("/api/chat/search?q=a")).status).toBe(422);
    expect(((await c.get("/api/chat/search?q=invoice&limit=2")).body.results as unknown[]).length).toBe(2);
    // Another workspace finds nothing of ours.
    const stranger = new Client(ctx.app);
    await stranger.signup("eve@else.io", "Eve Else");
    expect((await stranger.get("/api/chat/search?q=invoice")).body.results).toEqual([]);
  });
});

describe("first unread", () => {
  beforeEach(setup);

  it("points at the first message after the read marker", async () => {
    const mate = await teammate();
    const g = await general();
    await mate.client.post(`/api/chat/channels/${g.id}/read`, {});
    expect((await mate.client.get(`/api/chat/channels/${g.id}/first-unread`)).body).toEqual({ messageId: null, createdAt: null, unread: 0 });
    const a = await post(g.id, "one");
    await post(g.id, "two");
    await post(g.id, "mine", mate.client);
    const r = (await mate.client.get(`/api/chat/channels/${g.id}/first-unread`)).body;
    // Sam's own post moved Sam's marker past "one" and "two".
    expect(r.unread).toBe(0);
    await post(g.id, "three");
    const r2 = (await mate.client.get(`/api/chat/channels/${g.id}/first-unread`)).body;
    expect(r2.unread).toBe(1);
    expect(r2.messageId).not.toBe(a.id);
    // Reading writes nothing new here; the owner, who wrote everything, has nothing unread.
    expect((await c.get(`/api/chat/channels/${g.id}/first-unread`)).body.unread).toBe(0);
  });
});

describe("calls from chat", () => {
  beforeEach(setup);

  it("creates exactly one meeting and one join message, titled after the channel", async () => {
    const mate = await teammate();
    const g = await general();
    const count = (t: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare(`select count(*) n from ${t}`).get().n;
    const meetings0 = count("meetings"), messages0 = count("chat_messages");
    const r = await c.post(`/api/chat/channels/${g.id}/call`, {});
    expect(r.status).toBe(201);
    expect(r.body.meeting).toMatchObject({ title: "#general call" });
    expect(r.body.message.body).toBe(`Started a call. Join: ${r.body.meeting.joinUrl}`);
    expect(count("meetings") - meetings0).toBe(1);
    expect(count("chat_messages") - messages0).toBe(1);
    const seen = (await mate.client.get(`/api/chat/channels/${g.id}/messages`)).body.messages;
    expect(seen.at(-1).body).toContain("/app/meetings/");
    expect((await mate.client.get(`/api/meetings/${r.body.meeting.id}`)).status).toBe(200);
    // A DM call is named after the other person; outsiders can't start one there.
    const other = await teammate("third@acme.io", "Tia Third");
    const dm = (await c.post("/api/chat/dms", { userIds: [mate.id] })).body.channel;
    expect((await c.post(`/api/chat/channels/${dm.id}/call`, {})).body.meeting.title).toBe("Call with Sam Mate");
    expect((await other.client.post(`/api/chat/channels/${dm.id}/call`, {})).status).toBe(404);
  });
});
