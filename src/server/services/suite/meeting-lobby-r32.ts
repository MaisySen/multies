/**
 * Round 32: the meeting waiting room. A meeting's "Guests wait to be let in" setting (on by default)
 * holds people who open the guest link: they ask to join with their name, wait on a lobby screen,
 * and get no room token until a workspace member admits them. Members see the requests in the call
 * (Admit, Deny, Admit all). One write per request and one per decision; the lobby screen and the
 * host's list only read. Also the guest's "Maya and 2 others are here" line before joining.
 */
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { meetingLobby, meetings } from "../../db/schema";
import { randomToken } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { roomParticipants } from "./calls";
import { assertWritable, type SuiteActor } from "./common";
import { hereText } from "@/shared/meeting-lobby";
import { closedReason, shownStatus, type OpenCheck } from "./meeting-open-meet";
import { assertMeetingVisible } from "./meeting-visibility"; // Review Z1

/** A request older than this drops off the host's list and the guest asks again. */
export const LOBBY_TTL_MS = 15 * 60_000;
/**
 * Wave 3 review Y3: an admission lets the guest in to the call it was given for, not every later meeting in a series.
 * It counts only when decided after the meeting's last call ended (endedAt) and within this long of the decision.
 */
export const ADMISSION_MAX_MS = 12 * 60 * 60_000;

/** Wave 3 review Y3: whether an admitted request still lets its guest in (this occurrence, not revoked). */
export function admissionCurrent(r: { status: string; decidedAt: Date | null }, m: { endedAt: Date | null }, now: Date): boolean {
  if (r.status !== "admitted" || !r.decidedAt) return false;
  if (m.endedAt && r.decidedAt.getTime() <= m.endedAt.getTime()) return false;
  return now.getTime() - r.decidedAt.getTime() <= ADMISSION_MAX_MS;
}
/** Pending requests one meeting holds at once. */
export const LOBBY_MAX_PENDING = 50;
/** Lobby requests one network address may make in the window (kept in memory, no limiter write). */
export const LOBBY_IP_LIMIT = 10;
export const LOBBY_IP_WINDOW_MS = 10 * 60_000;

export type LobbyStatus = "pending" | "admitted" | "denied";
/** Y3: "remove" takes back an admission already given (a guest the host put out); deny on an admitted guest changes nothing. */
export type LobbyDecision = "admit" | "deny" | "remove";

const hits = new Map<string, { n: number; resetAt: number }>();
export function clearLobbyLimits() { hits.clear(); }

/** True when this address may ask to join again; counts the attempt. */
export function lobbyAllowed(ip: string, now: number) {
  const h = hits.get(ip);
  if (!h || h.resetAt <= now) {
    hits.set(ip, { n: 1, resetAt: now + LOBBY_IP_WINDOW_MS });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return true;
  }
  if (h.n >= LOBBY_IP_LIMIT) return false;
  h.n += 1;
  return true;
}

/** A name people will see: trimmed, single spaced, 1 to 60 characters, no control characters. */
export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return null;
  return s;
}

export { hereText };

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? "";
/** Two requests under one name in one meeting are one guest asking twice (case and spacing aside). */
export const sameGuestName = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

async function byToken(deps: Deps, token: string) {
  const m = await deps.db.select({ id: meetings.id, orgId: meetings.orgId, room: meetings.room, status: meetings.status, guestLobby: meetings.guestLobby, deletedAt: meetings.deletedAt,
    endedAt: meetings.endedAt, startsAt: meetings.startsAt, recurrence: meetings.recurrence, recurrenceTz: meetings.recurrenceTz })
    .from(meetings).where(eq(meetings.guestToken, token)).get();
  if (!m || m.deletedAt) throw notFound("Meeting");
  return m;
}

function assertOpen(m: OpenCheck, now: Date) {
  const closed = closedReason(m, now);
  if (closed) throw new HttpError(409, closed === "cancelled" ? "meeting_cancelled" : "meeting_ended", closed === "cancelled" ? "This meeting was cancelled." : "This meeting has ended.");
}

async function memberMeeting(deps: Deps, actor: SuiteActor, id: string) {
  const m = await deps.db.select({ id: meetings.id, orgId: meetings.orgId, guestLobby: meetings.guestLobby, title: meetings.title, deletedAt: meetings.deletedAt, channelId: meetings.channelId, room: meetings.room })
    .from(meetings).where(and(eq(meetings.id, id), eq(meetings.orgId, actor.orgId))).get();
  if (!m || m.deletedAt) throw notFound("Meeting");
  // Review Z1: a DM's or private channel's call: only the people in that chat run its waiting room.
  await assertMeetingVisible(deps, actor, m);
  return m;
}

