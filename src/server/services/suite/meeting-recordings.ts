/**
 * Round 23 (R23.2): recording a call and its transcript, on the workspace's own AI key.
 *
 * The browser records (the local mic mixed with every remote track, MediaRecorder, opus at a low
 * bitrate) and uploads a self contained chunk about every 5 minutes and at Stop. Each chunk goes
 * straight on to the workspace's OpenAI or Groq key for speech to text; Multies keeps only the TEXT,
 * never the audio. At Stop the workspace's chat model writes a short summary with decisions and
 * action items, and it is posted once to the chat the call started from (meetings.channel_id), or
 * sent to the attendees who are members as a notification when there is no channel.
 *
 * Writes: starting is 1 row, each chunk is 1 UPDATE, Stop is 2 UPDATEs plus the chat message (or the
 * notifications). The table has no secondary index (its primary key is org, meeting, id).
 */
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { meetingRecordings, members, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { providerFor } from "../ai/keys";
import { AI_PROVIDER_INFO, AiProviderError } from "../ai/providers";
import { canTranscribe, MAX_CHUNK_BYTES, RECORDING_SETUP_MESSAGE, SETUP_CODES, setupError, transcribe, transcribeKeyFor } from "../ai/transcribe";
import { aiKeyStatus } from "../ai/keys";
import { assertWritable, iso, sortableId, type SuiteActor } from "./common";
import { getMeeting, type Meeting } from "./meetings";
import { inIds } from "../../lib/sql-chunks";
import { aiAllowed } from "../ai-trust-td1"; // TD1: AI trust gate

type Row = typeof meetingRecordings.$inferSelect;
export interface ActionItem { text: string; assignee: string | null; due: string | null }

/** The transcript is capped; past this the rest is dropped and a note says so. */
export const TRANSCRIPT_CAP = 200 * 1024;
export const TRUNCATED_NOTE = "\n\n[The transcript was cut at 200 KB. Later parts of the call are not included.]";
/** A recording with no chunk for this long was left behind (the tab closed): anyone can finish it. */
export const STALE_MS = 15 * 60_000;
/** How much of the transcript the summary reads, to spare the workspace's key. */
const SUMMARY_INPUT_CHARS = 40_000;

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const isPerson = (a: SuiteActor) => !a.agentId && !a.apiKeyId && !!a.userId;
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function present(r: Row, names: Map<string, string>, now: Date) {
  const stale = r.status === "recording" && now.getTime() - r.updatedAt.getTime() > STALE_MS;
  return {
    id: r.id, meetingId: r.meetingId, status: r.status, stale,
    startedBy: { id: r.startedBy, name: names.get(r.startedBy) ?? "Someone" },
    startedAt: r.startedAt.toISOString(), endedAt: iso(r.endedAt), durationSec: r.durationSec, chunks: r.chunkCount,
    transcript: r.transcript, truncated: r.transcript.endsWith(TRUNCATED_NOTE), summary: r.summary,
    actionItems: JSON.parse(r.actionItems || "[]") as ActionItem[], provider: r.provider, error: r.error,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}
export type Recording = ReturnType<typeof present>;

async function namesOf(deps: Deps, ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<string, string>();
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, uniq));
  return new Map(rows.map((u) => [u.id, u.name || u.email]));
}

async function row(deps: Deps, orgId: string, meetingId: string, id: string) {
  const r = await deps.db.select().from(meetingRecordings).where(and(eq(meetingRecordings.orgId, orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.id, id))).get();
  if (!r) throw notFound("Recording");
  return r;
}

/** Whether this workspace can record, and what to tell the person when it can't. Reads only. */
export async function recordingSetup(deps: Deps, a: SuiteActor) {
  const k = await aiKeyStatus(deps, a.orgId);
  const ready = canTranscribe(k.provider);
  return {
    ready, provider: k.provider, providerName: k.providerName,
    code: ready ? null : k.provider ? SETUP_CODES.wrongProvider : SETUP_CODES.noKey,
    message: ready ? null : RECORDING_SETUP_MESSAGE,
    /** Owners and admins change Settings > AI; others ask them. */
    canConfigure: a.role === "owner" || a.role === "admin",
  };
}

/** The meeting's recordings, newest first, with each summary and transcript. Readers see what they can open: the meeting. */
export async function listRecordings(deps: Deps, a: SuiteActor, meetingId: string) {
  const meeting = await getMeeting(deps, a, meetingId);
  const rows = await deps.db.select().from(meetingRecordings).where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meeting.id))).orderBy(desc(meetingRecordings.id)).limit(50);
  const names = await namesOf(deps, rows.map((r) => r.startedBy));
  return rows.map((r) => present(r, names, deps.now()));
}

