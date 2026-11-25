/**
 * Review Z8: (a) the waiting room's Remove took back an admission but left the guest in the call; now the guest's room
 * identity is tied to their request and Remove disconnects it through the room service. (b) Reopening an ended
 * meeting made admissions given before the end count again. (c) A series between meetings showed Reopen (its raw
 * status is scheduled) and the reopen did nothing; now the meeting says canReopen, and a reopen with nothing to reopen
 * is a 409 (after the owner or admin check).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { clearLobbyLimits } from "@/server/services/suite/meeting-lobby-r32";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const removed: [string, string][] = [];
const rooms = new Map<string, CallParticipant[]>();
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

beforeEach(async () => {
  ctx = await makeTestApp(LK);
  clock = new Date("2026-11-12T01:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  rooms.clear(); removed.length = 0; clearCallCache(); clearLobbyLimits();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [], remove: async (room, identity) => { removed.push([room, identity]); } };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

async function admitted(m: { id: string; guestUrl: string }, name = "Grace") {
  const token = m.guestUrl.split("/m/")[1];
  const guest = new Client(ctx.app);
  const lobbyId = (await guest.post(`/api/public/meeting-lobby/${token}`, { name })).body.lobbyId as string;
  expect((await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "admit" })).body.status).toBe("admitted");
  return { guest, token, lobbyId };
}

describe("Z8: waiting room and reopen", () => {
  it("(a) Remove disconnects the admitted guest from the call", async () => {
    const m = (await c.post("/api/meetings", { title: "Review" })).body.meeting;
    const { guest, token, lobbyId } = await admitted(m);
    const join = await guest.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId });
    expect(join.status).toBe(200);
    expect(claims(join.body.token).sub).toBe(`guest-${lobbyId}`);
    const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, m.id)).get())!.room;
    expect((await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "remove" })).body.decided).toBe(1);
    expect(removed).toEqual([[room, `guest-${lobbyId}`]]);
    expect((await guest.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId })).status).toBe(403);
  });

  it("(b) reopening an ended meeting does not bring back admissions from before the end", async () => {
    const m = (await c.post("/api/meetings", { title: "Review" })).body.meeting;
    const { guest, token, lobbyId } = await admitted(m);
    expect((await c.patch(`/api/meetings/${m.id}`, { status: "ended" })).status).toBe(200);
    expect((await c.patch(`/api/meetings/${m.id}`, { status: "scheduled" })).status).toBe(200);
    const again = await guest.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId });
    expect(again.status).toBe(403);
    // A new admission after the reopen works.
    const fresh = await admitted(m, "Grace Again");
    expect((await fresh.guest.post(`/api/public/meetings/${token}/join`, { name: "x", lobbyId: fresh.lobbyId })).status).toBe(200);
  });

  it("(c) a series between meetings can't be reopened: canReopen is false and the reopen is a 409; a member gets 403", async () => {
    const startsAt = new Date(clock + 3600_000).toISOString();
    const m = (await c.post("/api/meetings", { title: "Weekly", startsAt, durationMin: 30, recurrence: { days: ["th"], timezone: "UTC" } })).body.meeting;
    expect(m.canReopen).toBe(false);
    clock = Date.parse(startsAt) + 31 * 60_000;
    await ctx.db.update(meetings).set({ endedAt: new Date(clock) }).where(eq(meetings.id, m.id));
    const shown = (await c.get(`/api/meetings/${m.id}`)).body.meeting;
    expect(shown.status).toBe("ended");
    expect(shown.canReopen).toBe(false);
    const r = await c.patch(`/api/meetings/${m.id}`, { status: "scheduled" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("nothing_to_reopen");
    // An ended one off can be reopened by an owner, not by a member.
    const one = (await c.post("/api/meetings", { title: "One off" })).body.meeting;
    await c.patch(`/api/meetings/${one.id}`, { status: "ended" });
    expect((await c.get(`/api/meetings/${one.id}`)).body.meeting.canReopen).toBe(true);
    const inv = await c.post("/api/team/invites", { email: "sam@acme.io", role: "member" });
    const sam = new Client(ctx.app);
    await sam.signup("sam@acme.io", "Sam", "");
    await sam.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    expect((await sam.patch(`/api/meetings/${m.id}`, { status: "scheduled" })).status).toBe(403);
    expect((await sam.patch(`/api/meetings/${one.id}`, { status: "scheduled" })).status).toBe(403);
    expect((await c.patch(`/api/meetings/${one.id}`, { status: "scheduled" })).status).toBe(200);
  });
});
