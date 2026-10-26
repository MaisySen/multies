/**
 * Round 21 (R21.2): one patch on many tasks at once, for the table view's bulk bar, the REST API
 * (POST /api/v1/tasks/bulk) and MCP (bulk_update_tasks).
 *
 * Same rules as updateTask, without a read per task: the tasks are read in a few chunked queries,
 * the statuses, the assignee and the target project once, then every write goes out in one batch.
 * D1 allows 100 bound values per statement, so a write that differs per task (a position, a label
 * list, a new number) is a CASE on the id over a chunk of tasks, and a write that is the same for
 * every task is one UPDATE per chunk of ids.
 *
 * What is written per changed task: the tasks row and one changes row (the sync feed web, mobile
 * and agents read). The activity timeline gets ONE summary row per action, not one per task.
 * Webhooks still get one task.updated per task (they are read only when an endpoint exists), and
 * status automations still run for each task that changed status (read only when a rule exists).
 * A task with a repeat rule that is finished here goes through updateTask, so the next one is made.
 *
 * Write budget: at shed the action is refused; at warn it runs but the summary activity row and
 * the assignment notification are skipped.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { activity, automations, changes, projectStatuses, projects, taskFieldValues, tasks, webhookEndpoints } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { writeBudget } from "../write-budget";
import { actorOf, assertWritable, parseDate, sortableId, type SuiteActor } from "./common";
import { parseAssignee, presentTaskRows, updateTask, validateAssignee, type Assignee, type Category, type Priority, type Task } from "./tasks";
import { inIds } from "../../lib/sql-chunks";

export const BULK_MAX = 500;
/** Ids per IN list, under D1's 100 bound values per statement. */
const ID_CHUNK = 90;

type TaskRow = typeof tasks.$inferSelect;

export interface BulkPatch {
  /** A status id in the tasks' project. */
  statusId?: string;
  /** A status group: the first status of that group in each task's project. */
  status?: Category;
  /** "member:<id>", "agent:<id>", an object, or null to unassign. */
  assignee?: string | Assignee | null;
  priority?: Priority;
  /** ISO date or time; null clears. */
  dueAt?: string | null;
  startAt?: string | null;
  addLabels?: string[];
  removeLabels?: string[];
  /** Move to another project: numbers are claimed there and each status maps to the same group. */
  projectId?: string;
  /** Round 21: task, story or bug. Epics change type one at a time (their rules need the items). */
  type?: "task" | "story" | "bug";
}

export interface BulkResult { updated: number; unchanged: number; ids: string[]; tasks: Task[]; /** R24 polish: assignee_changed rule runs, and tasks skipped over the cap or while paused. */ automationRuns?: { runs: number; skipped: number } }

const chunk = <T>(rows: T[], n: number) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n));
const cleanLabel = (x: string) => x.trim().slice(0, 40);
const sameLabels = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function capIds(ids: string[]) {
  const list = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
  if (!list.length) throw new HttpError(422, "validation_failed", "Pick at least one task.");
  if (list.length > BULK_MAX) throw new HttpError(413, "too_many_tasks", `One bulk action changes at most ${BULK_MAX} tasks. Send them in smaller groups.`);
  return list;
}

async function assertBudget(deps: Deps) {
  const level = (await writeBudget(deps)).level;
  if (level === "shed") throw new HttpError(503, "write_budget", "Bulk changes are paused for today because the workspace database is near its daily write limit. Single edits still work.");
  return level;
}

