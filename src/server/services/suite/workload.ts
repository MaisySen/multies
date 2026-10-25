/**
 * R24.2 Workload: open tasks and their estimates per person per week, read in two grouped queries
 * (the tasks with their project, and the people), so a view costs no D1 writes. A reassign or a
 * reschedule from the view is the normal task update (PATCH /api/tasks/:id).
 *
 * Which week a task sits in: its due date, or its start date when it has a start and no due date,
 * read in the viewer's time zone; weeks start on Monday. Open tasks only (not in a done category,
 * not waiting in Triage, not deleted, not an epic); open tasks due before the range land in the
 * Overdue column. Capacity per person per week: a request's capacity applies to everyone; else
 * the person's stored weekly capacity (workload-capacity.ts); else the default (40 hours or 20 points).
 */
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { organizations, projects, sprints, tasks, users } from "../../db/schema";
import { notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { assignees } from "./tasks";
import { listCapacities } from "./workload-capacity";
import { topLevelCondition } from "./task-types";

export type WorkloadUnit = "points" | "hours";
export const DEFAULT_CAPACITY: Record<WorkloadUnit, number> = { hours: 40, points: 20 };
export const MAX_WEEKS = 12;
export const ROW_CAP = 2000;
const DAY = 86_400_000;

export interface WorkloadQuery {
  from?: string; weeks?: number; projectIds?: string[]; sprintId?: string; people?: string[];
  unit?: WorkloadUnit; capacity?: number; tz?: string;
}

// ---------------------------------------------------------------- zoned dates (no dependency)

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}
function parts(t: number, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
/** Milliseconds the zone is ahead of UTC at instant t. */
function offsetAt(t: number, tz: string) {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}
export function validZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}
/** The calendar date (YYYY-MM-DD) of instant t in the zone. */
export function localDate(t: number, tz: string) {
  const p = parts(t, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
/** The instant a calendar date starts in the zone (local midnight), across DST changes. */
export function zonedMidnight(date: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** The Monday on or before a calendar date. */
export function mondayOf(date: string) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((dow + 6) % 7));
}
/** The week (its Monday) instant t falls in, in the zone. */
export function weekOf(t: number, tz: string) {
  return mondayOf(localDate(t, tz));
}

// ---------------------------------------------------------------- the read

type Chip = { id: string; ref: string; title: string; projectId: string; project: string; projectColor: string; due: string | null; start: string | null; status: string; points: number | null; unit: WorkloadUnit };
type Cell = { count: number; points: number; hours: number; noEstimate: number; load: number; over: boolean; near: boolean; tasks: Chip[] };
const emptyCell = (): Cell => ({ count: 0, points: 0, hours: 0, noEstimate: 0, load: 0, over: false, near: false, tasks: [] });

async function viewerZone(deps: Deps, actor: SuiteActor, tz?: string) {
  if (validZone(tz)) return tz;
  const [u, o] = await Promise.all([
    actor.userId && !actor.agentId ? deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, actor.userId)).get() : undefined,
    deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get(),
  ]);
  if (validZone(u?.tz)) return u!.tz!;
  if (validZone(o?.tz)) return o!.tz;
  return "UTC";
}

