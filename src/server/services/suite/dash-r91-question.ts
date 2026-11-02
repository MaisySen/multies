/**
 * R91 question builder: a no code question over Multies data (tasks, deals, form responses, bookings, time,
 * mail volume) or an uploaded data source. A question is pick data, filters, group by, measure, chart.
 *
 * Safety: every field comes from the allowlist below, every value is a bound parameter (drizzle sql``), and
 * every query is scoped to the workspace and to what the viewer could see anyway: tasks the way the task
 * lists read them, time entries only the viewer's own unless they are an admin, bookings on their own
 * booking pages unless admin, mail only the mailboxes they may read. Results are capped at 50 groups.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { bookings, dashboardSources, deals, formSubmissions, forms, mailboxes, messages, projects, schedulingPages, tasks, timeEntries, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import type { SuiteActor } from "./common";
import { topLevelCondition } from "./task-types";

const DAY = 86_400_000;
export const Q_TABLES = ["tasks", "deals", "forms", "bookings", "time", "mail", "source"] as const;
export type QTable = (typeof Q_TABLES)[number];
export const Q_OPS = ["is", "is_not", "contains", "gt", "lt", "empty", "not_empty", "last_days", "before", "after"] as const;
export const Q_MEASURES = ["count", "sum", "avg", "min", "max"] as const;
export const Q_BUCKETS = ["day", "week", "month"] as const;
export const Q_CHARTS = ["number", "bar", "line", "donut", "table"] as const;
export const Q_MAX_GROUPS = 50;

export const QuestionSpec = z.object({
  table: z.enum(Q_TABLES),
  sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  filters: z.array(z.object({ field: z.string().max(64), op: z.enum(Q_OPS), value: z.string().max(200).optional() }).strict()).max(8).default([]),
  groupBy: z.string().max(64).nullable().optional(),
  bucket: z.enum(Q_BUCKETS).nullable().optional(),
  measure: z.object({ op: z.enum(Q_MEASURES), field: z.string().max(64).optional() }).strict().default({ op: "count" }),
}).strict();
export type QuestionSpec = z.infer<typeof QuestionSpec>;

type Kind = "text" | "number" | "date" | "enum" | "person" | "project" | "mailbox" | "form" | "page";
interface FieldDef { label: string; kind: Kind; expr: SQL; values?: readonly string[]; format?: "money" | "hours" }
interface TableDef { label: string; from: SQL; fields: Record<string, FieldDef>; countOnly?: boolean }

/** The field catalogue, shared with the builder UI (labels in sentence case). */
export function tableDefs(): Record<Exclude<QTable, "source">, TableDef> {
  return {
    tasks: { label: "Tasks", from: sql`${tasks}`, fields: {
      status: { label: "Status", kind: "enum", expr: sql`${tasks.status}`, values: ["todo", "doing", "done"] },
      priority: { label: "Priority", kind: "enum", expr: sql`${tasks.priority}`, values: ["none", "low", "medium", "high", "urgent"] },
      type: { label: "Type", kind: "enum", expr: sql`${tasks.type}`, values: ["task", "story", "bug", "epic"] },
      project: { label: "Project", kind: "project", expr: sql`${tasks.projectId}` },
      assignee: { label: "Assignee", kind: "person", expr: sql`${tasks.assigneeId}` },
      title: { label: "Title", kind: "text", expr: sql`${tasks.title}` },
      created: { label: "Created", kind: "date", expr: sql`${tasks.createdAt}` },
      due: { label: "Due", kind: "date", expr: sql`${tasks.dueAt}` },
      completed: { label: "Completed", kind: "date", expr: sql`${tasks.completedAt}` },
      points: { label: "Points", kind: "number", expr: sql`${tasks.points}` },
    } },
    deals: { label: "Deals", from: sql`${deals}`, fields: {
      stage: { label: "Stage", kind: "enum", expr: sql`${deals.stage}`, values: ["lead", "qualified", "proposal", "won", "lost"] },
      owner: { label: "Owner", kind: "person", expr: sql`${deals.ownerUserId}` },
      title: { label: "Title", kind: "text", expr: sql`${deals.title}` },
      value: { label: "Value", kind: "number", expr: sql`(${deals.valueCents} / 100.0)`, format: "money" },
      close: { label: "Expected close", kind: "date", expr: sql`${deals.expectedCloseAt}` },
      closed: { label: "Closed", kind: "date", expr: sql`${deals.closedAt}` }, // TD10: revenue by month
      created: { label: "Created", kind: "date", expr: sql`${deals.createdAt}` },
    } },
    forms: { label: "Form responses", from: sql`${formSubmissions}`, countOnly: true, fields: {
      form: { label: "Form", kind: "form", expr: sql`${formSubmissions.formId}` },
      created: { label: "Received", kind: "date", expr: sql`${formSubmissions.createdAt}` },
    } },
    bookings: { label: "Bookings", from: sql`${bookings}`, fields: {
      status: { label: "Status", kind: "enum", expr: sql`${bookings.status}`, values: ["confirmed", "cancelled"] },
      page: { label: "Booking page", kind: "page", expr: sql`${bookings.pageId}` },
      starts: { label: "Starts", kind: "date", expr: sql`${bookings.startsAt}` },
      duration: { label: "Length in minutes", kind: "number", expr: sql`${bookings.durationMin}` },
    } },
    time: { label: "Time", from: sql`${timeEntries}`, fields: {
      person: { label: "Person", kind: "person", expr: sql`${timeEntries.personId}` },
      project: { label: "Project", kind: "project", expr: sql`${timeEntries.projectId}` },
      billable: { label: "Billable", kind: "enum", expr: sql`(case when ${timeEntries.billable} then 'yes' else 'no' end)`, values: ["yes", "no"] },
      started: { label: "Date", kind: "date", expr: sql`${timeEntries.startedAt}` },
      hours: { label: "Hours", kind: "number", expr: sql`(${timeEntries.seconds} / 3600.0)`, format: "hours" },
    } },
    mail: { label: "Mail volume", from: sql`${messages}`, countOnly: true, fields: {
      mailbox: { label: "Mailbox", kind: "mailbox", expr: sql`${messages.mailboxId}` },
      folder: { label: "Folder", kind: "enum", expr: sql`${messages.folder}`, values: ["inbox", "sent", "archive", "spam"] },
      date: { label: "Date", kind: "date", expr: sql`${messages.date}` },
    } },
  };
}

