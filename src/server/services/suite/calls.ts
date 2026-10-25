/**
 * Round 23 (R23.3): who is in a chat call right now, read from the video service, and the call
 * notifications. No D1 write per poll: participant lists are cached in memory per isolate for
 * CALL_CACHE_MS, and the only write is marking a call ended, at most once per call.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatMembers, meetings } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { guestChannel, visibleChannel, type GuestViewer } from "./chat";
import { notify } from "./notify";

export interface CallParticipant { identity: string; name: string; joinedAt: number | null }
/** Lists the people connected to a video room. Injectable (Deps.callRooms) so tests fake it. */
export interface CallRooms { list(room: string): Promise<CallParticipant[]> }

/** How long one room's participant list is reused before asking the video service again. */
export const CALL_CACHE_MS = 10_000;
/** Calls started in a channel this recently show live presence. Older cards are plain. */
export const CALL_WINDOW_MS = 6 * 3600_000;
/** Channels with up to this many members notify each of them when a call starts. Bigger ones get only the card. */
export const CALL_NOTIFY_MAX_MEMBERS = 8;

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
  };
}

/**
 * Local test rooms for E2E (CALLS_TEST_HOOK, refused in production by loadConfig): the test sets
 * who is in a meeting's room through a session route, and presence reads it back.
 */
export const testRooms = (() => {
  const rooms = new Map<string, CallParticipant[]>();
  return { list: async (room: string) => rooms.get(room) ?? [], set: (room: string, ps: CallParticipant[]) => void rooms.set(room, ps) };
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
export function clearCallCache() { cache.clear(); seen.clear(); }

async function participants(deps: Deps, rooms: CallRooms, room: string, fresh = false) {
  const now = deps.now().getTime();
  const hit = cache.get(room);
  if (!fresh && hit && now - hit.at < CALL_CACHE_MS) return hit.value;
  const value = rooms.list(room);
  cache.set(room, { at: now, value });
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= CALL_CACHE_MS) cache.delete(k);
  try {
    const ps = await value;
    if (ps.length) { seen.add(room); if (seen.size > 2000) seen.delete(seen.values().next().value!); }
    return ps;
  } catch (err) {
    cache.delete(room);
    throw err;
  }
}

// ---------------------------------------------------------------- presence

type MeetingRow = typeof meetings.$inferSelect;
export type CallState = "live" | "waiting" | "ended";
export interface CallStatus {
  meetingId: string; title: string; channelId: string | null; state: CallState;
  participants: { name: string }[]; count: number;
  startedAt: string; endedAt: string | null; durationMin: number | null;
}

/** One write, only while the meeting is still scheduled: a second isolate or a repeat read writes nothing. */
async function markEnded(deps: Deps, m: MeetingRow) {
  const now = deps.now();
  const done = await deps.db.update(meetings).set({ status: "ended", endedAt: now })
    .where(and(eq(meetings.id, m.id), eq(meetings.status, "scheduled"))).returning({ id: meetings.id });
  if (done.length) { m.status = "ended"; m.endedAt = now; }
  return done.length > 0;
}

async function statusOf(deps: Deps, rooms: CallRooms | null, m: MeetingRow, fresh = false): Promise<CallStatus> {
  const base = { meetingId: m.id, title: m.title, channelId: m.channelId ?? null, startedAt: m.startsAt.toISOString() };
  const ended = (): CallStatus => {
    const end = m.endedAt ?? deps.now();
    return { ...base, state: "ended", participants: [], count: 0, endedAt: m.endedAt?.toISOString() ?? null, durationMin: Math.max(1, Math.round((end.getTime() - m.startsAt.getTime()) / 60_000)) };
  };
  if (m.status !== "scheduled" || !rooms) return m.status !== "scheduled" ? ended() : { ...base, state: "waiting", participants: [], count: 0, endedAt: null, durationMin: null };
  const ps = await participants(deps, rooms, m.room, fresh);
  if (ps.length) return { ...base, state: "live", participants: ps.map((p) => ({ name: p.name })), count: ps.length, endedAt: null, durationMin: null };
  // Empty after this isolate saw people in it: the call is over. Write once.
  if (seen.has(m.room) && (await markEnded(deps, m))) { seen.delete(m.room); return ended(); }
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

async function visibleMeeting(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.orgId, a.orgId), eq(meetings.id, meetingId), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  // A call from a DM or private channel is visible only to the people who can open that chat.
  if (m.channelId) await visibleChannel(deps, a, m.channelId).catch(() => { throw notFound("Meeting"); });
  return m;
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
  if (!rooms || !m.channelId || m.status !== "scheduled") return { enabled: !!rooms, ...(await statusOf(deps, rooms, m)) };
  const ps = await participants(deps, rooms, m.room, true);
  if (!ps.length) await markEnded(deps, m);
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
