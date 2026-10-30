/**
 * R37: dependencies that plan for you. A "blocks" link means the blocked task starts after the blocker ends
 * (finish to start). This module finds date conflicts (a blocked task that starts on or before its blocker's last
 * day) and plans the shift of every task that waits on a moved task, keeping each task's length. Only later shifts
 * happen: moving a task earlier never pulls the tasks after it (the "flexible" rule; nothing is squeezed).
 *
 *   GET  /api/tasks/schedule-check?projectId=     { links, conflicts }
 *   POST /api/tasks/:id/reschedule                { start?, due?, moveDependents? (default true), preview? }
 *
 * R38: lead and lag per link (entity_links.lag_days), working days only and strict mode per project
 * (schedule-settings-r38.ts). The response says which mode planned the move.
 *
 * Writes: one task update per moved task, each an essential user write (the person asked for the move); a preview
 * writes nothing. The chain is capped at 50 tasks so one drag can never fan out into a write storm.
 */
import { and, eq, isNull } from "drizzle-orm";
import { projects, tasks } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { assertWritable, type SuiteActor } from "./common";
import { dependencyLinks, resolveTaskId, taskDetail, updateTask } from "./tasks";
import { DEFAULT_SCHEDULE, getScheduleSettings, scheduleSettingsFor } from "./schedule-settings-r38";

const DAY = 86_400_000;
export const MAX_CHAIN = 50;

export interface SchedTask { id: string; ref?: string; title?: string; projectId?: string; start: string | null; due: string | null; status: string }
/** R38: lag is whole days after the blocker ends (negative = lead, the blocked task may start that many days early). */
export interface Link { from: string; to: string; lag?: number }
export interface Move { id: string; from: { start: string | null; due: string | null }; to: { start: string | null; due: string | null }; days: number }
export interface Conflict { from: string; to: string; lag: number; overlapDays: number; fix: { taskId: string; start: string | null; due: string | null } }
/** R38: which days count. Off = every day counts (the R37 rule). */
export interface Cal { workingDaysOnly: boolean; daysOff: number[] }
export const CALENDAR_DAYS: Cal = { workingDaysOnly: false, daysOff: [0, 6] };
export interface PlanOptions { calOf?: (taskId: string) => Cal; strict?: boolean }

const day = (s: string | null) => (s ? Date.parse(`${s.slice(0, 10)}T00:00:00.000Z`) : null);
const ymd = (n: number | null) => (n === null ? null : new Date(n).toISOString().slice(0, 10));
/** The first and last day a task takes. A task with one date takes that one day. */
export function span(t: Pick<SchedTask, "start" | "due">): { first: number; last: number } | null {
  const s = day(t.start), d = day(t.due);
  if (s === null && d === null) return null;
  const first = s ?? d!, last = d ?? s!;
  return { first: Math.min(first, last), last: Math.max(first, last) };
}

// ---------------------------------------------------------------- R38: working days
const on = (c: Cal) => c.workingDaysOnly && c.daysOff.length > 0 && c.daysOff.length < 7;
export const isDayOff = (t: number, c: Cal) => on(c) && c.daysOff.includes(new Date(t).getUTCDay());
/** The day itself when it counts, else the next day that does. */
export function nextWorkDay(t: number, c: Cal) { let g = 0; while (isDayOff(t, c) && g++ < 7) t += DAY; return t; }
/** Moves n counted days (negative goes back). With working days on, days off are stepped over and never counted. */
export function addDays(t: number, n: number, c: Cal) {
  if (!on(c)) return t + n * DAY;
  const step = n < 0 ? -DAY : DAY;
  let left = Math.abs(n), g = 0;
  while (left > 0 && g++ < 5000) { t += step; if (!isDayOff(t, c)) left--; }
  return t;
}
/** Counted days from a to b (signed): b - a in days, or in working days when working days are on. */
export function countDays(a: number, b: number, c: Cal) {
  if (!on(c)) return Math.round((b - a) / DAY);
  const sign = b < a ? -1 : 1;
  let n = 0, t = a, g = 0;
  while (t !== b && g++ < 5000) { t += sign * DAY; if (!isDayOff(t, c)) n += sign; }
  return n;
}
/** The first day a task may start when it waits on a task whose last day is `last`, with this link's lag. */
export function earliestStart(last: number, lag: number, c: Cal) {
  return nextWorkDay(addDays(last, 1 + lag, c), c);
}
/** The task's dates placed to start on `first`, keeping its length (in counted days) and which dates it has. */
function placeAt(t: SchedTask, first: number, c: Cal) {
  const sp = span(t)!;
  const f = nextWorkDay(first, c);
  const len = on(c) ? Math.max(0, countDays(nextWorkDay(sp.first, c), sp.last, c)) : Math.round((sp.last - sp.first) / DAY);
  const l = on(c) ? nextWorkDay(addDays(f, len, c), c) : f + len * DAY;
  if (t.start && t.due) return { start: ymd(f), due: ymd(l) };
  return t.start ? { start: ymd(f), due: null } : { start: null, due: ymd(f) };
}
function shiftedBy(t: SchedTask, n: number, c: Cal) {
  const sp = span(t)!;
  return placeAt(t, on(c) ? addDays(nextWorkDay(sp.first, c), n, c) : sp.first + n * DAY, c);
}
const calDays = (a: { start: string | null; due: string | null }, b: { start: string | null; due: string | null }) =>
  Math.round(((span(b)?.first ?? 0) - (span(a)?.first ?? span(b)?.first ?? 0)) / DAY);

