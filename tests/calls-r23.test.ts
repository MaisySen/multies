import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings, notifications } from "@/server/db/schema";
import { clearCallCache, CALL_NOTIFY_MAX_MEMBERS, type CallParticipant } from "@/server/services/suite/calls";
import { loadConfig } from "@/server/config";

/** Round 23 (R23.3): calls in DMs and channels ring people once, show who is in the room, and end once. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
let tick = 1000;
const rooms = new Map<string, CallParticipant[]>();
let listCalls = 0;

async function setup(env: Record<string, string> = {}) {
  ctx = await makeTestApp(env);
  clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  tick = 1000;
  ctx.deps.now = () => new Date((clock += tick));
  rooms.clear(); listCalls = 0; clearCallCache();
  ctx.deps.callRooms = { list: async (room) => { listCalls++; return rooms.get(room) ?? []; } };
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
const roomOf = async (meetingId: string) => (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, meetingId)).get())!.room;
const person = (name: string): CallParticipant => ({ identity: `member-${name}`, name, joinedAt: null });
const callNotes = (userId: string) => ctx.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "call.started")));
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);
const v1 = async (key: string, path: string) => {
  const r = await ctx.app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

describe("screen share in the room token", () => {
  it("lets members and guests publish camera, microphone, screen and screen audio", async () => {
    await setup({ LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) });
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    const join = (await c.post(`/api/meetings/${call.meeting.id}/join`)).body;
    const claims = JSON.parse(Buffer.from(join.token.split(".")[1], "base64url").toString());
    expect(claims.video).toMatchObject({ canPublish: true, canSubscribe: true, canPublishData: true });
    expect(claims.video.canPublishSources).toEqual(expect.arrayContaining(["camera", "microphone", "screen_share", "screen_share_audio"]));
    const meeting = (await c.get(`/api/meetings/${call.meeting.id}`)).body.meeting;
    const guest = (await new Client(ctx.app).post(`/api/public/meetings/${meeting.guestUrl.split("/m/")[1]}/join`, { name: "Maria" })).body;
    const gc = JSON.parse(Buffer.from(guest.token.split(".")[1], "base64url").toString());
    expect(gc.video.canPublishSources).toEqual(expect.arrayContaining(["screen_share", "screen_share_audio"]));
    expect(gc.video.roomAdmin).toBeFalsy();
  });
});

describe("call notifications", () => {
  beforeEach(() => setup());

  it("a DM call rings the other members once; a second press within the window joins and rings nobody", async () => {
    const sam = await teammate();
    const tia = await teammate("tia@acme.io", "Tia Third");
    const dm = (await c.post("/api/chat/dms", { userIds: [sam.id, tia.id] })).body.channel;
    const first = await c.post(`/api/chat/channels/${dm.id}/call`, {});
    expect(first.status).toBe(201);
    for (const u of [sam.id, tia.id]) {
      const n = await callNotes(u);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ title: "Olive Owner is calling you", entityType: "chat_message", entityId: first.body.message.id, actorName: "Olive Owner" });
    }
    // The card doesn't also send a plain DM notification.
    expect(await ctx.db.select().from(notifications).where(and(eq(notifications.userId, sam.id), eq(notifications.type, "chat.dm")))).toHaveLength(0);
    const second = await sam.client.post(`/api/chat/channels/${dm.id}/call`, {});
    expect(second.status).toBe(200);
    expect(second.body.joined).toBe(true);
    expect(second.body.meeting.id).toBe(first.body.meeting.id);
    expect(await callNotes(sam.id)).toHaveLength(1);
    expect(await callNotes(tia.id)).toHaveLength(1);
    // The caller is never rung, and the notification opens the chat at the card.
    const me = (await c.get("/api/account/me")).body.user.id;
    expect(await callNotes(me)).toHaveLength(0);
    expect(JSON.stringify((await sam.client.get("/api/notifications")).body)).toContain(`/app/chat/${dm.id}?m=${first.body.message.id}`);
  });

  it("a small channel rings its members; a big one gets only the card", async () => {
    const sam = await teammate();
    const small = (await c.post("/api/chat/channels", { name: "design" })).body.channel;
    await sam.client.post(`/api/chat/channels/${small.id}/messages`, { body: "hi" });
    await c.post(`/api/chat/channels/${small.id}/call`, {});
    expect((await callNotes(sam.id))[0]?.title).toBe("Olive Owner started a call in #design");
    const big = (await c.post("/api/chat/channels", { name: "everyone" })).body.channel;
    await sam.client.post(`/api/chat/channels/${big.id}/messages`, { body: "me too" });
    // Pad the channel past the limit with member rows (inviting that many people hits the seat limit).
    const raw = (ctx.db as unknown as { $client: { exec: (q: string) => void; prepare: (q: string) => { run: (...a: unknown[]) => void } } }).$client;
    const orgId = (await c.get("/api/account/me")).body.organization.id;
    raw.exec("PRAGMA foreign_keys = OFF");
    const ids: string[] = [sam.id];
    for (let i = 0; i < CALL_NOTIFY_MAX_MEMBERS; i++) {
      ids.push(`usr_pad${i}`);
      raw.prepare("insert into chat_members (channel_id, user_id, org_id, created_at) values (?, ?, ?, ?)").run(big.id, `usr_pad${i}`, orgId, Date.now());
    }
    raw.exec("PRAGMA foreign_keys = ON");
    await c.post(`/api/chat/channels/${big.id}/call`, {});
    for (const u of ids) expect((await callNotes(u)).filter((n) => n.title.includes("#everyone"))).toHaveLength(0);
  });
});

describe("in call presence", () => {
  beforeEach(() => setup());

  it("shows who is in the room, then ends the call once when it empties", async () => {
    const sam = await teammate();
    const dm = (await c.post("/api/chat/dms", { userIds: [sam.id] })).body.channel;
    const call = (await c.post(`/api/chat/channels/${dm.id}/call`, {})).body;
    const room = await roomOf(call.meeting.id);
    let p = (await sam.client.get(`/api/chat/channels/${dm.id}/call`)).body;
    expect(p).toMatchObject({ enabled: true, live: null, calls: [{ meetingId: call.meeting.id, state: "waiting", count: 0 }] });
    rooms.set(room, [person("Olive Owner"), person("Sam Mate")]);
    tick = 20_000; // past the cache
    p = (await sam.client.get(`/api/chat/channels/${dm.id}/call`)).body;
    expect(p.live).toMatchObject({ meetingId: call.meeting.id, state: "live", count: 2, participants: [{ name: "Olive Owner" }, { name: "Sam Mate" }] });
    rooms.set(room, []);
    p = (await sam.client.get(`/api/chat/channels/${dm.id}/call`)).body;
    expect(p.live).toBeNull();
    expect(p.calls[0]).toMatchObject({ state: "ended" });
    expect(p.calls[0].durationMin).toBeGreaterThanOrEqual(1);
    const row = (await ctx.db.select().from(meetings).where(eq(meetings.id, call.meeting.id)).get())!;
    expect(row.status).toBe("ended");
    expect(row.endedAt).toBeTruthy();
    // Later reads see the ended row and write nothing more.
    const ended = row.endedAt!.getTime();
    for (let i = 0; i < 3; i++) await c.get(`/api/chat/channels/${dm.id}/call`);
    expect((await ctx.db.select().from(meetings).where(eq(meetings.id, call.meeting.id)).get())!.endedAt!.getTime()).toBe(ended);
  });

  it("a call nobody joined yet stays waiting (no write), and the last person leaving ends it", async () => {
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    tick = 20_000;
    for (let i = 0; i < 3; i++) expect((await c.get(`/api/chat/channels/${g.id}/call`)).body.calls[0].state).toBe("waiting");
    expect((await ctx.db.select().from(meetings).where(eq(meetings.id, call.meeting.id)).get())!.status).toBe("scheduled");
    const left = await c.post(`/api/chat/calls/${call.meeting.id}/left`, {});
    expect(left.status).toBe(200);
    expect(left.body.state).toBe("ended");
    expect((await ctx.db.select().from(meetings).where(eq(meetings.id, call.meeting.id)).get())!.status).toBe("ended");
  });

  it("asks the video service once for many polls inside 10 seconds", async () => {
    const sam = await teammate();
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    rooms.set(await roomOf(call.meeting.id), [person("Olive Owner")]);
    clearCallCache(); listCalls = 0;
    tick = 100;
    for (let i = 0; i < 10; i++) await (i % 2 ? sam.client : c).get(`/api/chat/channels/${g.id}/call`);
    expect(listCalls).toBe(1);
    tick = 11_000;
    await c.get(`/api/chat/channels/${g.id}/call`);
    expect(listCalls).toBe(2);
  });

  it("answers enabled: false without video keys", async () => {
    delete ctx.deps.callRooms;
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/call`, {});
    const p = (await c.get(`/api/chat/channels/${g.id}/call`)).body;
    expect(p).toMatchObject({ enabled: false, live: null, calls: [{ state: "waiting" }] });
  });

  it("only people who can open the chat see its call: DMs, other workspaces, guests of a shared channel", async () => {
    const sam = await teammate();
    const tia = await teammate("tia@acme.io", "Tia Third");
    const dm = (await c.post("/api/chat/dms", { userIds: [sam.id] })).body.channel;
    const call = (await c.post(`/api/chat/channels/${dm.id}/call`, {})).body;
    expect((await tia.client.get(`/api/chat/channels/${dm.id}/call`)).status).toBe(404);
    expect((await tia.client.get(`/api/chat/calls/${call.meeting.id}`)).status).toBe(404);
    expect((await tia.client.post(`/api/chat/calls/${call.meeting.id}/left`, {})).status).toBe(404);
    const stranger = new Client(ctx.app);
    await stranger.signup("eve@else.io", "Eve Else");
    const g = await general();
    expect((await stranger.get(`/api/chat/channels/${g.id}/call`)).status).toBe(404);
    expect((await stranger.get(`/api/chat/channels/${dm.id}/call`)).status).toBe(404);
    expect((await stranger.get(`/api/chat/calls/${call.meeting.id}`)).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/chat/channels/${g.id}/call`)).status).toBe(401);
    // The E2E hook is off here.
    expect((await c.post(`/api/chat/calls/${call.meeting.id}/test-room`, { participants: [{ name: "X" }] })).status).toBe(404);

    // A guest sees calls only in the channel shared with them.
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const shared = (await c.post("/api/chat/channels", { name: "harbour-client", projectId: p.id, guestAccess: true })).body.channel;
    const internal = (await c.post("/api/chat/channels", { name: "harbour-internal", projectId: p.id })).body.channel;
    await c.patch(`/api/chat/channels/${internal.id}`, { guestAccess: false });
    const sharedCall = (await c.post(`/api/chat/channels/${shared.id}/call`, {})).body;
    expect(sharedCall.message.body).toContain("Guests join here: ");
    await c.post(`/api/chat/channels/${internal.id}/call`, {});
    await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((x) => x.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
    const guest = new Client(ctx.app);
    expect((await guest.get(`/api/guest/chat/channels/${shared.id}/call`)).status).toBe(401);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    const seen = await guest.get(`/api/guest/chat/channels/${shared.id}/call`);
    expect(seen.status).toBe(200);
    expect(seen.body.calls[0].meetingId).toBe(sharedCall.meeting.id);
    expect((await guest.get(`/api/guest/chat/channels/${internal.id}/call`)).status).toBe(404);
    expect((await guest.get(`/api/guest/chat/channels/${dm.id}/call`)).status).toBe(404);
    expect((await guest.get(`/api/chat/channels/${shared.id}/call`)).status).toBe(401);
  });
});

describe("call status for agents: MCP and REST", () => {
  beforeEach(() => setup());

  it("reads public channel calls and one meeting; keys can't open DMs; agents still can't start calls", async () => {
    const sam = await teammate();
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    rooms.set(await roomOf(call.meeting.id), [person("Olive Owner")]);
    const dm = (await c.post("/api/chat/dms", { userIds: [sam.id] })).body.channel;
    const dmCall = (await c.post(`/api/chat/channels/${dm.id}/call`, {})).body;
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;

    const rest = await v1(ro, `/chat/channels/${g.id}/call`);
    expect(rest.status).toBe(200);
    expect(rest.body).toMatchObject({ enabled: true, live: { meetingId: call.meeting.id, state: "live", participants: [{ name: "Olive Owner" }] } });
    expect((await v1(ro, `/meetings/${call.meeting.id}/call`)).body).toMatchObject({ meetingId: call.meeting.id, state: "live", count: 1 });
    expect((await v1(ro, `/chat/channels/${dm.id}/call`)).status).toBe(404);
    expect((await v1(ro, `/meetings/${dmCall.meeting.id}/call`)).status).toBe(404);

    const mcp = await mcpFor(ro);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_call_status");
    expect(data(await mcp.callTool({ name: "get_call_status", arguments: { channelId: g.id } }))).toMatchObject({ live: { state: "live", count: 1 } });
    expect(data(await mcp.callTool({ name: "get_call_status", arguments: { meetingId: call.meeting.id } }))).toMatchObject({ state: "live" });
    expect((await mcp.callTool({ name: "get_call_status", arguments: { channelId: dm.id } })).isError).toBe(true);
    expect((await mcp.callTool({ name: "get_call_status", arguments: {} })).isError).toBe(true);

    // Another workspace's key sees nothing.
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    const otherKey = (await other.post("/api/developer/keys", { name: "Eve bot" })).body.secret;
    expect((await v1(otherKey, `/chat/channels/${g.id}/call`)).status).toBe(404);
    expect((await v1(otherKey, `/meetings/${call.meeting.id}/call`)).status).toBe(404);
  });
});

describe("the E2E room hook", () => {
  it("is refused in production config and fakes rooms only when on", async () => {
    expect(() => loadConfig({ APP_SECRET: "t".repeat(40), APP_MODE: "production", APP_URL: "https://multies.si", CALLS_TEST_HOOK: "true" })).toThrow(/CALLS_TEST_HOOK/);
    expect(loadConfig({ APP_SECRET: "t".repeat(40) }).callsTestHook).toBe(false);
    await setup({ CALLS_TEST_HOOK: "true" });
    delete ctx.deps.callRooms;
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    expect((await c.post(`/api/chat/calls/${call.meeting.id}/test-room`, { participants: [{ name: "Olive Owner" }] })).status).toBe(200);
    expect((await c.get(`/api/chat/channels/${g.id}/call`)).body.live).toMatchObject({ participants: [{ name: "Olive Owner" }] });
  });
});
