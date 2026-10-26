/**
 * Round 32: the meeting waiting room. A meeting's "Guests wait to be let in" setting (on by default)
 * holds people who open the guest link: they ask to join with their name, wait on a lobby screen,
 * and get no room token until a workspace member admits them. Members see the requests in the call
 * (Admit, Deny, Admit all). One write per request and one per decision; the lobby screen and the
 * host's list only read. Also the guest's "Maya and 2 others are here" line before joining.
 */
import { and, asc, eq, gte } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { meetingLobby, meetings } from "../../db/schema";
import { randomToken } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { roomParticipants } from "./calls";
import { assertWritable, type SuiteActor } from "./common";
import { hereText } from "@/shared/meeting-lobby";

/** A request older than this drops off the host's list and the guest asks again. */
export const LOBBY_TTL_MS = 15 * 60_000;
/** Pending requests one meeting holds at once. */
export const LOBBY_MAX_PENDING = 50;
/** Lobby requests one network address may make in the window (kept in memory, no limiter write). */
export const LOBBY_IP_LIMIT = 10;
export const LOBBY_IP_WINDOW_MS = 10 * 60_000;

export type LobbyStatus = "pending" | "admitted" | "denied";
export type LobbyDecision = "admit" | "deny";

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

async function byToken(deps: Deps, token: string) {
  const m = await deps.db.select({ id: meetings.id, orgId: meetings.orgId, room: meetings.room, status: meetings.status, guestLobby: meetings.guestLobby, deletedAt: meetings.deletedAt })
    .from(meetings).where(eq(meetings.guestToken, token)).get();
  if (!m || m.deletedAt) throw notFound("Meeting");
  return m;
}

function assertOpen(status: string) {
  if (status !== "scheduled") throw new HttpError(409, status === "cancelled" ? "meeting_cancelled" : "meeting_ended", status === "cancelled" ? "This meeting was cancelled." : "This meeting has ended.");
}

async function memberMeeting(deps: Deps, actor: SuiteActor, id: string) {
  const m = await deps.db.select({ id: meetings.id, orgId: meetings.orgId, guestLobby: meetings.guestLobby, title: meetings.title, deletedAt: meetings.deletedAt })
    .from(meetings).where(and(eq(meetings.id, id), eq(meetings.orgId, actor.orgId))).get();
  if (!m || m.deletedAt) throw notFound("Meeting");
  return m;
}

const who = (a: SuiteActor) => (a.agentId ? `agent:${a.agentId}` : `member:${a.userId}`);

// ---------------------------------------------------------------- guest side (no account)

/** The guest asks to join. With the waiting room off the answer is admitted with no lobby id. */
export async function askToJoin(deps: Deps, token: string, rawName: unknown, ip: string) {
  const m = await byToken(deps, token);
  assertOpen(m.status);
  const name = cleanGuestName(rawName);
  if (!name) throw new HttpError(422, "validation_failed", "Tell the others your name (up to 60 characters).");
  if (!m.guestLobby) return { lobbyId: null, status: "admitted" as LobbyStatus, waitingRoom: false };
  const now = deps.now();
  if (!lobbyAllowed(ip || "unknown", now.getTime())) throw new HttpError(429, "rate_limited", "Too many requests to join from here. Wait a few minutes and try again.");
  const pending = await deps.db.select({ id: meetingLobby.id }).from(meetingLobby)
    .where(and(eq(meetingLobby.meetingId, m.id), eq(meetingLobby.status, "pending"), gte(meetingLobby.createdAt, new Date(now.getTime() - LOBBY_TTL_MS)))).limit(LOBBY_MAX_PENDING).all();
  if (pending.length >= LOBBY_MAX_PENDING) throw new HttpError(429, "lobby_full", "The waiting room is full. Try again in a few minutes.");
  const id = `lby_${randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
  await deps.db.insert(meetingLobby).values({ id, meetingId: m.id, orgId: m.orgId, guestName: name, status: "pending", createdAt: now });
  return { lobbyId: id, status: "pending" as LobbyStatus, waitingRoom: true };
}

/** Where the guest's request stands. Read only: the lobby screen polls this every 3 seconds. */
export async function lobbyStatus(deps: Deps, token: string, lobbyId: string) {
  const m = await byToken(deps, token);
  const r = await deps.db.select().from(meetingLobby).where(and(eq(meetingLobby.id, lobbyId), eq(meetingLobby.meetingId, m.id))).get();
  if (!r) throw notFound("Request");
  const expired = r.status === "pending" && deps.now().getTime() - r.createdAt.getTime() > LOBBY_TTL_MS;
  return { status: (expired ? "expired" : r.status) as LobbyStatus | "expired", name: r.guestName, meetingStatus: m.status };
}

/**
 * For guestJoin: the name to use, or a refusal when the waiting room is on and this request was not
 * admitted. With the room off it returns null and the guest's own name stands.
 */
export async function admittedGuest(deps: Deps, m: { id: string; guestLobby: boolean }, lobbyId: string | undefined): Promise<string | null> {
  if (!m.guestLobby) return null;
  if (!lobbyId) throw new HttpError(403, "lobby_required", "Ask to join first. Someone in the meeting lets you in.");
  const r = await deps.db.select({ status: meetingLobby.status, name: meetingLobby.guestName }).from(meetingLobby).where(and(eq(meetingLobby.id, lobbyId), eq(meetingLobby.meetingId, m.id))).get();
  if (!r) throw new HttpError(403, "lobby_required", "Ask to join first. Someone in the meeting lets you in.");
  if (r.status === "denied") throw new HttpError(403, "lobby_denied", "The host didn't let you in to this meeting.");
  if (r.status !== "admitted") throw new HttpError(403, "lobby_waiting", "Waiting for the host to let you in.");
  return r.name;
}

/** Who is in the call, for the guest's pre-join line: first names only, and the count. */
export async function whoIsHere(deps: Deps, token: string) {
  const m = await byToken(deps, token);
  if (m.status !== "scheduled") return { names: [] as string[], count: 0, text: hereText([], 0) };
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
  return { meetingId: m.id, guestsWait: m.guestLobby, waiting: rows.map((r) => ({ id: r.id, name: r.guestName, status: r.status, askedAt: r.createdAt.toISOString() })) };
}

/** Admit or deny one waiting guest, or every waiting guest with all. One write, one audit line. */
export async function decideLobby(deps: Deps, actor: SuiteActor, meetingId: string, input: { lobbyId?: string; all?: boolean; decision: LobbyDecision }, ip?: string | null) {
  assertWritable(actor);
  const m = await memberMeeting(deps, actor, meetingId);
  const status: LobbyStatus = input.decision === "admit" ? "admitted" : "denied";
  const now = deps.now();
  const since = new Date(now.getTime() - LOBBY_TTL_MS);
  let ids: string[];
  if (input.all) {
    ids = (await deps.db.select({ id: meetingLobby.id }).from(meetingLobby)
      .where(and(eq(meetingLobby.meetingId, m.id), eq(meetingLobby.status, "pending"), gte(meetingLobby.createdAt, since))).limit(LOBBY_MAX_PENDING).all()).map((r) => r.id);
  } else {
    if (!input.lobbyId) throw new HttpError(422, "validation_failed", "Say which guest, or all.");
    const r = await deps.db.select({ id: meetingLobby.id, status: meetingLobby.status }).from(meetingLobby).where(and(eq(meetingLobby.id, input.lobbyId), eq(meetingLobby.meetingId, m.id))).get();
    if (!r) throw notFound("Request");
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