/**
 * Final review F2: the room identities of a guest let in through the waiting room. Everyone in a call sees identities,
 * so they never hold the request id (the secret the guest joins with): each request has its own random room key, and
 * each join adds a random suffix, so a second tab doesn't push the first one out and Remove finds every tab.
 */
export const newRoomKey = () => randomToken(12).replace(/[^A-Za-z0-9]/g, "x").slice(0, 16);
export const guestIdentityPrefix = (roomKey: string) => `guest-${roomKey}-`;
export const guestJoinIdentity = (roomKey: string) => `${guestIdentityPrefix(roomKey)}${randomToken(6).replace(/[^A-Za-z0-9]/g, "x").slice(0, 8)}`;
/** Review Z8: the identity guests admitted before F2 joined under (still disconnected by Remove). */
const legacyGuestIdentity = (lobbyId: string) => `guest-${lobbyId}`;

const who = (a: SuiteActor) => (a.agentId ? `agent:${a.agentId}` : `member:${a.userId}`);

// ---------------------------------------------------------------- guest side (no account)

/**
 * The guest asks to join. With the waiting room off the answer is admitted with no lobby id.
 *
 * MEET fixes (12 Nov 2026): one request per guest. Before this a guest who asked again (a reload, a second
 * tap, the quiet retry after 15 minutes) made a second request, the host saw two Admit buttons for one
 * person, and admitting the older one left the guest waiting on the newer one. The guest now sends the id
 * of the request it already has (previousLobbyId, the secret only that browser holds): a request still
 * waiting under the same name is answered again with no new row, an admitted one stays admitted, and a
 * stale or renamed one is closed when the new one is made, so the host only ever sees one.
 */
