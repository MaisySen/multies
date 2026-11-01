/**
 * R95 Tasks plus (flag TASKS_PLUS_R95): My Day plans with time blocks, the weekly timesheet submit and approve
 * steps (and the lock they put on a member's own time), and the time CSV. The rules live in
 * src/shared/tasks-plus-r95.ts. Everything here reads only on its own routes and on time writes, never on a
 * hot read route.
 */
import { and, asc, desc, eq, isNull, lt, ne, gte } from "drizzle-orm";
import type { Deps } from "../../context";
import { dayPlanItems, organizations, projects, tasks, timesheets, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { sortableId, type SuiteActor } from "./common";
import { resolveTaskId } from "./tasks";
import {
  addDays, clampBlock, clashOf, csvRow, isYmd, planTomorrow, sheetStep, SHEET_LOCKED, validTimeZone, weekStartOf, ymdIn,
  type SheetAction, type SheetStatus,
} from "../../../shared/tasks-plus-r95";

export const tasksPlusOn = (deps: Deps) => !!deps.config.tasksPlus;
export const isAdmin = (a: SuiteActor) => !a.agentId && (a.role === "owner" || a.role === "admin");

function memberOf(a: SuiteActor) {
  if (a.agentId || !a.userId) throw new HttpError(403, "members_only", "My Day and timesheets belong to signed in members.");
  return a.userId;
}

export async function orgZone(deps: Deps, orgId: string) {
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return o?.tz && validTimeZone(o.tz) ? o.tz : "UTC";
}

// ---------------------------------------------------------------- My Day

type PlanRow = typeof dayPlanItems.$inferSelect;

async function present(deps: Deps, orgId: string, rows: PlanRow[]) {
  const ids = [...new Set(rows.map((r) => r.taskId))];
  const ts = ids.length ? await deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, priority: tasks.priority, dueAt: tasks.dueAt, projectId: tasks.projectId, deletedAt: tasks.deletedAt })
    .from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, ids))) : [];
  const ps = ts.length ? await deps.db.select({ id: projects.id, key: projects.key, color: projects.color, name: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.id, [...new Set(ts.map((t) => t.projectId))]))) : [];
  const tm = new Map(ts.map((t) => [t.id, t])), pm = new Map(ps.map((p) => [p.id, p]));
  return rows.flatMap((r) => {
    const t = tm.get(r.taskId);
    if (!t || t.deletedAt) return []; // a deleted task drops off the plan
    const p = pm.get(t.projectId);
    return [{ id: r.id, taskId: r.taskId, day: r.day, start: r.startMin, minutes: r.minutes, position: r.position,
      task: { id: t.id, ref: `${p?.key ?? "TSK"}-${t.number}`, title: t.title, status: t.status, priority: t.priority, due: t.dueAt?.toISOString() ?? null, project: p ? { id: p.id, name: p.name, color: p.color } : null } }];
  });
}
export type PlanItemView = Awaited<ReturnType<typeof present>>[number];

async function dayRows(deps: Deps, orgId: string, userId: string, day: string) {
  return deps.db.select().from(dayPlanItems).where(and(eq(dayPlanItems.orgId, orgId), eq(dayPlanItems.userId, userId), eq(dayPlanItems.day, day)))
    .orderBy(asc(dayPlanItems.position), asc(dayPlanItems.createdAt)).limit(200);
}

function checkDay(day: unknown): string {
  if (!isYmd(day)) throw new HttpError(422, "validation_failed", "day must be YYYY-MM-DD.");
  return day;
}

