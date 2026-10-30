/**
 * R24.3 Dashboards: a named set of widgets, private to its owner or shared with the workspace. The
 * widgets live in the dashboard row's layout JSON, so saving a dashboard (any number of widget
 * changes) is one row write. Widget data is computed on read with grouped SQL, a few queries per
 * widget sent together, so viewing a dashboard writes nothing.
 *
 * Who sees what: the same as the list views. Tasks are read the way GET /tasks reads them (the
 * workspace's tasks, top level, not in Triage, not deleted); mail widgets read only the mailboxes the
 * viewer may read (an agent key its own mailboxes). Guests have no session here, so they are refused.
 * A private dashboard is seen only by its owner; another workspace's ids answer not found.
 */
import { and, asc, eq, gte, isNull, like, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { dashboards, mailboxes, messages, projects, projectStatuses, savedViews, sprints, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, sortableId, type SuiteActor } from "./common";
import { assignees } from "./tasks";
import { topLevelCondition } from "./task-types";
import { burndownFor, sprintZone } from "./sprints";
import { goalTree } from "./goals";
import { getWorkload } from "./workload";
import { replyStats } from "../mail/thread-state";
import { dateFormat } from "../../lib/intl-cache";
import { inIds } from "../../lib/sql-chunks";
import { R38_WIDGET_TYPES, R38WidgetFields, r38DefaultTitle, r38Settings, type R38WidgetSettings, type R38WidgetType } from "./dashboards-r38-schema";
import { battery, calculation, createdCompleted, note, pivot, taskList, timeTracked } from "./dashboards-r38-widgets";

const DAY = 86_400_000;
export const MAX_WIDGETS = 24;
export const MAX_DASHBOARDS = 50;
/** Groups a breakdown returns at most, biggest first; the rest are added up in "Other". */
export const GROUP_CAP = 20;
/** Tasks a list widget shows at most. */
export const LIST_CAP = 10;

export const WIDGET_TYPES = ["count", "breakdown", "due", "completed", "burndown", "goals", "reply_times", "mail_volume", "workload", ...R38_WIDGET_TYPES] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const GROUP_BYS = ["status", "assignee", "priority", "project", "sprint", "type", "label"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const CHARTS = ["number", "bar", "donut", "line", "table"] as const;

const idStr = z.string().min(1).max(64);
export const WidgetFilters = z.object({
  assignee: z.string().max(80).optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  label: z.string().max(80).optional(),
  type: z.enum(["task", "story", "bug", "epic"]).optional(),
  q: z.string().max(200).optional(),
  due: z.enum(["overdue", "week", "none"]).optional(),
}).strict();
export type WidgetFilters = z.infer<typeof WidgetFilters>;

export const WidgetSource = z.object({
  savedViewId: idStr.optional(),
  projectId: idStr.optional(),
  filters: WidgetFilters.optional(),
  mailboxId: idStr.optional(),
}).strict();

export const WidgetInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  type: z.enum(WIDGET_TYPES),
  title: z.string().trim().max(80).optional(),
  source: WidgetSource.default({}),
  groupBy: z.enum([...GROUP_BYS, "mailbox", "person"]).nullable().optional(),
  chart: z.enum(CHARTS).optional(),
  size: z.union([z.literal(1), z.literal(2)]).optional(),
  // R38: range, metric, op, goal, columnBy, sort and text, each kept only on the types that use it.
  ...R38WidgetFields,
});
export type WidgetInput = z.input<typeof WidgetInput>;
export interface Widget extends R38WidgetSettings {
  id: string; type: WidgetType; title: string; source: z.infer<typeof WidgetSource>;
  groupBy: GroupBy | "mailbox" | "person" | null; chart: (typeof CHARTS)[number]; size: 1 | 2; position: number;
}

