/**
 * Round 23 (R23.3): who is in a chat call right now, read from the video service, and the call
 * notifications. No D1 write per poll: participant lists are cached in memory per isolate for
 * CALL_CACHE_MS, and the only write is marking a call ended, at most once per call.
 */
import { and, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatMembers, meetings, members } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { guestChannel, visibleChannel, type GuestViewer } from "./chat";
import { notify } from "./notify";
import { closedReason } from "./meeting-open-meet";
import { liveMinutes, meetingMinutes, minutesState, participantMinutes, recordMeetingMinutes, type MinutesState, type SeenPerson } from "./meeting-minutes-r34";

export interface CallParticipant { identity: string; name: string; joinedAt: number | null }
/** Lists the people connected to a video room. Injectable (Deps.callRooms) so tests fake it. */
export interface CallRooms {
  list(room: string): Promise<CallParticipant[]>;
  /** Review Z8, Z9: disconnects one person from a room (nothing when they are not in it). */
  remove?(room: string, identity: string): Promise<void>;
}

/** How long one room's participant list is reused before asking the video service again. */
export const CALL_CACHE_MS = 10_000;
/** Calls started in a channel this recently show live presence. Older cards are plain. */
export const CALL_WINDOW_MS = 6 * 3600_000;
/** Channels with up to this many members notify each of them when a call starts. Bigger ones get only the card. */
export const CALL_NOTIFY_MAX_MEMBERS = 8;
/**
 * MEET fixes (12 Nov 2026): a room seen empty ends the call only after it stayed empty this long. A page
 * reload, a phone switching networks or a short drop leaves the room for a few seconds; before this, one
 * empty read in that gap ended the meeting for good and its link stopped working. The last person
 * pressing Leave still ends it at once (leftCall), and an ended meeting stays ended (no rejoin, 10 Nov).
 */
export const CALL_EMPTY_GRACE_MS = 45_000;
/** A series' call is marked ended at most once in this window (two isolates reading the same empty room). */
const SERIES_END_DEDUPE_MS = 10 * 60_000;

const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);

// ---------------------------------------------------------------- the video service