/** The plan for a day plus up to 12 open tasks of the person's that are due by then and not on it yet. */
export async function getDay(deps: Deps, actor: SuiteActor, day: string, tz?: string) {
  const userId = memberOf(actor);
  checkDay(day);
  const zone = tz && validTimeZone(tz) ? tz : await orgZone(deps, actor.orgId);
  const items = await present(deps, actor.orgId, await dayRows(deps, actor.orgId, userId, day));
  const planned = new Set(items.map((i) => i.taskId));
  // Due by the end of that day in the person's zone (a day ends at most 14 h after UTC midnight + 24 h).
  const end = new Date(Date.parse(`${addDays(day, 1)}T00:00:00Z`) + 14 * 3600_000);
  const due = await deps.db.select({ id: tasks.id, dueAt: tasks.dueAt }).from(tasks)
    .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, userId), ne(tasks.status, "done"), isNull(tasks.deletedAt), lt(tasks.dueAt, end)))
    .orderBy(asc(tasks.dueAt)).limit(40);
  const want = due.filter((t) => t.dueAt && ymdIn(t.dueAt, zone) <= day && !planned.has(t.id)).slice(0, 12);
  const suggestions = (await present(deps, actor.orgId, want.map((t, i) => ({ id: `sug-${t.id}`, orgId: actor.orgId, userId, taskId: t.id, day, startMin: null, minutes: 30, position: i, createdAt: new Date(0), updatedAt: new Date(0) }))))
    .map((s) => s.task);
  return { day, timeZone: zone, items, suggestions };
}

async function ownRow(deps: Deps, actor: SuiteActor, id: string) {
  const userId = memberOf(actor);
  const r = await deps.db.select().from(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), eq(dayPlanItems.id, id))).get();
  if (!r || r.userId !== userId) throw notFound("Plan item"); // someone else's plan is not there for you
  return r;
}

function blockOf(start: number | null | undefined, minutes: number | undefined) {
  if (start === null || start === undefined) return { start: null as number | null, minutes: clampBlock(0, minutes ?? 30).minutes };
  if (!Number.isFinite(start)) throw new HttpError(422, "validation_failed", "start is minutes after midnight.");
  const b = clampBlock(start, minutes ?? 30);
  return { start: b.start as number | null, minutes: b.minutes };
}

async function assertFree(deps: Deps, orgId: string, userId: string, day: string, id: string, start: number | null, minutes: number) {
  if (start === null) return;
  const rows = await dayRows(deps, orgId, userId, day);
  const blocks = rows.filter((r) => r.startMin !== null).map((r) => ({ id: r.id, start: r.startMin!, minutes: r.minutes }));
  const clash = clashOf(blocks, { id, start, minutes });
  if (clash) throw new HttpError(409, "time_taken", "That time is already blocked. Pick a free slot.", { clashWith: clash.id });
}

/** Puts a task on the day (or moves its block when it is already there). */
export async function addToDay(deps: Deps, actor: SuiteActor, input: { day: string; taskId: string; start?: number | null; minutes?: number }) {
  const userId = memberOf(actor);
  const day = checkDay(input.day);
  const taskId = await resolveTaskId(deps, actor.orgId, input.taskId);
  const t = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, taskId), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound("Task");
  const existing = await deps.db.select().from(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), eq(dayPlanItems.userId, userId), eq(dayPlanItems.day, day), eq(dayPlanItems.taskId, taskId))).get();
  const b = blockOf(input.start, input.minutes ?? existing?.minutes);
  const id = existing?.id ?? sortableId("day", deps.now().getTime());
  await assertFree(deps, actor.orgId, userId, day, id, b.start, b.minutes);
  const now = deps.now();
  if (existing) await deps.db.update(dayPlanItems).set({ startMin: b.start, minutes: b.minutes, updatedAt: now }).where(eq(dayPlanItems.id, id));
  else {
    const count = (await dayRows(deps, actor.orgId, userId, day)).length;
    if (count >= 100) throw new HttpError(422, "day_full", "A day holds up to 100 tasks.");
    await deps.db.insert(dayPlanItems).values({ id, orgId: actor.orgId, userId, taskId, day, startMin: b.start, minutes: b.minutes, position: count, createdAt: now, updatedAt: now });
  }
  return (await present(deps, actor.orgId, [(await ownRow(deps, actor, id))]))[0] ?? null;
}