export const DEFAULT_CHART: Record<WidgetType, Widget["chart"]> = {
  count: "number", breakdown: "bar", due: "table", completed: "line", burndown: "line", goals: "table", reply_times: "table", mail_volume: "line", workload: "bar",
  calculation: "number", battery: "bar", pivot: "table", created_completed: "bar", task_list: "table", time_tracked: "bar", note: "table",
};
const GROUP_LABEL: Record<GroupBy, string> = { status: "status", assignee: "person", priority: "priority", project: "project", sprint: "sprint", type: "type", label: "label" };
function defaultTitle(w: { type: WidgetType; groupBy?: string | null } & R38WidgetSettings) {
  if ((R38_WIDGET_TYPES as readonly string[]).includes(w.type)) return r38DefaultTitle(w.type as R38WidgetType, w);
  switch (w.type) {
    case "count": return "Tasks";
    case "breakdown": return `Tasks by ${GROUP_LABEL[(w.groupBy as GroupBy) ?? "status"] ?? "status"}`;
    case "due": return "Due this week and overdue";
    case "completed": return "Completed per week";
    case "burndown": return "Sprint burndown";
    case "goals": return "Goal progress";
    case "reply_times": return "Reply times";
    case "mail_volume": return "Mail per day";
    case "workload": return "Workload per person";
    default: return "Widget";
  }
}

// ---------------------------------------------------------------- dashboards (CRUD)

type Row = typeof dashboards.$inferSelect;
const parseLayout = (s: string): Widget[] => { try { const l = JSON.parse(s) as { widgets?: Widget[] }; return Array.isArray(l.widgets) ? l.widgets : []; } catch { return []; } };

function present(r: Row, actor: SuiteActor) {
  const widgets = parseLayout(r.layout).sort((a, b) => a.position - b.position);
  return {
    id: r.id, name: r.name, shared: r.shared, owner: r.ownerUserId, mine: !!personOf(actor) && r.ownerUserId === personOf(actor),
    widgets, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version,
  };
}
export type Dashboard = ReturnType<typeof present>;

const personOf = (actor: SuiteActor) => (actor.agentId ? "" : actor.userId || "");
/** A dashboard this actor may open: shared ones, and private ones they own. An agent key owns none. */
const visible = (actor: SuiteActor) => (personOf(actor) ? or(eq(dashboards.shared, true), eq(dashboards.ownerUserId, personOf(actor))) : eq(dashboards.shared, true));

async function rowFor(deps: Deps, actor: SuiteActor, id: string) {
  const r = await deps.db.select().from(dashboards).where(and(eq(dashboards.orgId, actor.orgId), eq(dashboards.id, id), visible(actor))).get();
  if (!r) throw notFound("Dashboard");
  return r;
}

export async function listDashboards(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select().from(dashboards).where(and(eq(dashboards.orgId, actor.orgId), visible(actor))).orderBy(asc(dashboards.createdAt)).limit(MAX_DASHBOARDS);
  return rows.map((r) => {
    const p = present(r, actor);
    return { id: p.id, name: p.name, shared: p.shared, mine: p.mine, widgetCount: p.widgets.length, updatedAt: p.updatedAt };
  });
}

export async function getDashboard(deps: Deps, actor: SuiteActor, id: string) {
  return present(await rowFor(deps, actor, id), actor);
}