/** The LiveKit RoomService with the workspace's meeting keys. A room that doesn't exist yet has nobody in it. */
export function livekitRooms(cfg: { url: string; apiKey: string; apiSecret: string }): CallRooms {
  let client: Promise<import("livekit-server-sdk").RoomServiceClient> | null = null;
  return {
    async list(room) {
      client ??= import("livekit-server-sdk").then(({ RoomServiceClient }) => new RoomServiceClient(cfg.url.replace(/^ws(s?):\/\//, "http$1://"), cfg.apiKey, cfg.apiSecret));
      try {
        const ps = await (await client).listParticipants(room);
        return ps.map((p) => ({ identity: p.identity, name: p.name || p.identity, joinedAt: p.joinedAt ? Number(p.joinedAt) * 1000 : null }));
      } catch (err) {
        if (/not.?found|does not exist/i.test(String((err as Error)?.message ?? err))) return [];
        throw err;
      }
    },
    async remove(room, identity) {
      client ??= import("livekit-server-sdk").then(({ RoomServiceClient }) => new RoomServiceClient(cfg.url.replace(/^ws(s?):\/\//, "http$1://"), cfg.apiKey, cfg.apiSecret));
      try {
        await (await client).removeParticipant(room, identity);
      } catch (err) {
        if (/not.?found|does not exist/i.test(String((err as Error)?.message ?? err))) return;
        throw err;
      }
    },
  };
}

/**
 * Local test rooms for E2E (CALLS_TEST_HOOK, refused in production by loadConfig): the test sets
 * who is in a meeting's room through a session route, and presence reads it back.
 */
export const testRooms = (() => {
  const rooms = new Map<string, CallParticipant[]>();
  return {
    list: async (room: string) => rooms.get(room) ?? [], set: (room: string, ps: CallParticipant[]) => void rooms.set(room, ps),
    remove: async (room: string, identity: string) => void rooms.set(room, (rooms.get(room) ?? []).filter((p) => p.identity !== identity)),
  };
})();

const livekitByUrl = new Map<string, CallRooms>();
/** The room service for this workspace, or null when video is off (presence then answers enabled: false). */
export function roomsFor(deps: Deps): CallRooms | null {
  if (deps.callRooms) return deps.callRooms;
  if (deps.config.callsTestHook) return testRooms;
  const cfg = deps.config.meetings;
  if (!cfg) return null;
  let r = livekitByUrl.get(cfg.url + cfg.apiKey);
  if (!r) { r = livekitRooms(cfg); livekitByUrl.set(cfg.url + cfg.apiKey, r); }
  return r;
}

// Per isolate: one in flight or recent read per room, and rooms seen with people (to tell "ended" from "not joined yet").
const cache = new Map<string, { at: number; value: Promise<CallParticipant[]> }>();
const seen = new Set<string>();
// R34 (MB-171): per room, each person's first and last sighting, so the call's participant-minutes are known at its end.
const usageSeen = new Map<string, Map<string, SeenPerson>>();
export function clearCallCache() { cache.clear(); seen.clear(); usageSeen.clear(); }

function noteUsage(room: string, ps: CallParticipant[], now: number) {
  let people = usageSeen.get(room);
  if (!people) {
    people = new Map();
    usageSeen.set(room, people);
    if (usageSeen.size > 2000) usageSeen.delete(usageSeen.keys().next().value!);
  }
  for (const p of ps) {
    const had = people.get(p.identity);
    const first = Math.min(had?.first ?? now, p.joinedAt ?? now);
    people.set(p.identity, { first, last: now });
  }
}

/** Test seam: what this isolate saw of a room. */
export function usageSeenFor(room: string) { return usageSeen.get(room); }

async function participants(deps: Deps, rooms: CallRooms, room: string, fresh = false) {
  const now = deps.now().getTime();
  const hit = cache.get(room);
  if (!fresh && hit && now - hit.at < CALL_CACHE_MS) return hit.value;
  const value = rooms.list(room);
  cache.set(room, { at: now, value });
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= CALL_CACHE_MS) cache.delete(k);
  try {
    const ps = await value;
    if (ps.length) { seen.add(room); if (seen.size > 2000) seen.delete(seen.values().next().value!); noteUsage(room, ps, deps.now().getTime()); }
    return ps;
  } catch (err) {
    cache.delete(room);
    throw err;
  }
}

/** Round 31: who is in a room now with when each joined (cached like presence). Empty when video is off. */
export async function roomParticipants(deps: Deps, room: string): Promise<CallParticipant[]> {
  const rooms = roomsFor(deps);
  return rooms ? participants(deps, rooms, room) : [];
}

// ---------------------------------------------------------------- presence

type MeetingRow = typeof meetings.$inferSelect;
export type CallState = "live" | "waiting" | "ended";
export interface CallStatus {
  meetingId: string; title: string; channelId: string | null; state: CallState;
  /** Round 31: the call's notes doc, once someone joined (null before). */
  docId: string | null;
  participants: { name: string }[]; count: number;
  startedAt: string; endedAt: string | null; durationMin: number | null;
  /** R34 (MB-171): the workspace's call minutes this month, on a live call when a cap applies (else absent). */
  minutes?: MinutesState;
}

/**
 * R34 (MB-171): the call's participant-minutes from what this isolate saw. A call another isolate watched counts
 * its length since it started, capped at 6 hours, for one person (the least it can have been).
 */
export function endedCallMinutes(m: { startsAt: Date }, people: Map<string, SeenPerson> | undefined, now: number) {
  if (people?.size) return participantMinutes(people.values());
  return Math.min(360, Math.max(1, Math.ceil((now - m.startsAt.getTime()) / 60_000)));
}

/** One write, only while the meeting is still scheduled: a second isolate or a repeat read writes nothing. */
async function markEnded(deps: Deps, m: MeetingRow) {
  const now = deps.now();
  // MEET fixes: a weekly series stays scheduled; endedAt closes its link until the next meeting (meeting-open-meet.ts).
  // Still one write per call: a racing isolate finds endedAt already set for this meeting in the series.
  const series = !!m.recurrence;
  const done = await deps.db.update(meetings).set(series ? { endedAt: now, emptySince: null } : { status: "ended", endedAt: now, emptySince: null })
    .where(and(eq(meetings.id, m.id), eq(meetings.status, "scheduled"), ...(series ? [or(isNull(meetings.endedAt), lt(meetings.endedAt, new Date(now.getTime() - SERIES_END_DEDUPE_MS)))] : [])))
    .returning({ id: meetings.id });
  if (done.length) { if (!series) m.status = "ended"; m.endedAt = now; m.emptySince = null; }
  // R24 polish: recipes listening for meeting_ended hear a call that emptied too. A failed rule never breaks the call status.
  if (done.length) await (await import("./automations-r24-events")).runCallEnded(deps, m).catch(() => 0);
  // R34 (MB-171): one counter upsert per call end. A failed count never breaks the call status.
  if (done.length) {
    await recordMeetingMinutes(deps, m.orgId, endedCallMinutes(m, usageSeen.get(m.room), now.getTime())).catch(() => 0);
    usageSeen.delete(m.room);
  }
  return done.length > 0;
}

/**
 * True once a room has read empty for CALL_EMPTY_GRACE_MS; the first empty read starts the wait. Wave 3 review Y4: the
 * start is the meeting's empty_since in D1, not this isolate's memory (an isolate's own first empty read could be from
 * long before, with the call live since on other isolates). One conditional write when the wait starts.
 */
export async function emptyLongEnough(deps: Deps, m: MeetingRow, now: Date) {
  if (m.emptySince) return now.getTime() - m.emptySince.getTime() >= CALL_EMPTY_GRACE_MS;
  const set = await deps.db.update(meetings).set({ emptySince: now }).where(and(eq(meetings.id, m.id), isNull(meetings.emptySince))).returning({ id: meetings.id });
  if (set.length) { m.emptySince = now; return CALL_EMPTY_GRACE_MS <= 0; }
  // Another read started the wait a moment ago: its start counts.
  const row = await deps.db.select({ emptySince: meetings.emptySince }).from(meetings).where(eq(meetings.id, m.id)).get();
  m.emptySince = row?.emptySince ?? now;
  return now.getTime() - m.emptySince.getTime() >= CALL_EMPTY_GRACE_MS;
}

/** Y4: people are in the room: a wait for it to stay empty starts again next time. One write, only when one was running. */
async function clearEmpty(deps: Deps, m: MeetingRow) {
  if (!m.emptySince) return;
  m.emptySince = null;
  await deps.db.update(meetings).set({ emptySince: null }).where(eq(meetings.id, m.id)).catch(() => undefined);
}

async function statusOf(deps: Deps, rooms: CallRooms | null, m: MeetingRow, fresh = false): Promise<CallStatus> {
  const base = { meetingId: m.id, title: m.title, channelId: m.channelId ?? null, docId: m.docId ?? null, startedAt: m.startsAt.toISOString() };
  const ended = (): CallStatus => {
    const end = m.endedAt ?? deps.now();
    return { ...base, state: "ended", participants: [], count: 0, endedAt: m.endedAt?.toISOString() ?? null, durationMin: Math.max(1, Math.round((end.getTime() - m.startsAt.getTime()) / 60_000)) };
  };
  if (closedReason(m, deps.now()) || !rooms) return closedReason(m, deps.now()) ? ended() : { ...base, state: "waiting", participants: [], count: 0, endedAt: null, durationMin: null };
  const ps = await participants(deps, rooms, m.room, fresh);
  if (ps.length) {
    await clearEmpty(deps, m);
    const live: CallStatus = { ...base, state: "live", participants: ps.map((p) => ({ name: p.name })), count: ps.length, endedAt: null, durationMin: null };
    // R34 (MB-171): reads only (cached 30 s); the call shows a warning at 80% and when 5 minutes remain.
    const mm = await meetingMinutes(deps, m.orgId).catch(() => null);
    if (mm && mm.cap !== null) live.minutes = minutesState(mm.used + liveMinutes(ps.map((p) => p.joinedAt), deps.now().getTime()), mm.cap, deps.now());
    return live;
  }
  // Empty after this isolate saw people in it, and still empty after the grace: the call is over. Write once.
  if (seen.has(m.room) && (await emptyLongEnough(deps, m, deps.now())) && (await markEnded(deps, m))) { seen.delete(m.room); return ended(); }
  return { ...base, state: "waiting", participants: [], count: 0, endedAt: null, durationMin: null };
}

async function channelCalls(deps: Deps, orgId: string, channelId: string) {
  const since = new Date(deps.now().getTime() - CALL_WINDOW_MS);
  return deps.db.select().from(meetings)
    .where(and(eq(meetings.orgId, orgId), gte(meetings.startsAt, since), eq(meetings.channelId, channelId), isNull(meetings.deletedAt)))
    .orderBy(desc(meetings.startsAt)).limit(5);
}

async function presentChannel(deps: Deps, orgId: string, channelId: string) {
  const rooms = roomsFor(deps);
  const rows = (await channelCalls(deps, orgId, channelId)).filter((m) => m.status !== "cancelled");
  const calls = await Promise.all(rows.map((m) => statusOf(deps, rooms, m)));
  return { enabled: !!rooms, channelId, live: calls.find((c) => c.state === "live") ?? null, calls };
}

/** Calls in a channel or DM from the last few hours, with who is in each now. 404 when the actor can't open the channel. */
export async function channelCallStatus(deps: Deps, a: SuiteActor, channelId: string) {
  const c = await visibleChannel(deps, a, channelId);
  return presentChannel(deps, a.orgId, c.id);
}

/** The same for a guest of a shared channel: only channels shared with them. */
export async function guestChannelCallStatus(deps: Deps, g: GuestViewer, channelId: string) {
  const c = await guestChannel(deps, g, channelId).catch(() => { throw notFound(); });
  return presentChannel(deps, g.orgId, c.id);
}

export async function visibleMeeting(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.orgId, a.orgId), eq(meetings.id, meetingId), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  // A call from a DM or private channel is visible only to the people who can open that chat.
  if (m.channelId) await visibleChannel(deps, a, m.channelId).catch(() => { throw notFound("Meeting"); });
  return m;
}

/** Review Z8: disconnects one person from a meeting's room, best effort (a failure is reported, never thrown). */
export async function removeFromRoom(deps: Deps, room: string, identity: string): Promise<boolean> {
  const r = roomsFor(deps);
  if (!r?.remove) return false;
  try { await r.remove(room, identity); return true; } catch (err) { deps.reportError?.(err, { where: "calls.removeFromRoom" }); return false; }
}

/**
 * Final review F2: disconnects everyone in a room whose identity matches (all tabs of one guest). Reads the room fresh
 * from the video service. Best effort: a failure is reported, never thrown. Returns how many were disconnected.
 */
export async function removeFromRoomWhere(deps: Deps, room: string, match: (identity: string) => boolean): Promise<number> {
  const r = roomsFor(deps);
  if (!r?.remove) return 0;
  cache.delete(room);
  let ps: CallParticipant[];
  try { ps = await r.list(room); } catch (err) { deps.reportError?.(err, { where: "calls.removeFromRoomWhere" }); return 0; }
  let n = 0;
  for (const p of ps) if (match(p.identity) && (await removeFromRoom(deps, room, p.identity))) n++;
  cache.delete(room);
  return n;
}

/**
 * Review Z9: a member removed from a workspace, or whose sessions were revoked, leaves every call that may be live there
 * at once (their room token would otherwise last until it expires). Calls that may be live: meetings not ended or
 * cancelled that started in the last CALL_WINDOW_MS or repeat. Best effort, at most 50 rooms.
 */
export async function disconnectFromCalls(deps: Deps, orgId: string, identity: string) {
  if (!roomsFor(deps)?.remove) return 0;
  const since = new Date(deps.now().getTime() - CALL_WINDOW_MS);
  const live = await deps.db.select({ room: meetings.room }).from(meetings)
    .where(and(eq(meetings.orgId, orgId), isNull(meetings.deletedAt), eq(meetings.status, "scheduled"), or(gte(meetings.startsAt, since), isNotNull(meetings.recurrence)), lt(meetings.startsAt, new Date(deps.now().getTime() + CALL_WINDOW_MS))))
    .limit(50).all();
  let n = 0;
  for (const m of live) if (await removeFromRoom(deps, m.room, identity)) n++;
  return n;
}

/** One meeting's live status (any meeting, not only chat calls). */
export async function meetingCallStatus(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await visibleMeeting(deps, a, meetingId);
  const rooms = roomsFor(deps);
  return { enabled: !!rooms, ...(await statusOf(deps, rooms, m)) };
}

/**
 * A person's client left a call: read the room fresh, and when nobody is left mark the call ended
 * (one write, never repeated). Only for calls started from chat, and only for people.
 */
export async function leftCall(deps: Deps, a: SuiteActor, meetingId: string) {
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "Only people join calls.");
  const m = await visibleMeeting(deps, a, meetingId);
  const rooms = roomsFor(deps);
  if (!rooms || !m.channelId || closedReason(m, deps.now())) return { enabled: !!rooms, ...(await statusOf(deps, rooms, m)) };
  const ps = await participants(deps, rooms, m.room, true);
  if (!ps.length && (await markEnded(deps, m))) seen.delete(m.room);
  return { enabled: true, ...(await statusOf(deps, rooms, m)) };
}

/** E2E only: sets who is in a meeting's room. 404 unless CALLS_TEST_HOOK is on (never in production). */
export async function setTestRoom(deps: Deps, a: SuiteActor, meetingId: string, people: { name: string }[]) {
  if (!deps.config.callsTestHook) throw notFound();
  const m = await visibleMeeting(deps, a, meetingId);
  testRooms.set(m.room, people.map((p, i) => ({ identity: `test-${i}`, name: p.name, joinedAt: deps.now().getTime() })));
  cache.delete(m.room);
  return { ok: true };
}

// ---------------------------------------------------------------- notifications

/**
 * Tells people a call started, once per call (the 60 second dedupe in startChannelCall means a
 * second presser joins and reaches nobody). DMs ring every other member; channels with up to
 * CALL_NOTIFY_MAX_MEMBERS members ring them too; bigger channels get only the card, so a busy
 * #general doesn't buzz everyone's phone. One notification row per person told.
 */
export async function notifyCallStarted(deps: Deps, a: SuiteActor, c: { id: string; kind: string; name: string; orgId: string }, messageId: string) {
  if (!a.userId) return 0;
  const members = (await deps.db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, c.id))).map((r) => r.userId);
  if (c.kind !== "dm" && members.length > CALL_NOTIFY_MAX_MEMBERS) return 0;
  const who = a.name || a.email || "Someone";
  const title = c.kind === "dm" ? `${who} is calling you` : `${who} started a call in #${c.name}`;
  let n = 0;
  for (const u of new Set(members)) {
    if (u === a.userId) continue;
    await notify(deps, c.orgId, u, { type: "call.started", entityType: "chat_message", entityId: messageId, title, actorName: who });
    n++;
  }
  return n;
}

/** Review Z9: the same for every workspace a person is in (their sessions were revoked). */
export async function disconnectUserFromCalls(deps: Deps, userId: string) {
  const orgs = await deps.db.select({ orgId: members.organizationId }).from(members).where(eq(members.userId, userId)).limit(50).all();
  for (const o of orgs) await disconnectFromCalls(deps, o.orgId, `member-${userId}`).catch((err) => deps.reportError?.(err, { where: "calls.disconnectUser" }));
}
