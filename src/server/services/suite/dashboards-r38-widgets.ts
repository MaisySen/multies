/**
 * R38 dashboard widgets, the data. Each type is one or two bounded grouped queries sent together;
 * nothing here writes. The task rules are the same as every other widget (taskConds): the list
 * views' rules, then the saved view, the project and the inline filters.
 */
import { and, asc, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { tasks, timeEntries } from "../../db/schema";
import { type Ctx, dayKey, LIST_CAP, midnight, taskConds, type Widget } from "./dashboards";
import { PIVOT_COLS, PIVOT_ROWS, RANGE_DAYS, type PivotAxis, type Range } from "./dashboards-r38-schema";

const DAY = 86_400_000;
const STATUS_NAME: Record<string, string> = { todo: "To do", doing: "In progress", done: "Done" };
const STATUS_COLOR: Record<string, string> = { todo: "#8E8E93", doing: "#0071E3", done: "#34C759" };
const PRIORITY_NAME: Record<string, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
const TYPE_NAME: Record<string, string> = { task: "Task", story: "Story", bug: "Bug", epic: "Epic" };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** The range ending at the end of today, and the same length just before it. */
function window(c: Ctx, range: Range | undefined) {
  const days = RANGE_DAYS[range ?? "30d"];
  const to = midnight(c.now, c.tz, 1);
  const from = midnight(c.now, c.tz, 1 - days);
  const prevFrom = midnight(c.now, c.tz, 1 - 2 * days);
  return { days, from, to, prevFrom };
}

/** Days for ranges up to 30 days, weeks above that. */
function buckets(c: Ctx, from: number, to: number, days: number) {
  const step = days <= 30 ? 1 : 7;
  const out: number[] = [];
  for (let i = 0; ; i += step) { const s = midnight(from, c.tz, i); if (s >= to) break; out.push(s); }
  return { unit: step === 1 ? "day" as const : "week" as const, starts: out, stepMs: step * DAY };
}

/** A tasks subquery for time entries: only entries on tasks the widget's filters keep. */
function entryConds(c: Ctx, w: Widget, from: number, to: number): SQL[] {
  const conds: SQL[] = [eq(timeEntries.orgId, c.actor.orgId), isNull(timeEntries.deletedAt), gte(timeEntries.startedAt, new Date(from)), lt(timeEntries.startedAt, new Date(to))];
  const filtered = !!(w.source.savedViewId || (w.source.filters && Object.keys(w.source.filters).length));
  if (filtered) conds.push(sql`${timeEntries.taskId} in (select ${tasks.id} from ${tasks} where ${and(...taskConds(c, w))})`);
  else if (w.source.projectId) conds.push(eq(timeEntries.projectId, w.source.projectId));
  return conds;
}

export async function calculation(c: Ctx, w: Widget) {
  const metric = w.metric ?? "done", op = w.op ?? "sum";
  const { days, from, to, prevFrom } = window(c, w.range);
  const db = c.deps.db;
  let cur = 0, prev = 0;
  if (metric === "hours") {
    const r = await db.select({
      cur: sql<number>`coalesce(sum(case when ${timeEntries.startedAt} >= ${from} then ${timeEntries.seconds} else 0 end), 0)`,
      prev: sql<number>`coalesce(sum(case when ${timeEntries.startedAt} < ${from} then ${timeEntries.seconds} else 0 end), 0)`,
    }).from(timeEntries).where(and(...entryConds(c, w, prevFrom, to))).get();
    cur = Number(r?.cur ?? 0) / 3600; prev = Number(r?.prev ?? 0) / 3600;
  } else {
    const at = metric === "created" ? tasks.createdAt : tasks.completedAt;
    const conds = [...taskConds(c, w), gte(at, new Date(prevFrom)), lt(at, new Date(to))];
    if (metric !== "created") conds.push(eq(tasks.status, "done"));
    const amount = metric === "points" ? sql`coalesce(${tasks.points}, 0)` : sql`1`;
    const r = await db.select({
      cur: sql<number>`coalesce(sum(case when ${at} >= ${from} then ${amount} else 0 end), 0)`,
      prev: sql<number>`coalesce(sum(case when ${at} < ${from} then ${amount} else 0 end), 0)`,
    }).from(tasks).where(and(...conds)).get();
    cur = Number(r?.cur ?? 0); prev = Number(r?.prev ?? 0);
  }
  if (op === "avg") { cur /= days; prev /= days; }
  const value = round(cur, metric === "hours" || op === "avg" ? 1 : 0);
  const previous = round(prev, metric === "hours" || op === "avg" ? 1 : 0);
  const goal = w.goal ?? null;
  return {
    metric, op, range: w.range ?? "30d", unit: metric === "hours" ? "hours" : metric === "points" ? "points" : "tasks",
    value, previous, change: previous ? Math.round(((value - previous) / previous) * 100) : null,
    goal, progress: goal ? Math.min(100, Math.round((value / goal) * 100)) : null,
  };
}

export async function battery(c: Ctx, w: Widget) {
  const rows = await c.deps.db.select({ k: tasks.status, n: sql<number>`count(*)` }).from(tasks).where(and(...taskConds(c, w))).groupBy(tasks.status);
  const m = new Map(rows.map((r) => [r.k, Number(r.n)]));
  const segments = (["done", "doing", "todo"] as const).map((k) => ({ key: k, label: STATUS_NAME[k], color: STATUS_COLOR[k], count: m.get(k) ?? 0 }));
  const total = segments.reduce((s, g) => s + g.count, 0);
  return { total, done: m.get("done") ?? 0, donePercent: total ? Math.round(((m.get("done") ?? 0) / total) * 100) : 0, segments };
}

function axisExpr(a: PivotAxis): SQL {
  switch (a) {
    case "status": return sql`${tasks.status}`;
    case "priority": return sql`${tasks.priority}`;
    case "project": return sql`${tasks.projectId}`;
    case "type": return sql`coalesce(${tasks.type}, 'task')`;
    case "assignee": return sql`case when ${tasks.assigneeId} is null then 'none' else ${tasks.assigneeType} || ':' || ${tasks.assigneeId} end`;
  }
}
async function axisLabels(c: Ctx, a: PivotAxis, keys: string[]) {
  const names = a === "assignee" ? await c.people : null;
  return new Map(keys.map((k) => [k,
    a === "status" ? STATUS_NAME[k] ?? k
      : a === "priority" ? PRIORITY_NAME[k] ?? k
        : a === "type" ? TYPE_NAME[k] ?? k
          : a === "project" ? c.projects.get(k)?.name ?? "Deleted project"
            : k === "none" ? "Unassigned" : names!.get(k) ?? (k.startsWith("agent:") ? "Removed agent" : "Former member")]));
}
const AXIS_ORDER: Partial<Record<PivotAxis, string[]>> = { status: ["todo", "doing", "done"], priority: ["urgent", "high", "medium", "low", "none"] };

export async function pivot(c: Ctx, w: Widget) {
  const rowsBy = (w.groupBy as PivotAxis) ?? "assignee", colsBy = w.columnBy ?? "status";
  const rx = axisExpr(rowsBy), cx = axisExpr(colsBy);
  // One grouped query; at most 2,000 cells come back before the caps fold the rest into Other.
  const cells = await c.deps.db.all<{ r: string; k: string; n: number }>(sql`select ${rx} as r, ${cx} as k, count(*) as n from ${tasks} where ${and(...taskConds(c, w))} group by 1, 2 limit 2000`);
  const rowTotal = new Map<string, number>(), colTotal = new Map<string, number>();
  for (const x of cells) { rowTotal.set(String(x.r), (rowTotal.get(String(x.r)) ?? 0) + Number(x.n)); colTotal.set(String(x.k), (colTotal.get(String(x.k)) ?? 0) + Number(x.n)); }
  const order = (a: PivotAxis, tot: Map<string, number>) => {
    const fixed = AXIS_ORDER[a];
    return [...tot.keys()].sort((x, y) => fixed ? fixed.indexOf(x) - fixed.indexOf(y) : (tot.get(y)! - tot.get(x)!) || x.localeCompare(y));
  };
  const rk = order(rowsBy, rowTotal), ck = order(colsBy, colTotal);
  const keepR = rk.length > PIVOT_ROWS ? rk.slice(0, PIVOT_ROWS - 1) : rk;
  const keepC = ck.length > PIVOT_COLS ? ck.slice(0, PIVOT_COLS - 1) : ck;
  const rl = await axisLabels(c, rowsBy, keepR), cl = await axisLabels(c, colsBy, keepC);
  const rKey = (k: string) => (keepR.includes(k) ? k : "other"), cKey = (k: string) => (keepC.includes(k) ? k : "other");
  const columns = keepC.map((k) => ({ key: k, label: cl.get(k)!, total: colTotal.get(k) ?? 0 }));
  if (ck.length > keepC.length) columns.push({ key: "other", label: "Other", total: ck.slice(keepC.length).reduce((s, k) => s + colTotal.get(k)!, 0) });
  const rows = keepR.map((k) => ({ key: k, label: rl.get(k)!, total: rowTotal.get(k) ?? 0, cells: {} as Record<string, number> }));
  if (rk.length > keepR.length) rows.push({ key: "other", label: "Other", total: rk.slice(keepR.length).reduce((s, k) => s + rowTotal.get(k)!, 0), cells: {} });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const x of cells) { const r = byKey.get(rKey(String(x.r)))!; const k = cKey(String(x.k)); r.cells[k] = (r.cells[k] ?? 0) + Number(x.n); }
  return { rowsBy, columnsBy: colsBy, columns, rows, total: cells.reduce((s, x) => s + Number(x.n), 0) };
}

