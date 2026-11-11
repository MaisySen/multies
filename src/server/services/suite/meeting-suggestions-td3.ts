/**
 * TD3 (MEET_TD3): meetings to tasks. Suggested action items from a meeting's transcript, notes or pasted text,
 * each one accepted (one real task linked to the meeting) or discarded by a person, plus the follow up email
 * draft. Nothing is created or sent without a click: Suggest only writes suggestions, Accept makes the task, and
 * the email opens in the composer as a draft for the person to send.
 *
 * AI: one provider call per Suggest press, through the workspace's existing AI routing (its own key, or built in
 * AI with its single meter and cap). aiGate runs first: with the workspace's AI switched off there is no provider
 * call, and the manual path (select text, make task) works with AI on or off.
 * Privacy: transcript, notes, titles and quotes never reach logs or Sentry; logs carry ids, counts and status only.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import type { Deps } from "../../context";
import { docs, meetingRecordings, meetingSuggestions, members, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { isPerson } from "./calendar-sync";
import { getMeeting, type Meeting } from "./meetings";
import { actionPeople, meetingNotes, zoneOf } from "./meeting-notes";
import { TRUNCATED_NOTE } from "./meeting-recordings";
import { createTask, deleteTask, getTask, link, validateAssignee } from "./tasks";
import { parseDue, type ActionPerson } from "@/shared/action-items";
import { followUpEmail, groundQuote, normalise, parseSuggestions, splitSummary, SUGGEST_INPUT_CHARS, SUGGEST_SYSTEM, QUOTE_MAX, TITLE_MAX } from "@/shared/meeting-suggest-td3";

type Row = typeof meetingSuggestions.$inferSelect;
export type SuggestSource = "recording" | "notes" | "pasted";

/** Open suggestions a meeting may hold; Suggest replaces the open ones, so this caps the list. */
export const MAX_OPEN = 50;
/** An accepted task can be undone (deleted again) this long after the click. */
export const UNDO_MS = 30 * 60_000;
export const PASTED_MAX = 200 * 1024;
const DUE = /^\d{4}-\d{2}-\d{2}$/;

export const AI_OFF_TEXT = "AI is off for this workspace. You can still pick lines and make tasks by hand.";
export const AI_NO_KEY_TEXT = "Add an AI key in Settings to get suggestions. You can still pick lines and make tasks by hand.";

export function meetTd3Enabled(deps: Deps) { return !!deps.config.meetTd3; }

/**
 * The one gate in front of every provider call. "off": the workspace switched AI off (TD1's switch); "no_key": no key and no built in AI; "ready": a call may go out.
 */
export async function aiGate(deps: Deps, orgId: string): Promise<"ready" | "off" | "no_key" | "key_problem"> {
  return (await aiGateView(deps, orgId)).state;
}

/**
 * The gate with the words the meeting page shows. QUAL1 (audit row 14): a key the provider refused is "key_problem"
 * (its plain sentence and a hand route) unless built-in AI stands in for it ("ready", with the same sentence). A call
 * still goes out on "key_problem": the key may work again, and a refusal answers 409 in plain words.
 */
export async function aiGateView(deps: Deps, orgId: string): Promise<{ state: "ready" | "off" | "no_key" | "key_problem"; message: string | null }> {
  if (!(await workspaceAiOn(deps, orgId))) return { state: "off", message: AI_OFF_TEXT };
  const { aiKeyStatus } = await import("../ai/keys");
  const k = await aiKeyStatus(deps, orgId);
  if (!k.connected) return builtinReady(deps) ? { state: "ready", message: null } : { state: "no_key", message: AI_NO_KEY_TEXT };
  if (!k.problemMessage) return { state: "ready", message: null };
  const { canFallBack } = await import("../ai");
  return canFallBack(deps)
    ? { state: "ready", message: `${k.problemMessage} Built-in AI writes the suggestions until it is fixed.` }
    : { state: "key_problem", message: `${k.problemMessage} You can still pick lines and make tasks by hand.` };
}
/** TD1's per workspace AI switch (the same gate ask() uses): off means no provider call. */
async function workspaceAiOn(deps: Deps, orgId: string): Promise<boolean> { return (await import("../ai-trust-td1")).aiAllowed(deps, orgId); }
/** Built in AI (AI2): the same check ask() uses to route to it (flag on and the existing binding present). Its meter decides each call; it never bills. */
function builtinReady(deps: Deps): boolean { return !!deps.config.aiConnectAi2 && !!deps.ai; }

