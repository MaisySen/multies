/**
 * Round 31: the live side of a call or meeting.
 *
 * Call notes: when a member enters a call, its notes doc is made once (race safe through
 * ensureNotesDocOnce) and titled "<title> notes, <date>". A call started from a chat channel or DM
 * also gets one "Notes for this call" message in that chat, posted only by whoever made the doc, so
 * two people joining at once make one doc and one message.
 *
 * Summary so far: for people who join late. A deterministic digest, labelled "So far": who is here
 * and since when, time elapsed, the notes doc's headings and to-dos, and decisions said in the chat
 * during the call. Multies never pays for model calls: "Write a summary" runs only on the
 * workspace's own key (providerFor) and is refused without one. There is no live transcription
 * (recordings are transcribed after the call), so the digest carries no transcript.
 * Reads only, apart from the notes doc and its one chat message.
 */
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatMessages, docs, meetings } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { collectTaskItems, sectionsOf, type PMNodeLike } from "@/shared/action-items";
import type { SuiteActor } from "./common";
import { roomParticipants, visibleMeeting } from "./calls";
import { ensureNotesDocOnce, zoneOf } from "./meeting-notes";
import { notBlockedBy } from "./reports-r35"; // R35: meeting chat leaves out blocked people

export const NOTES_MESSAGE_PREFIX = "Notes for this call: ";
import { assertAiAllowed } from "../ai-trust-td1"; // TD1: AI trust gate
/** People joining this long after the start see the So far panel open on its own. */
export const LATE_JOIN_MS = 5 * 60_000;
const MAX_DECISIONS = 20;
const MAX_LINES = 12;

const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);

/** "26 Oct 2026" in a time zone (a bad zone falls back to UTC). */
export function notesDate(d: Date, timeZone: string) {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(d);
  try { return fmt(timeZone); } catch { return fmt("UTC"); }
}

/** The dated title of a call's notes doc: "#design call notes, 26 Oct 2026". */
export const callNotesTitle = (title: string, d: Date, timeZone: string) => `${title.trim() || "Call"} notes, ${notesDate(d, timeZone)}`;

/**
 * Makes (once) the call's notes doc and, for a call from chat, posts its link in that chat. People
 * only; a guest never makes the doc. Returns the doc id and whether this call made it.
 */
export async function startCallNotes(deps: Deps, a: SuiteActor, meetingId: string) {
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "Notes for a call are made when a person joins it. Agents can use get_meeting_notes.");
  const m = await visibleMeeting(deps, a, meetingId);
  if (m.status === "cancelled") throw new HttpError(409, "meeting_cancelled", "This meeting was cancelled.");
  const tz = await zoneOf(deps, a, m);
  const { id, created } = await ensureNotesDocOnce(deps, a, m.id, { title: callNotesTitle(m.title, deps.now(), tz) });
  let messageId: string | null = null;
  if (created && m.channelId) {
    try {
      const { postMessage } = await import("./chat");
      messageId = (await postMessage(deps, a, m.channelId, { body: `${NOTES_MESSAGE_PREFIX}${deps.config.appUrl}/app/docs/${id}` })).id;
    } catch { /* an archived channel or a lost membership never blocks the call */ }
  }
  return { docId: id, created, messageId };
}

// ---------------------------------------------------------------- summary so far

