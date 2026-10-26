/**
 * R37: dependencies that plan for you. A "blocks" link means the blocked task starts after the blocker ends
 * (finish to start). This module finds date conflicts (a blocked task that starts on or before its blocker's last
 * day) and plans the shift of every task that waits on a moved task, keeping each task's length. Only later shifts
 * happen: moving a task earlier never pulls the tasks after it (the "flexible" rule; nothing is squeezed).
 *
 *   GET  /api/tasks/schedule-check?projectId=     { links, conflicts }
 *   POST /api/tasks/:id/reschedule                { start?, due?, moveDependents? (default true), preview? }
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

const DAY = 86_400_000;
export const MAX_CHAIN = 50;

export interface SchedTask { id: string; ref?: string; title?: string; start: string | null; due: string | null; status: string }
export interface Link { from: string; to: string }
export interface Move { id: string; from: { start: string | null; due: string | null }; to: { start: string | null; due: string | null }; days: number }
export interface Conflict { from: string; to: string; overlapDays: number; fix: { taskId: string; start: string | null; due: string | null } }

const day = (s: string | null) => (s ? Date.parse(`${s.slice(0, 10)}T00:00:00.000Z`) : null);
const ymd = (n: number | null) => (n === null ? null : new Date(n).toISOString().slice(0, 10));
/** The first and last day a task takes. A task with one date takes that one day. */
export function span(t: Pick<SchedTask, "start" | "due">): { first: number; last: number } | null {
  const s = day(t.start), d = day(t.due);
  if (s === null && d === null) return null;
  const first = s ?? d!, last = d ?? s!;
  return { first: Math.min(first, last), last: Math.max(first, last) };
}
function shifted(t: SchedTask, days: number) {
  return { start: t.start ? ymd(day(t.start)! + days * DAY) : null, due: t.due ? ymd(day(t.due)! + days * DAY) : null };
}

/** Links whose blocked task starts on or before the blocker's last day. Done tasks never conflict. */
export function findConflicts(list: SchedTask[], links: Link[]): Conflict[] {
  const byId = new Map(list.map((t) => [t.id, t]));
  const out: Conflict[] = [];
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b || a.status === "done" || b.status === "done") continue;
    const sa = span(a), sb = span(b);
    if (!sa || !sb || sb.first > sa.last) continue;
    const days = Math.round((sa.last - sb.first) / DAY) + 1;
    out.push({ from: l.from, to: l.to, overlapDays: days, fix: { taskId: b.id, ...shifted(b, days) } });
  }
  return out.sort((x, y) => y.overlapDays - x.overlapDays);
}

/**
 * Plan the moves after `movedId` gets new dates. Every task that waits on it (directly or down the chain) and would
 * now start on or before a blocker's last day shifts later by just enough, keeping its length. Done and undated tasks
 * stay put (an undated task passes nothing on). Returns the moved task first, then each dependent once.
 */