function present(r: Row, people: Map<string, ActionPerson>, task: { id: string; ref: string; title: string } | null) {
  const who = r.assigneeId ? people.get(`${r.assigneeType}:${r.assigneeId}`) ?? null : null;
  return {
    id: r.id, source: r.source, sourceId: r.sourceId, title: r.title, quote: r.quote, due: r.due, status: r.status,
    assignee: who ? { type: who.type, id: who.id, name: who.name } : null,
    task: task ? { id: task.id, ref: task.ref, title: task.title } : r.taskId ? { id: r.taskId, ref: "", title: r.title } : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    canUndo: r.status === "discarded" || (r.status === "accepted" && !!r.decidedAt && Date.now() - r.decidedAt.getTime() < UNDO_MS),
  };
}
export type Suggestion = ReturnType<typeof present>;

async function rows(deps: Deps, orgId: string, meetingId: string) {
  return deps.db.select().from(meetingSuggestions).where(and(eq(meetingSuggestions.orgId, orgId), eq(meetingSuggestions.meetingId, meetingId)));
}
async function rowOf(deps: Deps, orgId: string, meetingId: string, id: string) {
  const r = await deps.db.select().from(meetingSuggestions).where(and(eq(meetingSuggestions.orgId, orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, id))).get();
  if (!r) throw notFound("Suggestion");
  return r;
}

/** Attendees who are workspace members: the creator, invitees with a member's email, and whoever recorded. */
async function attendees(deps: Deps, orgId: string, m: Meeting, people: ActionPerson[]): Promise<ActionPerson[]> {
  const ids = new Set<string>();
  if (m.createdBy.type === "member" && m.createdBy.id) ids.add(m.createdBy.id);
  const emails = new Set(m.invitees.slice(0, 100).map((e) => e.toLowerCase()));
  for (const p of people) if (p.type === "member" && p.email && emails.has(p.email.toLowerCase())) ids.add(p.id);
  const rec = await deps.db.select({ by: meetingRecordings.startedBy }).from(meetingRecordings).where(and(eq(meetingRecordings.orgId, orgId), eq(meetingRecordings.meetingId, m.id)));
  for (const r of rec) ids.add(r.by);
  return people.filter((p) => p.type === "member" && ids.has(p.id));
}

async function tasksOf(deps: Deps, a: SuiteActor, list: Row[]) {
  const out = new Map<string, { id: string; ref: string; title: string }>();
  for (const r of list) {
    if (r.status !== "accepted" || !r.taskId) continue;
    try { const t = await getTask(deps, a, r.taskId); out.set(r.taskId, { id: t.id, ref: (t as { ref?: string }).ref ?? "", title: t.title }); } catch { /* deleted since */ }
  }
  return out;
}

const order = (x: Row, y: Row) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1);

async function view(deps: Deps, a: SuiteActor, meetingId: string) {
  const [list, people] = await Promise.all([rows(deps, a.orgId, meetingId), actionPeople(deps, a.orgId)]);
  const byKey = new Map(people.map((p) => [`${p.type}:${p.id}`, p]));
  const tasks = await tasksOf(deps, a, list);
  return list.filter((r) => !(r.status === "accepted" && r.taskId && !tasks.has(r.taskId))).sort(order).map((r) => present(r, byKey, r.taskId ? tasks.get(r.taskId) ?? null : null));
}

/** The meeting's suggestions, what can be read for them, its attendees and the AI state. Readers: anyone who can open the meeting. */
export async function meetingSuggestionsView(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await getMeeting(deps, a, meetingId);
  const people = await actionPeople(deps, a.orgId);
  const [suggestions, who, recs, notesDoc, ai] = await Promise.all([
    view(deps, a, meetingId),
    attendees(deps, a.orgId, m, people),
    deps.db.select({ id: meetingRecordings.id, startedAt: meetingRecordings.startedAt, status: meetingRecordings.status, transcript: meetingRecordings.transcript })
      .from(meetingRecordings).where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId))).orderBy(desc(meetingRecordings.startedAt)).limit(20),
    m.docId ? deps.db.select({ text: docs.plainText }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.id, m.docId))).get() : Promise.resolve(undefined),
    aiGateView(deps, a.orgId),
  ]);
  return {
    suggestions,
    attendees: who.map((p) => ({ type: p.type, id: p.id, name: p.name })),
    people: people.filter((p) => p.type === "member").map((p) => ({ type: p.type, id: p.id, name: p.name })),
    sources: {
      recordings: recs.filter((r) => r.transcript.replace(TRUNCATED_NOTE, "").trim()).map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), status: r.status })),
      notes: !!notesDoc?.text?.trim(),
    },
    ai,
  };
}

