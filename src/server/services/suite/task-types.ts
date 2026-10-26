/**
 * Round 21 (R21.4): task types and epics.
 *
 * Every task has a type: task (the default), story, bug or epic. Epics group work through the
 * existing parent link: an item whose parent is an epic is in that epic. The rules, kept simple:
 *   1. An epic has no parent. It can't be a subtask, and it can't sit inside another epic.
 *   2. A story, task or bug is in at most one epic (it has one parent). Putting it in an epic moves
 *      it there; subtasks of a story stay subtasks of that story.
 *   3. An item with a parent can't become an epic. Take it out first.
 *   4. An epic that still has items can't change to another type. Move its items out first.
 * Epic progress (done of total, by count and by points when tasks carry points) and the epic's date
 * span are worked out when read, so they cost no writes.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { activity, changes, tasks } from "../../db/schema";
import { runBatch } from "../../db";
import { HttpError, notFound } from "../../lib/errors";
import { actorOf, assertWritable, sortableId, type SuiteActor } from "./common";

export const TASK_TYPES = ["task", "story", "bug", "epic"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const isTaskType = (v: unknown): v is TaskType => typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);

/** Most items a single add or remove call takes. */
export const MAX_EPIC_BATCH = 100;
/** D1 allows 100 bound values per statement: id lists are read in chunks below that. */
const CHUNK = 90;

type TaskRow = typeof tasks.$inferSelect;

/**
 * The list and board show top level items: no parent, or a parent that is an epic (an epic's items
 * stay on the board). Subtasks of a story, task or bug stay hidden there, as before.
 */
export function topLevelCondition(): SQL {
  return or(isNull(tasks.parentId), sql`exists (select 1 from tasks ep where ep.id = ${tasks.parentId} and ep.type = 'epic')`)!;
}

/** Checks the epic rules for a create or an update. `current` is the row before the change (absent on create). */
export async function checkTypeRules(deps: Deps, orgId: string, next: { type: TaskType; parentId: string | null }, current?: Pick<TaskRow, "id" | "type" | "parentId">) {
  if (next.type === "epic" && next.parentId) {
    throw new HttpError(422, current && current.type !== "epic" && current.parentId ? "epic_has_parent" : "epic_in_epic",
      current && current.type !== "epic" && current.parentId
        ? "This item sits inside another task or epic. Take it out first, then make it an epic."
        : "An epic can't sit inside another task or epic.");
  }
  if (current && current.type === "epic" && next.type !== "epic") {
    const child = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, current.id), eq(tasks.orgId, orgId), isNull(tasks.deletedAt))).get();
    if (child) throw new HttpError(422, "epic_has_items", "This epic still has items. Move them out before changing its type.");
  }
}

// ---------------------------------------------------------------- progress

export interface ProgressItem { id: string; parentId: string | null; status: string; startAt?: Date | null; dueAt?: Date | null }
export type Weight<T> = (item: T) => number | null | undefined;
export interface EpicProgress {
  done: number; total: number; percent: number;
  /** Direct items of the epic, and their subtasks, counted apart. */
  items: number; subtasks: number;
  /** By points, when any item carries points; otherwise null. */
  points: { done: number; total: number; percent: number } | null;
  /** Earliest start and latest due date of the epic's items, for the timeline. */
  start: string | null; end: string | null;
}

/** Reads a numeric `points` value off a row when the column exists, else null. */
export const pointsWeight = (row: unknown): number | null => {
  const p = (row as { points?: unknown } | null)?.points;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

/**
 * Progress of one epic from its items and their subtasks (rows with other parents are ignored).
 * Pure: pass a weight getter to also count points; without one, or with no weights, points is null.
 */
export function epicProgress<T extends ProgressItem>(epicId: string, rows: T[], weight?: Weight<T>): EpicProgress {
  const items = rows.filter((r) => r.parentId === epicId);
  const itemIds = new Set(items.map((r) => r.id));
  const subtasks = rows.filter((r) => r.parentId !== null && r.parentId !== epicId && itemIds.has(r.parentId));
  const all = [...items, ...subtasks];
  const done = all.filter((r) => r.status === "done").length;
  let points: EpicProgress["points"] = null;
  if (weight) {
    let total = 0, pdone = 0, any = false;
    for (const r of all) {
      const w = weight(r);
      if (typeof w !== "number" || !Number.isFinite(w)) continue;
      any = true; total += w;
      if (r.status === "done") pdone += w;
    }
    if (any) points = { done: pdone, total, percent: pct(pdone, total) };
  }
  let start: number | null = null, end: number | null = null;
  for (const r of items) {
    const s = r.startAt ? new Date(r.startAt).getTime() : null;
    const d = r.dueAt ? new Date(r.dueAt).getTime() : null;
    if (s !== null && (start === null || s < start)) start = s;
    if (d !== null && (end === null || d > end)) end = d;
  }
  return {
    done, total: all.length, percent: pct(done, all.length), items: items.length, subtasks: subtasks.length, points,
    start: start === null ? null : new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString(),
  };
}

const chunks = <T>(xs: T[], n = CHUNK) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Live rows whose parent is one of `parentIds`, in this workspace. Uses the parent index. */
async function childrenOf(deps: Deps, orgId: string, parentIds: string[]): Promise<TaskRow[]> {
  const out: TaskRow[] = [];
  for (const ids of chunks(parentIds)) {
    if (!ids.length) continue;
    out.push(...await deps.db.select().from(tasks).where(and(inArray(tasks.parentId, ids), eq(tasks.orgId, orgId), isNull(tasks.deletedAt))));
  }
  return out;
}

/** Items and subtasks for these epics, then progress per epic. */
async function progressFor(deps: Deps, orgId: string, epicIds: string[], weight: Weight<TaskRow> = pointsWeight) {
  const items = await childrenOf(deps, orgId, epicIds);
  const subs = await childrenOf(deps, orgId, items.map((r) => r.id));
  const rows = [...items, ...subs];
  return new Map(epicIds.map((id) => [id, epicProgress(id, rows, weight)]));
}

// ---------------------------------------------------------------- reads

async function epicRow(deps: Deps, orgId: string, idOrRef: string) {
  const { resolveTaskId } = await import("./tasks");
  const id = await resolveTaskId(deps, orgId, idOrRef);
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t || t.type !== "epic") throw notFound("Epic");
  return t;
}

