import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetingLobby, meetings } from "@/server/db/schema";
import { CALL_EMPTY_GRACE_MS, clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { clearLobbyLimits, oneRowPerGuest, sameGuestName } from "@/server/services/suite/meeting-lobby-r32";
import { closedReason, JOIN_EARLY_MS } from "@/server/services/suite/meeting-open-meet";
import { accountKept } from "@/server/auth/mobile-web-link";
import {
  dockSize, DOCK_SIZE, endCallSession, getCallSession, meetingPageClosed, meetingPageOpened, resetCallSessionForTests,
  sessionFor, setCallState, setCallView, startCallSession, type CallConnection,
} from "@/web/lib/call-session-meet";

/**
 * MEET fixes (POL6, 12 Nov 2026): one Admit per waiting guest, the call kept while moving around the app,
 * the account and workspace a meeting opens as, and meeting links that keep working (with the 10 Nov rule kept:
 * a link stays ended after the last person leaves).
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
let tick = 1000;
const rooms = new Map<string, CallParticipant[]>();
const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };

async function setup(env: Record<string, string> = LK) {
  ctx = await makeTestApp(env);
  clock = new Date("2026-11-12T01:00:00.000Z").getTime();
  tick = 1000;
  ctx.deps.now = () => new Date((clock += tick));
  rooms.clear(); clearCallCache(); clearLobbyLimits();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function meeting(body: Record<string, unknown> = { title: "Design review" }, opts: { guestsWait?: boolean } = {}) {
  const m = (await c.post("/api/meetings", body)).body.meeting;
  if (opts.guestsWait === false) expect((await c.patch(`/api/meeting-lobby/${m.id}/settings`, { guestsWait: false })).status).toBe(200);
  return { ...m, token: m.guestUrl.split("/m/")[1] as string };
}
const roomOf = async (id: string) => (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, id)).get())!.room;
const person = (name: string): CallParticipant => ({ identity: `member-${name}`, name, joinedAt: null });
const guest = () => new Client(ctx.app);
const row = (id: string) => ctx.db.select().from(meetings).where(eq(meetings.id, id)).get();

describe("a) one Admit for one waiting guest", () => {
  beforeEach(async () => { await setup(); });

  it("asking again with the request this browser holds is the same request, not a second one", async () => {
    const m = await meeting();
    const g = guest();
    const first = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace Hopper" })).body;
    expect(first.status).toBe("pending");
    const again = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace Hopper", lobbyId: first.lobbyId })).body;
    expect(again.lobbyId).toBe(first.lobbyId);
    const all = await ctx.db.select().from(meetingLobby).where(eq(meetingLobby.meetingId, m.id)).all();
    expect(all).toHaveLength(1);
    const list = (await c.get(`/api/meeting-lobby/${m.id}`)).body;
    expect(list.waiting).toHaveLength(1);
  });

  it("an old page that asks twice still shows one row, and one Admit lets the guest in on either request", async () => {
    const m = await meeting();
    const g = guest();
    const a = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace Hopper" })).body;
    const b = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "grace  hopper" })).body;
    expect(b.lobbyId).not.toBe(a.lobbyId);
    const list = (await c.get(`/api/meeting-lobby/${m.id}`)).body;
    expect(list.waiting).toHaveLength(1);
    expect(list.waiting[0].id).toBe(b.lobbyId); // the newest request, the one the guest's page waits on
    const d = (await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId: a.lobbyId, decision: "admit" })).body;
    expect(d.ids.sort()).toEqual([a.lobbyId, b.lobbyId].sort());
    for (const id of [a.lobbyId, b.lobbyId]) expect((await g.get(`/api/public/meeting-lobby/${m.token}/${id}`)).body.status).toBe("admitted");
    expect((await c.get(`/api/meeting-lobby/${m.id}`)).body.waiting).toHaveLength(0);
    // Joining with the admitted request works without another Admit.
    const j = await g.post(`/api/public/meetings/${m.token}/join`, { name: "Grace Hopper", lobbyId: b.lobbyId });
    expect(j.status).toBe(200);
  });

  it("an expired or renamed earlier request is closed when the new one is made; an admitted one stays admitted", async () => {
    const m = await meeting();
    const g = guest();
    const a = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace" })).body;
    const b = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace H", lobbyId: a.lobbyId })).body;
    expect(b.lobbyId).not.toBe(a.lobbyId);
    expect((await ctx.db.select().from(meetingLobby).where(eq(meetingLobby.id, a.lobbyId)).get())!.status).toBe("denied");
    expect((await c.get(`/api/meeting-lobby/${m.id}`)).body.waiting.map((w: { id: string }) => w.id)).toEqual([b.lobbyId]);
    await c.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId: b.lobbyId, decision: "admit" });
    const back = (await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace H", lobbyId: b.lobbyId })).body;
    expect(back).toMatchObject({ lobbyId: b.lobbyId, status: "admitted" });
  });

  it("another meeting's request id is ignored, and two different names stay two guests", async () => {
    const m1 = await meeting();
    const m2 = await meeting({ title: "Other" });
    const g = guest();
    const a = (await g.post(`/api/public/meeting-lobby/${m1.token}`, { name: "Ada" })).body;
    const b = (await g.post(`/api/public/meeting-lobby/${m2.token}`, { name: "Ada", lobbyId: a.lobbyId })).body;
    expect(b.lobbyId).not.toBe(a.lobbyId);
    await g.post(`/api/public/meeting-lobby/${m1.token}`, { name: "Alan" });
    expect((await c.get(`/api/meeting-lobby/${m1.id}`)).body.waiting).toHaveLength(2);
  });

  it("collapses twin rows by name", () => {
    const at = (s: number) => new Date(1_000 * s);
    const out = oneRowPerGuest([{ id: "1", guestName: "Sam", createdAt: at(1) }, { id: "2", guestName: "Ann", createdAt: at(2) }, { id: "3", guestName: " sam ", createdAt: at(3) }]);
    expect(out.map((r) => r.id)).toEqual(["3", "2"]);
    expect(out[0].createdAt).toEqual(at(1));
    expect(sameGuestName("Grace  Hopper", "grace hopper")).toBe(true);
    expect(sameGuestName("Grace", "Grace H")).toBe(false);
  });
});

describe("d) meeting links that keep working", () => {
  beforeEach(async () => { await setup(); });

  it("a room that empties for a moment (a reload, a network switch) does not end the meeting", async () => {
    const m = await meeting();
    const room = await roomOf(m.id);
    rooms.set(room, [person("Olive Owner")]);
    tick = 11_000;
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("live");
    rooms.set(room, []);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("waiting");
    rooms.set(room, [person("Olive Owner")]);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("live");
    expect((await row(m.id))!.status).toBe("scheduled");
    const g = guest();
    expect((await g.get(`/api/public/meetings/${m.token}`)).body.meeting.status).toBe("scheduled");
  });

  it("a room that stays empty past the grace ends the meeting, and the link stays ended (no rejoin)", async () => {
    const m = await meeting({ title: "Design review" }, { guestsWait: false });
    const room = await roomOf(m.id);
    rooms.set(room, [person("Olive Owner")]);
    tick = 11_000;
    await c.get(`/api/chat/calls/${m.id}`);
    rooms.set(room, []);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("waiting");
    tick = CALL_EMPTY_GRACE_MS;
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("ended");
    expect((await row(m.id))!.status).toBe("ended");
    // The 10 Nov rule: nobody gets back in, member or guest.
    expect((await c.post(`/api/meetings/${m.id}/join`)).status).toBe(409);
    const g = guest();
    expect((await g.get(`/api/public/meetings/${m.token}`)).body.meeting.status).toBe("ended");
    expect((await g.post(`/api/public/meetings/${m.token}/join`, { name: "Grace" })).status).toBe(409);
    expect((await g.post(`/api/public/meeting-lobby/${m.token}`, { name: "Grace" })).status).toBe(409);
  });

  it("a chat call still ends at once when the last person presses Leave", async () => {
    const g = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    rooms.set(await roomOf(call.meeting.id), [person("Olive Owner")]);
    tick = 11_000;
    await c.get(`/api/chat/calls/${call.meeting.id}`);
    rooms.set(await roomOf(call.meeting.id), []);
    const left = await c.post(`/api/chat/calls/${call.meeting.id}/left`, {});
    expect(left.body.state).toBe("ended");
    expect((await row(call.meeting.id))!.status).toBe("ended");
  });

  it("a weekly series keeps its link: closed after this week's call, open again for next week's", async () => {
    // Thursday 12 Nov 2026, 01:00 UTC: weekly on Thursdays at 02:00 UTC.
    const startsAt = new Date(clock + 3600_000).toISOString();
    const m = await meeting({ title: "Weekly sync", startsAt, durationMin: 30, recurrence: { days: ["th"], timezone: "UTC" } }, { guestsWait: false });
    expect(m.recurrence).toBeTruthy();
    const room = await roomOf(m.id);
    clock = Date.parse(startsAt) - 60_000;
    rooms.set(room, [person("Olive Owner")]);
    tick = 11_000;
    await c.get(`/api/chat/calls/${m.id}`);
    rooms.set(room, []);
    await c.get(`/api/chat/calls/${m.id}`);
    tick = CALL_EMPTY_GRACE_MS;
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("ended");
    const after = (await row(m.id))!;
    expect(after.status).toBe("scheduled"); // the series itself is not ended
    expect(after.endedAt).toBeTruthy();
    const g = guest();
    expect((await g.get(`/api/public/meetings/${m.token}`)).body.meeting.status).toBe("ended");
    expect((await g.post(`/api/public/meetings/${m.token}/join`, { name: "Grace" })).status).toBe(409);
    // Next Thursday, a few minutes before it starts: the same link works again.
    tick = 1000;
    clock = Date.parse(startsAt) + 7 * 86_400_000 - 5 * 60_000;
    expect((await g.get(`/api/public/meetings/${m.token}`)).body.meeting.status).toBe("scheduled");
    expect((await g.post(`/api/public/meetings/${m.token}/join`, { name: "Grace" })).status).toBe(200);
    expect((await c.post(`/api/meetings/${m.id}/join`)).status).toBe(200);
  });

  it("closedReason: one off, cancelled, and a series between meetings", () => {
    const base = { startsAt: new Date("2026-11-12T02:00:00Z"), recurrence: null, recurrenceTz: null, endedAt: null };
    const now = new Date("2026-11-12T03:00:00Z");
    expect(closedReason({ ...base, status: "scheduled" }, now)).toBeNull();
    expect(closedReason({ ...base, status: "ended" }, now)).toBe("ended");
    expect(closedReason({ ...base, status: "cancelled" }, now)).toBe("cancelled");
    const series = { ...base, status: "scheduled", recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH", recurrenceTz: "UTC", endedAt: new Date("2026-11-12T02:40:00Z") };
    expect(closedReason(series, now)).toBe("ended");
    expect(closedReason(series, new Date(Date.parse("2026-11-19T02:00:00Z") - JOIN_EARLY_MS + 1000))).toBeNull();
  });
});

describe("c) the account and workspace a meeting opens as", () => {
  beforeEach(async () => { await setup(); });

  it("a meeting from another of the person's workspaces names that workspace instead of 'not found'", async () => {
    const m = await meeting({ title: "Board meeting" });
    const second = (await c.post("/api/account/workspaces", { name: "Second Co" })).body.id as string;
    expect(second).toBeTruthy();
    expect((await c.post(`/api/account/workspaces/${second}/switch`)).status).toBe(200);
    const r = await c.get(`/api/meetings/${m.id}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("meeting_in_other_workspace");
    expect(r.body.error.details.workspace.name).toBeTruthy();
    expect((await c.post(`/api/meetings/${m.id}/join`)).body.error.code).toBe("meeting_in_other_workspace");
    // Someone who is not a member of that workspace learns nothing.
    const stranger = new Client(ctx.app);
    await stranger.signup("x@other.io", "Xena");
    const s = await stranger.get(`/api/meetings/${m.id}`);
    expect(s.status).toBe(404);
    expect(s.body.error.code).not.toBe("meeting_in_other_workspace");
  });

  it("the app handoff keeps the page it asked for when the browser keeps its own account", () => {
    expect(accountKept("/app/meetings/mtg_1")).toBe("/app/meetings/mtg_1?account=kept");
    expect(accountKept("/app/meetings/mtg_1?join=1")).toBe("/app/meetings/mtg_1?join=1&account=kept");
    expect(accountKept("/app/docs#top")).toBe("/app/docs?account=kept#top");
  });
});

describe("b) the call carries on while moving around the app", () => {
  const conn = () => { const c2 = { disconnect: () => { c2.closed = true; }, closed: false }; return c2 as CallConnection & { closed: boolean }; };
  const join = { url: "wss://x", token: "t", room: "r" };
  beforeEach(() => resetCallSessionForTests());

  it("leaving the meeting page moves the call to the floating window, coming back shows it full again", () => {
    const k = conn();
    startCallSession({ meetingId: "m1", title: "Sync", path: "/app/meetings/m1", join, view: "full", connection: k });
    setCallState(k, "connected");
    meetingPageClosed("m1");
    expect(getCallSession()).toMatchObject({ meetingId: "m1", view: "dock", state: "connected" });
    expect(k.closed).toBe(false);
    meetingPageOpened("m1");
    expect(getCallSession()?.view).toBe("full");
    expect(k.closed).toBe(false);
  });

  it("one call per tab: the same meeting is never joined twice; another meeting hangs up the first", () => {
    const a = conn();
    startCallSession({ meetingId: "m1", title: "A", path: "/a", join, view: "dock", connection: a });
    const again = startCallSession({ meetingId: "m1", title: "A", path: "/a", join, view: "full", connection: conn() });
    expect(again.started).toBe(false);
    expect(again.session.connection).toBe(a);
    expect(getCallSession()?.view).toBe("full");
    const other = startCallSession({ meetingId: "m2", title: "B", path: "/b", join, view: "full", connection: conn() });
    expect(other.started).toBe(true);
    expect(other.replaced?.meetingId).toBe("m1");
    expect(a.closed).toBe(true);
  });

  it("a call that failed to connect is dropped instead of moving to the window; Leave hangs up", () => {
    const a = conn();
    startCallSession({ meetingId: "m1", title: "A", path: "/a", join, view: "full", connection: a });
    setCallState(a, "failed", "no route");
    expect(sessionFor("m1")).toBeNull();
    meetingPageClosed("m1");
    expect(getCallSession()).toBeNull();
    const b = conn();
    startCallSession({ meetingId: "m2", title: "B", path: "/b", join, view: "full", connection: b });
    setCallView("m2", "dock");
    expect(endCallSession("m2")?.meetingId).toBe("m2");
    expect(b.closed).toBe(true);
    expect(getCallSession()).toBeNull();
  });

  it("news from a call that was replaced is ignored", () => {
    const a = conn();
    startCallSession({ meetingId: "m1", title: "A", path: "/a", join, view: "full", connection: a });
    const b = conn();
    startCallSession({ meetingId: "m2", title: "B", path: "/b", join, view: "full", connection: b });
    setCallState(a, "failed");
    expect(getCallSession()).toMatchObject({ meetingId: "m2", state: "connecting" });
  });

  it("the floating window fits a 375 px phone screen", () => {
    expect(dockSize(DOCK_SIZE, { w: 375, h: 667 })).toEqual({ w: 359, h: 380 });
    expect(dockSize(DOCK_SIZE, { w: 1440, h: 900 })).toEqual(DOCK_SIZE);
    expect(dockSize({ w: 900, h: 900 }, { w: 320, h: 500 })).toEqual({ w: 304, h: 360 });
  });
});
