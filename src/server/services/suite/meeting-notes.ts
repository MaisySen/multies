/**
 * Round 23 (R23.1, R23.5): the agenda and notes doc of a meeting, and its action items turned into tasks.
 *
 * The doc is made the first time someone opens Notes (or an agent asks for it). Two people opening at
 * once must not make two docs: each inserts its doc and claims meetings.doc_id with a conditional
 * update (doc_id still empty, or still pointing at a deleted doc); the loser reads the winner's id and
 * removes its own row. A weekly series is one meetings row, so a series shares one notes doc.
 *
 * Action items are the doc's task list items (anywhere in it). Which ones already became tasks lives in
 * meeting_action_items (one row per item, 1 write, no extra index). Writing the task id back into the
 * doc instead would rewrite the whole doc row (its index too) on every click and fight a live editing
 * session for the same row, so the small table is cheaper and safer.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { docs, meetingActionItems, meetings, organizations, users } from "../../db/schema";
import { runBatch } from "../../db";
import { HttpError, notFound } from "../../lib/errors";
import { listPeople } from "../people";
import { assertWritable, createdBy, sortableId, type SuiteActor } from "./common";
import { plainTextOf } from "./docs";
import { getMeeting } from "./meetings";
import { createTask, deleteTask, getTask, link, parseAssignee, validateAssignee } from "./tasks";
import { actionItemsOf, actionItemText, appendActionItem, itemKey, notesTemplate, sectionsOf, type ActionPerson, type PMNodeLike } from "@/shared/action-items";

type Assignee = { type: "member" | "agent"; id: string };
const MAX_CREATE = 50;

async function meetingRow(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.orgId, orgId), eq(meetings.id, id), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  return m;
}

async function liveDoc(deps: Deps, orgId: string, id: string | null) {
  if (!id) return undefined;
  return deps.db.select().from(docs).where(and(eq(docs.orgId, orgId), eq(docs.id, id), isNull(docs.deletedAt))).get();
}

/** People an item can name: members (agent members included) and mail agents. */
export async function actionPeople(deps: Deps, orgId: string): Promise<ActionPerson[]> {
  return (await listPeople(deps, orgId)).map((p) => (p.type === "mail_agent"
    ? { type: "agent" as const, id: p.agentId!, name: p.name, email: p.inbox }
    : { type: "member" as const, id: p.userId!, name: p.name, email: p.email }));
}

/** Relative dates ("Friday", "tomorrow") read in the series' zone, else the person's, else the workspace's. */
async function zoneOf(deps: Deps, actor: SuiteActor, m: { recurrenceTz: string | null }) {
  if (m.recurrenceTz) return m.recurrenceTz;
  if (actor.userId) {
    const u = await deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, actor.userId)).get();
    if (u?.tz) return u.tz;
  }
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  return o?.tz ?? "UTC";
}

/** The notes doc, made on first use. Returns its id. */
export async function ensureNotesDoc(deps: Deps, actor: SuiteActor, meetingId: string): Promise<string> {
  const m = await meetingRow(deps, actor.orgId, meetingId);
  if (await liveDoc(deps, actor.orgId, m.docId)) return m.docId!;
  assertWritable(actor);
  const now = deps.now();
  const id = sortableId("doc", now.getTime());
  const body = notesTemplate();
  const title = `${m.title} notes`.slice(0, 200);
  await runBatch(deps.db, [
    deps.db.insert(docs).values({ id, orgId: actor.orgId, title, content: JSON.stringify(body), plainText: plainTextOf(body as never), projectId: null, ...createdBy(actor), createdAt: now, updatedAt: now }),
    deps.db.update(meetings).set({ docId: id })
      .where(and(eq(meetings.orgId, actor.orgId), eq(meetings.id, meetingId), m.docId ? or(isNull(meetings.docId), eq(meetings.docId, m.docId)) : isNull(meetings.docId))),
  ]);
  const after = await deps.db.select({ docId: meetings.docId }).from(meetings).where(and(eq(meetings.orgId, actor.orgId), eq(meetings.id, meetingId))).get();
  if (after?.docId === id) return id;
  // Someone else's doc won the race: drop ours (never seen by anyone) and use theirs.
  await deps.db.delete(docs).where(and(eq(docs.orgId, actor.orgId), eq(docs.id, id)));
  if (!after?.docId) throw new HttpError(409, "conflict", "The notes doc could not be made. Try again.");
  return after.docId;
}

export interface NotesActionItem {
  key: string; text: string; title: string;
  assignee: { type: "member" | "agent"; id: string; name: string } | null;
  due: string | null;
  task: { id: string; ref: string; title: string; status: string; done: boolean; assignee: unknown; due: string | null } | null;
}