/** What the builder shows: tables, fields with their kind and allowed values. */
export function questionCatalog() {
  const defs = tableDefs();
  return {
    tables: Object.entries(defs).map(([id, t]) => ({ id, label: t.label, countOnly: !!t.countOnly, fields: Object.entries(t.fields).map(([fid, f]) => ({ id: fid, label: f.label, kind: f.kind, values: f.values ?? null })) })),
    ops: Q_OPS, measures: Q_MEASURES, buckets: Q_BUCKETS, charts: Q_CHARTS, maxGroups: Q_MAX_GROUPS,
  };
}

export interface QScope { orgId: string; userId: string; admin: boolean; mailboxes: string[]; now: number; offsetMin: number }

const bad = (m: string) => new HttpError(422, "validation_failed", m);

function dateValue(v: string | undefined): number {
  const t = v ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw bad("Enter a date like 2026-10-31.");
  return t;
}

function filterSql(f: FieldDef, op: (typeof Q_OPS)[number], value: string | undefined, now: number): SQL {
  const e = f.expr;
  switch (op) {
    case "empty": return sql`(${e} is null or ${e} = '')`;
    case "not_empty": return sql`(${e} is not null and ${e} != '')`;
    case "contains":
      if (f.kind !== "text") throw bad(`${f.label} can't use contains.`);
      return sql`instr(lower(${e}), lower(${value ?? ""})) > 0`;
    case "last_days": {
      if (f.kind !== "date") throw bad(`${f.label} isn't a date.`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 3660) throw bad("Enter a number of days from 1 to 3660.");
      return sql`(${e} >= ${now - n * DAY} and ${e} <= ${now})`;
    }
    case "before": case "after": {
      if (f.kind !== "date") throw bad(`${f.label} isn't a date.`);
      const t = dateValue(value);
      return op === "before" ? sql`${e} < ${t}` : sql`${e} >= ${t}`;
    }
    case "gt": case "lt": {
      if (f.kind === "date") { const t = dateValue(value); return op === "gt" ? sql`${e} > ${t}` : sql`${e} < ${t}`; }
      if (f.kind !== "number") throw bad(`${f.label} isn't a number.`);
      const n = Number(value);
      if (!Number.isFinite(n)) throw bad(`Enter a number for ${f.label.toLowerCase()}.`);
      return op === "gt" ? sql`${e} > ${n}` : sql`${e} < ${n}`;
    }
    case "is": case "is_not": {
      if (value === undefined || value === "") throw bad(`Pick a value for ${f.label.toLowerCase()}.`);
      if (f.values && !f.values.includes(value)) throw bad(`${value} isn't a ${f.label.toLowerCase()}.`);
      let v: string | number = value;
      if (f.kind === "number") { v = Number(value); if (!Number.isFinite(v)) throw bad(`Enter a number for ${f.label.toLowerCase()}.`); }
      return op === "is" ? sql`${e} = ${v}` : sql`(${e} is null or ${e} != ${v})`;
    }
  }
}