/** Epics in the workspace (or one project), each with its progress. */
export async function listEpics(deps: Deps, actor: SuiteActor, opts: { projectId?: string } = {}) {
  const { listTasks } = await import("./tasks");
  const epics = await listTasks(deps, actor, { projectId: opts.projectId, type: "epic", includeSubtasks: true, limit: 500 });
  const progress = await progressFor(deps, actor.orgId, epics.map((e) => e.id));
  return epics.map((e) => ({ ...e, progress: progress.get(e.id)! }));
}

/** One epic with its items (each with its own subtask counts) and its progress. */
export async function getEpic(deps: Deps, actor: SuiteActor, idOrRef: string) {
  const row = await epicRow(deps, actor.orgId, idOrRef);
  const { getTask, listTasks } = await import("./tasks");
  const [epic, items, progress] = await Promise.all([
    getTask(deps, actor, row.id),
    listTasks(deps, actor, { parentId: row.id, limit: 1000 }),
    progressFor(deps, actor.orgId, [row.id]),
  ]);
  return { epic: { ...epic, progress: progress.get(row.id)! }, items };
}

// ---------------------------------------------------------------- writes

/**
 * Puts items in an epic (or takes them out) in one batch: one UPDATE for all the task rows, one
 * change entry per task for the sync feed, and one activity entry on the epic.
 */
async function moveItems(deps: Deps, actor: SuiteActor, epicIdOrRef: string, idsOrRefs: string[], mode: "add" | "remove") {
  assertWritable(actor);
  const epic = await epicRow(deps, actor.orgId, epicIdOrRef);
  const wanted = [...new Set(idsOrRefs.map((x) => x.trim()).filter(Boolean))];
  if (!wanted.length) throw new HttpError(422, "validation_failed", "Pass ids: the tasks to move.");
  if (wanted.length > MAX_EPIC_BATCH) throw new HttpError(422, "validation_failed", `Up to ${MAX_EPIC_BATCH} items at a time.`);
  const { resolveTaskId } = await import("./tasks");
  const ids = [...new Set(await Promise.all(wanted.map((x) => resolveTaskId(deps, actor.orgId, x))))];
  const rows: TaskRow[] = [];
  for (const part of chunks(ids)) rows.push(...await deps.db.select().from(tasks).where(and(eq(tasks.orgId, actor.orgId), inArray(tasks.id, part), isNull(tasks.deletedAt))));
  // Another workspace's ids (or deleted ones) are simply not found.
  if (rows.length !== ids.length) throw notFound("Task");
  if (mode === "add") {
    if (rows.some((r) => r.id === epic.id || r.type === "epic")) throw new HttpError(422, "epic_in_epic", "An epic can't sit inside another epic.");
  }
  const moving = rows.filter((r) => (mode === "add" ? r.parentId !== epic.id : r.parentId === epic.id));
  if (moving.length) {
    const now = deps.now();
    const a = actorOf(actor);
    const statements: PromiseLike<unknown>[] = [];
    for (const part of chunks(moving.map((r) => r.id))) {
      statements.push(deps.db.update(tasks).set({ parentId: mode === "add" ? epic.id : null, updatedAt: now, version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.orgId, actor.orgId), inArray(tasks.id, part))));
    }
    for (const part of chunks(moving, 14)) {
      statements.push(deps.db.insert(changes).values(part.map((r) => ({ orgId: actor.orgId, entityType: "task", entityId: r.id, op: "update" as const, version: r.version + 1, createdAt: now }))));
    }
    statements.push(deps.db.insert(activity).values({
      id: sortableId("act", now.getTime()), orgId: actor.orgId, actorType: a.type, actorId: a.id, actorName: a.name,
      verb: mode === "add" ? "added_to_epic" : "removed_from_epic", entityType: "task", entityId: epic.id,
      data: JSON.stringify({ ids: moving.map((r) => r.id) }), createdAt: now,
    }));
    await runBatch(deps.db, statements);
  }
  const out = await getEpic(deps, actor, epic.id);
  return { ...out, moved: moving.length };
}

export const addToEpic = (deps: Deps, actor: SuiteActor, epicId: string, ids: string[]) => moveItems(deps, actor, epicId, ids, "add");
export const removeFromEpic = (deps: Deps, actor: SuiteActor, epicId: string, ids: string[]) => moveItems(deps, actor, epicId, ids, "remove");