/** The meeting's notes: the doc (if made yet), its agenda and notes lines, and the action items with their tasks. Reads only. */
export async function meetingNotes(deps: Deps, actor: SuiteActor, meetingId: string) {
  const meeting = await getMeeting(deps, actor, meetingId);
  const m = await meetingRow(deps, actor.orgId, meetingId);
  const d = await liveDoc(deps, actor.orgId, m.docId);
  const content = d ? (JSON.parse(d.content) as PMNodeLike) : null;
  const [people, tz, done] = await Promise.all([actionPeople(deps, actor.orgId), zoneOf(deps, actor, m),
    deps.db.select().from(meetingActionItems).where(and(eq(meetingActionItems.orgId, actor.orgId), eq(meetingActionItems.meetingId, meetingId)))]);
  const now = deps.now();
  const parsed = actionItemsOf(content, people, now, tz);
  const byKey = new Map(done.map((r) => [r.itemKey, r.taskId]));
  const tasksById = new Map<string, NotesActionItem["task"]>();
  for (const taskId of new Set(parsed.map((p) => byKey.get(p.key)).filter((x): x is string => !!x))) {
    try {
      const t = await getTask(deps, actor, taskId);
      tasksById.set(taskId, { id: t.id, ref: t.ref, title: t.title, status: t.statusName, done: t.status === "done", assignee: t.assignee, due: t.due });
    } catch { /* the task was deleted: show the item as converted with no task */ }
  }
  const actionItems: NotesActionItem[] = parsed.map((p) => ({ key: p.key, text: p.text, title: p.title, assignee: p.assignee, due: p.due, task: byKey.has(p.key) ? tasksById.get(byKey.get(p.key)!) ?? null : null }));
  const converted = new Set(done.map((r) => r.itemKey));
  const sections = sectionsOf(content);
  return {
    meeting: { id: meeting.id, title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, status: meeting.status, invitees: meeting.invitees, joinUrl: meeting.joinUrl, recurrence: meeting.recurrence ? meeting.recurrence.summary : null, source: meeting.source },
    timeZone: tz,
    doc: d ? { id: d.id, title: d.title, version: d.version, updatedAt: d.updatedAt.toISOString(), content, text: d.plainText } : null,
    agenda: sections.agenda,
    notes: [...sections.notes, ...sections.other],
    actionItems,
    /** Items not yet turned into tasks. */
    pending: actionItems.filter((i) => !converted.has(i.key)).length,
    people: people.map((p) => ({ type: p.type, id: p.id, name: p.name })),
    /** Filled by the recording and transcript feature when a summary exists. */
    summary: null as string | null,
  };
}

/** The meeting a doc holds the notes for, if any (for "Notes for <meeting>" on the doc page). Reads only. */
export async function meetingForDoc(deps: Deps, actor: SuiteActor, docId: string) {
  if (!(await liveDoc(deps, actor.orgId, docId))) throw notFound("Doc");
  const m = await deps.db.select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt }).from(meetings)
    .where(and(eq(meetings.orgId, actor.orgId), eq(meetings.docId, docId), isNull(meetings.deletedAt))).get();
  return m ? { id: m.id, title: m.title, startsAt: m.startsAt.toISOString() } : null;
}

export interface ActionItemInput {
  /** An item already in the doc (from meetingNotes). Without a key the item is new: it is added to the doc, then made a task. */
  key?: string;
  title?: string;
  /** "member:<userId>", "agent:<agentId>", a name or an email in the workspace; null for nobody. */
  assignee?: string | Assignee | null;
  /** YYYY-MM-DD (or an ISO time); null for none. */
  due?: string | null;
}

function resolveAssignee(v: string | Assignee | null | undefined, people: ActionPerson[]): Assignee | null | undefined {
  if (v === undefined || v === null || v === "") return v === undefined ? undefined : null;
  if (typeof v === "string" && !/^(member|agent):/.test(v)) {
    const s = v.trim().replace(/^@/, "").toLowerCase();
    const hit = people.find((p) => p.id === v.trim() || p.name.toLowerCase() === s || (p.email ?? "").toLowerCase() === s);
    if (!hit) throw new HttpError(422, "invalid_assignee", `No one called "${v}" in this workspace.`);
    return { type: hit.type, id: hit.id };
  }
  return parseAssignee(v) as Assignee;
}

const DUE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/**
 * Turns action items into tasks in one go. With no items: every unchecked doc item that is not a task yet.
 * Items that already became tasks are skipped, so pressing twice makes nothing new. Each task links back
 * to the meeting ("about"). Assignees must be members or agents of this workspace (checked before any write).
 */