function bucketSql(e: SQL, bucket: (typeof Q_BUCKETS)[number], offsetMin: number): SQL {
  const local = sql`((${e} / 1000) + ${offsetMin * 60})`;
  if (bucket === "day") return sql`strftime('%Y-%m-%d', ${local}, 'unixepoch')`;
  if (bucket === "week") return sql`date(${local}, 'unixepoch', 'weekday 0', '-6 days')`;
  return sql`strftime('%Y-%m', ${local}, 'unixepoch')`;
}

/** The permission scope of each table, always including the workspace. */
function scopeConds(table: Exclude<QTable, "source">, s: QScope): SQL[] {
  switch (table) {
    case "tasks": return [eq(tasks.orgId, s.orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), topLevelCondition()].filter(Boolean) as SQL[];
    case "deals": return [eq(deals.orgId, s.orgId)];
    case "forms": return [eq(formSubmissions.orgId, s.orgId)];
    case "bookings": return s.admin ? [eq(bookings.orgId, s.orgId)]
      : [eq(bookings.orgId, s.orgId), sql`${bookings.pageId} in (select ${schedulingPages.id} from ${schedulingPages} where ${schedulingPages.orgId} = ${s.orgId} and ${schedulingPages.userId} = ${s.userId})`];
    case "time": return s.admin ? [eq(timeEntries.orgId, s.orgId)] : [eq(timeEntries.orgId, s.orgId), eq(timeEntries.personType, "member"), eq(timeEntries.personId, s.userId || "-")];
    case "mail": return [eq(messages.orgId, s.orgId), s.mailboxes.length ? inArray(messages.mailboxId, s.mailboxes.slice(0, 90)) : sql`0`];
  }
}

export interface Compiled { query: SQL; grouped: boolean; groupKind: Kind | "bucket" | null; format?: "money" | "hours" }

/** Turns a question into one parameterised, permission scoped SQL query. Throws 422 on anything unknown. */
export function compileQuestion(spec: QuestionSpec, s: QScope): Compiled {
  if (spec.table === "source") throw bad("A data source question is answered without SQL.");
  const def = tableDefs()[spec.table];
  const field = (id: string) => { const f = def.fields[id]; if (!f) throw bad(`Unknown field ${id}.`); return f; };
  const conds = [...scopeConds(spec.table, s), ...spec.filters.map((f) => filterSql(field(f.field), f.op, f.value, s.now))];
  let value: SQL = sql`count(*)`;
  let format: Compiled["format"];
  if (spec.measure.op !== "count") {
    if (def.countOnly) throw bad(`${def.label} can only be counted.`);
    const m = field(spec.measure.field ?? "");
    if (m.kind !== "number") throw bad(`${m.label} isn't a number, so it can only be counted.`);
    value = sql`coalesce(${sql.raw(spec.measure.op)}(${m.expr}), 0)`;
    format = m.format;
  }
  if (!spec.groupBy) return { query: sql`select ${value} as v from ${def.from} where ${and(...conds)}`, grouped: false, groupKind: null, format };
  const g = field(spec.groupBy);
  const bucketed = g.kind === "date";
  const gx = bucketed ? bucketSql(g.expr, spec.bucket ?? "week", s.offsetMin) : g.expr;
  const order = bucketed ? sql`g asc` : sql`v desc`;
  return {
    query: sql`select ${gx} as g, ${value} as v from ${def.from} where ${and(...conds)} group by g order by ${order} limit ${Q_MAX_GROUPS + 1}`,
    grouped: true, groupKind: bucketed ? "bucket" : g.kind, format,
  };
}

export interface QuestionResult { kind: "question"; value: number | null; rows: { label: string; value: number }[] | null; truncated: boolean; format: "money" | "hours" | null; label: string }