/** The text a source holds, to pick lines from (and what Suggest reads). */
export async function sourceText(deps: Deps, a: SuiteActor, meetingId: string, src: { source: "recording" | "notes"; recordingId?: string | null }) {
  const m = await getMeeting(deps, a, meetingId);
  if (src.source === "notes") {
    if (!m.docId) return { source: "notes" as const, sourceId: null, text: "" };
    const d = await deps.db.select({ text: docs.plainText }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.id, m.docId))).get();
    return { source: "notes" as const, sourceId: m.docId, text: (d?.text ?? "").slice(0, PASTED_MAX) };
  }
  const where = [eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId)];
  if (src.recordingId) where.push(eq(meetingRecordings.id, src.recordingId));
  const r = await deps.db.select({ id: meetingRecordings.id, transcript: meetingRecordings.transcript }).from(meetingRecordings).where(and(...where)).orderBy(desc(meetingRecordings.startedAt)).get();
  if (!r) throw notFound("Recording");
  return { source: "recording" as const, sourceId: r.id, text: r.transcript.replace(TRUNCATED_NOTE, "").trim() };
}

/** Relative dates are read from the meeting's day (if it has happened) in the meeting's zone. */
async function dueOf(deps: Deps, a: SuiteActor, m: Meeting, raw: string | null, quote: string | null) {
  const tz = await zoneOf(deps, a, { recurrenceTz: m.recurrence?.timezone ?? null });
  const now = deps.now();
  const start = new Date(m.startsAt);
  const base = start.getTime() < now.getTime() ? start : now;
  if (raw && DUE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return raw;
  if (raw) { const d = parseDue(/\b(by|due|on)\b/i.test(raw) ? raw : `by ${raw}`, base, tz); if (d) return d.due; }
  if (quote) { const d = parseDue(quote, base, tz); if (d) return d.due; }
  return null;
}

/**
 * Suggest: reads the source, makes ONE provider call (after the gate), and replaces the meeting's open suggestions
 * (manual ones stay; accepted and discarded stay, and their titles are not suggested again). Writes only suggestions.
 */
export async function suggest(deps: Deps, a: SuiteActor, meetingId: string, input: { source: SuggestSource; recordingId?: string | null; text?: string | null }) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "People make suggestions from the meeting page.");
  const m = await getMeeting(deps, a, meetingId);
  let source: SuggestSource = input.source;
  let sourceId: string | null = null;
  let text: string;
  if (input.source === "pasted") {
    text = (input.text ?? "").trim();
    if (text.length > PASTED_MAX) throw new HttpError(422, "validation_failed", "That text is too long. Paste up to 200 KB.");
  } else {
    const s = await sourceText(deps, a, meetingId, { source: input.source, recordingId: input.recordingId });
    source = s.source; sourceId = s.sourceId; text = s.text;
  }
  if (!text) throw new HttpError(422, "empty_source", source === "notes" ? "The notes are empty. Write some notes first, or paste the transcript." : "There is nothing to read yet.");

  const gate = await aiGate(deps, a.orgId);
  if (gate === "off") throw new HttpError(409, "ai_off", AI_OFF_TEXT);
  if (gate === "no_key") throw new HttpError(409, "ai_key_required", AI_NO_KEY_TEXT);
  const { askWorkspaceAi } = await import("../ai");
  const answer = await askWorkspaceAi(deps, a.orgId, { system: SUGGEST_SYSTEM, user: `Meeting: ${m.title}\n\n${text.slice(-SUGGEST_INPUT_CHARS)}`, maxTokens: 900 });
  const raw = parseSuggestions(answer.text);

  const people = await actionPeople(deps, a.orgId);
  const who = await attendees(deps, a.orgId, m, people);
  const existing = await rows(deps, a.orgId, meetingId);
  const decided = new Set(existing.filter((r) => r.status !== "open" || r.source === "manual").map((r) => normalise(r.title)));
  const { matchPerson } = await import("@/shared/action-items");
  const now = deps.now();
  const fresh: (typeof meetingSuggestions.$inferInsert)[] = [];
  for (const s of raw) {
    if (decided.has(normalise(s.title))) continue;
    const quote = groundQuote(s.quote, s.title, text);
    const owner = matchPerson(s.owner, who);
    fresh.push({
      orgId: a.orgId, meetingId, id: sortableId("msg", now.getTime() + fresh.length), source, sourceId,
      title: s.title.slice(0, TITLE_MAX), quote, assigneeType: owner ? "member" : null, assigneeId: owner?.id ?? null,
      due: await dueOf(deps, a, m, s.due, quote), status: "open", createdBy: a.userId!, createdAt: new Date(now.getTime() + fresh.length), updatedAt: now,
    });
  }
  const keep = existing.filter((r) => r.status === "open" && r.source === "manual").length;
  const take = fresh.slice(0, Math.max(0, MAX_OPEN - keep));
  await deps.db.delete(meetingSuggestions).where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.status, "open"), ne(meetingSuggestions.source, "manual")));
  if (take.length) await deps.db.insert(meetingSuggestions).values(take);
  deps.log?.info("meeting_td3.suggested", { meetingId, count: take.length, parsed: raw.length, answered: !!answer.text, provider: answer.provider }); // counts only, never the text
  return { suggestions: await view(deps, a, meetingId), added: take.length };
}

