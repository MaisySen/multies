/**
 * R27 (teardown): duplicate a task, the "Duplicate" / "Clone" item on every rival's task menu (ClickUp, Asana,
 * monday.com, Jira "Clone"). The copy gets a new number and starts in the project's first to-do status. It keeps the
 * notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom field values; by default
 * it also copies the subtasks (up to 3 levels, at most DUPLICATE_MAX_TASKS tasks in all) and the checklist (every
 * item unticked). Comments, time, files and history stay with the original. "Blocked by" links are copied only when
 * asked (dependencies: true). The copy is linked to the original ("duplicate_of") and its activity says where it came
 * from. A copy into another project keeps no sprint or custom field values (they belong to the old project).
 * Inserts of copied checklist items and field values go in small batches, under D1's 100-variable limit.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { taskChecklistItems, taskFieldValues, tasks } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { chunkIds } from "../../lib/sql-chunks";
import { assertWritable, recordWrite, sortableId, type SuiteActor } from "./common";
import { addDependency, createTask, dependenciesOf, getTask, link, type Task } from "./tasks";
import type { RepeatRule } from "./recurrence";

export const DUPLICATE_MAX_TASKS = 200;
const MAX_DEPTH = 3;

export interface DuplicateOptions {
  /** The copy's title; "<title> (copy)" when not given. */
  title?: string;
  /** Another project of the same workspace; the same project when not given. */
  projectId?: string;
  /** Copy the subtasks too (default true). */
  subtasks?: boolean;
  /** Copy the checklist, every item unticked (default true). */
  checklist?: boolean;
  /** Keep the assignee (default true). */
  assignee?: boolean;
  /** Copy the "blocked by" links (default false). */
  dependencies?: boolean;
}

const bad = (message: string) => new HttpError(422, "validation_failed", message);

/** Rows per insert so rows x columns stays under D1's 100 bound variables. */
const rowsPerInsert = (columns: number) => Math.max(1, Math.floor(90 / columns));

async function copyChecklist(deps: Deps, orgId: string, fromId: string, toId: string, by: string) {
  const items = await deps.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, fromId)).orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.createdAt));
  if (!items.length) return 0;
  const now = deps.now();
  const rows = items.map((r) => ({ id: sortableId("chk"), orgId, taskId: toId, title: r.title, done: false, position: r.position, assignee: r.assignee, due: r.due, createdBy: by, createdAt: now, updatedAt: now }));
  for (const part of chunkIds(rows, rowsPerInsert(11))) await deps.db.insert(taskChecklistItems).values(part);
  return rows.length;
}

async function copyFieldValues(deps: Deps, orgId: string, fromId: string, toId: string) {
  const vals = await deps.db.select().from(taskFieldValues).where(and(eq(taskFieldValues.orgId, orgId), eq(taskFieldValues.taskId, fromId)));
  if (!vals.length) return;
  const now = deps.now();
  const rows = vals.map((v) => ({ taskId: toId, fieldId: v.fieldId, orgId, valueText: v.valueText, valueNum: v.valueNum, updatedAt: now }));
  for (const part of chunkIds(rows, rowsPerInsert(6))) await deps.db.insert(taskFieldValues).values(part).onConflictDoNothing();
}

const repeatOf = (t: Task): RepeatRule | null => {
  if (!t.repeat) return null;
  const { text: _text, ...rule } = t.repeat as RepeatRule & { text?: string };
  return rule as RepeatRule;
};

/** Duplicates a task (and by default its subtasks and checklist). Returns the copy and what was copied. */
export async function duplicateTask(deps: Deps, a: SuiteActor, taskIdOrRef: string, opts: DuplicateOptions = {}) {
  assertWritable(a);
  const src = await getTask(deps, a, taskIdOrRef);
  if (src.triage) throw bad("Accept the task from Triage before duplicating it.");
  const title = (opts.title ?? `${src.title} (copy)`).replace(/\s+/g, " ").trim();
  if (!title) throw bad("Give the copy a title.");
  if (title.length > 500) throw bad("A task title is at most 500 characters.");
  const projectId = opts.projectId ?? src.projectId;
  const sameProject = projectId === src.projectId;
  const by = a.agentId ? `agent:${a.agentId}` : a.system ? "system" : `member:${a.userId}`;
  const counts = { tasks: 0, checklistItems: 0, dependencies: 0 };

  const copyOne = async (t: Task, parentId: string | null, depth: number, top: boolean): Promise<Task> => {
    const made = await createTask(deps, a, {
      title: top ? title : t.title, notes: t.notes, projectId,
      status: "todo",
      assignee: opts.assignee === false || !t.assignee ? null : { type: t.assignee.type, id: t.assignee.id },
      priority: t.priority, start: t.start, due: t.due, labels: t.labels,
      parentId: top ? (sameProject ? t.parentId : null) : parentId,
      type: t.type, points: t.points, sprintId: sameProject ? t.sprintId : null,
      repeat: repeatOf(t),
    });
    counts.tasks++;
    if (sameProject) await copyFieldValues(deps, a.orgId, t.id, made.id);
    if (opts.checklist !== false) counts.checklistItems += await copyChecklist(deps, a.orgId, t.id, made.id, by);
    if (opts.subtasks !== false && depth < MAX_DEPTH) {
      const subs = await deps.db.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.orgId, a.orgId), eq(tasks.parentId, t.id), isNull(tasks.deletedAt), isNull(tasks.triageState))).orderBy(asc(tasks.position), asc(tasks.createdAt));
      for (const s of subs) {
        if (counts.tasks >= DUPLICATE_MAX_TASKS) break;
        await copyOne(await getTask(deps, a, s.id), made.id, depth + 1, false);
      }
    }
    return made;
  };

  const copy = await copyOne(src, null, 0, true);
  if (opts.dependencies) {
    const { blockedBy } = await dependenciesOf(deps, a.orgId, src.id);
    for (const b of blockedBy) { await addDependency(deps, a, copy.id, b.id); counts.dependencies++; }
  }
  await link(deps, a.orgId, { type: "task", id: copy.id }, { type: "task", id: src.id }, "duplicate_of");
  const task = await getTask(deps, a, copy.id);
  await recordWrite(deps, a, { entityType: "task", entityId: copy.id, op: "update", version: task.version, verb: "duplicated", data: { from: src.id, ref: src.ref, title: src.title, ...counts } });
  return { task, from: { id: src.id, ref: src.ref }, copied: { tasks: counts.tasks, subtasks: counts.tasks - 1, checklistItems: counts.checklistItems, dependencies: counts.dependencies } };
}
