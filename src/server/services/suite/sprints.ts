/**
 * Round 21: sprints (cycles) per project. A project has any number of planned sprints, at most one
 * active sprint and its completed ones; tasks with no sprint are the project's backlog.
 *
 * Write costs (D1 bills a row once for the table and once per index entry that changes):
 * - create or edit a sprint: the sprints row and its one index (2). WITHOUT ROWID, so no second key index.
 * - add or remove tasks: one tasks row each plus the partial sprint index (2 to 3 each), all in one
 *   db.batch. On an active sprint the call also writes one activity row (3) naming the tasks, which
 *   dates the scope change for the burndown. Planned sprints need no dating: the scope is taken at start.
 * - start: the sprints row (2), with the scope at start in its snapshot.
 * - complete: the sprints row (2) plus each carried task (2 to 3), and a new sprints row (2) when
 *   carrying to a next sprint that did not exist yet.
 *
 * The burndown is worked out when it is read, from what the database already holds: task membership,
 * each task's completed_at, the scope snapshot at start, and the activity rows ordinary task writes
 * already make (a points or sprint change through updateTask is recorded there anyway). So changing,
 * finishing or re-estimating a task costs no extra write for the chart. At complete the chart is
 * frozen into the snapshot, so a finished sprint reads in one row.
 */
import { and, asc, eq, gte, inArray, isNull, like, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { activity, activityFeed, organizations, projects, sprints, tasks, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, iso, sortableId, actorOf, type SuiteActor } from "./common";
import { endOfDayIn, sprintDate, sprintDateAliases, startOfDayIn, todayIn } from "./sprint-dates";
import { listTasks, resolveTaskId, type Task } from "./tasks";
import { dateFormat, dayInZone } from "../../lib/intl-cache";
import { inIds } from "../../lib/sql-chunks";
import { TASK_LIST_LIMIT } from "../../../shared/task-list-limit";

export type SprintStatus = "planned" | "active" | "completed";
type SprintRow = typeof sprints.$inferSelect;
export const MAX_SPRINT_TASKS = 500;
const DAY = 86_400_000;
export const DEFAULT_SPRINT_DAYS = 14;

interface Snapshot {
  /** Task id to points (null: not estimated) and done flag, at start. */
  start?: Record<string, [number | null, boolean]>;
  /** The chart as it stood when the sprint was completed. */
  end?: Burndown;
}

export interface BurndownDay { date: string; remaining: number | null; ideal: number }
export interface Burndown {
  unit: "points" | "tasks";
  timeZone: string;
  /** Remaining at the start of the first day. */
  start: number;
  days: BurndownDay[];
  scope: number;
  done: number;
  remaining: number;
}

const parseSnap = (s: string): Snapshot => { try { return JSON.parse(s) as Snapshot; } catch { return {}; } };

function addDays(day: string, n: number) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function presentSprint(s: SprintRow) {
  return {
    id: s.id, projectId: s.projectId, name: s.name, goal: s.goal, status: s.status,
    startAt: iso(s.startAt)!, endAt: iso(s.endAt)!, startedAt: iso(s.startedAt), completedAt: iso(s.completedAt),
    carriedOver: s.carriedOver, createdAt: iso(s.createdAt)!, updatedAt: iso(s.updatedAt)!, version: s.version,
    // MB-62: a link that opens this sprint (the API adds the site origin as url).
    path: `/app/tasks?project=${encodeURIComponent(s.projectId)}&view=sprints&sprint=${encodeURIComponent(s.id)}`,
  };
}
export type Sprint = ReturnType<typeof presentSprint>;

async function projectOf(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  return p;
}

async function sprintRow(deps: Deps, orgId: string, id: string) {
  const s = await deps.db.select().from(sprints).where(and(eq(sprints.orgId, orgId), eq(sprints.id, id), isNull(sprints.deletedAt))).get();
  if (!s) throw notFound("Sprint");
  return s;
}

/** For task create and update: the sprint must be in the same workspace and project and not finished. */
export async function checkSprintForTask(deps: Deps, orgId: string, projectId: string, sprintId: string) {
  const s = await sprintRow(deps, orgId, sprintId);
  if (s.projectId !== projectId) throw new HttpError(422, "validation_failed", "That sprint belongs to another project.");
  if (s.status === "completed") throw new HttpError(409, "sprint_completed", "That sprint is complete. Pick a planned or active sprint.");
  return s;
}

/** An estimate: a number from 0 to 1000, or null for none. */
export function cleanPoints(v: number | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Number.isFinite(v) || v < 0 || v > 1000) throw new HttpError(422, "validation_failed", "An estimate is a number from 0 to 1000.");
  return Math.round(v * 100) / 100;
}