function checkFields(input: { title?: string; due?: string | null; quote?: string | null }) {
  if (input.title !== undefined && !input.title.trim()) throw new HttpError(422, "validation_failed", "Give the action item a title.");
  if (input.due && (!DUE.test(input.due) || Number.isNaN(Date.parse(`${input.due}T00:00:00Z`)))) throw new HttpError(422, "validation_failed", "due looks like 2026-10-30.");
}
async function checkAssignee(deps: Deps, orgId: string, id: string | null | undefined) {
  if (!id) return;
  // A member of THIS workspace only: anyone else is refused before any write.
  const m = await deps.db.select({ id: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, id))).get();
  if (!m) throw new HttpError(422, "validation_failed", "That person is not in this workspace.");
  await validateAssignee(deps, orgId, { type: "member", id });
}

/** Adds an action item by hand (from selected text, or typed). accept: the task is made in the same click. */
export async function addSuggestion(deps: Deps, a: SuiteActor, meetingId: string, input: { title: string; quote?: string | null; assigneeId?: string | null; due?: string | null; accept?: boolean; projectId?: string | null }) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "People add action items from the meeting page.");
  await getMeeting(deps, a, meetingId);
  checkFields(input);
  await checkAssignee(deps, a.orgId, input.assigneeId);
  const open = (await rows(deps, a.orgId, meetingId)).filter((r) => r.status === "open").length;
  if (open >= MAX_OPEN) throw new HttpError(422, "too_many", `A meeting holds up to ${MAX_OPEN} open suggestions. Accept or discard some first.`);
  const now = deps.now();
  const id = sortableId("msg", now.getTime());
  await deps.db.insert(meetingSuggestions).values({
    orgId: a.orgId, meetingId, id, source: "manual", sourceId: null, title: input.title.trim().slice(0, TITLE_MAX), quote: input.quote?.trim().slice(0, QUOTE_MAX) || null,
    assigneeType: input.assigneeId ? "member" : null, assigneeId: input.assigneeId ?? null, due: input.due ?? null, status: "open", createdBy: a.userId!, createdAt: now, updatedAt: now,
  });
  if (input.accept) return acceptSuggestion(deps, a, meetingId, id, { projectId: input.projectId });
  return { suggestion: (await view(deps, a, meetingId)).find((s) => s.id === id)! };
}