export async function createdCompleted(c: Ctx, w: Widget) {
  const { days, from, to } = window(c, w.range);
  const b = buckets(c, from, to, days);
  const idx = (col: SQL) => sql<number>`cast((${col} - ${from}) / ${b.stepMs} as integer)`;
  const base = taskConds(c, w);
  const [made, done] = await Promise.all([
    c.deps.db.select({ b: idx(sql`${tasks.createdAt}`), n: sql<number>`count(*)` }).from(tasks).where(and(...base, gte(tasks.createdAt, new Date(from)), lt(tasks.createdAt, new Date(to)))).groupBy(sql`1`),
    c.deps.db.select({ b: idx(sql`${tasks.completedAt}`), n: sql<number>`count(*)` }).from(tasks).where(and(...base, eq(tasks.status, "done"), gte(tasks.completedAt, new Date(from)), lt(tasks.completedAt, new Date(to)))).groupBy(sql`1`),
  ]);
  const mm = new Map(made.map((r) => [Number(r.b), Number(r.n)])), dm = new Map(done.map((r) => [Number(r.b), Number(r.n)]));
  const points = b.starts.map((s, i) => ({ start: dayKey(s, c.tz), created: mm.get(i) ?? 0, completed: dm.get(i) ?? 0 }));
  const created = points.reduce((s, p) => s + p.created, 0), completed = points.reduce((s, p) => s + p.completed, 0);
  return { range: w.range ?? "30d", bucket: b.unit, points, created, completed, net: created - completed };
}