function validZone(tz: string | null | undefined) {
  if (!tz) return null;
  try { dateFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}

/** The zone that draws day lines: the one asked for, else the person's, else the workspace's. */
export async function sprintZone(deps: Deps, actor: SuiteActor, tz?: string | null) {
  const given = validZone(tz);
  if (given) return given;
  const [u, o] = await Promise.all([
    actor.userId ? deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, actor.userId)).get() : Promise.resolve(undefined),
    deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get(),
  ]);
  return validZone(u?.tz) ?? validZone(o?.tz) ?? "UTC";
}

/** The calendar day (YYYY-MM-DD) of a moment in a zone. */
export function dayIn(d: Date, timeZone: string) {
  return dayInZone(d, timeZone); // R25: one cached formatter per zone
}
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

export async function listSprints(deps: Deps, actor: SuiteActor, projectId: string) {
  const p = await projectOf(deps, actor.orgId, projectId);
  const rows = await deps.db.select().from(sprints).where(and(eq(sprints.orgId, actor.orgId), eq(sprints.projectId, p.id), isNull(sprints.deletedAt))).orderBy(asc(sprints.startAt));
  const ids = rows.map((r) => r.id);
  const counts = new Map<string, { tasks: number; done: number; points: number; donePoints: number }>();
  if (ids.length) {
    const ts = await deps.db.select({ sprintId: tasks.sprintId, status: tasks.status, points: tasks.points }).from(tasks)
      .where(and(eq(tasks.orgId, actor.orgId), inArray(tasks.sprintId, ids.slice(0, 90)), isNull(tasks.deletedAt)));
    for (const t of ts) {
      const c = counts.get(t.sprintId!) ?? { tasks: 0, done: 0, points: 0, donePoints: 0 };
      c.tasks++; c.points += t.points ?? 0;
      if (t.status === "done") { c.done++; c.donePoints += t.points ?? 0; }
      counts.set(t.sprintId!, c);
    }
  }
  return {
    unit: p.estimateUnit,
    sprints: rows.map((r) => ({ ...presentSprint(r), counts: counts.get(r.id) ?? { tasks: 0, done: 0, points: 0, donePoints: 0 } })),
  };
}

export interface SprintInput { name?: string; goal?: string; startAt?: string; endAt?: string; startDate?: string; endDate?: string }

export async function createSprint(deps: Deps, actor: SuiteActor, projectId: string, given: SprintInput) {
  assertWritable(actor);
  const input = sprintDateAliases(given);
  const p = await projectOf(deps, actor.orgId, projectId);
  const existing = await deps.db.select({ name: sprints.name, endAt: sprints.endAt }).from(sprints)
    .where(and(eq(sprints.orgId, actor.orgId), eq(sprints.projectId, p.id), isNull(sprints.deletedAt)));
  const last = existing.reduce<Date | null>((m, s) => (!m || s.endAt > m ? s.endAt : m), null);
  // The next sprint starts the day after the last one ends; the first one starts today. Days are
  // the workspace's (or person's) calendar days, and a date with no time means that whole day (MB-54).
  const zone = await sprintZone(deps, actor);
  const startDay = last ? addDays(dayIn(last, zone), 1) : todayIn(deps.now(), zone);
  const startAt = sprintDate(input.startAt, "start", zone) ?? startOfDayIn(startDay, zone);
  const endAt = sprintDate(input.endAt, "end", zone) ?? endOfDayIn(addDays(dayIn(startAt, zone), DEFAULT_SPRINT_DAYS - 1), zone);
  if (endAt.getTime() <= startAt.getTime()) throw new HttpError(422, "validation_failed", "A sprint has to end after it starts.");
  if (endAt.getTime() - startAt.getTime() > 92 * DAY) throw new HttpError(422, "validation_failed", "A sprint can be at most 3 months long.");
  const n = existing.length + 1;
  const name = (input.name ?? "").trim().slice(0, 80) || `Sprint ${n}`;
  const now = deps.now();
  const row: typeof sprints.$inferInsert = {
    id: sortableId("spr", now.getTime()), orgId: actor.orgId, projectId: p.id, name, goal: (input.goal ?? "").slice(0, 2000),
    startAt, endAt, status: "planned", snapshot: "{}", ...createdBy(actor), createdAt: now, updatedAt: now,
  };
  await deps.db.insert(sprints).values(row);
  return presentSprint(row as SprintRow);
}