/** Checks every widget's saved filter, project and mailbox belong to this workspace and this viewer. */
async function normalise(deps: Deps, actor: SuiteActor, input: WidgetInput[], keep: Widget[] = []): Promise<Widget[]> {
  if (input.length > MAX_WIDGETS) throw new HttpError(422, "too_many_widgets", `A dashboard holds up to ${MAX_WIDGETS} widgets.`);
  const parsed = input.map((w) => {
    const r = WidgetInput.safeParse(w);
    if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the widget.", r.error.issues);
    return r.data;
  });
  const viewIds = [...new Set(parsed.map((w) => w.source.savedViewId).filter(Boolean))] as string[];
  const projectIds = [...new Set(parsed.map((w) => w.source.projectId).filter(Boolean))] as string[];
  const boxIds = [...new Set(parsed.map((w) => w.source.mailboxId).filter(Boolean))] as string[];
  const [vs, ps] = await Promise.all([
    viewIds.length ? deps.db.select({ id: savedViews.id }).from(savedViews).where(and(eq(savedViews.orgId, actor.orgId), inIds(savedViews.id, viewIds), isNull(savedViews.deletedAt),
      personOf(actor) ? or(isNull(savedViews.userId), eq(savedViews.userId, personOf(actor))) : isNull(savedViews.userId))) : [],
    projectIds.length ? deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, actor.orgId), inIds(projects.id, projectIds), isNull(projects.deletedAt))) : [],
  ]);
  if (vs.length !== viewIds.length) throw notFound("Saved view");
  if (ps.length !== projectIds.length) throw notFound("Project");
  if (boxIds.length) {
    const allowed = await readableMailboxes(deps, actor);
    if (boxIds.some((b) => !allowed.includes(b))) throw notFound("Mailbox");
  }
  const old = new Map(keep.map((w) => [w.id, w]));
  const used = new Set<string>();
  return parsed.map((w, i) => {
    if (w.type === "burndown" && !w.source.projectId && !w.source.savedViewId) throw new HttpError(422, "validation_failed", "A burndown needs a project: pick one for its active sprint.");
    let id = w.id && !used.has(w.id) ? w.id : sortableId("wdg", deps.now().getTime() + i).slice(0, 40);
    while (used.has(id)) id = `${id.slice(0, 36)}${i}`;
    used.add(id);
    const extra = r38Settings(w.type, w);
    const groupBy = w.type === "breakdown" ? (GROUP_BYS.includes(w.groupBy as GroupBy) ? (w.groupBy as GroupBy) : "status")
      : w.type === "reply_times" ? (w.groupBy === "person" ? "person" : "mailbox") : w.type === "pivot" ? extra.groupBy! : null;
    delete extra.groupBy;
    const prev = old.get(id);
    const wide = ["completed", "workload", "pivot", "created_completed", "time_tracked"].includes(w.type);
    return {
      id, type: w.type, title: w.title || prev?.title || defaultTitle({ type: w.type, groupBy, ...extra }), source: w.source, groupBy,
      chart: w.chart ?? DEFAULT_CHART[w.type], size: w.size ?? (wide ? 2 : 1), position: i, ...extra,
    };
  });
}

export const STARTER: Record<"team", { name: string; widgets: WidgetInput[] }> = {
  team: {
    name: "Team overview",
    widgets: [
      { type: "breakdown", groupBy: "status", chart: "donut", title: "Tasks by status" },
      { type: "breakdown", groupBy: "assignee", chart: "bar", title: "Open tasks by person" },
      { type: "due", chart: "table", title: "Due this week and overdue" },
      { type: "completed", chart: "line", title: "Completed per week", size: 2 },
    ],
  },
};

export async function createDashboard(deps: Deps, actor: SuiteActor, input: { name?: string; shared?: boolean; widgets?: WidgetInput[]; starter?: "team" }, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  // R53 (MB-239): a retry under the same Idempotency-Key returns the dashboard the first attempt made (one read, only on a retry).
  if (opts.id && opts.retry && await deps.db.select({ id: dashboards.id }).from(dashboards).where(and(eq(dashboards.orgId, actor.orgId), eq(dashboards.id, opts.id))).get()) return getDashboard(deps, actor, opts.id);
  const starter = input.starter ? STARTER[input.starter] : undefined;
  const name = (input.name ?? starter?.name ?? "").trim();
  if (!name || name.length > 80) throw new HttpError(422, "validation_failed", "Give the dashboard a name of up to 80 characters.");
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(dashboards).where(eq(dashboards.orgId, actor.orgId)).get();
  if (Number(n?.n ?? 0) >= MAX_DASHBOARDS) throw new HttpError(422, "too_many_dashboards", `A workspace holds up to ${MAX_DASHBOARDS} dashboards. Remove one first.`);
  const widgets = await normalise(deps, actor, input.widgets ?? starter?.widgets ?? []);
  const now = deps.now();
  const id = opts.id ?? sortableId("dsh", now.getTime());
  // A dashboard made by an agent key (no person behind it) is shared, or nobody could open it.
  const shared = input.shared ?? !!starter;
  await deps.db.insert(dashboards).values({
    id, orgId: actor.orgId, name, ownerUserId: personOf(actor) || null, shared: shared || !personOf(actor),
    layout: JSON.stringify({ widgets }), ...createdBy(actor), createdAt: now, updatedAt: now, version: 1,
  });
  return getDashboard(deps, actor, id);
}

function assertCanChange(r: Row, actor: SuiteActor, what: "edit" | "share" | "delete") {
  const owner = !!personOf(actor) && r.ownerUserId === personOf(actor);
  const admin = actor.role === "owner" || actor.role === "admin";
  if (owner) return;
  if (what === "edit" && r.shared) return;
  if (admin && r.shared) return;
  throw new HttpError(403, "forbidden", what === "edit" ? "Only the owner can change this dashboard." : "Only the owner or a workspace admin can do that.");
}