/** Links whose blocked task starts before its blocker's last day plus the link's lag. Done tasks never conflict. */
export function findConflicts(list: SchedTask[], links: Link[], opts: PlanOptions = {}): Conflict[] {
  const calOf = opts.calOf ?? (() => CALENDAR_DAYS);
  const byId = new Map(list.map((t) => [t.id, t]));
  const out: Conflict[] = [];
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b || a.status === "done" || b.status === "done") continue;
    const sa = span(a), sb = span(b);
    if (!sa || !sb) continue;
    const c = calOf(b.id), lag = l.lag ?? 0;
    const earliest = earliestStart(sa.last, lag, c);
    if (sb.first >= earliest) continue;
    const fix = placeAt(b, earliest, c);
    out.push({ from: l.from, to: l.to, lag, overlapDays: calDays(b, fix), fix: { taskId: b.id, ...fix } });
  }
  return out.sort((x, y) => y.overlapDays - x.overlapDays);
}

/**
 * Plan the moves after `movedId` gets new dates. Flexible (default): every task that waits on it (directly or down
 * the chain) and would now start before a blocker's last day plus the link's lag shifts later by just enough,
 * keeping its length. Strict (R38): every task down the chain shifts by the same number of counted days as the
 * moved task, earlier or later. Done and undated tasks stay put (and pass nothing on). Returns the moved task
 * first, then each dependent once.
 */
export function planShift(list: SchedTask[], links: Link[], movedId: string, next: { start: string | null; due: string | null }, opts: PlanOptions = {}): Move[] {
  const calOf = opts.calOf ?? (() => CALENDAR_DAYS);
  const byId = new Map(list.map((t) => [t.id, { ...t }]));
  const moved = byId.get(movedId);
  if (!moved) return [];
  const orig = new Map(list.map((t) => [t.id, { start: t.start, due: t.due }]));
  moved.start = next.start; moved.due = next.due;
  const touched = new Set<string>();
  const after = new Map<string, string[]>();
  for (const l of links) after.set(l.from, [...(after.get(l.from) ?? []), l.to]);
  const blockersOf = new Map<string, Link[]>();
  for (const l of links) blockersOf.set(l.to, [...(blockersOf.get(l.to) ?? []), l]);
  const note = (id: string) => { touched.add(id); if (touched.size > MAX_CHAIN) throw new HttpError(422, "chain_too_long", `This move would shift more than ${MAX_CHAIN} tasks. Move fewer at once.`); };

  if (opts.strict) {
    const o = span(orig.get(movedId)!), m = span(moved);
    const c = calOf(movedId);
    const n = o && m ? countDays(nextWorkDay(o.first, c), nextWorkDay(m.first, c), c) : 0;
    if (n !== 0) {
      const queue = [movedId];
      const seen = new Set([movedId]);
      while (queue.length) {
        const id = queue.shift()!;
        for (const childId of after.get(id) ?? []) {
          if (seen.has(childId)) continue;
          seen.add(childId);
          const t = byId.get(childId);
          if (!t || t.status === "done" || !span(t)) continue;
          Object.assign(t, shiftedBy(t, n, calOf(childId)));
          note(childId);
          queue.push(childId);
        }
      }
    }
  } else {
    const queue = [movedId];
    let guard = 0;
    while (queue.length && guard++ < 10_000) {
      const id = queue.shift()!;
      for (const childId of after.get(id) ?? []) {
        const ch = byId.get(childId);
        if (!ch || ch.status === "done" || childId === movedId) continue;
        const sc = span(ch);
        if (!sc) continue;
        const c = calOf(childId);
        // The earliest allowed start from everything that blocks it (open blockers only, each with its lag).
        let earliest = -Infinity;
        for (const l of blockersOf.get(childId) ?? []) {
          const b = byId.get(l.from);
          const sb = b && b.status !== "done" ? span(b) : null;
          if (sb) earliest = Math.max(earliest, earliestStart(sb.last, l.lag ?? 0, c));
        }
        if (earliest === -Infinity || sc.first >= earliest) continue;
        Object.assign(ch, placeAt(ch, earliest, c));
        note(childId);
        queue.push(childId);
      }
    }
  }
  const o = orig.get(movedId)!;
  const to = { start: moved.start, due: moved.due };
  const firstMove: Move = { id: movedId, from: o, to, days: calDays(o, to) };
  return [firstMove, ...[...touched].map((id) => { const t = byId.get(id)!; const to2 = { start: t.start, due: t.due }; return { id, from: orig.get(id)!, to: to2, days: calDays(orig.get(id)!, to2) }; })];
}