export async function updateSprint(deps: Deps, actor: SuiteActor, id: string, given: SprintInput & { version?: number }) {
  assertWritable(actor);
  const patch = sprintDateAliases(given);
  const s = await sprintRow(deps, actor.orgId, id);
  if (patch.version !== undefined && patch.version !== s.version) throw new HttpError(409, "version_conflict", "Someone else changed this sprint. Reload and try again.");
  const set: Partial<typeof sprints.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 80);
    if (!name) throw new HttpError(422, "validation_failed", "A sprint needs a name.");
    set.name = name;
  }
  if (patch.goal !== undefined) set.goal = patch.goal.slice(0, 2000);
  // MB-55: a date only end is the end of that day here too, the same as on create.
  const zone = patch.startAt !== undefined || patch.endAt !== undefined ? await sprintZone(deps, actor) : "UTC";
  const startAt = patch.startAt !== undefined ? sprintDate(patch.startAt, "start", zone) : s.startAt;
  const endAt = patch.endAt !== undefined ? sprintDate(patch.endAt, "end", zone) : s.endAt;
  if (!startAt || !endAt) throw new HttpError(422, "validation_failed", "A sprint needs a start and an end.");
  if (endAt.getTime() <= startAt.getTime()) throw new HttpError(422, "validation_failed", "A sprint has to end after it starts.");
  if (s.status === "completed" && (patch.startAt !== undefined || patch.endAt !== undefined)) throw new HttpError(409, "sprint_completed", "A completed sprint keeps its dates.");
  if (patch.startAt !== undefined) set.startAt = startAt;
  if (patch.endAt !== undefined) set.endAt = endAt;
  if (!Object.keys(set).length) return presentSprint(s);
  const now = deps.now();
  await deps.db.update(sprints).set({ ...set, updatedAt: now, version: s.version + 1 }).where(and(eq(sprints.id, s.id), eq(sprints.orgId, actor.orgId)));
  return presentSprint({ ...s, ...set, updatedAt: now, version: s.version + 1 } as SprintRow);
}

/** Deletes a planned sprint; its tasks go back to the backlog. */
export async function deleteSprint(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const s = await sprintRow(deps, actor.orgId, id);
  if (s.status !== "planned") throw new HttpError(409, "sprint_not_planned", "Only a planned sprint can be deleted.");
  const { runBatch } = await import("../../db");
  await runBatch(deps.db, [
    deps.db.update(tasks).set({ sprintId: null }).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.sprintId, s.id))),
    deps.db.delete(sprints).where(and(eq(sprints.id, s.id), eq(sprints.orgId, actor.orgId))),
  ]);
  return { ok: true };
}

async function memberRows(deps: Deps, orgId: string, sprintId: string) {
  return deps.db.select({ id: tasks.id, status: tasks.status, points: tasks.points, completedAt: tasks.completedAt, createdAt: tasks.createdAt, projectId: tasks.projectId })
    .from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.sprintId, sprintId), isNull(tasks.deletedAt)));
}