/** Saves a name, the share flag and the whole widget list in one row write. */
export async function updateDashboard(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; shared?: boolean; widgets?: WidgetInput[]; version?: number }) {
  assertWritable(actor);
  const r = await rowFor(deps, actor, id);
  assertCanChange(r, actor, patch.shared !== undefined && patch.shared !== r.shared ? "share" : "edit");
  if (patch.version !== undefined && patch.version !== r.version) throw new HttpError(409, "version_conflict", "Someone changed this dashboard. Reload to see their changes.");
  const set: Partial<typeof dashboards.$inferInsert> = { updatedAt: deps.now(), version: r.version + 1 };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 80) throw new HttpError(422, "validation_failed", "Give the dashboard a name of up to 80 characters.");
    set.name = name;
  }
  if (patch.shared !== undefined) {
    if (!patch.shared && !r.ownerUserId) throw new HttpError(422, "validation_failed", "This dashboard has no owner, so it stays shared.");
    set.shared = patch.shared;
  }
  if (patch.widgets) set.layout = JSON.stringify({ widgets: await normalise(deps, actor, patch.widgets, parseLayout(r.layout)) });
  await deps.db.update(dashboards).set(set).where(and(eq(dashboards.id, id), eq(dashboards.orgId, actor.orgId)));
  return getDashboard(deps, actor, id);
}

export async function addWidget(deps: Deps, actor: SuiteActor, id: string, widget: WidgetInput, opts: { id?: string; retry?: boolean } = {}) {
  const d = await getDashboard(deps, actor, id);
  // R54 (MB-239): a retry under the same Idempotency-Key whose first attempt saved the widget gets the dashboard back
  // as it is, with no second widget. The dashboard is read here anyway, so the check costs nothing.
  if (opts.id && opts.retry && d.widgets.some((w) => w.id === opts.id)) return d;
  if (d.widgets.length >= MAX_WIDGETS) throw new HttpError(422, "too_many_widgets", `A dashboard holds up to ${MAX_WIDGETS} widgets.`);
  return updateDashboard(deps, actor, id, { widgets: [...d.widgets, { ...widget, id: opts.id }] });
}

export async function deleteDashboard(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const r = await rowFor(deps, actor, id);
  assertCanChange(r, actor, "delete");
  await deps.db.delete(dashboards).where(and(eq(dashboards.id, id), eq(dashboards.orgId, actor.orgId)));
  return { ok: true };
}

// ---------------------------------------------------------------- widget data (computed on read)

async function readableMailboxes(deps: Deps, actor: SuiteActor): Promise<string[]> {
  const { scopeOf } = await import("./common");
  const scope = await scopeOf(deps, actor);
  if (scope) return scope;
  return (await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.orgId, actor.orgId))).map((m) => m.id);
}

export interface Ctx {
  deps: Deps; actor: SuiteActor; tz: string; now: number;
  weekStart: number; weekEnd: number; todayStart: number;
  views: Map<string, { projectId: string | null; filters: Record<string, string> }>;
  projects: Map<string, { name: string; key: string; color: string }>;
  people: Promise<Map<string, string>>;
}