export async function getRecording(deps: Deps, a: SuiteActor, meetingId: string, id: string) {
  await getMeeting(deps, a, meetingId);
  const r = await row(deps, a.orgId, meetingId, id);
  return present(r, await namesOf(deps, [r.startedBy]), deps.now());
}

/**
 * Starts recording. People record (an agent key can read transcripts but not start one). Without an
 * OpenAI or Groq key the answer is 409 with a setup code the app opens the setup prompt on. A second
 * press while a recording is live returns that one. Cost: 1 row.
 */
export async function startRecording(deps: Deps, a: SuiteActor, meetingId: string) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "People record calls from the meeting room. Keys can read transcripts with get_meeting_transcript.");
  const meeting = await getMeeting(deps, a, meetingId);
  if (meeting.status === "cancelled") throw new HttpError(409, "meeting_cancelled", "This meeting was cancelled.");
  const k = await aiKeyStatus(deps, a.orgId);
  if (!canTranscribe(k.provider)) throw setupError(k.provider);
  const now = deps.now();
  const live = await deps.db.select().from(meetingRecordings).where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meeting.id), eq(meetingRecordings.status, "recording"))).orderBy(desc(meetingRecordings.id)).limit(1).get();
  if (live && now.getTime() - live.updatedAt.getTime() <= STALE_MS) {
    return { recording: present(live, await namesOf(deps, [live.startedBy]), now), joined: true };
  }
  const id = sortableId("rec", now.getTime());
  await deps.db.insert(meetingRecordings).values({ orgId: a.orgId, meetingId: meeting.id, id, startedBy: a.userId, status: "recording", startedAt: now, provider: k.provider, createdAt: now, updatedAt: now });
  return { recording: present(await row(deps, a.orgId, meeting.id, id), await namesOf(deps, [a.userId]), now), joined: false };
}

function providerFailure(err: AiProviderError) {
  const name = AI_PROVIDER_INFO[err.provider].name;
  return err.status === 401 || err.status === 403 ? `${name} did not accept the API key. Check it in Settings > AI.`
    : err.status === 429 ? `${name} says the key is over its rate limit or out of credit.`
    : err.status === 413 ? `${name} refused the audio chunk as too large.`
    : `${name} could not transcribe just now${err.status ? ` (status ${err.status})` : ""}. Try again in a minute.`;
}

/** The transcript with a chunk's text added, capped at TRANSCRIPT_CAP bytes. */
export function appendText(transcript: string, text: string, offsetSec: number | null) {
  if (transcript.endsWith(TRUNCATED_NOTE) || !text) return transcript;
  const piece = `${transcript ? "\n\n" : ""}${offsetSec !== null ? `[${mmss(offsetSec)}] ` : ""}${text}`;
  const next = transcript + piece;
  if (byteLength(next) <= TRANSCRIPT_CAP) return next;
  // Cut by characters until the text plus the note fits.
  let cut = next.slice(0, TRANSCRIPT_CAP - byteLength(TRUNCATED_NOTE));
  while (byteLength(cut) + byteLength(TRUNCATED_NOTE) > TRANSCRIPT_CAP) cut = cut.slice(0, -1024);
  return cut + TRUNCATED_NOTE;
}

/**
 * One audio chunk: sent on to the workspace's OpenAI or Groq key, and only its text is kept. Chunks
 * carry a sequence number from 0: a chunk already taken answers again without a second transcription
 * (so a retried upload is safe), and one that skips ahead is refused with the number expected.
 * Only the person who started the recording uploads to it. Cost: 1 row (the UPDATE).
 */