/** Edits an open suggestion before it is accepted. */
export async function editSuggestion(deps: Deps, a: SuiteActor, meetingId: string, id: string, input: { title?: string; assigneeId?: string | null; due?: string | null }) {
  assertWritable(a);
  await getMeeting(deps, a, meetingId);
  const r = await rowOf(deps, a.orgId, meetingId, id);
  if (r.status !== "open") throw new HttpError(409, "decided", "This one is already accepted or discarded.");
  checkFields(input);
  if (input.assigneeId !== undefined) await checkAssignee(deps, a.orgId, input.assigneeId);
  const set: Partial<Row> = { updatedAt: deps.now() };
  if (input.title !== undefined) set.title = input.title.trim().slice(0, TITLE_MAX);
  if (input.due !== undefined) set.due = input.due;
  if (input.assigneeId !== undefined) { set.assigneeId = input.assigneeId; set.assigneeType = input.assigneeId ? "member" : null; }
  await deps.db.update(meetingSuggestions).set(set).where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, id), eq(meetingSuggestions.status, "open")));
  return { suggestion: (await view(deps, a, meetingId)).find((s) => s.id === id)! };
}

/**
 * Accept: one conditional update claims the suggestion (open to accepted, with the task id made here), and only
 * the claimer creates the task, so a double click or two people at once make ONE task. A failed create reopens it.
 */
export async function acceptSuggestion(deps: Deps, a: SuiteActor, meetingId: string, id: string, opts: { projectId?: string | null } = {}) {
  assertWritable(a);
  if (!isPerson(a)) throw new HttpError(403, "forbidden", "People accept suggestions from the meeting page.");
  const m = await getMeeting(deps, a, meetingId);
  const r = await rowOf(deps, a.orgId, meetingId, id);
  if (r.status === "discarded") throw new HttpError(409, "decided", "This one was discarded. Undo it first.");
  const now = deps.now();
  const taskId = sortableId("tsk", now.getTime());
  const claimed = r.status !== "open" ? [] : await deps.db.update(meetingSuggestions).set({ status: "accepted", taskId, decidedBy: a.userId!, decidedAt: now, updatedAt: now })
    .where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, id), eq(meetingSuggestions.status, "open")))
    .returning({ id: meetingSuggestions.id });
  if (claimed.length) {
    try {
      const notes = `From the meeting "${m.title}".${r.quote ? `\n\n“${r.quote}”` : ""}`;
      let projectId = opts.projectId ?? undefined;
      if (!projectId && m.source?.type === "task") { try { projectId = (await getTask(deps, a, m.source.id)).projectId; } catch { /* the source task is gone */ } }
      await createTask(deps, a, { title: r.title, assignee: r.assigneeId ? { type: (r.assigneeType ?? "member") as "member" | "agent", id: r.assigneeId } : null, due: r.due, projectId, notes }, { id: taskId, retry: false });
      await link(deps, a.orgId, { type: "task", id: taskId }, { type: "meeting", id: meetingId }, "about");
    } catch (err) {
      await deps.db.update(meetingSuggestions).set({ status: "open", taskId: null, decidedBy: null, decidedAt: null, updatedAt: deps.now() })
        .where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, id), eq(meetingSuggestions.taskId, taskId)));
      throw err;
    }
  }
  return { suggestion: (await view(deps, a, meetingId)).find((s) => s.id === id) ?? null, created: claimed.length > 0 };
}

export async function discardSuggestion(deps: Deps, a: SuiteActor, meetingId: string, id: string) {
  assertWritable(a);
  await getMeeting(deps, a, meetingId);
  const r = await rowOf(deps, a.orgId, meetingId, id);
  if (r.status === "accepted") throw new HttpError(409, "decided", "This one is already a task. Undo it first.");
  const now = deps.now();
  await deps.db.update(meetingSuggestions).set({ status: "discarded", decidedBy: a.userId ?? null, decidedAt: now, updatedAt: now })
    .where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, id), eq(meetingSuggestions.status, "open")));
  return { suggestion: (await view(deps, a, meetingId)).find((s) => s.id === id)! };
}

/** Accept all open suggestions (or the given ones), one task each. */
export async function acceptAll(deps: Deps, a: SuiteActor, meetingId: string, input: { ids?: string[]; projectId?: string | null } = {}) {
  assertWritable(a);
  await getMeeting(deps, a, meetingId);
  const want = input.ids ? new Set(input.ids) : null;
  const open = (await rows(deps, a.orgId, meetingId)).filter((r) => r.status === "open" && (!want || want.has(r.id))).sort(order).slice(0, MAX_OPEN);
  const accepted: string[] = [];
  for (const r of open) {
    const x = await acceptSuggestion(deps, a, meetingId, r.id, { projectId: input.projectId });
    if (x.created) accepted.push(r.id);
  }
  return { accepted, suggestions: await view(deps, a, meetingId) };
}

