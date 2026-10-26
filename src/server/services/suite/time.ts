/**
 * Time tracking on tasks: one running timer per person (starting a new one stops the old),
 * manual entries, and a timesheet per person and project. Agents can log time too, under
 * their own name. Durations are stored in seconds when an entry stops.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, projects, tasks, timeEntries, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, iso, parseDate, recordWrite, sortableId, type SuiteActor } from "./common";
import { resolveTaskId } from "./tasks";

type EntryRow = typeof timeEntries.$inferSelect;
export interface Person { type: "member" | "agent"; id: string }

const DAY = 86_400_000;
/** A timer left running longer than this is capped when it stops, so a forgotten timer can't log a week. */
export const MAX_TIMER_SECONDS = 12 * 3600;

export function personOf(a: SuiteActor): Person {
  if (a.agentId) return { type: "agent", id: a.agentId };
  if (!a.userId) throw new HttpError(422, "person_required", "Time belongs to a person or an agent. Use an agent key, or sign in.");
  return { type: "member", id: a.userId };
}

const isLead = (a: SuiteActor) => a.role === "owner" || a.role === "admin" || (!a.agentId && !a.userId);

async function taskInfo(deps: Deps, orgId: string, idOrRef: string) {
  const id = await resolveTaskId(deps, orgId, idOrRef);
  const t = await deps.db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound("Task");
  return t;
}

/** Seconds an entry covers, counting a running timer up to now. */
export function entrySeconds(e: Pick<EntryRow, "startedAt" | "endedAt" | "seconds">, now: Date) {
  if (e.endedAt) return e.seconds;
  return Math.min(MAX_TIMER_SECONDS, Math.max(0, Math.round((now.getTime() - e.startedAt.getTime()) / 1000)));
}

async function present(deps: Deps, orgId: string, rows: EntryRow[]) {
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean) as string[])];
  const memberIds = [...new Set(rows.filter((r) => r.personType === "member").map((r) => r.personId))];
  const agentIds = [...new Set(rows.filter((r) => r.personType === "agent").map((r) => r.personId))];
  const [ts, prs, us, ags] = await Promise.all([
    taskIds.length ? deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId }).from(tasks).where(inArray(tasks.id, taskIds.slice(0, 900))) : [],
    deps.db.select({ id: projects.id, key: projects.key, name: projects.name, color: projects.color }).from(projects).where(eq(projects.orgId, orgId)),
    memberIds.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, memberIds)) : [],
    agentIds.length ? deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  const tm = new Map(ts.map((t) => [t.id, t])), pm = new Map(prs.map((p) => [p.id, p]));
  const um = new Map(us.map((u) => [u.id, u])), am = new Map(ags.map((a) => [a.id, a]));
  const now = deps.now();
  return rows.map((r) => {
    const t = r.taskId ? tm.get(r.taskId) : undefined;
    const p = r.projectId ? pm.get(r.projectId) : undefined;
    const name = r.personType === "member" ? (um.get(r.personId)?.name || um.get(r.personId)?.email || "Former member") : (am.get(r.personId)?.name ?? "Removed agent");
    return {
      id: r.id, taskId: r.taskId, task: t ? { id: t.id, ref: `${pm.get(t.projectId)?.key ?? "TSK"}-${t.number}`, title: t.title } : null,
      projectId: r.projectId, project: p ? { id: p.id, name: p.name, key: p.key, color: p.color } : null,
      person: { type: r.personType, id: r.personId, name }, personId: `${r.personType}:${r.personId}`,
      startedAt: r.startedAt.toISOString(), endedAt: iso(r.endedAt), running: !r.endedAt, seconds: entrySeconds(r, now),
      note: r.note, billable: r.billable, source: r.source, createdAt: r.createdAt.toISOString(), version: r.version,
    };
  });
}
export type TimeEntry = Awaited<ReturnType<typeof present>>[number];

async function entryRow(deps: Deps, orgId: string, id: string) {
  const e = await deps.db.select().from(timeEntries).where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.id, id), isNull(timeEntries.deletedAt))).get();
  if (!e) throw notFound("Time entry");
  return e;
}

function assertOwnOrLead(a: SuiteActor, e: EntryRow) {
  const p = a.agentId ? { type: "agent", id: a.agentId } : { type: "member", id: a.userId };
  if (isLead(a) && !a.agentId) return;
  if (e.personType !== p.type || e.personId !== p.id) throw new HttpError(403, "not_your_entry", "You can only change your own time. An admin can change anyone's.");
}