function zoneOffset(t: number, tz: string) {
  const p = Object.fromEntries(dateFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
}
/** Local midnight of the calendar day holding t (or `days` later), in the zone. */
export function midnight(t: number, tz: string, days = 0) {
  const local = t + zoneOffset(t, tz);
  const day = Math.floor(local / DAY) * DAY + days * DAY;
  let u = day - zoneOffset(day, tz);
  u = day - zoneOffset(u, tz);
  return u;
}
function mondayStart(t: number, tz: string) {
  const local = new Date(t + zoneOffset(t, tz));
  const dow = (local.getUTCDay() + 6) % 7;
  return midnight(t, tz, -dow);
}
export const dayKey = (t: number, tz: string) => new Date(t + zoneOffset(t, tz)).toISOString().slice(0, 10);

/** The task conditions for a widget: the list views' rules, then the saved filter, project and inline filters. */
export function taskConds(c: Ctx, w: Widget): SQL[] {
  const view = w.source.savedViewId ? c.views.get(w.source.savedViewId) : undefined;
  if (w.source.savedViewId && !view) throw new HttpError(404, "not_found", "This widget's saved filter was removed.");
  const projectId = w.source.projectId ?? view?.projectId ?? undefined;
  const f: Record<string, string | undefined> = { ...(view?.filters ?? {}), ...(w.source.filters ?? {}) };
  const conds: (SQL | undefined)[] = [eq(tasks.orgId, c.actor.orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), topLevelCondition()];
  if (projectId) conds.push(eq(tasks.projectId, projectId));
  if (f.status === "todo" || f.status === "doing" || f.status === "done") conds.push(eq(tasks.status, f.status));
  if (f.priority) conds.push(eq(tasks.priority, f.priority as never));
  if (f.type) conds.push(eq(tasks.type, f.type as never));
  if (f.assignee) {
    if (f.assignee === "none") conds.push(isNull(tasks.assigneeId));
    else {
      const [type, id] = f.assignee === "me" ? (c.actor.agentId ? ["agent", c.actor.agentId] : ["member", c.actor.userId]) : f.assignee.split(":");
      conds.push(and(eq(tasks.assigneeType, type as "member" | "agent"), eq(tasks.assigneeId, id ?? "")));
    }
  }
  if (f.label) conds.push(like(tasks.labels, `%${JSON.stringify(f.label).slice(1, -1)}%`));
  if (f.q) conds.push(or(like(tasks.title, `%${f.q}%`), like(tasks.notes, `%${f.q}%`)));
  if (f.due === "overdue") conds.push(sql`${tasks.dueAt} < ${c.todayStart}`, ne(tasks.status, "done"));
  else if (f.due === "week") conds.push(sql`${tasks.dueAt} >= ${c.weekStart} and ${tasks.dueAt} < ${c.weekEnd}`);
  else if (f.due === "none") conds.push(isNull(tasks.dueAt));
  return conds.filter(Boolean) as SQL[];
}
const hasStatusFilter = (c: Ctx, w: Widget) => !!(w.source.filters?.status || (w.source.savedViewId && c.views.get(w.source.savedViewId)?.filters.status));

type Group = { key: string; label: string; color?: string; count: number };
function capGroups(groups: Group[]) {
  const sorted = groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (sorted.length <= GROUP_CAP) return sorted;
  const rest = sorted.slice(GROUP_CAP - 1);
  return [...sorted.slice(0, GROUP_CAP - 1), { key: "other", label: "Other", count: rest.reduce((s, g) => s + g.count, 0) }];
}

const PRIORITY_NAME: Record<string, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
const TYPE_NAME: Record<string, string> = { task: "Task", story: "Story", bug: "Bug", epic: "Epic" };

async function breakdown(c: Ctx, w: Widget) {
  const by = (w.groupBy ?? "status") as GroupBy;
  const conds = taskConds(c, w);
  // Grouping by person shows open work unless the widget filters a status itself.
  if (by === "assignee" && !hasStatusFilter(c, w)) conds.push(ne(tasks.status, "done"));
  const where = and(...conds);
  const db = c.deps.db;
  let groups: Group[] = [];
  if (by === "status") {
    const rows = await db.select({ id: tasks.statusId, cat: tasks.status, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.statusId, tasks.status).limit(500);
    const ids = [...new Set(rows.map((r) => r.id))];
    const sts = ids.length ? await db.select({ id: projectStatuses.id, name: projectStatuses.name, color: projectStatuses.color }).from(projectStatuses).where(inIds(projectStatuses.id, ids)) : [];
    const sm = new Map(sts.map((s) => [s.id, s]));
    const merged = new Map<string, Group>();
    for (const r of rows) {
      const s = sm.get(r.id);
      const name = s?.name ?? r.cat;
      const g = merged.get(name) ?? { key: name, label: name, color: s?.color ?? "#8E8E93", count: 0 };
      g.count += Number(r.n);
      merged.set(name, g);
    }
    groups = [...merged.values()];
  } else if (by === "assignee") {
    const rows = await db.select({ type: tasks.assigneeType, id: tasks.assigneeId, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.assigneeType, tasks.assigneeId).limit(500);
    const names = await c.people;
    groups = rows.map((r) => {
      const key = r.type && r.id ? `${r.type}:${r.id}` : "none";
      return { key, label: key === "none" ? "Unassigned" : names.get(key) ?? (r.type === "agent" ? "Removed agent" : "Former member"), count: Number(r.n) };
    });
  } else if (by === "priority") {
    const rows = await db.select({ k: tasks.priority, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.priority);
    groups = rows.map((r) => ({ key: r.k, label: PRIORITY_NAME[r.k] ?? r.k, count: Number(r.n) }));
  } else if (by === "type") {
    const rows = await db.select({ k: tasks.type, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.type);
    groups = rows.map((r) => ({ key: r.k ?? "task", label: TYPE_NAME[r.k ?? "task"] ?? String(r.k), count: Number(r.n) }));
  } else if (by === "project") {
    const rows = await db.select({ k: tasks.projectId, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.projectId).limit(500);
    groups = rows.map((r) => ({ key: r.k, label: c.projects.get(r.k)?.name ?? "Deleted project", color: c.projects.get(r.k)?.color, count: Number(r.n) }));
  } else if (by === "sprint") {
    const rows = await db.select({ k: tasks.sprintId, n: sql<number>`count(*)` }).from(tasks).where(where).groupBy(tasks.sprintId).limit(500);
    const ids = rows.map((r) => r.k).filter(Boolean) as string[];
    const ss = ids.length ? await db.select({ id: sprints.id, name: sprints.name }).from(sprints).where(and(eq(sprints.orgId, c.actor.orgId), inIds(sprints.id, ids))) : [];
    const sm = new Map(ss.map((s) => [s.id, s.name]));
    groups = rows.map((r) => ({ key: r.k ?? "none", label: r.k ? sm.get(r.k) ?? "Removed sprint" : "Backlog", count: Number(r.n) }));
  } else if (by === "label") {
    const rows = await db.all<{ k: string; n: number }>(sql`select j.value as k, count(*) as n from ${tasks}, json_each(${tasks.labels}) j where ${where} group by j.value order by n desc limit 200`);
    const none = await db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(where, sql`(${tasks.labels} = '[]' or ${tasks.labels} = '')`)).get();
    groups = rows.map((r) => ({ key: String(r.k), label: String(r.k), count: Number(r.n) }));
    if (Number(none?.n ?? 0)) groups.push({ key: "none", label: "No label", count: Number(none?.n ?? 0) });
  }
  const total = groups.reduce((s, g) => s + g.count, 0);
  return { total, groups: capGroups(groups) };
}

async function count(c: Ctx, w: Widget) {
  const conds = taskConds(c, w);
  const r = await c.deps.db.select({ n: sql<number>`count(*)`, open: sql<number>`sum(case when ${tasks.status} != 'done' then 1 else 0 end)` }).from(tasks).where(and(...conds)).get();
  return { value: Number(r?.n ?? 0), open: Number(r?.open ?? 0) };
}

async function due(c: Ctx, w: Widget) {
  const conds = [...taskConds(c, w), ne(tasks.status, "done"), lt(tasks.dueAt, new Date(c.weekEnd))];
  const where = and(...conds);
  const [agg, rows] = await Promise.all([
    c.deps.db.select({
      overdue: sql<number>`sum(case when ${tasks.dueAt} < ${c.todayStart} then 1 else 0 end)`,
      week: sql<number>`sum(case when ${tasks.dueAt} >= ${c.todayStart} then 1 else 0 end)`,
    }).from(tasks).where(where).get(),
    c.deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, dueAt: tasks.dueAt, type: tasks.assigneeType, aid: tasks.assigneeId, priority: tasks.priority })
      .from(tasks).where(where).orderBy(asc(tasks.dueAt), asc(tasks.id)).limit(LIST_CAP),
  ]);
  const names = await c.people;
  return {
    overdue: Number(agg?.overdue ?? 0), dueThisWeek: Number(agg?.week ?? 0),
    tasks: rows.map((t) => ({
      id: t.id, ref: `${c.projects.get(t.projectId)?.key ?? "TSK"}-${t.number}`, title: t.title, due: t.dueAt ? t.dueAt.toISOString() : null,
      overdue: !!t.dueAt && t.dueAt.getTime() < c.todayStart, priority: t.priority,
      assignee: t.type && t.aid ? names.get(`${t.type}:${t.aid}`) ?? null : null,
    })),
  };
}

async function completed(c: Ctx, w: Widget) {
  const weeks = Array.from({ length: 8 }, (_, i) => midnight(c.weekStart, c.tz, -7 * (7 - i)));
  const end = c.weekEnd;
  const bucket = sql.join(weeks.slice(1).map((s, i) => sql`when ${tasks.completedAt} < ${s} then ${i}`), sql` `);
  const rows = await c.deps.db.select({ b: sql<number>`case ${bucket} else 7 end`, n: sql<number>`count(*)` }).from(tasks)
    .where(and(...taskConds(c, w), eq(tasks.status, "done"), gte(tasks.completedAt, new Date(weeks[0])), lt(tasks.completedAt, new Date(end)))).groupBy(sql`1`);
  const m = new Map(rows.map((r) => [Number(r.b), Number(r.n)]));
  return { weeks: weeks.map((s, i) => ({ week: dayKey(s, c.tz), count: m.get(i) ?? 0 })), total: rows.reduce((s, r) => s + Number(r.n), 0) };
}

async function burndown(c: Ctx, w: Widget) {
  const view = w.source.savedViewId ? c.views.get(w.source.savedViewId) : undefined;
  const projectId = w.source.projectId ?? view?.projectId;
  if (!projectId) return { sprint: null, burndown: null };
  const s = await c.deps.db.select().from(sprints).where(and(eq(sprints.orgId, c.actor.orgId), eq(sprints.projectId, projectId), eq(sprints.status, "active"), isNull(sprints.deletedAt))).get();
  if (!s) return { sprint: null, burndown: null };
  const b = await burndownFor(c.deps, c.actor, s, { timeZone: c.tz });
  return { sprint: { id: s.id, name: s.name, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString() }, burndown: b };
}

async function goalsData(c: Ctx) {
  const t = await goalTree(c.deps, c.actor.orgId);
  return {
    progress: t.summary.progress, health: t.summary.health,
    goals: t.goals.slice(0, LIST_CAP).map((g) => ({ id: g.id, name: g.name, progress: g.progress, health: g.health ?? g.suggestedHealth, due: g.due })),
    more: Math.max(0, t.goals.length - LIST_CAP),
  };
}

async function replyTimes(c: Ctx, w: Widget) {
  const r = await replyStats(c.deps, c.actor, { groupBy: w.groupBy === "person" ? "person" : "mailbox", mailboxId: w.source.mailboxId, from: new Date(c.now - 30 * DAY), to: new Date(c.now) });
  return { from: r.from, to: r.to, total: r.total, rows: r.rows.slice(0, GROUP_CAP) };
}

async function mailVolume(c: Ctx, w: Widget) {
  const days = 14;
  const from = midnight(c.now, c.tz, -(days - 1));
  const boxes = w.source.mailboxId ? [w.source.mailboxId] : await readableMailboxes(c.deps, c.actor);
  const keys = Array.from({ length: days }, (_, i) => dayKey(midnight(c.now, c.tz, -(days - 1) + i), c.tz));
  if (!boxes.length) return { days: keys.map((day) => ({ day, received: 0, sent: 0 })), received: 0, sent: 0 };
  const off = zoneOffset(c.now, c.tz);
  // The mailbox, folder and date index serves this; one grouped query for the whole range.
  const rows = await c.deps.db.select({
    day: sql<string>`strftime('%Y-%m-%d', (${messages.date} + ${off}) / 1000, 'unixepoch')`,
    sent: sql<number>`sum(case when ${messages.folder} = 'sent' then 1 else 0 end)`,
    received: sql<number>`sum(case when ${messages.folder} in ('inbox', 'archive') then 1 else 0 end)`,
  }).from(messages).where(and(eq(messages.orgId, c.actor.orgId), inIds(messages.mailboxId, boxes.slice(0, 200)), inIds(messages.folder, ["inbox", "archive", "sent"]), gte(messages.date, new Date(from)))).groupBy(sql`1`);
  const m = new Map(rows.map((r) => [r.day, r]));
  const out = keys.map((day) => ({ day, received: Number(m.get(day)?.received ?? 0), sent: Number(m.get(day)?.sent ?? 0) }));
  return { days: out, received: out.reduce((s, d) => s + d.received, 0), sent: out.reduce((s, d) => s + d.sent, 0) };
}

async function workloadData(c: Ctx, w: Widget) {
  const view = w.source.savedViewId ? c.views.get(w.source.savedViewId) : undefined;
  const projectId = w.source.projectId ?? view?.projectId ?? undefined;
  const r = await getWorkload(c.deps, c.actor, { weeks: 4, projectIds: projectId ? [projectId] : undefined, tz: c.tz });
  return {
    unit: r.unit, capacity: r.capacity, weeks: r.range.weeks.map((x) => x.start),
    people: r.people.slice(0, GROUP_CAP).map((p) => ({ id: p.id, name: p.name, count: p.total.count, load: p.total.load, overdue: p.overdue.count, weeks: p.weeks.map((x) => x.load), over: p.total.overAnyWeek })),
    truncated: r.truncated,
  };
}

async function widgetData(c: Ctx, w: Widget): Promise<unknown> {
  switch (w.type) {
    case "count": return count(c, w);
    case "breakdown": return breakdown(c, w);
    case "due": return due(c, w);
    case "completed": return completed(c, w);
    case "burndown": return burndown(c, w);
    case "goals": return goalsData(c);
    case "reply_times": return replyTimes(c, w);
    case "mail_volume": return mailVolume(c, w);
    case "workload": return workloadData(c, w);
    case "calculation": return calculation(c, w);
    case "battery": return battery(c, w);
    case "pivot": return pivot(c, w);
    case "created_completed": return createdCompleted(c, w);
    case "task_list": return taskList(c, w);
    case "time_tracked": return timeTracked(c, w);
    case "note": return note(w);
  }
}

/**
 * Every widget's data for one dashboard in one call. The saved filters, projects and people are read
 * once and shared; the widgets run together. A widget that can't be read (its saved filter was
 * removed, a mailbox the viewer can't read) carries an error; the rest still answer. Writes nothing.
 */
export async function dashboardData(deps: Deps, actor: SuiteActor, id: string, opts: { tz?: string } = {}) {
  const d = await getDashboard(deps, actor, id);
  const tz = await sprintZone(deps, actor, opts.tz);
  const now = deps.now().getTime();
  const viewIds = [...new Set(d.widgets.map((w) => w.source.savedViewId).filter(Boolean))] as string[];
  const [vs, ps] = await Promise.all([
    viewIds.length ? deps.db.select().from(savedViews).where(and(eq(savedViews.orgId, actor.orgId), inIds(savedViews.id, viewIds), isNull(savedViews.deletedAt),
      personOf(actor) ? or(isNull(savedViews.userId), eq(savedViews.userId, personOf(actor))) : isNull(savedViews.userId))) : [],
    deps.db.select({ id: projects.id, name: projects.name, key: projects.key, color: projects.color }).from(projects).where(eq(projects.orgId, actor.orgId)),
  ]);
  const projectSet = new Set(ps.map((p) => p.id));
  let people: Promise<Map<string, string>> | undefined;
  const c: Ctx = {
    deps, actor, tz, now,
    todayStart: midnight(now, tz), weekStart: mondayStart(now, tz), weekEnd: midnight(mondayStart(now, tz), tz, 7),
    views: new Map(vs.map((v) => [v.id, { projectId: v.projectId && projectSet.has(v.projectId) ? v.projectId : null, filters: (() => { try { return JSON.parse(v.filters) as Record<string, string>; } catch { return {}; } })() }])),
    projects: new Map(ps.map((p) => [p.id, p])),
    get people() {
      people ??= assignees(deps, actor.orgId).then((rs) => new Map(rs.map((r) => [r.id, r.name || r.email || "Someone"] as [string, string])));
      return people;
    },
  };
  const widgets = await Promise.all(d.widgets.map(async (w) => {
    try {
      if (w.source.projectId && !projectSet.has(w.source.projectId)) throw notFound("Project");
      return { id: w.id, type: w.type, data: await widgetData(c, w), error: null as string | null };
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return { id: w.id, type: w.type, data: null, error: e.message };
      throw e;
    }
  }));
  return { dashboard: d, timeZone: tz, generatedAt: new Date(now).toISOString(), weekStart: dayKey(c.weekStart, tz), widgets };
}