export async function appendChunk(deps: Deps, a: SuiteActor, meetingId: string, id: string, input: { seq: number; audio: Uint8Array; mime: string; offsetSec?: number | null; durationSec?: number | null }) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "Only the person recording uploads audio.");
  await getMeeting(deps, a, meetingId);
  const r = await row(deps, a.orgId, meetingId, id);
  if (r.startedBy !== a.userId) throw new HttpError(403, "forbidden", "Only the person who started this recording uploads its audio.");
  if (r.status !== "recording") throw new HttpError(409, "recording_stopped", "This recording has stopped.");
  if (!Number.isInteger(input.seq) || input.seq < 0) throw new HttpError(422, "validation_failed", "seq is a whole number from 0.");
  if (input.seq < r.chunkCount) return { recording: present(r, await namesOf(deps, [r.startedBy]), deps.now()), duplicate: true };
  if (input.seq > r.chunkCount) throw new HttpError(409, "out_of_order", `Upload chunk ${r.chunkCount} first.`, { expected: r.chunkCount });
  if (input.audio.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, "chunk_too_large", "That audio chunk is over 24 MB. Upload it in smaller pieces.");
  if (!input.audio.byteLength) throw new HttpError(422, "validation_failed", "The audio chunk is empty.");
  const key = await transcribeKeyFor(deps, a.orgId);
  let text: string;
  try {
    text = await transcribe(key.provider, key.apiKey, input.audio, input.mime, deps.fetch);
  } catch (err) {
    if (err instanceof AiProviderError) {
      deps.log?.warn("recording.transcribe_failed", { provider: err.provider, status: err.status });
      throw new HttpError(502, "ai_provider_error", providerFailure(err));
    }
    throw err;
  }
  const now = deps.now();
  const transcript = appendText(r.transcript, text, input.offsetSec ?? null);
  const durationSec = Math.max(r.durationSec, Math.round(input.durationSec ?? 0));
  // The WHERE on chunk_count makes two copies of the same upload land once.
  const done = await deps.db.update(meetingRecordings).set({ transcript, chunkCount: r.chunkCount + 1, durationSec, provider: key.provider, error: null, updatedAt: now })
    .where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.id, id), eq(meetingRecordings.chunkCount, r.chunkCount), eq(meetingRecordings.status, "recording")))
    .returning({ id: meetingRecordings.id });
  const fresh = await row(deps, a.orgId, meetingId, id);
  return { recording: present(fresh, await namesOf(deps, [fresh.startedBy]), now), duplicate: !done.length };
}

/** Pulls the first JSON object out of a model's answer. */
function firstJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>; } catch { return null; }
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Reads the model's summary answer: { summary, decisions[], actionItems[{ text, assignee, due }] }. */
export function parseSummary(text: string | null): { summary: string; decisions: string[]; actionItems: ActionItem[] } | null {
  const out = firstJson(text);
  if (!out) return text?.trim() ? { summary: text.trim().slice(0, 1500), decisions: [], actionItems: [] } : null;
  const summary = str(out.summary, 1500);
  if (!summary) return null;
  const decisions = Array.isArray(out.decisions) ? out.decisions.map((d) => str(d, 300)).filter((d): d is string => !!d).slice(0, 10) : [];
  const actionItems = Array.isArray(out.actionItems) ? out.actionItems.map((x): ActionItem | null => {
    if (typeof x === "string") return x.trim() ? { text: x.trim().slice(0, 300), assignee: null, due: null } : null;
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    const t = str(o.text ?? o.task, 300);
    return t ? { text: t, assignee: str(o.assignee ?? o.owner, 80), due: str(o.due, 40) } : null;
  }).filter((x): x is ActionItem => !!x).slice(0, 20) : [];
  return { summary, decisions, actionItems };
}

export const SUMMARY_SYSTEM = "You summarise a recorded work call from its transcript. Reply with JSON only: {\"summary\": string (at most 4 sentences), \"decisions\": string[], \"actionItems\": [{\"text\": string, \"assignee\": string or null, \"due\": string or null}]}. Use names and dates only when the transcript says them. Don't invent anything.";

/** The chat message posted after the call. Plain text with bullets, and a link to the meeting page. */
export function summaryMessage(meeting: Pick<Meeting, "title" | "joinUrl">, s: { summary: string; decisions: string[]; actionItems: ActionItem[] }) {
  const lines = [`Call summary: ${meeting.title}`, "", s.summary];
  if (s.decisions.length) lines.push("", "Decisions", ...s.decisions.map((d) => `- ${d}`));
  if (s.actionItems.length) lines.push("", "Action items", ...s.actionItems.map((x) => `- ${x.text}${x.assignee || x.due ? ` (${[x.assignee, x.due ? `due ${x.due}` : null].filter(Boolean).join(", ")})` : ""}`));
  lines.push("", `Transcript and recording details: ${meeting.joinUrl}`);
  return lines.join("\n").slice(0, 19_000);
}

/** The attendees who are workspace members: the recorder, the meeting's creator and invitees with a member's email. */
async function attendeeMembers(deps: Deps, orgId: string, meeting: Meeting, recorder: string) {
  const ids = new Set<string>([recorder]);
  if (meeting.createdBy.type === "member" && meeting.createdBy.id) ids.add(meeting.createdBy.id);
  if (meeting.invitees.length) {
    const rows = await deps.db.select({ id: users.id }).from(users).innerJoin(members, eq(members.userId, users.id))
      .where(and(eq(members.organizationId, orgId), inIds(users.email, meeting.invitees.slice(0, 50))));
    for (const u of rows) ids.add(u.id);
  }
  return [...ids];
}