export async function getWorkload(deps: Deps, actor: SuiteActor, q: WorkloadQuery = {}) {
  const tz = await viewerZone(deps, actor, q.tz);
  const unit: WorkloadUnit = q.unit === "hours" ? "hours" : "points";
  const capacity = q.capacity && q.capacity > 0 ? q.capacity : DEFAULT_CAPACITY[unit];
  const weeksN = Math.max(1, Math.min(MAX_WEEKS, Math.floor(q.weeks ?? 4)));
  const fromDate = q.from && /^\d{4}-\d{2}-\d{2}/.test(q.from) ? q.from.slice(0, 10) : localDate(deps.now().getTime(), tz);
  const first = mondayOf(fromDate);
  const weeks = Array.from({ length: weeksN }, (_, i) => addDays(first, i * 7));
  const start = zonedMidnight(first, tz);
  const end = zonedMidnight(addDays(first, weeksN * 7), tz);

  const projectIds = [...new Set(q.projectIds ?? [])].filter(Boolean);
  // Another workspace's ids are refused, never read as an empty answer.
  if (projectIds.length) {
    const found = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, actor.orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)));
    if (found.length !== projectIds.length) throw notFound("Project");
  }
  if (q.sprintId) {
    const s = await deps.db.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.orgId, actor.orgId), eq(sprints.id, q.sprintId))).get();
    if (!s) throw notFound("Sprint");
  }

  const conds: (SQL | undefined)[] = [
    eq(tasks.orgId, actor.orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), ne(tasks.status, "done"), ne(tasks.type, "epic"),
    isNull(projects.deletedAt), topLevelCondition(),
    or(
      sql`(${tasks.dueAt} is not null and ${tasks.dueAt} < ${end})`,
      sql`(${tasks.dueAt} is null and ${tasks.startAt} >= ${start} and ${tasks.startAt} < ${end})`,
    ),
  ];
  if (projectIds.length) conds.push(inArray(tasks.projectId, projectIds));
  if (q.sprintId) conds.push(eq(tasks.sprintId, q.sprintId));
  const people = (q.people ?? []).filter(Boolean);
  if (people.length) {
    const ors: SQL[] = [];
    for (const p of people) {
      if (p === "none") { ors.push(isNull(tasks.assigneeId)); continue; }
      const [type, id] = p.split(":");
      if ((type === "member" || type === "agent") && id) ors.push(and(eq(tasks.assigneeType, type), eq(tasks.assigneeId, id))!);
    }
    conds.push(ors.length ? or(...ors) : sql`0`);
  }

  const [rows, roster, stored] = await Promise.all([
    deps.db.select({
      id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, status: tasks.status, points: tasks.points,
      dueAt: tasks.dueAt, startAt: tasks.startAt, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId,
      key: projects.key, projectName: projects.name, color: projects.color, estimateUnit: projects.estimateUnit,
    }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(...conds))
      .orderBy(sql`coalesce(${tasks.dueAt}, ${tasks.startAt})`, asc(tasks.id)).limit(ROW_CAP + 1),
    assignees(deps, actor.orgId),
    q.capacity && q.capacity > 0 ? Promise.resolve([]) : listCapacities(deps, actor.orgId),
  ]);
  const storedBy = new Map(stored.map((s) => [s.person, s]));
  /** This person's weekly capacity in the chosen unit, and where it came from. */
  const capFor = (key: string): { value: number; source: "request" | "stored" | "default" } => {
    if (q.capacity && q.capacity > 0) return { value: q.capacity, source: "request" };
    const v = storedBy.get(key)?.[unit];
    return v != null && v > 0 ? { value: v, source: "stored" } : { value: DEFAULT_CAPACITY[unit], source: "default" };
  };
  const truncated = rows.length > ROW_CAP;
  const used = truncated ? rows.slice(0, ROW_CAP) : rows;

  type Row = { id: string | null; type: "member" | "agent" | null; name: string; email: string | null; isAgent: boolean; overdue: Cell; weeks: Record<string, Cell>; total: Cell; capacity: number; capacitySource: "request" | "stored" | "default" };
  const byPerson = new Map<string, Row>();
  const names = new Map(roster.map((r) => [r.id, r]));
  const rowFor = (key: string) => {
    let r = byPerson.get(key);
    if (!r) {
      const who = names.get(key);
      const type = key === "none" ? null : key.split(":")[0];
      r = {
        id: key === "none" ? null : key, type: type as Row["type"], name: key === "none" ? "Unassigned" : who?.name || "Former member",
        email: who?.email ?? null, isAgent: type === "agent" || !!(who as { isAgent?: boolean } | undefined)?.isAgent,
        overdue: emptyCell(), weeks: Object.fromEntries(weeks.map((w) => [w, emptyCell()])), total: emptyCell(),
        capacity: DEFAULT_CAPACITY[unit], capacitySource: "default",
      };
      byPerson.set(key, r);
    }
    return r;
  };
  const add = (cell: Cell, chip: Chip, pts: number | null, u: WorkloadUnit) => {
    cell.count++;
    if (pts == null) cell.noEstimate++;
    else if (u === "hours") cell.hours += pts;
    else cell.points += pts;
    cell.tasks.push(chip);
  };
  for (const t of used) {
    const key = t.assigneeId && t.assigneeType ? `${t.assigneeType}:${t.assigneeId}` : "none";
    const r = rowFor(key);
    const u = (t.estimateUnit ?? "points") as WorkloadUnit;
    const chip: Chip = {
      id: t.id, ref: `${t.key}-${t.number}`, title: t.title, projectId: t.projectId, project: t.projectName, projectColor: t.color,
      due: t.dueAt ? new Date(t.dueAt).toISOString() : null, start: t.startAt ? new Date(t.startAt).toISOString() : null,
      status: t.status, points: t.points ?? null, unit: u,
    };
    const at = (t.dueAt ?? t.startAt)!.getTime();
    const cell = t.dueAt && at < start ? r.overdue : r.weeks[weekOf(at, tz)];
    if (!cell) continue;
    add(cell, chip, t.points ?? null, u);
    add(r.total, chip, t.points ?? null, u);
    r.total.tasks.pop();
  }
  const finish = (c: Cell, capacity: number) => {
    c.points = Math.round(c.points * 100) / 100;
    c.hours = Math.round(c.hours * 100) / 100;
    c.load = unit === "hours" ? c.hours : c.points;
    c.over = c.load > capacity;
    c.near = !c.over && c.load >= capacity * 0.8;
  };
  const out = [...byPerson.values()].map((r) => {
    const cap = capFor(r.id ?? "none");
    for (const w of weeks) finish(r.weeks[w], cap.value);
    finish(r.overdue, cap.value);
    finish(r.total, cap.value * weeks.length);
    r.capacity = cap.value;
    r.capacitySource = cap.source;
    r.total.over = weeks.some((w) => r.weeks[w].over);
    return r;
  }).sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));

  return {
    unit, capacity, timeZone: tz,
    range: { from: first, to: addDays(first, weeksN * 7 - 1), weeks: weeks.map((w) => ({ start: w, end: addDays(w, 6) })) },
    people: out.map((r) => ({
      id: r.id, type: r.type, name: r.name, isAgent: r.isAgent, capacity: r.capacity, capacitySource: r.capacitySource,
      overdue: r.overdue,
      weeks: weeks.map((w) => ({ week: w, ...r.weeks[w] })),
      total: { count: r.total.count, points: r.total.points, hours: r.total.hours, noEstimate: r.total.noEstimate, load: r.total.load, overAnyWeek: r.total.over },
    })),
    overloaded: out.flatMap((r) => weeks.filter((w) => r.weeks[w].over && r.id).map((w) => ({ person: r.name, id: r.id, week: w, load: r.weeks[w].load, capacity: r.capacity }))),
    taskCount: used.length,
    truncated,
  };
}
export type Workload = Awaited<ReturnType<typeof getWorkload>>;