export async function runningTimer(deps: Deps, actor: SuiteActor) {
  const p = personOf(actor);
  const row = await deps.db.select().from(timeEntries)
    .where(and(eq(timeEntries.orgId, actor.orgId), eq(timeEntries.personType, p.type), eq(timeEntries.personId, p.id), isNull(timeEntries.endedAt), isNull(timeEntries.deletedAt))).get();
  return row ? (await present(deps, actor.orgId, [row]))[0] : null;
}

async function stopRow(deps: Deps, actor: SuiteActor, row: EntryRow) {
  const now = deps.now();
  const seconds = entrySeconds(row, now);
  const endedAt = new Date(row.startedAt.getTime() + seconds * 1000);
  await deps.db.update(timeEntries).set({ endedAt, seconds, updatedAt: now, version: row.version + 1 }).where(eq(timeEntries.id, row.id));
  await recordWrite(deps, actor, { entityType: "time_entry", entityId: row.id, op: "update", version: row.version + 1, verb: "time.stopped", data: { seconds, taskId: row.taskId },
    event: "time_entry.updated", eventData: { id: row.id, taskId: row.taskId, seconds, running: false } });
  if (row.taskId) await recordWrite(deps, actor, { entityType: "task", entityId: row.taskId, op: "update", verb: "time.logged", data: { seconds } });
}

/** Starts a timer on a task. A timer already running for this person stops first. */
export async function startTimer(deps: Deps, actor: SuiteActor, input: { taskId: string; note?: string }) {
  assertWritable(actor);
  const p = personOf(actor);
  const t = await taskInfo(deps, actor.orgId, input.taskId);
  const running = await deps.db.select().from(timeEntries)
    .where(and(eq(timeEntries.orgId, actor.orgId), eq(timeEntries.personType, p.type), eq(timeEntries.personId, p.id), isNull(timeEntries.endedAt), isNull(timeEntries.deletedAt)));
  for (const r of running) await stopRow(deps, actor, r);
  const now = deps.now();
  const id = sortableId("tim", now.getTime());
  await deps.db.insert(timeEntries).values({
    id, orgId: actor.orgId, taskId: t.id, projectId: t.projectId, personType: p.type, personId: p.id,
    startedAt: now, endedAt: null, seconds: 0, note: (input.note ?? "").slice(0, 500), source: "timer", ...createdBy(actor), createdAt: now, updatedAt: now,
  });
  await recordWrite(deps, actor, { entityType: "time_entry", entityId: id, op: "create", verb: "time.started", data: { taskId: t.id },
    event: "time_entry.created", eventData: { id, taskId: t.id, running: true } });
  return (await present(deps, actor.orgId, [(await entryRow(deps, actor.orgId, id))]))[0];
}

/** Stops this person's running timer (or the one named). Returns the stopped entry, or null if none ran. */
export async function stopTimer(deps: Deps, actor: SuiteActor, input: { entryId?: string } = {}) {
  assertWritable(actor);
  let row: EntryRow | undefined;
  if (input.entryId) {
    row = await entryRow(deps, actor.orgId, input.entryId);
    assertOwnOrLead(actor, row);
    if (row.endedAt) throw new HttpError(409, "timer_not_running", "That timer has already stopped.");
  } else {
    const p = personOf(actor);
    row = await deps.db.select().from(timeEntries)
      .where(and(eq(timeEntries.orgId, actor.orgId), eq(timeEntries.personType, p.type), eq(timeEntries.personId, p.id), isNull(timeEntries.endedAt), isNull(timeEntries.deletedAt))).get();
    if (!row) return null;
  }
  await stopRow(deps, actor, row);
  return (await present(deps, actor.orgId, [await entryRow(deps, actor.orgId, row.id)]))[0];
}

export interface ManualEntryInput { taskId?: string | null; projectId?: string | null; date?: string; startedAt?: string; minutes: number; note?: string; billable?: boolean; person?: string }

function parsePerson(v: string | undefined, actor: SuiteActor): Person {
  if (!v) return personOf(actor);
  const [type, id] = v.split(":");
  if ((type !== "member" && type !== "agent") || !id) throw new HttpError(422, "validation_failed", "person looks like member:<userId> or agent:<agentId>.");
  const self = personOf(actor);
  if ((type !== self.type || id !== self.id) && (!isLead(actor) || actor.agentId)) throw new HttpError(403, "not_your_entry", "Only an admin can log time for someone else.");
  return { type, id };
}