/** Every heading in a doc, in order. */
export function headingsOf(doc: PMNodeLike | null | undefined): string[] {
  const text = (n: PMNodeLike): string => n.type === "text" ? n.text ?? "" : (n.content ?? []).map(text).join("");
  return (doc?.content ?? []).filter((n) => n.type === "heading").map((n) => text(n).replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** A chat line that records a decision: "Decision: ...", "Decided ...", "Agreed ...", "We decided ...", "We agreed ...". */
export function decisionOf(body: string): string | null {
  const line = body.trim();
  const m = /^(?:decision|decided|agreed|we(?:'ve| have)? (?:decided|agreed))\b[\s:,.-]*([^\s:,.-].*)$/is.exec(line); // nosemgrep: regex_dos (anchored, linear, on one chat message)
  if (!m) return null;
  const rest = m[1].replace(/\s+/g, " ").trim();
  return rest ? rest.slice(0, 300) : null;
}

export interface SoFar {
  meetingId: string; title: string; kind: "digest"; label: "So far";
  state: "live" | "waiting" | "ended"; startedAt: string; elapsedMin: number;
  participants: { name: string; joinedAt: string | null; minutesIn: number | null }[];
  notes: { docId: string; title: string; headings: string[]; agenda: string[]; notes: string[]; todos: { text: string; done: boolean }[] } | null;
  decisions: { text: string; by: string; at: string }[];
  /** Always null: there is no live transcription; recordings are transcribed after the call. */
  transcript: null;
  /** True when the workspace has its own AI key, so "Write a summary" can run. */
  canWriteSummary: boolean;
  lateJoinMs: number;
  /** The digest as plain text, for agents and for copying. */
  text: string;
}

function parseDoc(raw: string): PMNodeLike | null {
  try { return JSON.parse(raw) as PMNodeLike; } catch { return null; }
}

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000));

/** The plain text digest built from the parts. Deterministic. */
export function digestText(s: Omit<SoFar, "text">): string {
  const lines = [`So far in ${s.title}: ${s.elapsedMin} min since the start.`];
  lines.push(s.participants.length ? `Here now: ${s.participants.map((p) => p.minutesIn === null ? p.name : `${p.name} (${p.minutesIn} min)`).join(", ")}.` : "Nobody is in the call yet.");
  if (s.notes?.headings.length) lines.push(`Notes headings: ${s.notes.headings.join(", ")}.`);
  if (s.notes?.notes.length) lines.push(`Notes: ${s.notes.notes.slice(0, 5).join("; ")}.`);
  const open = s.notes?.todos.filter((t) => !t.done) ?? [];
  if (open.length) lines.push(`To-dos: ${open.map((t) => t.text).join("; ")}.`);
  if (s.decisions.length) lines.push(`Decisions: ${s.decisions.map((d) => `${d.text} (${d.by})`).join("; ")}.`);
  return lines.join("\n");
}

export async function summarySoFar(deps: Deps, a: SuiteActor, meetingId: string): Promise<SoFar> {
  const m = await visibleMeeting(deps, a, meetingId);
  const now = deps.now().getTime();
  const ps = m.status === "scheduled" ? await roomParticipants(deps, m.room).catch(() => []) : [];
  const joined = ps.map((p) => p.joinedAt).filter((t): t is number => typeof t === "number" && t > 0);
  // A chat call starts when it is made; a scheduled meeting starts when the first person joins it (else its start time).
  const startedAt = m.channelId ? m.startsAt.getTime() : joined.length ? Math.min(...joined) : m.startsAt.getTime();
  const state: SoFar["state"] = m.status !== "scheduled" ? "ended" : ps.length ? "live" : "waiting";
  const d = m.docId ? await deps.db.select({ id: docs.id, title: docs.title, content: docs.content }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.id, m.docId), isNull(docs.deletedAt))).get() : undefined;
  let notes: SoFar["notes"] = null;
  if (d) {
    const content = parseDoc(d.content);
    const sec = sectionsOf(content);
    notes = {
      docId: d.id, title: d.title, headings: headingsOf(content), agenda: sec.agenda.slice(0, MAX_LINES), notes: sec.notes.slice(0, MAX_LINES),
      todos: collectTaskItems(content).slice(0, 50).map((t) => ({ text: t.text, done: t.checked })),
    };
  }
  let decisions: SoFar["decisions"] = [];
  if (m.channelId) {
    const rows = await deps.db.select({ body: chatMessages.body, by: chatMessages.authorName, at: chatMessages.createdAt }).from(chatMessages)
      .where(and(eq(chatMessages.orgId, a.orgId), eq(chatMessages.channelId, m.channelId), isNull(chatMessages.deletedAt), gte(chatMessages.createdAt, new Date(startedAt)), notBlockedBy(chatMessages.authorId, isKey(a) ? null : a.userId)))
      .orderBy(asc(chatMessages.createdAt)).limit(300);
    decisions = rows.flatMap((r) => { const t = decisionOf(r.body); return t ? [{ text: t, by: r.by || "Someone", at: r.at.toISOString() }] : []; }).slice(-MAX_DECISIONS);
  }
  const { providerFor } = await import("../ai/keys");
  const canWriteSummary = !isKey(a) && !!(await providerFor(deps, a.orgId).catch(() => null));
  const base: Omit<SoFar, "text"> = {
    meetingId: m.id, title: m.title, kind: "digest", label: "So far", state,
    startedAt: new Date(startedAt).toISOString(), elapsedMin: minutes(now - startedAt),
    participants: ps.map((p) => ({ name: p.name, joinedAt: p.joinedAt ? new Date(p.joinedAt).toISOString() : null, minutesIn: p.joinedAt ? minutes(now - p.joinedAt) : null })),
    notes, decisions, transcript: null, canWriteSummary, lateJoinMs: LATE_JOIN_MS,
  };
  return { ...base, text: digestText(base) };
}

/** "Write a summary": the digest rewritten by the workspace's own model key. 409 without a key. */
export async function writeSummarySoFar(deps: Deps, a: SuiteActor, meetingId: string) {
  const s = await summarySoFar(deps, a, meetingId);
  await assertAiAllowed(deps, a.orgId); // TD1: AI off means no provider call
  const { providerFor } = await import("../ai/keys");
  const ai = await providerFor(deps, a.orgId);
  if (!ai) throw new HttpError(409, "no_ai_key", "Add your workspace's own AI key in Settings to write a summary. The So far digest works without one.");
  // Round 2 (PR 20): through the workspace's AI routing (askWorkspaceAi): a refused key or an outage answers in plain
  // words (QUAL1), and built-in AI stands in only where the deployment turned that on (AI_KEY_FALLBACK=on).
  const answer = await (await import("../ai")).askWorkspaceAi(deps, a.orgId, {
    system: "You summarise a live work call for someone who just joined. Use only the facts given. Five short bullet lines at most: what is being discussed, decisions, open to-dos. Plain text, no preamble.",
    user: s.text.slice(0, 8000), maxTokens: 400,
  });
  if (!answer.text) throw new HttpError(502, "ai_failed", "Your AI provider didn't return a summary. Try again, or read the So far digest.");
  return { meetingId: s.meetingId, summary: answer.text.trim(), digest: s, ...(answer.fallback ? { fallback: answer.fallback } : {}) };
}

/** For a meeting guest (the /m/<token> page): the notes doc's text, read only. Null before notes exist. */
export async function guestNotes(deps: Deps, token: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.guestToken, token), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  if (!m.docId) return { notes: null };
  const d = await deps.db.select({ title: docs.title, content: docs.content }).from(docs).where(and(eq(docs.orgId, m.orgId), eq(docs.id, m.docId), isNull(docs.deletedAt))).get();
  if (!d) return { notes: null };
  const content = parseDoc(d.content);
  const sec = sectionsOf(content);
  return { notes: { title: d.title, headings: headingsOf(content), agenda: sec.agenda, notes: sec.notes, todos: collectTaskItems(content).map((t) => ({ text: t.text, done: t.checked })) } };
}