export function planShift(list: SchedTask[], links: Link[], movedId: string, next: { start: string | null; due: string | null }): Move[] {
  const byId = new Map(list.map((t) => [t.id, { ...t }]));
  const moved = byId.get(movedId);
  if (!moved) return [];
  const orig = new Map(list.map((t) => [t.id, { start: t.start, due: t.due }]));
  moved.start = next.start; moved.due = next.due;
  const out = new Map<string, number>();
  const after = new Map<string, string[]>();
  for (const l of links) after.set(l.from, [...(after.get(l.from) ?? []), l.to]);
  const blockersOf = new Map<string, string[]>();
  for (const l of links) blockersOf.set(l.to, [...(blockersOf.get(l.to) ?? []), l.from]);
  const queue = [movedId];
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const id = queue.shift()!;
    for (const childId of after.get(id) ?? []) {
      const c = byId.get(childId);
      if (!c || c.status === "done" || childId === movedId) continue;
      const sc = span(c);
      if (!sc) continue;
      // The latest last day among everything that blocks it (open blockers only), as it stands now.
      let latest = -Infinity;
      for (const bId of blockersOf.get(childId) ?? []) {
        const b = byId.get(bId);
        const sb = b && b.status !== "done" ? span(b) : null;
        if (sb) latest = Math.max(latest, sb.last);
      }
      if (latest === -Infinity || sc.first > latest) continue;
      const days = Math.round((latest - sc.first) / DAY) + 1;
      Object.assign(c, shifted(c, days));
      out.set(childId, (out.get(childId) ?? 0) + days);
      if (out.size > MAX_CHAIN) throw new HttpError(422, "chain_too_long", `This move would shift more than ${MAX_CHAIN} tasks. Move fewer at once.`);
      queue.push(childId);
    }
  }
  const o = orig.get(movedId)!;
  const firstMove: Move = { id: movedId, from: o, to: { start: moved.start, due: moved.due }, days: Math.round(((span(moved)?.first ?? 0) - (span(o)?.first ?? span(moved)?.first ?? 0)) / DAY) };
  return [firstMove, ...[...out.entries()].map(([id, days]) => ({ id, from: orig.get(id)!, to: { start: byId.get(id)!.start, due: byId.get(id)!.due }, days }))];
}

async function datedTasks(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [] as (SchedTask & { ref: string; title: string })[];
  const rows = await deps.db.select({ id: tasks.id, number: tasks.number, projectId: tasks.projectId, title: tasks.title, startAt: tasks.startAt, dueAt: tasks.dueAt, status: tasks.status })
    .from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, ids.slice(0, 900)), isNull(tasks.deletedAt)));
  const pids = [...new Set(rows.map((r) => r.projectId))];
  const keys = new Map((pids.length ? await deps.db.select({ id: projects.id, key: projects.key }).from(projects).where(inIds(projects.id, pids)) : []).map((p) => [p.id, p.key]));
  const d = (x: Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : null);
  return rows.map((r) => ({ id: r.id, ref: `${keys.get(r.projectId) ?? "TSK"}-${r.number}`, title: r.title, start: d(r.startAt), due: d(r.dueAt), status: r.status }));
}

/** Every dependency link in the workspace (or one project) and the ones whose dates clash. Read only. */
export async function scheduleCheck(deps: Deps, orgId: string, projectId?: string) {
  const links = await dependencyLinks(deps, orgId, projectId);
  const list = await datedTasks(deps, orgId, [...new Set(links.flatMap((l) => [l.from, l.to]))]);
  const byId = new Map(list.map((t) => [t.id, t]));
  const brief = (t: SchedTask & { ref: string; title: string }) => ({ id: t.id, ref: t.ref, title: t.title, start: t.start, due: t.due });
  const conflicts = findConflicts(list, links).map((c) => ({ ...c, blocker: brief(byId.get(c.from)!), blocked: brief(byId.get(c.to)!) }));
  return { links, conflicts };
}

/**
 * Give a task new dates and, unless moveDependents is false, shift every task waiting on it that would now clash.
 * preview: true plans and returns the same shape with nothing written.
 */
export async function rescheduleTask(deps: Deps, actor: SuiteActor, idOrRef: string, input: { start?: string | null; due?: string | null; moveDependents?: boolean; preview?: boolean }) {
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
  const plan = input.moveDependents === false ? [{ id, from: { start: self.start, due: self.due }, to: next, days: 0 }] : planShift(list, links, id, next);
  const byId = new Map(list.map((t) => [t.id, t]));
  const moves = plan.map((m) => ({ ...m, ref: byId.get(m.id)?.ref ?? "", title: byId.get(m.id)?.title ?? "" }));
  if (input.preview) return { preview: true, moved: moves.slice(1), task: moves[0] };
  // Essential writes: each is a date change the person asked for (directly or by keeping the chain in order).
  for (const m of moves) await updateTask(deps, actor, m.id, { start: m.to.start, due: m.to.due });
  return { preview: false, moved: moves.slice(1), task: (await taskDetail(deps, actor, id)).task };
}
