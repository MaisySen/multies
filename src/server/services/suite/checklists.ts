/**
 * R26 (MB-85): checklists inside a task. A checklist item is a light to-do on one task: title, done, order and an
 * optional assignee and due date. Permissions follow the task: anyone who can open the task in this workspace can
 * read its checklist; read only keys can't write; another workspace's ids answer 404. Writes cost one row plus the
 * one index (task_checklist_items_task_idx) and record no activity rows, so ticking through a list stays cheap.
 * The same service backs the app routes (checklists.ts), REST (v1-r26-checklists.ts) and MCP (mcp-r26-checklists.ts).
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { tasks, taskChecklistItems } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { chunkIds, inChunks, inIds } from "../../lib/sql-chunks";
import { assertWritable, iso, parseDate, sortableId, actorOf, type SuiteActor } from "./common";
import { createTask, getTask, parseAssignee, resolveTaskId, validateAssignee, type Task } from "./tasks";

export const CHECKLIST_MAX_ITEMS = 200;
export const CHECKLIST_TITLE_MAX = 500;

type Row = typeof taskChecklistItems.$inferSelect;
export interface ChecklistItem { id: string; taskId: string; title: string; done: boolean; position: number; assignee: string | null; due: string | null; createdAt: string; updatedAt: string }
export interface ChecklistInput { title?: string; done?: boolean; assignee?: string | null; due?: string | null; position?: number }

const present = (r: Row): ChecklistItem => ({
  id: r.id, taskId: r.taskId, title: r.title, done: !!r.done, position: r.position,
  assignee: r.assignee, due: iso(r.due), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

const bad = (message: string) => new HttpError(422, "validation_failed", message);

/** The task, if this actor's workspace has it and it is not deleted. A guest passes its project to be held to it. */
async function taskFor(deps: Deps, a: SuiteActor, idOrRef: string, projectId?: string) {
  const id = await resolveTaskId(deps, a.orgId, idOrRef);
  const t = await deps.db.select({ id: tasks.id, projectId: tasks.projectId, orgId: tasks.orgId }).from(tasks)
    .where(and(eq(tasks.orgId, a.orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t || (projectId && t.projectId !== projectId)) throw notFound("Task");
  return t;
}

async function itemFor(deps: Deps, a: SuiteActor, itemId: string) {
  const r = await deps.db.select().from(taskChecklistItems).where(and(eq(taskChecklistItems.orgId, a.orgId), eq(taskChecklistItems.id, itemId))).get();
  if (!r) throw notFound("Checklist item");
  await taskFor(deps, a, r.taskId); // a deleted task hides its checklist
  return r;
}

const cleanTitle = (t: string | undefined) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  if (!s) throw bad("A checklist item needs a title.");
  if (s.length > CHECKLIST_TITLE_MAX) throw bad(`A checklist item title is at most ${CHECKLIST_TITLE_MAX} characters.`);
  return s;
};

async function cleanAssignee(deps: Deps, orgId: string, v: string | null | undefined) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const a = parseAssignee(v);
  if (!a) throw bad("assignee is member:<userId> or agent:<agentId>.");
  await validateAssignee(deps, orgId, a);
  return `${a.type}:${a.id}`;
}

function cleanDue(v: string | null | undefined) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = parseDate(v);
  if (!d) throw bad("due is a date, like 2026-11-02.");
  return d;
}

async function rows(deps: Deps, taskId: string) {
  return deps.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, taskId)).orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.createdAt));
}

const summary = (items: ChecklistItem[]) => ({ total: items.length, done: items.filter((i) => i.done).length });

export async function listChecklist(deps: Deps, a: SuiteActor, taskIdOrRef: string, guestProjectId?: string) {
  const t = await taskFor(deps, a, taskIdOrRef, guestProjectId);
  const items = (await rows(deps, t.id)).map(present);
  return { taskId: t.id, items, ...summary(items) };
}

export async function addChecklistItems(deps: Deps, a: SuiteActor, taskIdOrRef: string, input: ChecklistInput | ChecklistInput[], opts: { ids?: string[]; retry?: boolean } = {}) {
  assertWritable(a);
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) throw bad("Add at least one item.");
  if (opts.ids?.length && opts.retry) { // R52 (MB-239): a retry under the same Idempotency-Key returns what the first attempt made (all items went in one call)
    const hit = await deps.db.select().from(taskChecklistItems).where(and(eq(taskChecklistItems.orgId, a.orgId), inIds(taskChecklistItems.id, opts.ids)));
    if (hit.length) return opts.ids.map((id) => hit.find((r) => r.id === id)).filter((r): r is Row => !!r).map(present);
  }
  const t = await taskFor(deps, a, taskIdOrRef);
  const existing = await rows(deps, t.id);
  if (existing.length + list.length > CHECKLIST_MAX_ITEMS) throw bad(`A task holds up to ${CHECKLIST_MAX_ITEMS} checklist items.`);
  let pos = existing.reduce((m, r) => Math.max(m, r.position), 0);
  const now = deps.now();
  const by = actorOf(a);
  const made: Row[] = [];
  for (const [i, x] of list.entries()) {
    pos = x.position ?? pos + 1;
    made.push({
      id: opts.ids?.[i] ?? sortableId("chk"), orgId: a.orgId, taskId: t.id, title: cleanTitle(x.title), done: !!x.done, position: pos,
      assignee: (await cleanAssignee(deps, a.orgId, x.assignee)) ?? null, due: cleanDue(x.due) ?? null,
      createdBy: by.id ? `${by.type}:${by.id}` : by.type, createdAt: now, updatedAt: now,
    });
  }
  // R27: 11 columns a row, so 8 rows an insert keeps under D1's 100 bound variables (a 10+ item add used to fail on D1).
  for (const part of chunkIds(made, 8)) await deps.db.insert(taskChecklistItems).values(part);
  return made.map(present);
}