async function names(deps: Deps, kind: Kind | "bucket" | null, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  if (kind === "person") (await deps.db.select({ id: users.id, n: users.name, e: users.email }).from(users).where(inIds(users.id, ids))).forEach((r) => m.set(r.id, r.n || r.e.split("@")[0] || "Someone"));
  if (kind === "project") (await deps.db.select({ id: projects.id, n: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.id, ids)))).forEach((r) => m.set(r.id, r.n));
  if (kind === "mailbox") (await deps.db.select({ id: mailboxes.id, n: mailboxes.displayName, a: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inIds(mailboxes.id, ids)))).forEach((r) => m.set(r.id, r.n || r.a));
  if (kind === "form") (await deps.db.select({ id: forms.id, n: forms.name }).from(forms).where(and(eq(forms.orgId, orgId), inIds(forms.id, ids)))).forEach((r) => m.set(r.id, r.n));
  if (kind === "page") (await deps.db.select({ id: schedulingPages.id, n: schedulingPages.title }).from(schedulingPages).where(and(eq(schedulingPages.orgId, orgId), inIds(schedulingPages.id, ids)))).forEach((r) => m.set(r.id, r.n));
  return m;
}

const ENUM_LABEL: Record<string, string> = { todo: "To do", doing: "In progress", done: "Done", none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent",
  task: "Task", story: "Story", bug: "Bug", epic: "Epic", lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost", confirmed: "Confirmed", cancelled: "Cancelled",
  yes: "Billable", no: "Not billable", inbox: "Inbox", sent: "Sent", archive: "Archive", spam: "Spam" };

export function describeQuestion(spec: QuestionSpec, sourceName?: string): string {
  const t = spec.table === "source" ? (sourceName ?? "Data source") : tableDefs()[spec.table].label;
  const field = spec.table === "source" ? spec.measure.field : spec.measure.field && tableDefs()[spec.table].fields[spec.measure.field]?.label.toLowerCase();
  const m = spec.measure.op === "count" ? `${t}` : `${({ sum: "Total", avg: "Average", min: "Lowest", max: "Highest" } as Record<string, string>)[spec.measure.op]} ${field ?? ""} of ${t.toLowerCase()}`;
  if (!spec.groupBy) return m;
  const g = spec.table === "source" ? spec.groupBy : tableDefs()[spec.table].fields[spec.groupBy]?.label.toLowerCase() ?? spec.groupBy;
  return `${m} by ${g}${spec.bucket ? ` per ${spec.bucket}` : ""}`.slice(0, 80);
}

// ---------------------------------------------------------------- data sources (computed in the worker)

export interface SourceColumn { name: string; kind: "number" | "date" | "text" }
type Cell = string | number | null;