export async function startSprint(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const s = await sprintRow(deps, actor.orgId, id);
  if (s.status !== "planned") throw new HttpError(409, "sprint_not_planned", s.status === "active" ? "This sprint has already started." : "This sprint is complete.");
  const active = await deps.db.select({ id: sprints.id, name: sprints.name }).from(sprints)
    .where(and(eq(sprints.orgId, actor.orgId), eq(sprints.projectId, s.projectId), eq(sprints.status, "active"), isNull(sprints.deletedAt))).get();
  if (active) throw new HttpError(409, "sprint_already_active", `${active.name} is still running. Complete it before starting another.`);
  const members = await memberRows(deps, actor.orgId, s.id);
  const snap: Snapshot = { start: Object.fromEntries(members.map((m) => [m.id, [m.points ?? null, m.status === "done"]])) };
  const now = deps.now();
  // Starting early moves the start to now, so the chart has no empty days before it.
  const startAt = now < s.startAt ? now : s.startAt;
  const set = { status: "active" as const, startedAt: now, startAt, snapshot: JSON.stringify(snap), updatedAt: now, version: s.version + 1 };
  await deps.db.update(sprints).set(set).where(and(eq(sprints.id, s.id), eq(sprints.orgId, actor.orgId), eq(sprints.status, "planned")));
  return presentSprint({ ...s, ...set });
}

export async function completeSprint(deps: Deps, actor: SuiteActor, id: string, opts: { carryOver?: "next" | "backlog"; timeZone?: string | null } = {}) {
  assertWritable(actor);
  const s = await sprintRow(deps, actor.orgId, id);
  if (s.status !== "active") throw new HttpError(409, "sprint_not_active", s.status === "planned" ? "Start this sprint before completing it." : "This sprint is already complete.");
  const carryOver = opts.carryOver ?? "next";
  const now = deps.now();
  const chart = await burndownFor(deps, actor, s, { timeZone: opts.timeZone, now });
  const members = await memberRows(deps, actor.orgId, s.id);
  const open = members.filter((m) => m.status !== "done").map((m) => m.id);
  let next: Sprint | null = null;
  if (carryOver === "next" && open.length) {
    const planned = await deps.db.select().from(sprints)
      .where(and(eq(sprints.orgId, actor.orgId), eq(sprints.projectId, s.projectId), eq(sprints.status, "planned"), isNull(sprints.deletedAt)))
      .orderBy(asc(sprints.startAt)).limit(1).get();
    next = planned ? presentSprint(planned) : await createSprint(deps, actor, s.projectId, {});
  }
  const snap = { ...parseSnap(s.snapshot), end: chart };
  const set = { status: "completed" as const, completedAt: now, carriedOver: open.length, snapshot: JSON.stringify(snap), updatedAt: now, version: s.version + 1 };
  const { runBatch } = await import("../../db");
  await runBatch(deps.db, [
    deps.db.update(sprints).set(set).where(and(eq(sprints.id, s.id), eq(sprints.orgId, actor.orgId))),
    ...chunk(open, 90).map((ids) => deps.db.update(tasks).set({ sprintId: next?.id ?? null, updatedAt: now, version: sql`${tasks.version} + 1` }).where(and(eq(tasks.orgId, actor.orgId), inArray(tasks.id, ids)))),
  ]);
  return { sprint: presentSprint({ ...s, ...set }), carriedOver: open.length, carriedTo: next ? { type: "sprint" as const, sprint: next } : { type: "backlog" as const } };
}

const chunk = <T>(rows: T[], n: number) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n));