export async function updatePlanItem(deps: Deps, actor: SuiteActor, id: string, patch: { start?: number | null; minutes?: number; day?: string; position?: number }) {
  const r = await ownRow(deps, actor, id);
  const day = patch.day !== undefined ? checkDay(patch.day) : r.day;
  const b = blockOf(patch.start !== undefined ? patch.start : r.startMin, patch.minutes ?? r.minutes);
  if (day !== r.day) {
    const dup = await deps.db.select({ id: dayPlanItems.id }).from(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), eq(dayPlanItems.userId, r.userId), eq(dayPlanItems.day, day), eq(dayPlanItems.taskId, r.taskId))).get();
    if (dup) throw new HttpError(409, "already_planned", "That task is already on that day.");
  }
  await assertFree(deps, actor.orgId, r.userId, day, r.id, b.start, b.minutes);
  await deps.db.update(dayPlanItems).set({ day, startMin: b.start, minutes: b.minutes, ...(patch.position !== undefined && Number.isFinite(patch.position) ? { position: patch.position } : {}), updatedAt: deps.now() }).where(eq(dayPlanItems.id, r.id));
  return (await present(deps, actor.orgId, [(await ownRow(deps, actor, r.id))]))[0] ?? null;
}

export async function removePlanItem(deps: Deps, actor: SuiteActor, id: string) {
  const r = await ownRow(deps, actor, id);
  await deps.db.delete(dayPlanItems).where(eq(dayPlanItems.id, r.id));
  return { removed: r.id, item: { id: r.id, taskId: r.taskId, day: r.day, start: r.startMin, minutes: r.minutes } };
}

/** Moves the day's unfinished items to the next day. Returns what moved so the app can undo it exactly. */
export async function planNextDay(deps: Deps, actor: SuiteActor, day: string) {
  const userId = memberOf(actor);
  checkDay(day);
  const next = addDays(day, 1);
  const [todayRows, nextRows] = await Promise.all([dayRows(deps, actor.orgId, userId, day), dayRows(deps, actor.orgId, userId, next)]);
  const ids = [...new Set([...todayRows, ...nextRows].map((r) => r.taskId))];
  const st = ids.length ? await deps.db.select({ id: tasks.id, status: tasks.status, deletedAt: tasks.deletedAt }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), inIds(tasks.id, ids))) : [];
  const done = new Set(st.filter((t) => t.status === "done" || t.deletedAt).map((t) => t.id));
  const plan = planTomorrow(todayRows.map((r) => ({ id: r.id, taskId: r.taskId, start: r.startMin, minutes: r.minutes, done: done.has(r.taskId) })),
    nextRows.map((r) => ({ id: r.id, taskId: r.taskId, start: r.startMin, minutes: r.minutes, done: false })));
  const byId = new Map(todayRows.map((r) => [r.id, r]));
  const undo = [...plan.moves.map((m) => m.id), ...plan.drops].map((id) => { const r = byId.get(id)!; return { id, taskId: r.taskId, day, start: r.startMin, minutes: r.minutes }; });
  const now = deps.now();
  let pos = nextRows.length;
  for (const m of plan.moves) await deps.db.update(dayPlanItems).set({ day: next, startMin: m.start, position: pos++, updatedAt: now }).where(eq(dayPlanItems.id, m.id));
  if (plan.drops.length) await deps.db.delete(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), inIds(dayPlanItems.id, plan.drops)));
  return { day, next, moved: plan.moves.length, kept: plan.moves.filter((m) => m.start !== null).length, merged: plan.drops.length, undo };
}