/** A manual entry: minutes on a day (or from a start time), on a task or just a project. */
export async function addEntry(deps: Deps, actor: SuiteActor, input: ManualEntryInput) {
  assertWritable(actor);
  if (!Number.isFinite(input.minutes) || input.minutes <= 0 || input.minutes > 24 * 60) throw new HttpError(422, "validation_failed", "Minutes must be between 1 and 1440.");
  const p = parsePerson(input.person, actor);
  let taskId: string | null = null, projectId = input.projectId ?? null;
  if (input.taskId) { const t = await taskInfo(deps, actor.orgId, input.taskId); taskId = t.id; projectId = t.projectId; }
  if (projectId && !taskId) {
    const pr = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId))).get();
    if (!pr) throw notFound("Project");
  }
  const now = deps.now();
  const startedAt = input.startedAt ? parseDate(input.startedAt)! : input.date ? new Date(`${input.date}T09:00:00.000Z`) : new Date(now.getTime() - input.minutes * 60_000);
  if (Number.isNaN(startedAt.getTime())) throw new HttpError(422, "validation_failed", "Not a date.");
  const seconds = Math.round(input.minutes * 60);
  const id = sortableId("tim", now.getTime());
  await deps.db.insert(timeEntries).values({
    id, orgId: actor.orgId, taskId, projectId, personType: p.type, personId: p.id, startedAt, endedAt: new Date(startedAt.getTime() + seconds * 1000), seconds,
    note: (input.note ?? "").slice(0, 500), billable: input.billable ?? true, source: "manual", ...createdBy(actor), createdAt: now, updatedAt: now,
  });
  await recordWrite(deps, actor, { entityType: "time_entry", entityId: id, op: "create", verb: "time.added", data: { taskId, seconds },
    event: "time_entry.created", eventData: { id, taskId, projectId, seconds, running: false } });
  if (taskId) await recordWrite(deps, actor, { entityType: "task", entityId: taskId, op: "update", verb: "time.logged", data: { seconds } });
  return (await present(deps, actor.orgId, [await entryRow(deps, actor.orgId, id)]))[0];
}