async function moveTasks(deps: Deps, actor: SuiteActor, s: SprintRow | null, projectId: string, idsOrRefs: string[], op: "add" | "remove") {
  assertWritable(actor);
  if (!idsOrRefs.length) throw new HttpError(422, "validation_failed", "Name at least one task.");
  if (idsOrRefs.length > MAX_SPRINT_TASKS) throw new HttpError(422, "validation_failed", `At most ${MAX_SPRINT_TASKS} tasks at a time.`);
  if (s?.status === "completed") throw new HttpError(409, "sprint_completed", "That sprint is complete.");
  const ids = [...new Set(await Promise.all(idsOrRefs.map((x) => resolveTaskId(deps, actor.orgId, x))))];
  const found: { id: string; projectId: string; sprintId: string | null; points: number | null }[] = [];
  for (const part of chunk(ids, 90)) {
    found.push(...await deps.db.select({ id: tasks.id, projectId: tasks.projectId, sprintId: tasks.sprintId, points: tasks.points }).from(tasks)
      .where(and(eq(tasks.orgId, actor.orgId), inIds(tasks.id, part), isNull(tasks.deletedAt))));
  }
  if (found.length !== ids.length) throw notFound("Task");
  if (found.some((t) => t.projectId !== projectId)) throw new HttpError(422, "validation_failed", "Every task has to be in the sprint's project.");
  const target = op === "add" ? s!.id : null;
  const moving = found.filter((t) => (op === "add" ? t.sprintId !== target : t.sprintId === s!.id));
  if (!moving.length) return { moved: 0 };
  const now = deps.now();
  const { runBatch } = await import("../../db");
  const statements: PromiseLike<unknown>[] = chunk(moving.map((t) => t.id), 90)
    .map((part) => deps.db.update(tasks).set({ sprintId: target, updatedAt: now, version: sql`${tasks.version} + 1` }).where(and(eq(tasks.orgId, actor.orgId), inIds(tasks.id, part))));
  // Tasks leaving an active sprint (moved to another sprint) and tasks joining one: one activity row dates the change.
  const touched = new Set<string>();
  if (s?.status === "active") touched.add(s.id);
  if (op === "add") for (const t of moving) if (t.sprintId) touched.add(t.sprintId);
  if (touched.size) {
    const activeIds = (await deps.db.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.orgId, actor.orgId), inIds(sprints.id, [...touched]), eq(sprints.status, "active")))).map((r) => r.id);
    const a = actorOf(actor);
    for (const sid of activeIds) {
      const added = op === "add" && sid === target ? moving.map((t) => t.id) : [];
      const removed = op === "remove" ? moving.map((t) => t.id) : moving.filter((t) => t.sprintId === sid).map((t) => t.id);
      statements.push(deps.db.insert(activity).values({
        id: sortableId("act", now.getTime()), orgId: actor.orgId, actorType: a.type, actorId: a.id, actorName: a.name,
        verb: "sprint_scope", entityType: "sprint", entityId: sid, data: JSON.stringify({ added, removed }), createdAt: now,
      }));
    }
  }
  await runBatch(deps.db, statements);
  return { moved: moving.length };
}

export async function addToSprint(deps: Deps, actor: SuiteActor, sprintId: string, taskIds: string[]) {
  const s = await sprintRow(deps, actor.orgId, sprintId);
  return moveTasks(deps, actor, s, s.projectId, taskIds, "add");
}
export async function removeFromSprint(deps: Deps, actor: SuiteActor, sprintId: string, taskIds: string[]) {
  const s = await sprintRow(deps, actor.orgId, sprintId);
  return moveTasks(deps, actor, s, s.projectId, taskIds, "remove");
}

export async function setEstimateUnit(deps: Deps, actor: SuiteActor, projectId: string, unit: "points" | "hours") {
  assertWritable(actor);
  const p = await projectOf(deps, actor.orgId, projectId);
  if (p.estimateUnit !== unit) await deps.db.update(projects).set({ estimateUnit: unit }).where(and(eq(projects.id, p.id), eq(projects.orgId, actor.orgId)));
  return { unit };
}

interface Ev { at: number; kind: "in" | "out" | "pts" | "done"; pts?: number | null; from?: number | null }

/**
 * The burndown: for each day of the sprint (in the zone's calendar), what was left at the end of
 * that day. Points when any task in it has an estimate, else a task count. Mid-sprint additions,
 * removals and re-estimates move the line on the day they happened.
 */