/** Reads the tasks for ids or refs (OPS-12) in a few queries; refuses if any is not in this workspace. */
export async function loadTasks(deps: Deps, orgId: string, idsOrRefs: string[]): Promise<TaskRow[]> {
  const refRe = /^([A-Za-z0-9]{1,6})-(\d+)$/;
  const plain = idsOrRefs.filter((x) => !refRe.test(x));
  const byKey = new Map<string, number[]>();
  for (const x of idsOrRefs) {
    const m = refRe.exec(x);
    if (m) byKey.set(m[1].toUpperCase(), [...(byKey.get(m[1].toUpperCase()) ?? []), Number(m[2])]);
  }
  const reads: Promise<TaskRow[]>[] = chunk(plain, ID_CHUNK).map((ids) => deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), inArray(tasks.id, ids))));
  for (const [key, nums] of byKey) {
    for (const part of chunk(nums, ID_CHUNK)) {
      reads.push(deps.db.select({ t: tasks }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), eq(projects.key, key), inArray(tasks.number, part))).then((rows) => rows.map((r) => r.t))); // D1: part is one ID_CHUNK
    }
  }
  const found = new Map<string, TaskRow>();
  for (const rows of await Promise.all(reads)) for (const r of rows) found.set(r.id, r);
  const refOf = new Map<string, string>();
  if (byKey.size) {
    const keys = await deps.db.select({ id: projects.id, key: projects.key }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.key, [...byKey.keys()])));
    const keyOf = new Map(keys.map((k) => [k.id, k.key]));
    for (const r of found.values()) refOf.set(`${keyOf.get(r.projectId)}-${r.number}`, r.id);
  }
  const missing = idsOrRefs.filter((x) => !found.has(x) && !refOf.has(refRe.test(x) ? x.toUpperCase() : x));
  if (missing.length) {
    throw new HttpError(404, "not_found", missing.length === 1 ? `Task ${missing[0]} isn't in this workspace (or was deleted). Nothing was changed.` : `${missing.length} of these tasks aren't in this workspace (or were deleted). Nothing was changed.`, { missing: missing.slice(0, 50) });
  }
  return [...found.values()];
}

/** A value per task id as one CASE expression (dates as stored milliseconds). */
function caseOn(ids: string[], values: Map<string, unknown>): SQL {
  const parts = ids.map((id) => {
    const v = values.get(id);
    const out = v instanceof Date ? v.getTime() : v;
    return sql`when ${id} then ${out ?? null}`;
  });
  return sql`case ${tasks.id} ${sql.join(parts, sql` `)} end`;
}

type Cols = Partial<Pick<TaskRow, "statusId" | "status" | "completedAt" | "position" | "assigneeType" | "assigneeId" | "priority" | "type" | "dueAt" | "reminderSentFor" | "startAt" | "labels" | "projectId" | "number">>;

/**
 * UPDATE statements for a set of per task changes: tasks that change the same columns share
 * statements; a column with one value for all is a literal, otherwise a CASE on the id.
 */
function updateStatements(deps: Deps, sets: Map<string, Cols>, now: Date) {
  const groups = new Map<string, string[]>();
  for (const [id, s] of sets) {
    const sig = Object.keys(s).sort().join(",");
    groups.set(sig, [...(groups.get(sig) ?? []), id]);
  }
  const stmts: PromiseLike<unknown>[] = [];
  for (const [sig, ids] of groups) {
    const cols = sig.split(",").filter(Boolean) as (keyof Cols)[];
    const varying = cols.filter((c) => new Set(ids.map((id) => { const v = sets.get(id)![c]; return v instanceof Date ? v.getTime() : JSON.stringify(v ?? null); })).size > 1);
    const uniform = cols.filter((c) => !varying.includes(c));
    const perTask = 1 + varying.length * 2;
    const size = Math.max(1, Math.floor((95 - uniform.length - 2) / perTask));
    for (const part of chunk(ids, size)) {
      const set: Record<string, unknown> = { updatedAt: now, version: sql`${tasks.version} + 1` };
      for (const c of uniform) set[c] = sets.get(part[0])![c] ?? null;
      for (const c of varying) set[c] = caseOn(part, new Map(part.map((id) => [id, sets.get(id)![c]])));
      stmts.push(deps.db.update(tasks).set(set as never).where(inIds(tasks.id, part)));
    }
  }
  return stmts;
}

function changeRows(deps: Deps, orgId: string, rows: { id: string; version: number }[], op: "update" | "delete", now: Date) {
  return chunk(rows, 14).map((part) => deps.db.insert(changes).values(part.map((r) => ({ orgId, entityType: "task", entityId: r.id, op, version: r.version, createdAt: now }))));
}

function summaryRow(actor: SuiteActor, now: Date, verb: string, entity: { type: string; id: string }, data: Record<string, unknown>) {
  const a = actorOf(actor);
  return { id: sortableId("act", now.getTime()), orgId: actor.orgId, actorType: a.type, actorId: a.id, actorName: a.name, verb, entityType: entity.type, entityId: entity.id, data: JSON.stringify(data), createdAt: now };
}

/** Webhook endpoints that want this event, read once per action. */
async function hookTargets(deps: Deps, orgId: string, type: string) {
  const rows = await deps.db.select({ events: webhookEndpoints.events }).from(webhookEndpoints).where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.enabled, true)));
  return rows.some((e) => { const ev = JSON.parse(e.events) as string[]; return ev.includes("*") || ev.includes(type); });
}