export async function updateEntry(deps: Deps, actor: SuiteActor, id: string, patch: { minutes?: number; note?: string; billable?: boolean; date?: string }) {
  assertWritable(actor);
  const e = await entryRow(deps, actor.orgId, id);
  assertOwnOrLead(actor, e);
  const set: Partial<EntryRow> = { updatedAt: deps.now(), version: e.version + 1 };
  if (patch.minutes !== undefined) {
    if (!e.endedAt) throw new HttpError(409, "timer_running", "Stop the timer before changing its length.");
    if (patch.minutes <= 0 || patch.minutes > 24 * 60) throw new HttpError(422, "validation_failed", "Minutes must be between 1 and 1440.");
    set.seconds = Math.round(patch.minutes * 60);
    set.endedAt = new Date(e.startedAt.getTime() + set.seconds * 1000);
  }
  if (patch.date) {
    const d = new Date(`${patch.date}T09:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new HttpError(422, "validation_failed", "Not a date.");
    set.startedAt = d;
    if (e.endedAt) set.endedAt = new Date(d.getTime() + (set.seconds ?? e.seconds) * 1000);
  }
  if (patch.note !== undefined) set.note = patch.note.slice(0, 500);
  if (patch.billable !== undefined) set.billable = patch.billable;
  await deps.db.update(timeEntries).set(set).where(eq(timeEntries.id, id));
  await recordWrite(deps, actor, { entityType: "time_entry", entityId: id, op: "update", version: e.version + 1, verb: "time.updated", event: "time_entry.updated", eventData: { id, taskId: e.taskId } });
  return (await present(deps, actor.orgId, [await entryRow(deps, actor.orgId, id)]))[0];
}

export async function deleteEntry(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const e = await entryRow(deps, actor.orgId, id);
  assertOwnOrLead(actor, e);
  await deps.db.update(timeEntries).set({ deletedAt: deps.now(), updatedAt: deps.now(), version: e.version + 1 }).where(eq(timeEntries.id, id));
  await recordWrite(deps, actor, { entityType: "time_entry", entityId: id, op: "delete", version: e.version + 1, verb: "time.deleted" });
  return { ok: true };
}

export interface EntryFilters { from?: string; to?: string; person?: string; projectId?: string; taskId?: string; limit?: number }

function rangeOf(f: { from?: string; to?: string }, now: Date) {
  const to = f.to ? new Date(parseDate(f.to)!.getTime() + (f.to.length === 10 ? DAY : 0)) : new Date(now.getTime() + DAY);
  const from = f.from ? parseDate(f.from)! : new Date(to.getTime() - 8 * DAY);
  if (to.getTime() - from.getTime() > 400 * DAY) throw new HttpError(422, "validation_failed", "Pick a range of up to 400 days.");
  return { from, to };
}

async function filteredRows(deps: Deps, actor: SuiteActor, f: EntryFilters) {
  const conds: (SQL | undefined)[] = [eq(timeEntries.orgId, actor.orgId), isNull(timeEntries.deletedAt)];
  if (f.taskId) conds.push(eq(timeEntries.taskId, await resolveTaskId(deps, actor.orgId, f.taskId)));
  else { const { from, to } = rangeOf(f, deps.now()); conds.push(gte(timeEntries.startedAt, from), lt(timeEntries.startedAt, to)); }
  if (f.projectId) conds.push(eq(timeEntries.projectId, f.projectId));
  if (f.person) {
    const [type, id] = f.person === "me" ? [personOf(actor).type, personOf(actor).id] : f.person.split(":");
    conds.push(eq(timeEntries.personType, type as "member" | "agent"), eq(timeEntries.personId, id));
  }
  return deps.db.select().from(timeEntries).where(and(...conds)).orderBy(desc(timeEntries.startedAt)).limit(Math.min(f.limit ?? 2000, 5000));
}

export async function listEntries(deps: Deps, actor: SuiteActor, f: EntryFilters = {}) {
  return present(deps, actor.orgId, await filteredRows(deps, actor, f));
}

/** Total seconds on a task, and who logged them. */
export async function taskTime(deps: Deps, actor: SuiteActor, taskIdOrRef: string) {
  const entries = await listEntries(deps, actor, { taskId: taskIdOrRef });
  return { totalSeconds: entries.reduce((s, e) => s + e.seconds, 0), entries };
}

/**
 * A timesheet: one row per person and project, seconds per day (YYYY-MM-DD in the
 * workspace's time zone) plus totals. The days run from `from` to `to`.
 */
export async function timesheet(deps: Deps, actor: SuiteActor, f: EntryFilters & { timeZone?: string } = {}) {
  const { from, to } = rangeOf(f, deps.now());
  const entries = await listEntries(deps, actor, { ...f, from: from.toISOString(), to: to.toISOString(), taskId: undefined });
  const tz = f.timeZone || "UTC";
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const days: string[] = [];
  for (let t = from.getTime(); t < to.getTime() && days.length < 62; t += DAY) { const d = dayOf(new Date(t)); if (!days.includes(d)) days.push(d); }
  const rows = new Map<string, { person: TimeEntry["person"]; project: TimeEntry["project"]; days: Record<string, number>; total: number; billable: number }>();
  for (const e of entries) {
    const key = `${e.personId}|${e.projectId ?? ""}`;
    const r = rows.get(key) ?? { person: e.person, project: e.project, days: {}, total: 0, billable: 0 };
    const d = dayOf(new Date(e.startedAt));
    r.days[d] = (r.days[d] ?? 0) + e.seconds;
    r.total += e.seconds;
    if (e.billable) r.billable += e.seconds;
    rows.set(key, r);
  }
  const list = [...rows.values()].sort((a, b) => a.person.name.localeCompare(b.person.name) || (a.project?.name ?? "").localeCompare(b.project?.name ?? ""));
  const dayTotals: Record<string, number> = {};
  for (const r of list) for (const [d, s] of Object.entries(r.days)) dayTotals[d] = (dayTotals[d] ?? 0) + s;
  return { from: from.toISOString(), to: to.toISOString(), timeZone: tz, days, rows: list, dayTotals, total: list.reduce((s, r) => s + r.total, 0), entries };
}

/** Seconds per project in a range: for the reports page. */
export async function secondsByProject(deps: Deps, orgId: string, from: Date, to: Date) {
  const rows = await deps.db.select({ projectId: timeEntries.projectId, startedAt: timeEntries.startedAt, endedAt: timeEntries.endedAt, seconds: timeEntries.seconds })
    .from(timeEntries).where(and(eq(timeEntries.orgId, orgId), isNull(timeEntries.deletedAt), gte(timeEntries.startedAt, from), lt(timeEntries.startedAt, to))).orderBy(asc(timeEntries.startedAt));
  const now = deps.now();
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.projectId ?? "", (m.get(r.projectId ?? "") ?? 0) + entrySeconds(r, now));
  return m;
}