export async function askToJoin(deps: Deps, token: string, rawName: unknown, ip: string, previousLobbyId?: unknown) {
  const m = await byToken(deps, token);
  assertOpen(m, deps.now());
  const name = cleanGuestName(rawName);
  if (!name) throw new HttpError(422, "validation_failed", "Tell the others your name (up to 60 characters).");
  if (!m.guestLobby) return { lobbyId: null, status: "admitted" as LobbyStatus, waitingRoom: false };
  const now = deps.now();
  const prev = typeof previousLobbyId === "string" && /^lby_[A-Za-z0-9]{1,40}$/.test(previousLobbyId)
    ? await deps.db.select().from(meetingLobby).where(and(eq(meetingLobby.id, previousLobbyId), eq(meetingLobby.meetingId, m.id))).get()
    : undefined;
  if (prev) {
    const fresh = now.getTime() - prev.createdAt.getTime() <= LOBBY_TTL_MS;
    if (admissionCurrent(prev, m, now)) return { lobbyId: prev.id, status: "admitted" as LobbyStatus, waitingRoom: true };
    if (prev.status === "pending" && fresh && sameGuestName(prev.guestName, name)) return { lobbyId: prev.id, status: "pending" as LobbyStatus, waitingRoom: true };
  }
  if (!lobbyAllowed(ip || "unknown", now.getTime())) throw new HttpError(429, "rate_limited", "Too many requests to join from here. Wait a few minutes and try again.");
  const pending = await deps.db.select({ id: meetingLobby.id }).from(meetingLobby)
    .where(and(eq(meetingLobby.meetingId, m.id), eq(meetingLobby.status, "pending"), gte(meetingLobby.createdAt, new Date(now.getTime() - LOBBY_TTL_MS)))).limit(LOBBY_MAX_PENDING).all();
  if (pending.length >= LOBBY_MAX_PENDING) throw new HttpError(429, "lobby_full", "The waiting room is full. Try again in a few minutes.");
  const id = `lby_${randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
  await deps.db.insert(meetingLobby).values({ id, meetingId: m.id, orgId: m.orgId, guestName: name, status: "pending", createdAt: now, roomKey: newRoomKey() });
  // The guest's earlier request, still open: closed now so the host doesn't see the same person twice.
  if (prev?.status === "pending") {
    await deps.db.update(meetingLobby).set({ status: "denied", decidedBy: "guest:asked_again", decidedAt: now }).where(and(eq(meetingLobby.id, prev.id), eq(meetingLobby.status, "pending")));
  }
  return { lobbyId: id, status: "pending" as LobbyStatus, waitingRoom: true };
}

/** Where the guest's request stands. Read only: the lobby screen polls this every 3 seconds. */
export async function lobbyStatus(deps: Deps, token: string, lobbyId: string) {
  const m = await byToken(deps, token);
  const r = await deps.db.select().from(meetingLobby).where(and(eq(meetingLobby.id, lobbyId), eq(meetingLobby.meetingId, m.id))).get();
  if (!r) throw notFound("Request");
  // Y3: an admission from an earlier meeting in a series (or a long gone one) is over too: the guest asks again.
  const expired = (r.status === "pending" && deps.now().getTime() - r.createdAt.getTime() > LOBBY_TTL_MS) || (r.status === "admitted" && !admissionCurrent(r, m, deps.now()));
  return { status: (expired ? "expired" : r.status) as LobbyStatus | "expired", name: r.guestName, meetingStatus: shownStatus(m, deps.now()) };
}

/**
 * For guestJoin: the name to use, or a refusal when the waiting room is on and this request was not
 * admitted. With the room off it returns null and the guest's own name stands.
 */
export async function admittedGuest(deps: Deps, m: { id: string; guestLobby: boolean; endedAt: Date | null }, lobbyId: string | undefined): Promise<{ name: string; roomKey: string } | null> {
  if (!m.guestLobby) return null;
  if (!lobbyId) throw new HttpError(403, "lobby_required", "Ask to join first. Someone in the meeting lets you in.");
  const r = await deps.db.select({ status: meetingLobby.status, name: meetingLobby.guestName, decidedAt: meetingLobby.decidedAt, roomKey: meetingLobby.roomKey }).from(meetingLobby).where(and(eq(meetingLobby.id, lobbyId), eq(meetingLobby.meetingId, m.id))).get();
  if (!r) throw new HttpError(403, "lobby_required", "Ask to join first. Someone in the meeting lets you in.");
  if (r.status === "denied") throw new HttpError(403, "lobby_denied", "The host didn't let you in to this meeting.");
  if (r.status !== "admitted") throw new HttpError(403, "lobby_waiting", "Waiting for the host to let you in.");
  // Y3: admitted for an earlier meeting in the series (or too long ago): ask again.
  if (!admissionCurrent(r, m, deps.now())) throw new HttpError(403, "lobby_required", "Ask to join again. Someone in the meeting lets you in.");
  return { name: r.name, roomKey: r.roomKey ?? (await ensureRoomKey(deps, lobbyId)) };
}

/** F2: a request made before 0185 gets its room key on its first join (one conditional write, then the stored one). */
async function ensureRoomKey(deps: Deps, lobbyId: string) {
  await deps.db.update(meetingLobby).set({ roomKey: newRoomKey() }).where(and(eq(meetingLobby.id, lobbyId), isNull(meetingLobby.roomKey)));
  const row = await deps.db.select({ roomKey: meetingLobby.roomKey }).from(meetingLobby).where(eq(meetingLobby.id, lobbyId)).get();
  return row?.roomKey ?? newRoomKey();
}

/** Who is in the call, for the guest's pre-join line: first names only, and the count. */
export async function whoIsHere(deps: Deps, token: string) {
  const m = await byToken(deps, token);
  if (closedReason(m, deps.now())) return { names: [] as string[], count: 0, text: hereText([], 0) };
  const ps = await roomParticipants(deps, m.room).catch(() => []);
  const names = ps.map((p) => firstName(p.name)).filter(Boolean).slice(0, 3);
  return { names, count: ps.length, text: hereText(names, ps.length) };
}

// ---------------------------------------------------------------- members (session, API key, MCP)

/** The waiting guests (oldest first) and the setting. Expired requests are left out. */
export async function listLobby(deps: Deps, actor: SuiteActor, meetingId: string) {
  const m = await memberMeeting(deps, actor, meetingId);
  const since = new Date(deps.now().getTime() - LOBBY_TTL_MS);
  const rows = await deps.db.select().from(meetingLobby)
    .where(and(eq(meetingLobby.meetingId, m.id), eq(meetingLobby.status, "pending"), gte(meetingLobby.createdAt, since)))
    .orderBy(asc(meetingLobby.createdAt)).limit(LOBBY_MAX_PENDING).all();
  // Wave 3 review Y2: no merging by name (a stranger could ask under a waiting guest's name and ride their Admit). One
  // browser asking again sends its earlier request's id (askToJoin), which closes it, so a guest still shows once.
  return { meetingId: m.id, guestsWait: m.guestLobby, waiting: rows.map((r) => ({ id: r.id, name: r.guestName, status: r.status, askedAt: r.createdAt.toISOString() })) };
}

/**
 * Admit or deny one waiting guest, or every waiting guest with all. One write, one audit line. Y2: one request is
 * exactly that request. Y3: "remove" on an admitted request takes the admission back (the guest can't join with it again).
 */
export async function decideLobby(deps: Deps, actor: SuiteActor, meetingId: string, input: { lobbyId?: string; all?: boolean; decision: LobbyDecision }, ip?: string | null) {
  assertWritable(actor);
  const m = await memberMeeting(deps, actor, meetingId);
  const status: LobbyStatus = input.decision === "admit" ? "admitted" : "denied";
  if (input.decision === "remove" && (input.all || !input.lobbyId)) throw new HttpError(422, "validation_failed", "Say which guest to remove.");
  const now = deps.now();
  const since = new Date(now.getTime() - LOBBY_TTL_MS);
  let ids: string[];
  if (input.all) {
    ids = (await deps.db.select({ id: meetingLobby.id }).from(meetingLobby)
      .where(and(eq(meetingLobby.meetingId, m.id), eq(meetingLobby.status, "pending"), gte(meetingLobby.createdAt, since))).limit(LOBBY_MAX_PENDING).all()).map((r) => r.id);
  } else {
    if (!input.lobbyId) throw new HttpError(422, "validation_failed", "Say which guest, or all.");
    const r = await deps.db.select({ id: meetingLobby.id, status: meetingLobby.status, roomKey: meetingLobby.roomKey }).from(meetingLobby).where(and(eq(meetingLobby.id, input.lobbyId), eq(meetingLobby.meetingId, m.id))).get();
    if (!r) throw notFound("Request");
    if (input.decision === "remove") {
      if (r.status !== "admitted") return { decided: 0, status: r.status, ids: [] as string[] };
      await deps.db.update(meetingLobby).set({ status, decidedBy: who(actor), decidedAt: now }).where(and(eq(meetingLobby.id, r.id), eq(meetingLobby.status, "admitted")));
      await audit(deps.db, {
        orgId: actor.orgId, actorUserId: actor.agentId ? null : actor.userId, actorEmail: actor.email ?? null, agentId: actor.agentId ?? null,
        action: "meeting.lobby_revoked", targetType: "meeting", targetId: m.id, metadata: { lobbyId: r.id }, ip: ip ?? null,
      });
      // Review Z8, F2: and out of the call now: every tab of this guest (guest-<room key>-*), and the identity guests
      // admitted before 0185 joined under.
      const calls = await import("./calls");
      const prefix = r.roomKey ? guestIdentityPrefix(r.roomKey) : null;
      const legacy = legacyGuestIdentity(r.id);
      await calls.removeFromRoomWhere(deps, m.room, (id) => id === legacy || (!!prefix && id.startsWith(prefix)));
      return { decided: 1, status, ids: [r.id] };
    }
    if (r.status !== "pending") return { decided: 0, status: r.status, ids: [] as string[] };
    ids = [r.id];
  }
  // Up to 50 ids: well under the 100 variable limit in one statement.
  if (ids.length) {
    await deps.db.update(meetingLobby).set({ status, decidedBy: who(actor), decidedAt: now })
      .where(and(inIds(meetingLobby.id, ids), eq(meetingLobby.status, "pending")));
    await audit(deps.db, {
      orgId: actor.orgId, actorUserId: actor.agentId ? null : actor.userId, actorEmail: actor.email ?? null, agentId: actor.agentId ?? null,
      action: status === "admitted" ? "meeting.lobby_admitted" : "meeting.lobby_denied", targetType: "meeting", targetId: m.id,
      metadata: { count: ids.length, all: !!input.all }, ip: ip ?? null,
    });
  }
  return { decided: ids.length, status, ids };
}

/** Turn "Guests wait to be let in" on or off. */
export async function setGuestsWait(deps: Deps, actor: SuiteActor, meetingId: string, on: boolean, ip?: string | null) {
  assertWritable(actor);
  const m = await memberMeeting(deps, actor, meetingId);
  if (m.guestLobby !== on) {
    await deps.db.update(meetings).set({ guestLobby: on }).where(eq(meetings.id, m.id));
    await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.agentId ? null : actor.userId, actorEmail: actor.email ?? null, agentId: actor.agentId ?? null, action: on ? "meeting.lobby_on" : "meeting.lobby_off", targetType: "meeting", targetId: m.id, ip: ip ?? null });
  }
  return { meetingId: m.id, guestsWait: on };
}