async function datedTasks(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [] as (SchedTask & { ref: string; title: string })[];
  const rows = await deps.db.select({ id: tasks.id, number: tasks.number, projectId: tasks.projectId, title: tasks.title, startAt: tasks.startAt, dueAt: tasks.dueAt, status: tasks.status })
    .from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, ids.slice(0, 900)), isNull(tasks.deletedAt)));
  const pids = [...new Set(rows.map((r) => r.projectId))];
  const keys = new Map((pids.length ? await deps.db.select({ id: projects.id, key: projects.key }).from(projects).where(inIds(projects.id, pids)) : []).map((p) => [p.id, p.key]));
  const d = (x: Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : null);
  return rows.map((r) => ({ id: r.id, ref: `${keys.get(r.projectId) ?? "TSK"}-${r.number}`, title: r.title, projectId: r.projectId, start: d(r.startAt), due: d(r.dueAt), status: r.status }));
}

/** R38: each task's calendar comes from its project's schedule rules (one batched read). */
async function plannerFor(deps: Deps, orgId: string, list: SchedTask[]) {
  const settings = await scheduleSettingsFor(deps, orgId, list.map((t) => t.projectId ?? ""));
  const pOf = new Map(list.map((t) => [t.id, t.projectId ?? ""]));
  const calOf = (id: string): Cal => settings.get(pOf.get(id) ?? "") ?? DEFAULT_SCHEDULE;
  return { settings, calOf };
}

/** Every dependency link in the workspace (or one project) and the ones whose dates clash. Read only. */
export async function scheduleCheck(deps: Deps, orgId: string, projectId?: string) {
  const links = await dependencyLinks(deps, orgId, projectId);
  const list = await datedTasks(deps, orgId, [...new Set(links.flatMap((l) => [l.from, l.to]))]);
  const byId = new Map(list.map((t) => [t.id, t]));
  const brief = (t: SchedTask & { ref: string; title: string }) => ({ id: t.id, ref: t.ref, title: t.title, start: t.start, due: t.due });
  const { calOf } = await plannerFor(deps, orgId, list);
  const conflicts = findConflicts(list, links, { calOf }).map((c) => ({ ...c, blocker: brief(byId.get(c.from)!), blocked: brief(byId.get(c.to)!) }));
  const settings = projectId ? await getScheduleSettings(deps, orgId, projectId) : undefined;
  return { links, conflicts, ...(settings ? { settings } : {}) };
}

/**
 * Give a task new dates and, unless moveDependents is false, shift every task waiting on it that would now clash.
 * preview: true plans and returns the same shape with nothing written.
 */
export async function rescheduleTask(deps: Deps, actor: SuiteActor, idOrRef: string, input: { start?: string | null; due?: string | null; moveDependents?: boolean; preview?: boolean; strict?: boolean }) {
  if (!input.preview) assertWritable(actor);
  const id = await resolveTaskId(deps, actor.orgId, idOrRef);
  const links = await dependencyLinks(deps, actor.orgId);
  // Only tasks connected to this one matter: walk the chain after it.
  const reach = new Set([id]);
  const stack = [id];
  while (stack.length) { const n = stack.pop()!; for (const l of links) if (l.from === n && !reach.has(l.to)) { reach.add(l.to); stack.push(l.to); } }
  for (const l of links) if (reach.has(l.to)) reach.add(l.from); // blockers of anything in the chain
  const list = await datedTasks(deps, actor.orgId, [...reach]);
  const self = list.find((t) => t.id === id);
  if (!self) throw new HttpError(404, "not_found", "No such task.");
  const next = { start: input.start !== undefined ? (input.start ? input.start.slice(0, 10) : null) : self.start, due: input.due !== undefined ? (input.due ? input.due.slice(0, 10) : null) : self.due };
  if (next.start && next.due && next.due < next.start) throw new HttpError(422, "validation_failed", "The due date is before the start date.");
  const { settings, calOf } = await plannerFor(deps, actor.orgId, list);
  // R38: the moved task's project says flexible or strict; `strict` on the request overrides it for this move only.
  const own = settings.get(self.projectId ?? "") ?? DEFAULT_SCHEDULE;
  const strict = input.strict ?? own.strict;
  const mode = { mode: strict ? "strict" : "flexible", workingDaysOnly: own.workingDaysOnly } as const;
  const plan = input.moveDependents === false ? [{ id, from: { start: self.start, due: self.due }, to: next, days: 0 }] : planShift(list, links, id, next, { calOf, strict });
  const byId = new Map(list.map((t) => [t.id, t]));
  const moves = plan.map((m) => ({ ...m, ref: byId.get(m.id)?.ref ?? "", title: byId.get(m.id)?.title ?? "" }));
  if (input.preview) return { preview: true, ...mode, moved: moves.slice(1), task: moves[0] };
  // Essential writes: each is a date change the person asked for (directly or by keeping the chain in order).
  for (const m of moves) await updateTask(deps, actor, m.id, { start: m.to.start, due: m.to.due });
  return { preview: false, ...mode, moved: moves.slice(1), task: (await taskDetail(deps, actor, id)).task };
}