/**
 * Stops the recording and writes the summary. Idempotent: one UPDATE claims the stop (recording to
 * processing), so a second press, a retry or two people pressing at once post the summary once.
 * Anyone who can edit the meeting may stop it (a recording left behind by a closed tab can be
 * finished from the meeting page). Cost: 2 rows here, plus the chat message or the notifications.
 */
export async function stopRecording(deps: Deps, a: SuiteActor, meetingId: string, id: string, input: { durationSec?: number | null } = {}) {
  assertWritable(a);
  const meeting = await getMeeting(deps, a, meetingId);
  const r = await row(deps, a.orgId, meetingId, id);
  const now = deps.now();
  const durationSec = Math.max(r.durationSec, Math.round(input.durationSec ?? 0));
  const claimed = r.status !== "recording" ? [] : await deps.db.update(meetingRecordings).set({ status: "processing", endedAt: now, durationSec, updatedAt: now })
    .where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.id, id), eq(meetingRecordings.status, "recording")))
    .returning({ id: meetingRecordings.id });
  if (!claimed.length) return { recording: await getRecording(deps, a, meetingId, id), posted: null };

  let set: Partial<Row>;
  let posted: { type: "chat"; channelId: string; messageId: string } | { type: "notification"; userIds: string[] } | null = null;
  const text = r.transcript.replace(TRUNCATED_NOTE, "").trim();
  if (!text) {
    set = { status: "done", summary: null, error: "Nothing was transcribed: the recording had no speech, or no audio reached the server." };
  } else {
    const allowed = await aiAllowed(deps, a.orgId); // TD1: AI off, no provider call
    const ai = allowed ? await providerFor(deps, a.orgId) : null;
    if (!allowed) {
      set = { status: "done", summary: null, error: "AI is off in this workspace, so no summary was written. The transcript is kept." };
    } else if (!ai) {
      set = { status: "failed", error: "The workspace's AI key was removed before the summary. The transcript is kept." };
    } else {
      try {
        const answer = await ai.complete({ system: SUMMARY_SYSTEM, user: `Call: ${meeting.title}\n\n${text.slice(-SUMMARY_INPUT_CHARS)}`, maxTokens: 600 });
        const s = parseSummary(answer);
        if (!s) {
          set = { status: "failed", error: "The AI provider answered without a summary. The transcript is kept." };
        } else {
          set = { status: "done", summary: s.summary + (s.decisions.length ? `\n\nDecisions:\n${s.decisions.map((d) => `- ${d}`).join("\n")}` : ""), actionItems: JSON.stringify(s.actionItems), error: null };
          posted = await postSummary(deps, a, meeting, r.startedBy, summaryMessage(meeting, s));
        }
      } catch (err) {
        if (!(err instanceof AiProviderError)) throw err;
        deps.log?.warn("recording.summary_failed", { provider: err.provider, status: err.status });
        set = { status: "failed", error: `${providerFailure(err).replace("transcribe", "summarise")} The transcript is kept.` };
      }
    }
  }
  await deps.db.update(meetingRecordings).set({ ...set, updatedAt: deps.now() })
    .where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.id, id)));
  return { recording: await getRecording(deps, a, meetingId, id), posted };
}

/** One chat message from the person who recorded, in the call's channel; else a notification to the attendees. */
async function postSummary(deps: Deps, a: SuiteActor, meeting: Meeting, recorderId: string, body: string) {
  const recorder = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, recorderId)).get();
  if (meeting.channelId && recorder) {
    try {
      const { postMessage } = await import("./chat");
      const as: SuiteActor = { orgId: a.orgId, userId: recorder.id, email: recorder.email, name: recorder.name, role: "member" };
      const m = await postMessage(deps, as, meeting.channelId, { body });
      return { type: "chat" as const, channelId: meeting.channelId, messageId: (m as { id: string }).id };
    } catch (err) {
      // The channel is gone or the recorder left it: the attendees hear instead.
      deps.log?.warn("recording.post_failed", { meetingId: meeting.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const { notify } = await import("./notify");
  const userIds = await attendeeMembers(deps, a.orgId, meeting, recorderId);
  for (const userId of userIds) await notify(deps, a.orgId, userId, { type: "meeting.summary", entityType: "meeting", entityId: meeting.id, title: `Call summary ready: ${meeting.title}`, actorName: recorder?.name ?? null });
  return { type: "notification" as const, userIds };
}

/** Deletes a recording and its transcript. Anyone who can edit the meeting. Cost: 1 row. */
export async function deleteRecording(deps: Deps, a: SuiteActor, meetingId: string, id: string) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "People delete recordings from the meeting page.");
  await getMeeting(deps, a, meetingId);
  await row(deps, a.orgId, meetingId, id);
  await deps.db.delete(meetingRecordings).where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.id, id)));
  return { deleted: true };
}