export async function taskList(c: Ctx, w: Widget) {
  const where = and(...taskConds(c, w));
  const sort = w.sort ?? "due";
  const order = sort === "updated" ? [desc(tasks.updatedAt), asc(tasks.id)]
    : sort === "priority" ? [sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`, sql`${tasks.dueAt} is null`, asc(tasks.dueAt), asc(tasks.id)]
      : [sql`${tasks.dueAt} is null`, asc(tasks.dueAt), asc(tasks.id)];
  const [agg, rows] = await Promise.all([
    c.deps.db.select({ n: sql<number>`count(*)` }).from(tasks).where(where).get(),
    c.deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, status: tasks.status, dueAt: tasks.dueAt, priority: tasks.priority, type: tasks.assigneeType, aid: tasks.assigneeId })
      .from(tasks).where(where).orderBy(...order).limit(LIST_CAP),
  ]);
  const names = await c.people;
  return {
    sort, total: Number(agg?.n ?? 0),
    tasks: rows.map((t) => ({
      id: t.id, ref: `${c.projects.get(t.projectId)?.key ?? "TSK"}-${t.number}`, title: t.title, status: t.status, priority: t.priority,
      due: t.dueAt ? t.dueAt.toISOString() : null, overdue: !!t.dueAt && t.status !== "done" && t.dueAt.getTime() < c.todayStart,
      assignee: t.type && t.aid ? names.get(`${t.type}:${t.aid}`) ?? null : null,
    })),
  };
}

export async function timeTracked(c: Ctx, w: Widget) {
  const { days, from, to } = window(c, w.range);
  const b = buckets(c, from, to, days);
  const where = and(...entryConds(c, w, from, to));
  const [byBucket, byPerson] = await Promise.all([
    c.deps.db.select({ b: sql<number>`cast((${timeEntries.startedAt} - ${from}) / ${b.stepMs} as integer)`, s: sql<number>`sum(${timeEntries.seconds})` }).from(timeEntries).where(where).groupBy(sql`1`),
    c.deps.db.select({ t: timeEntries.personType, id: timeEntries.personId, s: sql<number>`sum(${timeEntries.seconds})` }).from(timeEntries).where(where)
      .groupBy(timeEntries.personType, timeEntries.personId).orderBy(desc(sql`3`)).limit(5),
  ]);
  const m = new Map(byBucket.map((r) => [Number(r.b), Number(r.s)]));
  const names = byPerson.length ? await c.people : new Map<string, string>();
  const points = b.starts.map((s, i) => ({ start: dayKey(s, c.tz), hours: round((m.get(i) ?? 0) / 3600) }));
  return {
    range: w.range ?? "30d", bucket: b.unit, points, hours: round(byBucket.reduce((s, r) => s + Number(r.s), 0) / 3600),
    people: byPerson.map((p) => ({ key: `${p.t}:${p.id}`, name: names.get(`${p.t}:${p.id}`) ?? "Former member", hours: round(Number(p.s) / 3600) })),
  };
}

export function note(w: Widget) {
  return { text: w.text ?? "" };
}
