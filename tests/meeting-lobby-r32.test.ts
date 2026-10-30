import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, meetingLobby, meetings } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { cleanGuestName, clearLobbyLimits, hereText, lobbyAllowed, LOBBY_IP_LIMIT, LOBBY_TTL_MS } from "@/server/services/suite/meeting-lobby-r32";

/** Round 32: the meeting waiting room (guests ask, members admit or deny), names on pre-join, and who is here. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const rooms = new Map<string, CallParticipant[]>();
const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };

async function setup(env: Record<string, string> = LK) {
  ctx = await makeTestApp(env);
  clock = new Date("2026-10-26T01:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  rooms.clear(); clearCallCache(); clearLobbyLimits();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
beforeEach(async () => { await setup(); });

async function meeting(title = "Design review") {
  const m = (await c.post("/api/meetings", { title })).body.meeting;
  return { ...m, token: m.guestUrl.split("/m/")[1] as string };
}
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
async function apiKey(scope: "full" | "read" = "full") {
  return (await c.post("/api/developer/keys", { name: `k-${scope}`, scope })).body.secret as string;
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

describe("pure helpers", () => {
  it("says who is here in plain words", () => {
    expect(hereText([], 0)).toBe("Nobody is here yet.");
    expect(hereText(["Maya"])).toBe("Maya is here.");
    expect(hereText(["Maya", "Sam"])).toBe("Maya and Sam are here.");
    expect(hereText(["Maya", "Sam", "Ann"], 3)).toBe("Maya and 2 others are here.");
    expect(hereText(["Maya", "Sam", "Ann"], 9)).toBe("Maya and 8 others are here.");
  });
  it("cleans a guest name: 1 to 60 characters, no control characters", () => {
    expect(cleanGuestName("  Grace   Hopper ")).toBe("Grace Hopper");
    expect(cleanGuestName("a\u0000b")).toBe("a b");
    expect(cleanGuestName("   ")).toBeNull();
    expect(cleanGuestName("x".repeat(61))).toBeNull();
    expect(cleanGuestName(42)).toBeNull();
  });
  it("limits asks per address in memory", () => {
    clearLobbyLimits();
    for (let i = 0; i < LOBBY_IP_LIMIT; i++) expect(lobbyAllowed("1.2.3.4", 1000)).toBe(true);
    expect(lobbyAllowed("1.2.3.4", 1000)).toBe(false);
    expect(lobbyAllowed("5.6.7.8", 1000)).toBe(true);
    expect(lobbyAllowed("1.2.3.4", 1000 + 11 * 60_000)).toBe(true);
  });
});

describe("waiting room", () => {
  it("is on by default; a guest asks, waits with no token, is admitted, then joins under the name they gave", async () => {
    const m = await meeting();
    expect(m.guestsWait).toBe(true);
    const guest = new Client(ctx.app);
    expect((await guest.get(`/api/public/meetings/${m.token}`)).body.meeting.guestsWait).toBe(true);
    // No token without a request.
    const early = await guest.post(`/api/public/meetings/${m.token}/join`, { name: "Grace" });
    expect(early.status).toBe(403); expect(early.body.error.code).toBe("lobby_required");
    const ask = await guest.post(`/api/public/meeting-lobby/${m.token}`, { name: "  Grace Hopper " });
    expect(ask.status).toBe(200);
    expect(ask.body).toMatchObject({ status: "pending", waitingRoom: true });
    const lobbyId = ask.body.lobbyId as string;
    expect(lobbyId).toMatch(/^lby_[A-Za-z0-9]{16,}$/);
    expect((await guest.get(`/api/public/meeting-lobby/${m.token}/${lobbyId}`)).body.status).toBe("pending");
    const waiting = await guest.post(`/api/public/meetings/${m.token}/join`, { name: "Grace", lobbyId });
    expect(waiting.status).toBe(403); expect(waiting.body.error.code).toBe("lobby_waiting");
    // The host sees the request and admits it.
    const list = (await c.get(`/api/meeting-lobby/${m.id}`)).body;
    expect(list).toMatchObject({ meetingId: m.id, guestsWait: true });
    expect(list.waiting).toHaveLength(1);
    expect(list.waiting[0]).toMatchObject({ id: lobbyId, name: "Grace Hopper", status: "pending" });
    const d = await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "admit" });
    expect(d.body).toMatchObject({ decided: 1, status: "admitted" });
    expect((await guest.get(`/api/public/meeting-lobby/${m.token}/${lobbyId}`)).body.status).toBe("admitted");
    expect((await c.get(`/api/meeting-lobby/${m.id}`)).body.waiting).toHaveLength(0);
    // The token carries the name asked with, not whatever the join body says.
    const join = await guest.post(`/api/public/meetings/${m.token}/join`, { name: "Someone Else", lobbyId });
    expect(join.status).toBe(200);
    expect(claims(join.body.token).name).toBe("Grace Hopper");
    expect(claims(join.body.token).video.roomAdmin).toBeFalsy();
    // Deciding again changes nothing; the decision is audited.
    expect((await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "deny" })).body).toMatchObject({ decided: 0, status: "admitted" });
    const audits = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "meeting.lobby_admitted")).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe(m.id);
  });

  it("deny keeps the guest out with a polite message; admit all lets every waiting guest in at once", async () => {
    const m = await meeting();
    const a = (await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Ann" })).body.lobbyId;
    const b = (await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Ben" })).body.lobbyId;
    const x = (await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Xan" })).body.lobbyId;
    expect((await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId: x, decision: "deny" })).body.status).toBe("denied");
    const denied = await new Client(ctx.app).post(`/api/public/meetings/${m.token}/join`, { name: "Xan", lobbyId: x });
    expect(denied.status).toBe(403); expect(denied.body.error.code).toBe("lobby_denied");
    expect(denied.body.error.message).toBe("The host didn't let you in to this meeting.");
    const all = await c.post(`/api/meeting-lobby/${m.id}/decide`, { all: true, decision: "admit" });
    expect(all.body.decided).toBe(2);
    expect(new Set(all.body.ids)).toEqual(new Set([a, b]));
    const rows = await ctx.db.select().from(meetingLobby).where(eq(meetingLobby.meetingId, m.id)).all();
    expect(rows.map((r) => [r.guestName, r.status]).sort()).toEqual([["Ann", "admitted"], ["Ben", "admitted"], ["Xan", "denied"]]);
    expect(rows.find((r) => r.guestName === "Ann")!.decidedBy).toMatch(/^member:/);
    expect((await c.post(`/api/meeting-lobby/${m.id}/decide`, { decision: "admit" })).status).toBe(422);
  });

  it("with the setting off guests join straight away; the setting is audited; members of other workspaces can't see the lobby", async () => {
    const m = await meeting();
    expect((await c.patch(`/api/meeting-lobby/${m.id}/settings`, { guestsWait: false })).body).toMatchObject({ guestsWait: false });
    expect((await c.get(`/api/meetings/${m.id}`)).body.meeting.guestsWait).toBe(false);
    const ask = await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace" });
    expect(ask.body).toMatchObject({ lobbyId: null, status: "admitted", waitingRoom: false });
    const join = await new Client(ctx.app).post(`/api/public/meetings/${m.token}/join`, { name: "Grace" });
    expect(join.status).toBe(200);
    expect(claims(join.body.token).name).toBe("Grace");
    expect(await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "meeting.lobby_off"), eq(auditLogs.targetId, m.id))).all()).toHaveLength(1);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    expect((await other.get(`/api/meeting-lobby/${m.id}`)).status).toBe(404);
    expect((await other.post(`/api/meeting-lobby/${m.id}/decide`, { all: true, decision: "admit" })).status).toBe(404);
  });

  it("refuses bad names, ended meetings, unknown requests and too many asks from one address", async () => {
    const m = await meeting();
    const g = new Client(ctx.app);
    expect((await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "" })).status).toBe(422);
    expect((await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "y".repeat(61) })).status).toBe(422);
    expect((await g.get(`/api/public/meeting-lobby/${m.token}/lby_nope`)).status).toBe(404);
    expect((await g.post(`/api/public/meeting-lobby/nope`, { name: "Grace" })).status).toBe(404);
    for (let i = 0; i < LOBBY_IP_LIMIT; i++) expect((await g.post(`/api/public/meeting-lobby/${m.token}`, { name: `G${i}` })).status).toBe(200);
    const limited = await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "One more" });
    expect(limited.status).toBe(429);
    await c.patch(`/api/meetings/${m.id}`, { status: "ended" });
    clearLobbyLimits();
    expect((await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Late" })).body.error.code).toBe("meeting_ended");
  });

  it("drops requests older than 15 minutes from the host list and tells the guest to ask again", async () => {
    const m = await meeting();
    const g = new Client(ctx.app);
    const id = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace" })).body.lobbyId;
    clock += LOBBY_TTL_MS + 5000;
    expect((await c.get(`/api/meeting-lobby/${m.id}`)).body.waiting).toHaveLength(0);
    expect((await g.get(`/api/public/meeting-lobby/${m.token}/${id}`)).body.status).toBe("expired");
  });
});

describe("names on pre-join and who is here", () => {
  it("a member's name for this call goes into the room token; blank falls back to their account name", async () => {
    const m = await meeting();
    expect(claims((await c.post(`/api/meetings/${m.id}/join`, { name: "  Olive (Sydney) " })).body.token).name).toBe("Olive (Sydney)");
    expect(claims((await c.post(`/api/meetings/${m.id}/join`, { name: "" })).body.token).name).toBe("Olive Owner");
    expect(claims((await c.post(`/api/meetings/${m.id}/join`)).body.token).name).toBe("Olive Owner");
  });
  it("tells a guest who is in the call by first name, with the count", async () => {
    const m = await meeting();
    const g = new Client(ctx.app);
    expect((await g.get(`/api/public/meeting-lobby/${m.token}/here`)).body).toMatchObject({ names: [], count: 0, text: "Nobody is here yet." });
    const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, m.id)).get())!.room;
    rooms.set(room, [{ name: "Maya Patel", identity: "member-1" }, { name: "Sam Lee", identity: "member-2" }, { name: "Gail", identity: "guest-x" }] as CallParticipant[]);
    clearCallCache();
    expect((await g.get(`/api/public/meeting-lobby/${m.token}/here`)).body).toMatchObject({ names: ["Maya", "Sam", "Gail"], count: 3, text: "Maya and 2 others are here." });
  });
});

describe("REST API and MCP", () => {
  it("lists and decides over v1 and MCP; a read key cannot decide", async () => {
    const m = await meeting();
    const a = (await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Ann" })).body.lobbyId;
    const b = (await new Client(ctx.app).post(`/api/public/meeting-lobby/${m.token}`, { name: "Ben" })).body.lobbyId;
    const key = await apiKey();
    const auth = { authorization: `Bearer ${key}` };
    const api = new Client(ctx.app);
    const l = await api.call("GET", `/api/v1/meetings/${m.id}/lobby`, undefined, auth);
    expect(l.status).toBe(200);
    expect(l.body.waiting.map((w: { name: string }) => w.name)).toEqual(["Ann", "Ben"]);
    const d = await api.call("POST", `/api/v1/meetings/${m.id}/lobby/decide`, { lobbyId: a, decision: "deny" }, auth);
    expect(d.status).toBe(200); expect(d.body.status).toBe("denied");
    const mcp = await mcpFor(key);
    const listed = data(await mcp.callTool({ name: "meeting_lobby_list", arguments: { meetingId: m.id } }));
    expect(listed.waiting.map((w: { id: string }) => w.id)).toEqual([b]);
    const decided = data(await mcp.callTool({ name: "meeting_lobby_decide", arguments: { meetingId: m.id, all: true, decision: "admit" } }));
    expect(decided).toMatchObject({ decided: 1, status: "admitted" });
    const ro = await mcpFor(await apiKey("read"));
    const refused = await ro.callTool({ name: "meeting_lobby_decide", arguments: { meetingId: m.id, all: true, decision: "admit" } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    const ro2 = { authorization: `Bearer ${await apiKey("read")}` };
    expect((await api.call("POST", `/api/v1/meetings/${m.id}/lobby/decide`, { all: true, decision: "admit" }, ro2)).status).toBe(403);
  });
});