/** Undo: an accepted one deletes the task it made (within UNDO_MS) and reopens; a discarded one reopens. */
export async function undoSuggestions(deps: Deps, a: SuiteActor, meetingId: string, ids: string[]) {
  assertWritable(a);
  await getMeeting(deps, a, meetingId);
  if (!ids.length) return { undone: [], suggestions: await view(deps, a, meetingId) };
  const list = await deps.db.select().from(meetingSuggestions).where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), inIds(meetingSuggestions.id, ids.slice(0, MAX_OPEN))));
  const now = deps.now();
  const undone: string[] = [];
  const reopen = { status: "open" as const, taskId: null, decidedBy: null, decidedAt: null, updatedAt: now };
  for (const r of list) {
    if (r.status === "discarded") {
      const x = await deps.db.update(meetingSuggestions).set(reopen).where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, r.id), eq(meetingSuggestions.status, "discarded"))).returning({ id: meetingSuggestions.id });
      if (x.length) undone.push(r.id);
    } else if (r.status === "accepted" && r.taskId) {
      if (!r.decidedAt || now.getTime() - r.decidedAt.getTime() > UNDO_MS) throw new HttpError(409, "too_late", "This task was made over 30 minutes ago. Delete it from the task instead.");
      const x = await deps.db.update(meetingSuggestions).set(reopen).where(and(eq(meetingSuggestions.orgId, a.orgId), eq(meetingSuggestions.meetingId, meetingId), eq(meetingSuggestions.id, r.id), eq(meetingSuggestions.taskId, r.taskId))).returning({ id: meetingSuggestions.id });
      if (!x.length) continue;
      try { await deleteTask(deps, a, r.taskId); } catch (err) { if (!(err instanceof HttpError && err.status === 404)) throw err; }
      undone.push(r.id);
    }
  }
  return { undone, suggestions: await view(deps, a, meetingId) };
}

/** The follow up email's fields. A read only: the web app opens them in the mail composer as a draft. */
export async function followUp(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await getMeeting(deps, a, meetingId);
  const [me, rec, list, notes, creator] = await Promise.all([
    a.userId ? deps.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, a.userId)).get() : Promise.resolve(undefined),
    deps.db.select({ summary: meetingRecordings.summary }).from(meetingRecordings).where(and(eq(meetingRecordings.orgId, a.orgId), eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.status, "done"))).orderBy(desc(meetingRecordings.startedAt)).get(),
    view(deps, a, meetingId),
    meetingNotes(deps, a, meetingId).catch(() => null),
    m.createdBy.type === "member" && m.createdBy.id ? deps.db.select({ email: users.email }).from(users).where(eq(users.id, m.createdBy.id)).get() : Promise.resolve(undefined),
  ]);
  const own = me?.email?.toLowerCase() ?? "";
  const to = [...new Set([creator?.email, ...m.invitees].filter((e): e is string => !!e).map((e) => e.trim()).filter((e) => e.toLowerCase() !== own))].slice(0, 50);
  const { summary, decisions } = splitSummary(rec?.summary ?? null);
  const tasks: { title: string; owner: string | null; due: string | null }[] = [];
  const seen = new Set<string>();
  for (const s of list) if (s.status === "accepted") { seen.add(normalise(s.title)); tasks.push({ title: s.title, owner: s.assignee?.name ?? null, due: s.due }); }
  for (const i of notes?.actionItems ?? []) if (i.task && !seen.has(normalise(i.task.title))) { seen.add(normalise(i.task.title)); tasks.push({ title: i.task.title, owner: i.assignee?.name ?? null, due: i.task.due ?? i.due }); }
  const tz = await zoneOf(deps, a, { recurrenceTz: m.recurrence?.timezone ?? null });
  let date: string;
  try { date = new Date(m.startsAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }); } catch { date = m.startsAt.slice(0, 10); }
  const mail = followUpEmail({ title: m.title, date, senderName: me?.name ?? null, summary, decisions, tasks: tasks.slice(0, 40) });
  return { to, subject: mail.subject, text: mail.text, counts: { tasks: tasks.length, decisions: decisions.length } };
}