/** Undo for Plan tomorrow and Remove: puts items back on their day and time (recreating removed ones). */
export async function restorePlan(deps: Deps, actor: SuiteActor, items: { id: string; taskId: string; day: string; start: number | null; minutes: number }[]) {
  const userId = memberOf(actor);
  const now = deps.now();
  let restored = 0;
  for (const it of items.slice(0, 100)) {
    checkDay(it.day);
    const b = blockOf(it.start, it.minutes);
    const row = await deps.db.select().from(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), eq(dayPlanItems.id, it.id))).get();
    if (row && row.userId !== userId) continue;
    const taskId = await resolveTaskId(deps, actor.orgId, it.taskId).catch(() => null);
    if (!taskId) continue;
    if (row) await deps.db.update(dayPlanItems).set({ day: it.day, startMin: b.start, minutes: b.minutes, updatedAt: now }).where(eq(dayPlanItems.id, row.id));
    else {
      const dup = await deps.db.select({ id: dayPlanItems.id }).from(dayPlanItems).where(and(eq(dayPlanItems.orgId, actor.orgId), eq(dayPlanItems.userId, userId), eq(dayPlanItems.day, it.day), eq(dayPlanItems.taskId, taskId))).get();
      if (dup) continue;
      await deps.db.insert(dayPlanItems).values({ id: it.id.startsWith("day") ? it.id : sortableId("day", now.getTime()), orgId: actor.orgId, userId, taskId, day: it.day, startMin: b.start, minutes: b.minutes, position: 0, createdAt: now, updatedAt: now });
    }
    restored++;
  }
  return { restored };
}

// ---------------------------------------------------------------- timesheets

type SheetRow = typeof timesheets.$inferSelect;

async function sheetRow(deps: Deps, orgId: string, personId: string, week: string) {
  return deps.db.select().from(timesheets).where(and(eq(timesheets.orgId, orgId), eq(timesheets.personId, personId), eq(timesheets.weekStart, week))).get();
}

async function presentSheet(deps: Deps, _orgId: string, personId: string, week: string, row: SheetRow | undefined) {
  const ids = [personId, ...(row?.decidedBy ? [row.decidedBy] : [])];
  const us = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, ids));
  const name = (id: string) => { const u = us.find((x) => x.id === id); return u ? (u.name || u.email) : "Former member"; };
  return { week, person: { id: personId, name: name(personId) }, status: (row?.status ?? "open") as SheetStatus, note: row?.note ?? "",
    submittedAt: row?.submittedAt?.toISOString() ?? null, decidedAt: row?.decidedAt?.toISOString() ?? null, decidedBy: row?.decidedBy ? name(row.decidedBy) : null, version: row?.version ?? 0 };
}

function checkWeek(week: unknown) {
  if (!isYmd(week)) throw new HttpError(422, "validation_failed", "week must be YYYY-MM-DD.");
  return weekStartOf(week);
}

function personArg(actor: SuiteActor, person: string | undefined) {
  if (!person || person === "me") return memberOf(actor);
  const [type, id] = person.includes(":") ? person.split(":") : ["member", person];
  if (type !== "member" || !id) throw new HttpError(422, "validation_failed", "person looks like member:<userId>.");
  return id;
}

export async function getSheet(deps: Deps, actor: SuiteActor, week: string, person?: string) {
  if (actor.agentId) throw new HttpError(403, "members_only", "Timesheets belong to signed in members.");
  const w = checkWeek(week);
  const pid = personArg(actor, person);
  return presentSheet(deps, actor.orgId, pid, w, await sheetRow(deps, actor.orgId, pid, w));
}