export function runOnRows(spec: QuestionSpec, columns: SourceColumn[], rows: Cell[][], offsetMin: number, now: number): Omit<QuestionResult, "label"> {
  const idx = (name: string) => { const i = columns.findIndex((c) => c.name === name); if (i < 0) throw bad(`This data source has no column ${name}.`); return i; };
  const num = (v: Cell) => (typeof v === "number" ? v : v === null || v === "" ? NaN : Number(String(v).replace(/[, $]/g, "")));
  const time = (v: Cell) => (v === null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)));
  const tests = spec.filters.map((f) => {
    const i = idx(f.field), kind = columns[i]!.kind, v = f.value ?? "";
    return (r: Cell[]) => {
      const c = r[i] ?? null; const s = c === null ? "" : String(c);
      switch (f.op) {
        case "empty": return s === "";
        case "not_empty": return s !== "";
        case "contains": return s.toLowerCase().includes(v.toLowerCase());
        case "is": return kind === "number" ? num(c) === Number(v) : s === v;
        case "is_not": return kind === "number" ? num(c) !== Number(v) : s !== v;
        case "gt": return kind === "date" ? time(c) > Date.parse(v) : num(c) > Number(v);
        case "lt": return kind === "date" ? time(c) < Date.parse(v) : num(c) < Number(v);
        case "last_days": { const t = time(c); return t >= now - Number(v) * DAY && t <= now; }
        case "before": return time(c) < Date.parse(v);
        case "after": return time(c) >= Date.parse(v);
      }
    };
  });
  const kept = rows.filter((r) => tests.every((t) => t(r)));
  const mi = spec.measure.op === "count" ? -1 : idx(spec.measure.field ?? "");
  if (mi >= 0 && columns[mi]!.kind !== "number") throw bad(`${columns[mi]!.name} isn't a number, so it can only be counted.`);
  const agg = (rs: Cell[][]) => {
    if (mi < 0) return rs.length;
    const xs = rs.map((r) => num(r[mi] ?? null)).filter((x) => Number.isFinite(x));
    if (!xs.length) return 0;
    switch (spec.measure.op) {
      case "sum": return xs.reduce((a, b) => a + b, 0);
      case "avg": return xs.reduce((a, b) => a + b, 0) / xs.length;
      case "min": return Math.min(...xs);
      default: return Math.max(...xs);
    }
  };
  const round = (x: number) => Math.round(x * 100) / 100;
  if (!spec.groupBy) return { kind: "question", value: round(agg(kept)), rows: null, truncated: false, format: null };
  const gi = idx(spec.groupBy), gk = columns[gi]!.kind;
  const key = (r: Cell[]) => {
    const c = r[gi] ?? null;
    if (gk !== "date") return c === null || c === "" ? "(empty)" : String(c);
    const t = time(c); if (!Number.isFinite(t)) return "(empty)";
    const d = new Date(t + offsetMin * 60_000);
    if (spec.bucket === "month") return d.toISOString().slice(0, 7);
    if (spec.bucket === "day") return d.toISOString().slice(0, 10);
    const dow = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
  };
  const groups = new Map<string, Cell[][]>();
  for (const r of kept) { const k = key(r); const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
  let out = [...groups.entries()].map(([label, rs]) => ({ label, value: round(agg(rs)) }));
  out = gk === "date" ? out.sort((a, b) => a.label.localeCompare(b.label)) : out.sort((a, b) => b.value - a.value);
  return { kind: "question", value: null, rows: out.slice(0, Q_MAX_GROUPS), truncated: out.length > Q_MAX_GROUPS, format: null };
}

// ---------------------------------------------------------------- run

export async function runQuestion(deps: Deps, actor: SuiteActor, spec: QuestionSpec, opts: { mailboxes: () => Promise<string[]>; offsetMin: number; now: number }): Promise<QuestionResult> {
  if (spec.table === "source") {
    const src = spec.sourceId ? await deps.db.select().from(dashboardSources).where(and(eq(dashboardSources.orgId, actor.orgId), eq(dashboardSources.id, spec.sourceId))).get() : undefined;
    if (!src) throw new HttpError(404, "not_found", "This data source was removed.");
    const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
    return { ...runOnRows(spec, parse<SourceColumn[]>(src.columns, []), parse<Cell[][]>(src.rows, []), opts.offsetMin, opts.now), label: describeQuestion(spec, src.name) };
  }
  const admin = actor.role === "owner" || actor.role === "admin";
  const userId = actor.agentId ? "" : actor.userId || "";
  const scope: QScope = { orgId: actor.orgId, userId, admin: admin && !actor.agentId, mailboxes: spec.table === "mail" ? await opts.mailboxes() : [], now: opts.now, offsetMin: opts.offsetMin };
  const c = compileQuestion(spec, scope);
  const rows = await deps.db.all<{ g?: string | number | null; v: number | null }>(c.query);
  const round = (x: number | null | undefined) => Math.round(Number(x ?? 0) * 100) / 100;
  if (!c.grouped) return { kind: "question", value: round(rows[0]?.v), rows: null, truncated: false, format: c.format ?? null, label: describeQuestion(spec) };
  const kept = rows.slice(0, Q_MAX_GROUPS);
  const nameMap = await names(deps, c.groupKind, actor.orgId, [...new Set(kept.map((r) => (r.g == null ? "" : String(r.g))).filter(Boolean))]);
  const label = (g: string | number | null | undefined) => {
    if (g === null || g === undefined || g === "") return c.groupKind === "person" ? "No one" : "None";
    const s = String(g);
    if (c.groupKind === "enum") return ENUM_LABEL[s] ?? s;
    if (c.groupKind && ["person", "project", "mailbox", "form", "page"].includes(c.groupKind)) return nameMap.get(s) ?? "Removed";
    return s;
  };
  return { kind: "question", value: null, rows: kept.map((r) => ({ label: label(r.g), value: round(r.v) })), truncated: rows.length > Q_MAX_GROUPS, format: c.format ?? null, label: describeQuestion(spec) };
}