export async function createActionItems(deps: Deps, actor: SuiteActor, meetingId: string, input: { items?: ActionItemInput[]; projectId?: string | null } = {}) {
  assertWritable(actor);
  const m = await meetingRow(deps, actor.orgId, meetingId);
  if ((input.items?.length ?? 0) > MAX_CREATE) throw new HttpError(422, "validation_failed", `Up to ${MAX_CREATE} action items at a time.`);
  const people = await actionPeople(deps, actor.orgId);
  const tz = await zoneOf(deps, actor, m);
  const now = deps.now();

  // New items (no key) go into the doc first, so the doc stays the record of what was agreed.
  const fresh = (input.items ?? []).filter((i) => !i.key);
  const plan: { key: string; title: string; assignee: Assignee | null; due: string | null }[] = [];
  for (const i of fresh) {
    if (!i.title?.trim()) throw new HttpError(422, "validation_failed", "Each new action item needs a title.");
    if (i.due && !DUE.test(i.due)) throw new HttpError(422, "validation_failed", "due looks like 2026-10-30.");
  }
  const freshResolved = fresh.map((i) => ({ i, assignee: resolveAssignee(i.assignee, people) ?? null }));
  for (const f of freshResolved) await validateAssignee(deps, actor.orgId, f.assignee);

  let docId = m.docId;
  let content: PMNodeLike | null;
  if (fresh.length) {
    docId = await ensureNotesDoc(deps, actor, meetingId);
    const d = (await liveDoc(deps, actor.orgId, docId))!;
    content = JSON.parse(d.content) as PMNodeLike;
    for (const { i, assignee } of freshResolved) {
      const who = assignee ? people.find((p) => p.type === assignee.type && p.id === assignee.id) ?? null : null;
      content = appendActionItem(content, actionItemText(i.title!.trim(), who, i.due ? i.due.slice(0, 10) : null));
    }
    const { updateDoc } = await import("./docs");
    await updateDoc(deps, actor, docId, { content });
  } else {
    const d = await liveDoc(deps, actor.orgId, docId);
    content = d ? (JSON.parse(d.content) as PMNodeLike) : null;
  }

  const items = actionItemsOf(content, people, now, tz);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const existing = await deps.db.select().from(meetingActionItems).where(and(eq(meetingActionItems.orgId, actor.orgId), eq(meetingActionItems.meetingId, meetingId)));
  const done = new Map(existing.map((r) => [r.itemKey, r.taskId]));

  if (!input.items?.length) {
    for (const i of items) plan.push({ key: i.key, title: i.title, assignee: i.assignee ? { type: i.assignee.type, id: i.assignee.id } : null, due: i.due });
  } else {
    // Keys of the fresh items: the text they were written as.
    const freshKeys = new Set<string>();
    for (const { i, assignee } of freshResolved) {
      const who = assignee ? people.find((p) => p.type === assignee.type && p.id === assignee.id) ?? null : null;
      const base = itemKey(actionItemText(i.title!.trim(), who, i.due ? i.due.slice(0, 10) : null));
      const key = [...byKey.keys()].reverse().find((k) => (k === base || k.startsWith(`${base}#`)) && !done.has(k) && !freshKeys.has(k)) ?? base;
      freshKeys.add(key);
      plan.push({ key, title: i.title!.trim(), assignee, due: i.due ?? null });
    }
    for (const i of input.items.filter((x) => x.key)) {
      const item = byKey.get(i.key!);
      if (!item) throw new HttpError(404, "not_found", "That action item is not in the notes any more. Reload the notes.");
      if (i.due && !DUE.test(i.due)) throw new HttpError(422, "validation_failed", "due looks like 2026-10-30.");
      const assignee = i.assignee !== undefined ? resolveAssignee(i.assignee, people) ?? null : item.assignee ? { type: item.assignee.type, id: item.assignee.id } : null;
      plan.push({ key: item.key, title: i.title?.trim() || item.title, assignee, due: i.due !== undefined ? i.due : item.due });
    }
  }
  const todo = plan.filter((p, n) => !done.has(p.key) && plan.findIndex((x) => x.key === p.key) === n).slice(0, MAX_CREATE);
  for (const p of todo) await validateAssignee(deps, actor.orgId, p.assignee);
  // Default project: the source task's project, else createTask's default.
  let projectId = input.projectId ?? undefined;
  if (!projectId && m.sourceType === "task" && m.sourceId) {
    try { projectId = (await getTask(deps, actor, m.sourceId)).projectId; } catch { /* the source task is gone */ }
  }

  const created: Awaited<ReturnType<typeof getTask>>[] = [];
  for (const p of todo) {
    const task = await createTask(deps, actor, { title: p.title.slice(0, 500), assignee: p.assignee, due: p.due, projectId, notes: `From the meeting "${m.title}".` });
    const claimed = await deps.db.insert(meetingActionItems).values({ orgId: actor.orgId, meetingId, itemKey: p.key, taskId: task.id, createdAt: now }).onConflictDoNothing().returning({ k: meetingActionItems.itemKey });
    if (!claimed.length) { await deleteTask(deps, actor, task.id); continue; } // another click got there first
    await link(deps, actor.orgId, { type: "task", id: task.id }, { type: "meeting", id: meetingId }, "about");
    created.push(task);
  }
  const skipped = plan.filter((p) => done.has(p.key)).map((p) => ({ key: p.key, taskId: done.get(p.key)! }));
  return { created, skipped, docId };
}