export async function burndownFor(deps: Deps, actor: SuiteActor, s: SprintRow, opts: { timeZone?: string | null; now?: Date } = {}): Promise<Burndown> {
  const snap = parseSnap(s.snapshot);
  if (s.status === "completed" && snap.end) return snap.end;
  const timeZone = await sprintZone(deps, actor, opts.timeZone);
  const now = opts.now ?? deps.now();
  const startMs = (s.startedAt && s.status !== "planned" ? Math.min(s.startAt.getTime(), s.startedAt.getTime()) : s.startAt.getTime());
  const members = await memberRows(deps, actor.orgId, s.id);
  const start = snap.start ?? {};
  // Dated changes: the sprint's own scope rows and the activity of tasks that touched it.
  const evs = new Map<string, Ev[]>();
  const push = (id: string, e: Ev) => { const l = evs.get(id) ?? []; l.push(e); evs.set(id, l); };
  const ids = new Set<string>([...members.map((m) => m.id), ...Object.keys(start)]);
  if (s.status === "active") {
    const scopeRows = await deps.db.select({ data: activityFeed.data, createdAt: activityFeed.createdAt }).from(activityFeed)
      .where(and(eq(activityFeed.entityType, "sprint"), eq(activityFeed.entityId, s.id), gte(activityFeed.createdAt, new Date(startMs))));
    // Single moves made through a task edit name the sprint in the task's own activity row.
    const moveRows = await deps.db.select({ entityId: activityFeed.entityId, data: activityFeed.data, createdAt: activityFeed.createdAt }).from(activityFeed)
      .where(and(eq(activityFeed.orgId, actor.orgId), gte(activityFeed.createdAt, new Date(startMs)), eq(activityFeed.entityType, "task"), like(activityFeed.data, `%${s.id}%`))).limit(5000);
    for (const r of scopeRows) {
      const d = JSON.parse(r.data) as { added?: string[]; removed?: string[] };
      for (const id of d.added ?? []) { ids.add(id); push(id, { at: r.createdAt.getTime(), kind: "in" }); }
      for (const id of d.removed ?? []) { ids.add(id); push(id, { at: r.createdAt.getTime(), kind: "out" }); }
    }
    for (const r of moveRows) {
      const sp = (JSON.parse(r.data) as { sprint?: { from: string | null; to: string | null } }).sprint;
      if (!sp) continue;
      ids.add(r.entityId);
      if (sp.to === s.id) push(r.entityId, { at: r.createdAt.getTime(), kind: "in" });
      else if (sp.from === s.id) push(r.entityId, { at: r.createdAt.getTime(), kind: "out" });
    }
  }
  // Current values for every task that was ever in scope, and their estimate changes.
  const rows: { id: string; status: string; points: number | null; completedAt: Date | null; createdAt: Date; sprintId: string | null }[] = [];
  // R25: the chunks (D1 takes at most 100 bound values a query) run side by side, then are read in order.
  const parts = await Promise.all(chunk([...ids], 90).map((part) => Promise.all([
    deps.db.select({ id: tasks.id, status: tasks.status, points: tasks.points, completedAt: tasks.completedAt, createdAt: tasks.createdAt, sprintId: tasks.sprintId })
      .from(tasks).where(and(eq(tasks.orgId, actor.orgId), inIds(tasks.id, part), isNull(tasks.deletedAt))),
    s.status === "active"
      ? deps.db.select({ entityId: activityFeed.entityId, data: activityFeed.data, createdAt: activityFeed.createdAt }).from(activityFeed)
        .where(and(eq(activityFeed.entityType, "task"), inIds(activityFeed.entityId, part), gte(activityFeed.createdAt, new Date(startMs)), like(activityFeed.data, "%\"points\"%")))
      : Promise.resolve([]),
  ])));
  for (const [taskRows, ptsRows] of parts) {
    rows.push(...taskRows);
    if (s.status === "active") {
      for (const r of ptsRows) {
        const p = (JSON.parse(r.data) as { points?: { from: number | null; to: number | null } }).points;
        if (p) push(r.entityId, { at: r.createdAt.getTime(), kind: "pts", pts: p.to, from: p.from });
      }
    }
  }
  const pointsMode = rows.some((r) => r.points !== null) || Object.values(start).some((v) => v[0] !== null);
  const days: string[] = [];
  const endDay = dayIn(s.endAt, timeZone);
  for (let d = dayIn(new Date(startMs), timeZone); d <= endDay && days.length < 120; d = nextDay(d)) days.push(d);
  const today = dayIn(now, timeZone);

  // Each task's state at the start, then its changes in time order, bucketed by local day.
  let startTotal = 0;
  const perDay = new Map<string, number>();
  for (const day of days) perDay.set(day, 0);
  for (const t of rows) {
    const list = [...(evs.get(t.id) ?? [])];
    if (t.status === "done" && t.completedAt) list.push({ at: t.completedAt.getTime(), kind: "done" });
    list.sort((a, b) => a.at - b.at);
    const firstPts = list.find((e) => e.kind === "pts");
    const snapAt = start[t.id];
    let inScope: boolean;
    let pts: number | null;
    let done = false;
    if (s.status === "planned") { inScope = t.sprintId === s.id; pts = t.points; }
    else if (snapAt) { inScope = true; pts = snapAt[0]; done = snapAt[1]; }
    else {
      // Not in the sprint at start. Joined later: by a dated move, or (no record) when it was made.
      inScope = false; pts = firstPts ? firstPts.from ?? null : t.points;
      if (t.sprintId === s.id && !list.some((e) => e.kind === "in")) list.push({ at: Math.max(startMs, t.createdAt.getTime()), kind: "in" });
      list.sort((a, b) => a.at - b.at);
    }
    if (s.status !== "planned" && done === false && t.status === "done" && t.completedAt && t.completedAt.getTime() < startMs) done = true;
    const w = () => (pointsMode ? (pts ?? 0) : 1);
    const value = () => (inScope && !done ? w() : 0);
    const initial = value();
    startTotal += initial;
    let cur = initial;
    const totals: number[] = days.map(() => 0);
    let li = 0;
    for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
      while (li < list.length && (list[li].at < startMs || dayIn(new Date(list[li].at), timeZone) <= days[dayIdx])) {
        const e = list[li++];
        if (e.kind === "in") inScope = true;
        else if (e.kind === "out") inScope = false;
        else if (e.kind === "pts") pts = e.pts ?? null;
        else if (e.kind === "done") done = true;
        cur = value();
      }
      totals[dayIdx] = cur;
    }
    days.forEach((d, i) => perDay.set(d, (perDay.get(d) ?? 0) + totals[i]));
  }
  const n = days.length;
  const round = (x: number) => Math.round(x * 100) / 100;
  const series: BurndownDay[] = days.map((date, i) => ({
    date,
    remaining: s.status === "planned" || date > today ? null : round(perDay.get(date) ?? 0),
    ideal: round(n ? startTotal * (1 - (i + 1) / n) : 0),
  }));
  const current = members.reduce((acc, m) => acc + (pointsMode ? m.points ?? 0 : 1), 0);
  const doneNow = members.filter((m) => m.status === "done").reduce((acc, m) => acc + (pointsMode ? m.points ?? 0 : 1), 0);
  return { unit: pointsMode ? "points" : "tasks", timeZone, start: round(startTotal), days: series, scope: round(current), done: round(doneNow), remaining: round(current - doneNow) };
}

/** One sprint with its tasks and chart. */
export async function getSprint(deps: Deps, actor: SuiteActor, id: string, opts: { timeZone?: string | null } = {}) {
  const s = await sprintRow(deps, actor.orgId, id);
  const [list, burndown, p] = await Promise.all([
    listTasks(deps, actor, { projectId: s.projectId, sprintId: s.id, includeSubtasks: true, limit: 1000 }),
    burndownFor(deps, actor, s, opts),
    projectOf(deps, actor.orgId, s.projectId),
  ]);
  return { sprint: presentSprint(s), unit: p.estimateUnit, tasks: list, burndown };
}

/** The project's backlog: unfinished tasks in no sprint. */
export async function backlog(deps: Deps, actor: SuiteActor, projectId: string): Promise<Task[]> {
  await projectOf(deps, actor.orgId, projectId);
  // R45b: done tasks are left out in the query itself, so they no longer use up the read's limit (on prod a project with
  // 1,000 tasks showed 450 of 894 open ones). The limit is the shared list limit; the panel says when it is reached.
  const list = await listTasks(deps, actor, { projectId, sprintId: null, limit: TASK_LIST_LIMIT, queryConds: [ne(tasks.status, "done")] });
  return list.filter((t) => t.status !== "done");
}