/** Submit or take back your own week; approve or return anyone's (admins). */
export async function stepSheet(deps: Deps, actor: SuiteActor, action: SheetAction, input: { week: string; person?: string; note?: string; version?: number }) {
  if (actor.agentId) throw new HttpError(403, "members_only", "Timesheets belong to signed in members.");
  const w = checkWeek(input.week);
  const pid = action === "submit" || action === "withdraw" ? memberOf(actor) : personArg(actor, input.person);
  const row = await sheetRow(deps, actor.orgId, pid, w);
  if (input.version !== undefined && row && input.version !== row.version) throw new HttpError(409, "version_conflict", "This week changed in another tab. Refresh and try again.");
  const step = sheetStep((row?.status ?? "open") as SheetStatus, action, { self: pid === actor.userId, admin: isAdmin(actor) });
  if (!step.ok) throw new HttpError(step.status, step.code, step.message);
  const now = deps.now();
  const set = {
    status: step.status, updatedAt: now,
    ...(action === "submit" ? { submittedAt: now, note: (input.note ?? "").slice(0, 500), decidedBy: null, decidedAt: null } : {}),
    ...(action === "withdraw" ? { submittedAt: null } : {}),
    ...(action === "approve" || action === "return" ? { decidedBy: actor.userId!, decidedAt: now, note: (input.note ?? (action === "approve" ? row?.note : "") ?? "").slice(0, 500) } : {}),
  };
  if (row) await deps.db.update(timesheets).set({ ...set, version: row.version + 1 }).where(eq(timesheets.id, row.id));
  else await deps.db.insert(timesheets).values({ id: sortableId("tsh", now.getTime()), orgId: actor.orgId, personId: pid, weekStart: w, createdAt: now, version: 1, note: "", ...set });
  return presentSheet(deps, actor.orgId, pid, w, await sheetRow(deps, actor.orgId, pid, w));
}

/** Weeks waiting on an admin (newest first), or every week of one status. */
export async function listSheets(deps: Deps, actor: SuiteActor, status: SheetStatus = "submitted") {
  if (!isAdmin(actor)) throw new HttpError(403, "admin_only", "Only an admin can see the weeks waiting for approval.");
  const rows = await deps.db.select().from(timesheets).where(and(eq(timesheets.orgId, actor.orgId), eq(timesheets.status, status), gte(timesheets.weekStart, "2000-01-01")))
    .orderBy(desc(timesheets.weekStart)).limit(50);
  const out = [];
  for (const r of rows) out.push(await presentSheet(deps, actor.orgId, r.personId, r.weekStart, r));
  return out;
}

/**
 * The lock: a member can't add, change or delete their own time in a week they submitted or that was approved.
 * Admins can (to fix a mistake before approving). Only with the flag on.
 */
export async function assertWeekOpen(deps: Deps, actor: SuiteActor, person: { type: "member" | "agent"; id: string }, at: Date) {
  if (!tasksPlusOn(deps) || person.type !== "member" || isAdmin(actor)) return;
  const week = weekStartOf(ymdIn(at, await orgZone(deps, actor.orgId)));
  const row = await sheetRow(deps, actor.orgId, person.id, week);
  if (row && SHEET_LOCKED.includes(row.status as SheetStatus)) {
    throw new HttpError(409, "timesheet_locked", row.status === "approved"
      ? "That week's timesheet is approved, so its time is locked. Ask an admin to return it."
      : "You submitted that week's timesheet. Take it back to change its time.", { week, status: row.status });
  }
}

// ---------------------------------------------------------------- CSV

export function entriesCsv(entries: { startedAt: string; endedAt: string | null; seconds: number; person: { name: string }; project: { name: string } | null; task: { ref: string; title: string } | null; note: string; billable: boolean; tags?: string[] }[], tz: string) {
  const zone = validTimeZone(tz) ? tz : "UTC";
  const time = (s: string | null) => s ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s)) : "";
  const lines = [csvRow(["Date", "Person", "Project", "Task", "Note", "Tags", "Billable", "Start", "End", "Hours"])];
  for (const e of entries) {
    lines.push(csvRow([ymdIn(new Date(e.startedAt), zone), e.person.name, e.project?.name ?? "", e.task ? `${e.task.ref} ${e.task.title}` : "", e.note, (e.tags ?? []).join("; "),
      e.billable ? "yes" : "no", time(e.startedAt), time(e.endedAt), (e.seconds / 3600).toFixed(2)]));
  }
  return lines.join("\r\n") + "\r\n";
}