export async function updateChecklistItem(deps: Deps, a: SuiteActor, itemId: string, patch: ChecklistInput) {
  assertWritable(a);
  const r = await itemFor(deps, a, itemId);
  const set: Partial<Row> = {};
  if (patch.title !== undefined) set.title = cleanTitle(patch.title);
  if (patch.done !== undefined) set.done = !!patch.done;
  if (patch.position !== undefined) { if (!Number.isFinite(patch.position)) throw bad("position is a number."); set.position = patch.position; }
  const as = await cleanAssignee(deps, a.orgId, patch.assignee);
  if (as !== undefined) set.assignee = as;
  const due = cleanDue(patch.due);
  if (due !== undefined) set.due = due;
  const changed = Object.entries(set).some(([k, v]) => {
    const cur = r[k as keyof Row];
    return cur instanceof Date || v instanceof Date ? (cur as Date | null)?.getTime() !== (v as Date | null)?.getTime() : cur !== v;
  });
  if (!changed) return present(r); // nothing to write
  set.updatedAt = deps.now();
  await deps.db.update(taskChecklistItems).set(set).where(eq(taskChecklistItems.id, r.id));
  return present({ ...r, ...set });
}

export async function deleteChecklistItem(deps: Deps, a: SuiteActor, itemId: string) {
  assertWritable(a);
  const r = await itemFor(deps, a, itemId);
  await deps.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, r.id));
  return { ok: true as const, id: r.id };
}

/** Puts the task's items in the order given (every id once). Only rows whose position changes are written. */
export async function reorderChecklist(deps: Deps, a: SuiteActor, taskIdOrRef: string, ids: string[]) {
  assertWritable(a);
  const t = await taskFor(deps, a, taskIdOrRef);
  const cur = await rows(deps, t.id);
  const known = new Set(cur.map((r) => r.id));
  if (ids.length !== cur.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) throw bad("Pass every item id of this checklist once, in the new order.");
  const byId = new Map(cur.map((r) => [r.id, r]));
  const now = deps.now();
  for (const [i, id] of ids.entries()) {
    if (byId.get(id)!.position === i + 1) continue;
    await deps.db.update(taskChecklistItems).set({ position: i + 1, updatedAt: now }).where(eq(taskChecklistItems.id, id));
  }
  return listChecklist(deps, a, t.id);
}

/** Turns an item into a subtask of its task (same title, assignee and due date) and removes the item. */
export async function checklistItemToSubtask(deps: Deps, a: SuiteActor, itemId: string, opts: { id?: string; retry?: boolean } = {}): Promise<{ task: Task; removedItemId: string }> {
  assertWritable(a);
  if (opts.id && opts.retry) {
    // R55 (MB-239): a retry under the same Idempotency-Key whose first attempt made the subtask returns it (the item is
    // already gone then, or goes now if the first attempt was cut off between the two writes). One read, only on a retry.
    const made = await deps.db.select({ id: tasks.id, parentId: tasks.parentId }).from(tasks).where(and(eq(tasks.id, opts.id), eq(tasks.orgId, a.orgId))).get();
    if (made) {
      if (made.parentId) await deps.db.delete(taskChecklistItems).where(and(eq(taskChecklistItems.id, itemId), eq(taskChecklistItems.taskId, made.parentId)));
      return { task: await getTask(deps, a, made.id), removedItemId: itemId };
    }
  }
  const r = await itemFor(deps, a, itemId);
  const task = await createTask(deps, a, { title: r.title, parentId: r.taskId, assignee: r.assignee ? parseAssignee(r.assignee) : null, due: r.due ? r.due.toISOString() : null }, opts.id ? { id: opts.id, retry: false } : {});
  await deps.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, r.id));
  return { task, removedItemId: r.id };
}

/** Item counts for many tasks at once (cards show "3/5"). Big id lists go through inChunks (D1 100 variables). */
export async function checklistCounts(deps: Deps, taskIds: readonly string[]) {
  const out = new Map<string, { total: number; done: number }>();
  const got = await inChunks([...new Set(taskIds)], (chunk) => deps.db.select({ taskId: taskChecklistItems.taskId, total: sql<number>`count(*)`, done: sql<number>`sum(${taskChecklistItems.done})` })
    .from(taskChecklistItems).where(inIds(taskChecklistItems.taskId, chunk)).groupBy(taskChecklistItems.taskId));
  for (const g of got) out.set(g.taskId, { total: Number(g.total), done: Number(g.done ?? 0) });
  return out;
}

/** Copies a task's checklist (titles and order, all unticked) onto another task: used by duplicate and template paths. */
export async function copyChecklist(deps: Deps, a: SuiteActor, titles: string[], toTaskId: string) {
  const list = titles.map((t) => t.trim()).filter(Boolean).slice(0, CHECKLIST_MAX_ITEMS);
  if (!list.length) return 0;
  await addChecklistItems(deps, a, toTaskId, list.map((title) => ({ title })));
  return list.length;
}

export async function checklistTitles(deps: Deps, taskId: string) {
  return (await rows(deps, taskId)).map((r) => r.title);
}