async function present(deps: Deps, orgId: string, ids: string[]) {
  const out: Task[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, part)));
    out.push(...await presentTaskRows(deps, orgId, rows));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function bulkUpdateTasks(deps: Deps, actor: SuiteActor, idsOrRefs: string[], patch: BulkPatch): Promise<BulkResult> {
  assertWritable(actor);
  const ids = capIds(idsOrRefs);
  const keys = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (!keys.length) throw new HttpError(422, "validation_failed", "Say what to change: status, assignee, due date, start date, priority, labels, type or project.");
  if (patch.statusId && patch.status) throw new HttpError(422, "validation_failed", "Send status or statusId, not both.");
  const level = await assertBudget(deps);
  const rows = await loadTasks(deps, actor.orgId, ids);
  const now = deps.now();

  // Everything the patch needs to know, read once.
  const assignee = parseAssignee(patch.assignee);
  if (assignee) await validateAssignee(deps, actor.orgId, assignee);
  let target: typeof projects.$inferSelect | null = null;
  if (patch.projectId) {
    target = (await deps.db.select().from(projects).where(and(eq(projects.id, patch.projectId), eq(projects.orgId, actor.orgId), isNull(projects.deletedAt))).get()) ?? null;
    if (!target) throw new HttpError(404, "not_found", "Project not found.");
  }
  const projectOf = (t: TaskRow) => (target ? target.id : t.projectId);
  const needStatuses = patch.status !== undefined || patch.statusId !== undefined || !!target;
  const statuses = needStatuses
    ? (await deps.db.select().from(projectStatuses).where(and(inIds(projectStatuses.projectId, [...new Set(rows.map(projectOf))]), isNull(projectStatuses.deletedAt)))).sort((a, b) => a.position - b.position)
    : [];
  if (patch.statusId) {
    const s = statuses.find((x) => x.id === patch.statusId);
    if (!s || rows.some((t) => projectOf(t) !== s.projectId)) throw new HttpError(422, "invalid_status", "That status isn't in every picked task's project. Pick tasks from one project, or set a status group (to do, doing, done).");
  }
  const pick = (t: TaskRow) => {
    const pid = projectOf(t);
    if (patch.statusId) return statuses.find((x) => x.id === patch.statusId)!;
    const cat = patch.status ?? t.status;
    const inProject = statuses.filter((x) => x.projectId === pid);
    // Moving project without a new status keeps the task's own status when it exists there (it never does across projects), else the same group.
    return (!patch.status && !target ? inProject.find((x) => x.id === t.statusId) : undefined) ?? inProject.find((x) => x.category === cat) ?? inProject[0];
  };
  const dueAt = patch.dueAt === undefined ? undefined : parseDate(patch.dueAt);
  const startAt = patch.startAt === undefined ? undefined : parseDate(patch.startAt);
  const add = [...new Set((patch.addLabels ?? []).map(cleanLabel).filter(Boolean))];
  const remove = new Set((patch.removeLabels ?? []).map(cleanLabel).filter(Boolean));

  // Work out each task's change in memory.
  const sets = new Map<string, Cols>();
  const moved: { row: TaskRow; from: Category; to: (typeof statuses)[number] }[] = [];
  const repeatToDone: TaskRow[] = [];
  for (const t of rows) {
    const s: Cols = {};
    if (needStatuses) {
      const st = pick(t);
      if (!st) throw new HttpError(422, "invalid_status", "That project has no statuses.");
      if (st.id !== t.statusId) {
        if (st.category === "done" && t.status !== "done" && t.repeatRule && !target) { repeatToDone.push(t); continue; }
        s.statusId = st.id; s.status = st.category;
        s.completedAt = st.category === "done" ? (t.completedAt ?? now) : null;
        moved.push({ row: t, from: t.status, to: st });
      }
    }
    const assigneeDiffers = assignee !== undefined && ((t.assigneeType ?? null) !== (assignee?.type ?? null) || (t.assigneeId ?? null) !== (assignee?.id ?? null));
    if (assigneeDiffers) {
      s.assigneeType = assignee?.type ?? null; s.assigneeId = assignee?.id ?? null;
    }
    if (patch.priority !== undefined && t.priority !== patch.priority) s.priority = patch.priority;
    if (patch.type !== undefined && (t.type ?? "task") !== patch.type) {
      if (t.type === "epic") throw new HttpError(422, "epic_type", `${t.id} is an epic. Change an epic's type on its own, from the task.`);
      s.type = patch.type;
    }
    if (dueAt !== undefined && (t.dueAt?.getTime() ?? null) !== (dueAt?.getTime() ?? null)) { s.dueAt = dueAt; s.reminderSentFor = null; }
    if (startAt !== undefined && (t.startAt?.getTime() ?? null) !== (startAt?.getTime() ?? null)) s.startAt = startAt;
    if (add.length || remove.size) {
      const before = JSON.parse(t.labels) as string[];
      const after = [...before.filter((x) => !remove.has(x)), ...add.filter((x) => !before.includes(x) && !remove.has(x))].slice(0, 20);
      if (!sameLabels(before, after)) s.labels = JSON.stringify(after);
    }
    if (target && t.projectId !== target.id) s.projectId = target.id;
    if (Object.keys(s).length) sets.set(t.id, s);
  }

  // Positions at the bottom of each status the tasks move into: one grouped read.
  const targetStatusIds = [...new Set(moved.map((m) => m.to.id))];
  if (targetStatusIds.length) {
    const maxes = await deps.db.select({ statusId: tasks.statusId, p: sql<number>`coalesce(max(${tasks.position}), 0)` }).from(tasks)
      .where(and(inIds(tasks.statusId, targetStatusIds), isNull(tasks.deletedAt))).groupBy(tasks.statusId);
    const next = new Map(maxes.map((m) => [m.statusId, Number(m.p)]));
    for (const m of moved) {
      const p = (next.get(m.to.id) ?? 0) + 1024;
      next.set(m.to.id, p);
      sets.get(m.row.id)!.position = p;
    }
  }

  // A move to another project claims a block of numbers there in one write.
  const movingProject = [...sets.entries()].filter(([, s]) => s.projectId);
  if (target && movingProject.length) {
    const claimed = await deps.db.update(projects).set({ nextNumber: sql`${projects.nextNumber} + ${movingProject.length}` }).where(eq(projects.id, target.id)).returning({ n: projects.nextNumber });
    const first = Number(claimed[0]?.n ?? target.nextNumber + movingProject.length) - movingProject.length;
    movingProject.forEach(([, s], i) => { s.number = first + i; });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const changedIds = [...sets.keys()];
  const stmts: PromiseLike<unknown>[] = updateStatements(deps, sets, now);
  if (target && movingProject.length) {
    for (const part of chunk(movingProject.map(([id]) => id), ID_CHUNK)) {
      stmts.push(deps.db.delete(taskFieldValues).where(and(inIds(taskFieldValues.taskId, part), sql`${taskFieldValues.fieldId} not in (select id from custom_fields where project_id = ${target.id})`)));
    }
  }
  stmts.push(...changeRows(deps, actor.orgId, changedIds.map((id) => ({ id, version: byId.get(id)!.version + 1 })), "update", now));
  const changedKeys = [...new Set([...sets.values()].flatMap((s) => Object.keys(s)))].filter((k) => !["position", "reminderSentFor", "completedAt", "assigneeType", "number"].includes(k));
  if (changedIds.length && level !== "warn") {
    const one = new Set(rows.map((r) => projectOf(r))).size === 1;
    stmts.push(deps.db.insert(activity).values(summaryRow(actor, now, "tasks.bulk_updated", one ? { type: "project", id: projectOf(rows[0]) } : { type: "workspace", id: actor.orgId }, {
      count: changedIds.length, ids: changedIds.slice(0, 50), changed: changedKeys.map((k) => (k === "assigneeId" ? "assignee" : k)), patch: { ...patch, assignee: assignee === undefined ? undefined : assignee ? `${assignee.type}:${assignee.id}` : null },
    })));
  }
  const { runBatch } = await import("../../db");
  await runBatch(deps.db, stmts);

  // Finishing a repeating task makes the next one: that path is updateTask's, one task at a time.
  for (const t of repeatToDone) {
    await updateTask(deps, actor, t.id, { ...(patch.statusId ? { statusId: patch.statusId } : { status: patch.status }) });
    const rest = { ...patch, status: undefined, statusId: undefined };
    if (Object.values(rest).some((v) => v !== undefined)) await bulkUpdateTasks(deps, actor, [t.id], rest);
  }

  const out = changedIds.length || repeatToDone.length ? await present(deps, actor.orgId, [...changedIds, ...repeatToDone.map((t) => t.id)]) : [];
  const outById = new Map(out.map((t) => [t.id, t]));

  // Side effects, each read once and skipped when nobody is listening.
  if (changedIds.length && await hookTargets(deps, actor.orgId, "task.updated")) {
    const { emitEvent } = await import("../developer/webhooks");
    const a = actorOf(actor);
    for (const id of changedIds) {
      const task = outById.get(id);
      if (task) await emitEvent(deps, actor.orgId, "task.updated", { task, changed: Object.keys(sets.get(id)!), bulk: true, actor: { type: a.type, id: a.id, name: a.name } });
    }
  }
  const movedNow = moved.filter((m) => sets.has(m.row.id));
  if (movedNow.length) {
    const rules = await deps.db.select({ id: automations.id }).from(automations).where(and(eq(automations.orgId, actor.orgId), eq(automations.trigger, "status_changed"), eq(automations.enabled, true), isNull(automations.deletedAt))).limit(1);
    if (rules.length) {
      const { runStatusAutomations } = await import("./automations");
      for (const m of movedNow) { const task = outById.get(m.row.id); if (task) await runStatusAutomations(deps, actor.orgId, task, m.from); }
    }
  }
  // R24 polish: assignee_changed recipes for the tasks whose assignee changed, capped per request.
  let automationRuns: { runs: number; skipped: number } | undefined;
  if (assignee) {
    const reassigned = changedIds.filter((id) => sets.get(id)!.assigneeId !== undefined).map((id) => outById.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    if (reassigned.length) automationRuns = await (await import("./automations-r24-events")).runBulkAssigneeChanged(deps, actor, reassigned);
  }
  if (assignee?.type === "member" && assignee.id !== actor.userId && level !== "warn") {
    const newly = changedIds.filter((id) => sets.get(id)!.assigneeId !== undefined);
    if (newly.length) {
      const { notify } = await import("./notify");
      const first = outById.get(newly[0]);
      await notify(deps, actor.orgId, assignee.id, {
        type: "task.assigned", entityType: "task", entityId: newly[0],
        title: newly.length === 1 && first ? `${first.ref} assigned to you: ${first.title}` : `${newly.length} tasks assigned to you`, actorName: actor.name || actor.email,
      });
    }
  }
  return { updated: changedIds.length + repeatToDone.length, unchanged: rows.length - changedIds.length - repeatToDone.length, ids: out.map((t) => t.id), tasks: out, ...(automationRuns?.runs || automationRuns?.skipped ? { automationRuns } : {}) };
}

/** Deletes many tasks (and their subtasks) in one batch. */
export async function bulkDeleteTasks(deps: Deps, actor: SuiteActor, idsOrRefs: string[]) {
  assertWritable(actor);
  const ids = capIds(idsOrRefs);
  const level = await assertBudget(deps);
  const rows = await loadTasks(deps, actor.orgId, ids);
  const now = deps.now();
  const stmts: PromiseLike<unknown>[] = [];
  for (const part of chunk(rows.map((r) => r.id), 45)) {
    stmts.push(deps.db.update(tasks).set({ deletedAt: now, updatedAt: now, version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.orgId, actor.orgId), isNull(tasks.deletedAt), sql`(${inIds(tasks.id, part)} or ${inIds(tasks.parentId, part)})`)));
  }
  stmts.push(...changeRows(deps, actor.orgId, rows.map((r) => ({ id: r.id, version: r.version + 1 })), "delete", now));
  if (level !== "warn") {
    const one = new Set(rows.map((r) => r.projectId)).size === 1;
    stmts.push(deps.db.insert(activity).values(summaryRow(actor, now, "tasks.bulk_deleted", one ? { type: "project", id: rows[0].projectId } : { type: "workspace", id: actor.orgId }, {
      count: rows.length, ids: rows.slice(0, 50).map((r) => r.id), titles: rows.slice(0, 20).map((r) => r.title),
    })));
  }
  const { runBatch } = await import("../../db");
  await runBatch(deps.db, stmts);
  if (await hookTargets(deps, actor.orgId, "task.deleted")) {
    const { emitEvent } = await import("../developer/webhooks");
    const a = actorOf(actor);
    for (const r of rows) await emitEvent(deps, actor.orgId, "task.deleted", { id: r.id, bulk: true, actor: { type: a.type, id: a.id, name: a.name } });
  }
  return { deleted: rows.length, ids: rows.map((r) => r.id) };
}

