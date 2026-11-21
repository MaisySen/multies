/**
 * OPS1 Trends: the platform metrics rollup and its reads.
 *
 * One row per metric per completed UTC day in `platform_metrics_daily` (about 23 rows a day). Flow metrics count what
 * happened on a day and are recomputed from the source tables' timestamps, so they can be backfilled as far back as
 * each source keeps its rows (`retentionDays`). Stock metrics are a snapshot of now, so they are only ever written for
 * yesterday (by the rollup just after midnight UTC) and shown live for today; their history starts at ship date.
 *
 * Cost. A rollup of any number of days runs at most 9 grouped flow queries (each covers the whole day range in one
 * statement) and 6 stock queries, then 2 upsert statements per day (20 rows each). Every pass of the maintenance cron
 * that finds yesterday already rolled costs one read on platform_metrics_daily_metric_idx. Which index each source
 * query uses, and where a full scan is unavoidable, is noted on the query.
 *
 * Gaps are explicit: a day with no stored row reads as null, never 0. A flow metric outside its source's retention is
 * neither computed nor written, so a backfill never stores a zero it cannot vouch for.
 */
import { and, eq, gte, inArray, lt, lte, max, min, notInArray, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Deps } from "../../context";
import {
  abuseEvents, agentRuns, aiUsageDaily, contentReports, deliveries, domains, jobs, mailboxes, organizations,
  platformMetricsDaily, uptimeChecks, usageCounters, users, webhookDeliveries, webhookEndpoints,
} from "../../db/schema";
import { optionalWritesPaused } from "../write-budget";
import { WORKSPACE_ROWS_METRIC } from "../workspace-budget";

// ---- registry --------------------------------------------------------------------------------------------------

export type MetricKind = "flow" | "stock";
export type MetricUnit = "count" | "units" | "mb" | "rows" | "percent";

export interface PlatformMetricDef {
  key: string;
  label: string;
  kind: MetricKind;
  unit: MetricUnit;
  description: string;
  /** Flow only: how many days back (from today) the source keeps the rows this metric counts. Unset: kept for good. */
  retentionDays?: number;
}

/** The global rows of ai_usage_daily (tools, Ask, social writing). Per workspace rows would count every call twice. */
const AI_GLOBAL_ROWS = ["*", "ask:*", "socialwrite:*"] as const;

export const PLATFORM_METRICS = [
  // Flow: counted per UTC day from timestamps.
  { key: "signups", label: "Sign ups", kind: "flow", unit: "count", description: "Accounts created that day." },
  { key: "workspaces_created", label: "Workspaces created", kind: "flow", unit: "count", description: "Workspaces created that day, demo workspaces left out." },
  { key: "deliveries_sent", label: "Mail sent", kind: "flow", unit: "count", description: "Outbound deliveries recorded that day that were not refused (everything but failed, rejected and suppressed); demo workspaces left out." },
  { key: "deliveries_failed", label: "Mail failed", kind: "flow", unit: "count", description: "Outbound deliveries recorded that day that failed, were rejected or bounced; demo workspaces left out." },
  { key: "ai_calls", label: "AI calls", kind: "flow", unit: "count", description: "AI requests that day across tools, Ask and social writing (the global rows of ai_usage_daily).", retentionDays: 2 },
  { key: "ai_units", label: "AI units", kind: "flow", unit: "units", description: "AI units spent that day across tools, Ask and social writing.", retentionDays: 2 },
  { key: "agent_runs", label: "Agent runs", kind: "flow", unit: "count", description: "Agent runs queued that day; demo workspaces left out." },
  { key: "agent_runs_failed", label: "Agent runs failed", kind: "flow", unit: "count", description: "Agent runs queued that day that ended failed; demo workspaces left out." },
  { key: "jobs_dead", label: "Dead jobs", kind: "flow", unit: "count", description: "Background jobs that ran out of retries that day (still present; dead jobs are pruned after 30 days).", retentionDays: 29 },
  { key: "abuse_events", label: "Abuse signals", kind: "flow", unit: "count", description: "Abuse events recorded that day; demo workspaces left out." },
  { key: "reports_opened", label: "Reports opened", kind: "flow", unit: "count", description: "Content reports filed that day, whatever their status now." },
  { key: "webhook_deliveries_failed", label: "Webhook deliveries failed", kind: "flow", unit: "count", description: "Webhook deliveries created that day that ran out of retries (deliveries are pruned after 30 days).", retentionDays: 29 },
  // Stock: a snapshot, written for yesterday by the rollup and computed live for today.
  { key: "users_total", label: "Accounts", kind: "stock", unit: "count", description: "All accounts." },
  { key: "workspaces_total", label: "Workspaces", kind: "stock", unit: "count", description: "All workspaces, demo workspaces left out." },
  { key: "workspaces_paid", label: "Paid workspaces", kind: "stock", unit: "count", description: "Workspaces on a paid plan with a live subscription (active, trialing or past due), comps left out." },
  { key: "workspaces_comp", label: "Comped workspaces", kind: "stock", unit: "count", description: "Workspaces on an operator comp." },
  { key: "workspaces_past_due", label: "Past due workspaces", kind: "stock", unit: "count", description: "Workspaces with a failed payment." },
  { key: "workspaces_suspended", label: "Suspended workspaces", kind: "stock", unit: "count", description: "Workspaces suspended by an operator or the abuse checks." },
  { key: "mailboxes_total", label: "Mailboxes", kind: "stock", unit: "count", description: "All mailboxes, people's and agents'." },
  { key: "domains_verified", label: "Verified domains", kind: "stock", unit: "count", description: "Domains whose DNS is verified." },
  { key: "storage_mb", label: "Mail storage", kind: "stock", unit: "mb", description: "Mail storage in use across mailboxes (sum of used bytes), in MB." },
  { key: "d1_rows_written", label: "D1 rows written", kind: "stock", unit: "rows", description: "Rows the workspaces wrote that day, from the per workspace write tally (usage_counters d1_rows). Not counted when the workspace write budget is off." },
  { key: "uptime_pct", label: "Uptime", kind: "stock", unit: "percent", description: "Share of that day's uptime self checks that passed. No value on a day with no checks." },
] as const satisfies readonly PlatformMetricDef[];

export type MetricKey = (typeof PLATFORM_METRICS)[number]["key"];
export type FlowMetricKey = Extract<(typeof PLATFORM_METRICS)[number], { kind: "flow" }>["key"];
export type StockMetricKey = Extract<(typeof PLATFORM_METRICS)[number], { kind: "stock" }>["key"];
/** Values computed for one day. A missing key means "not known" (outside retention, not a stock day, no source data). */
export type MetricValues = Partial<Record<MetricKey, number>>;

const BY_KEY = new Map<string, PlatformMetricDef>(PLATFORM_METRICS.map((m) => [m.key, m]));
export const FLOW_METRICS = PLATFORM_METRICS.filter((m) => m.kind === "flow").map((m) => m.key) as FlowMetricKey[];
export const STOCK_METRICS = PLATFORM_METRICS.filter((m) => m.kind === "stock").map((m) => m.key) as StockMetricKey[];
export const isMetricKey = (k: string): k is MetricKey => BY_KEY.has(k);

/** The rollup catches up at most this many missed completed days; older gaps are for backfillFlowMetrics. */
export const MAX_CATCH_UP_DAYS = 7;
export const MAX_BACKFILL_DAYS = 90;
/** The longest range readMetrics and readWorkspaceTrends answer. */
export const MAX_READ_DAYS = 400;
/** The rollup writes this stock metric for yesterday every time, so its latest day is the last rolled day. */
const ROLL_MARKER: MetricKey = "users_total";
/** 4 bound values a row; D1 takes at most 100 a statement. */
const UPSERT_CHUNK = 20;

// ---- days ------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number) => dayOf(new Date(startOf(day) + n * DAY_MS));
export function isDay(s: unknown): s is string {
  return typeof s === "string" && DAY_RE.test(s) && Number.isFinite(startOf(s)) && dayOf(new Date(startOf(s))) === s;
}
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** The UTC day of a timestamp_ms column, as SQLite text. */
const dayExpr = (col: SQLiteColumn) => sql<string>`strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;
const num = (v: unknown) => Number(v ?? 0) || 0;

// ---- compute ---------------------------------------------------------------------------------------------------

/** Rows for one grouped flow query: day plus named sums. */
type DayRow = { day: string } & Record<string, unknown>;

/**
 * Flow metrics for every day in [from, to], with one grouped statement per source. Values only for days within each
 * metric's retention (counted back from `now`) and not after today; within it, a day with no rows is a real 0.
 */
async function computeFlows(deps: Deps, from: string, to: string, now: Date, keys: readonly MetricKey[] = FLOW_METRICS): Promise<Map<string, MetricValues>> {
  const today = dayOf(now);
  if (to > today) to = today;
  const out = new Map<string, MetricValues>();
  if (from > to) return out;
  const want = new Set(keys);
  const need = (...k: FlowMetricKey[]) => k.some((x) => want.has(x));
  const start = new Date(startOf(from));
  const end = new Date(startOf(to) + DAY_MS);
  const db = deps.db;
  const liveOrgs = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.isDemo, false));
  const demoOrgs = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.isDemo, true));
  const skip = Promise.resolve([] as DayRow[]);

  const [signups, orgs, mail, ai, runs, dead, abuse, reports, hooks] = await Promise.all([
    // users: no index on created_at, so a full scan of users (one pass for the whole range).
    !need("signups") ? skip : db.select({ day: dayExpr(users.createdAt), n: sql<number>`count(*)` }).from(users)
      .where(and(gte(users.createdAt, start), lt(users.createdAt, end))).groupBy(sql`1`),
    // organizations: no index on created_at; a full scan of a small table.
    !need("workspaces_created") ? skip : db.select({ day: dayExpr(organizations.createdAt), n: sql<number>`count(*)` }).from(organizations)
      .where(and(eq(organizations.isDemo, false), gte(organizations.createdAt, start), lt(organizations.createdAt, end))).groupBy(sql`1`),
    // deliveries_org_idx (org_id, created_at): one range per live workspace.
    !need("deliveries_sent", "deliveries_failed") ? skip : db.select({
      day: dayExpr(deliveries.createdAt),
      sent: sql<number>`sum(case when ${deliveries.status} not in ('failed', 'rejected', 'suppressed') then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${deliveries.status} in ('failed', 'rejected', 'bounced') then 1 else 0 end)`,
    }).from(deliveries).where(and(
      inArray(deliveries.orgId, liveOrgs), // D1: a subquery, no bound list
      gte(deliveries.createdAt, start), lt(deliveries.createdAt, end), eq(deliveries.direction, "outbound"),
    )).groupBy(sql`1`),
    // ai_usage_daily primary key (day, org_id): a range on day.
    !need("ai_calls", "ai_units") ? skip : db.select({ day: aiUsageDaily.day, calls: sql<number>`sum(${aiUsageDaily.calls})`, units: sql<number>`sum(${aiUsageDaily.units})` })
      .from(aiUsageDaily).where(and(gte(aiUsageDaily.day, from), lte(aiUsageDaily.day, to), inArray(aiUsageDaily.orgId, [...AI_GLOBAL_ROWS]))).groupBy(aiUsageDaily.day),
    // agent_runs: no index on created_at (agent_runs_creator_td6_idx leads with org_id, created_by_user_id), so a full scan.
    !need("agent_runs", "agent_runs_failed") ? skip : db.select({
      day: dayExpr(agentRuns.createdAt), n: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${agentRuns.status} = 'failed' then 1 else 0 end)`,
    }).from(agentRuns).where(and(
      gte(agentRuns.createdAt, start), lt(agentRuns.createdAt, end),
      notInArray(agentRuns.orgId, demoOrgs), // D1: a subquery, no bound list
    )).groupBy(sql`1`),
    // jobs_due_idx (status, run_at): status = 'dead' bounds it to the dead jobs (pruned after 30 days); updated_at is filtered per row.
    !need("jobs_dead") ? skip : db.select({ day: dayExpr(jobs.updatedAt), n: sql<number>`count(*)` }).from(jobs)
      .where(and(eq(jobs.status, "dead"), gte(jobs.updatedAt, start), lt(jobs.updatedAt, end))).groupBy(sql`1`),
    // abuse_events_org_idx (org_id, created_at): one range per live workspace.
    !need("abuse_events") ? skip : db.select({ day: dayExpr(abuseEvents.createdAt), n: sql<number>`count(*)` }).from(abuseEvents).where(and(
      inArray(abuseEvents.orgId, liveOrgs), // D1: a subquery, no bound list
      gte(abuseEvents.createdAt, start), lt(abuseEvents.createdAt, end),
    )).groupBy(sql`1`),
    // content_reports_status_idx (status, created_at): one range per status.
    !need("reports_opened") ? skip : db.select({ day: dayExpr(contentReports.createdAt), n: sql<number>`count(*)` }).from(contentReports)
      .where(and(inArray(contentReports.status, ["open", "resolved", "dismissed"]), gte(contentReports.createdAt, start), lt(contentReports.createdAt, end))).groupBy(sql`1`),
    // webhook_deliveries_endpoint_idx (endpoint_id, created_at): one range per endpoint.
    !need("webhook_deliveries_failed") ? skip : db.select({ day: dayExpr(webhookDeliveries.createdAt), n: sql<number>`count(*)` }).from(webhookDeliveries).where(and(
      inArray(webhookDeliveries.endpointId, db.select({ id: webhookEndpoints.id }).from(webhookEndpoints)), // D1: a subquery, no bound list
      gte(webhookDeliveries.createdAt, start), lt(webhookDeliveries.createdAt, end), eq(webhookDeliveries.status, "failed"),
    )).groupBy(sql`1`),
  ]);

  const index = (rows: DayRow[]) => new Map(rows.map((r) => [r.day, r]));
  const src: Record<FlowMetricKey, [Map<string, DayRow>, string]> = {
    signups: [index(signups), "n"], workspaces_created: [index(orgs), "n"],
    deliveries_sent: [index(mail), "sent"], deliveries_failed: [index(mail), "failed"],
    ai_calls: [index(ai), "calls"], ai_units: [index(ai), "units"],
    agent_runs: [index(runs), "n"], agent_runs_failed: [index(runs), "failed"],
    jobs_dead: [index(dead), "n"], abuse_events: [index(abuse), "n"], reports_opened: [index(reports), "n"],
    webhook_deliveries_failed: [index(hooks), "n"],
  };
  for (const day of daysBetween(from, to)) {
    const v: MetricValues = {};
    for (const key of FLOW_METRICS) {
      if (!want.has(key)) continue;
      const keep = BY_KEY.get(key)!.retentionDays;
      if (keep !== undefined && day < addDays(today, -keep)) continue;
      const [rows, col] = src[key];
      v[key] = num(rows.get(day)?.[col]);
    }
    out.set(day, v);
  }
  return out;
}

/** Stock metrics as of now (uptime and D1 rows for `day`). Six reads. */
async function computeStocks(deps: Deps, day: string, keys: readonly MetricKey[] = STOCK_METRICS): Promise<MetricValues> {
  const want = new Set(keys);
  const need = (...k: StockMetricKey[]) => k.some((x) => want.has(x));
  const db = deps.db;
  const start = new Date(startOf(day));
  const end = new Date(startOf(day) + DAY_MS);
  const none = Promise.resolve(undefined);
  const rowsOn = !!deps.config.workspaceBudget.daily;
  const [u, o, m, d, rows, up] = await Promise.all([
    // users_email_uq covers count(*).
    need("users_total") ? db.select({ n: sql<number>`count(*)` }).from(users).get() : none,
    // organizations: one scan of a small table for all five.
    need("workspaces_total", "workspaces_paid", "workspaces_comp", "workspaces_past_due", "workspaces_suspended") ? db.select({
      total: sql<number>`count(*)`,
      paid: sql<number>`sum(case when ${organizations.plan} <> 'starter' and ${organizations.compPlan} = 0 and ${organizations.subscriptionStatus} in ('active', 'trialing', 'past_due') then 1 else 0 end)`,
      comp: sql<number>`sum(case when ${organizations.compPlan} = 1 then 1 else 0 end)`,
      pastDue: sql<number>`sum(case when ${organizations.pastDueSince} is not null then 1 else 0 end)`,
      suspended: sql<number>`sum(case when ${organizations.suspendedAt} is not null then 1 else 0 end)`,
    }).from(organizations).where(eq(organizations.isDemo, false)).get() : none,
    // mailboxes: a full scan (the byte sum needs every row).
    need("mailboxes_total", "storage_mb") ? db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${mailboxes.usedBytes}), 0)` }).from(mailboxes).get() : none,
    // domains: no status index; a full scan of a small table.
    need("domains_verified") ? db.select({ n: sql<number>`count(*)` }).from(domains).where(eq(domains.status, "verified")).get() : none,
    // usage_counters primary key (org_id, period, metric): one lookup per workspace.
    need("d1_rows_written") && rowsOn ? db.select({ n: sql<number>`coalesce(sum(${usageCounters.count}), 0)` }).from(usageCounters).where(and(
      inArray(usageCounters.orgId, db.select({ id: organizations.id }).from(organizations)), // D1: a subquery, no bound list
      eq(usageCounters.period, day), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC),
    )).get() : none,
    // uptime_checks_at_idx (at): the day's checks only.
    need("uptime_pct") ? db.select({ n: sql<number>`count(*)`, ok: sql<number>`coalesce(sum(case when ${uptimeChecks.ok} then 1 else 0 end), 0)` })
      .from(uptimeChecks).where(and(gte(uptimeChecks.at, start), lt(uptimeChecks.at, end))).get() : none,
  ]);
  const v: MetricValues = {};
  const set = (k: StockMetricKey, x: number | undefined) => { if (want.has(k) && x !== undefined) v[k] = x; };
  set("users_total", u ? num(u.n) : undefined);
  if (o) {
    set("workspaces_total", num(o.total)); set("workspaces_paid", num(o.paid)); set("workspaces_comp", num(o.comp));
    set("workspaces_past_due", num(o.pastDue)); set("workspaces_suspended", num(o.suspended));
  }
  if (m) { set("mailboxes_total", num(m.n)); set("storage_mb", Math.round((num(m.bytes) / 1_048_576) * 100) / 100); }
  set("domains_verified", d ? num(d.n) : undefined);
  set("d1_rows_written", rows ? num(rows.n) : undefined);
  set("uptime_pct", up && num(up.n) > 0 ? Math.round((num(up.ok) / num(up.n)) * 10_000) / 100 : undefined);
  return v;
}

/**
 * Every metric known for one UTC day: flow metrics within their source's retention, and stock metrics only when the
 * day is today or yesterday (a snapshot of now cannot stand for an older day). `keys` limits the work to those metrics.
 */
export async function computeDay(deps: Deps, day: string, keys: readonly MetricKey[] = PLATFORM_METRICS.map((m) => m.key)): Promise<MetricValues> {
  if (!isDay(day)) throw new RangeError(`not a day: ${day}`);
  const now = deps.now();
  const today = dayOf(now);
  const flowKeys = keys.filter((k) => BY_KEY.get(k)?.kind === "flow");
  const stockKeys = keys.filter((k) => BY_KEY.get(k)?.kind === "stock");
  const stockDay = day === today || day === addDays(today, -1);
  const [flows, stocks] = await Promise.all([
    flowKeys.length ? computeFlows(deps, day, day, now, flowKeys) : Promise.resolve(new Map<string, MetricValues>()),
    stockDay && stockKeys.length ? computeStocks(deps, day, stockKeys) : Promise.resolve({} as MetricValues),
  ]);
  return { ...flows.get(day), ...stocks };
}

// ---- write -----------------------------------------------------------------------------------------------------

export interface MetricRow { day: string; metric: MetricKey; value: number }

/** Upserts rows, 20 to a statement. Writes exactly one row per (day, metric). */
async function upsert(deps: Deps, rows: MetricRow[]) {
  const at = deps.now();
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const part = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, updatedAt: at }));
    await deps.db.insert(platformMetricsDaily).values(part).onConflictDoUpdate({
      target: [platformMetricsDaily.day, platformMetricsDaily.metric],
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
  }
}

const toRows = (byDay: Map<string, MetricValues>): MetricRow[] =>
  [...byDay].flatMap(([day, v]) => (Object.entries(v) as [MetricKey, number][]).map(([metric, value]) => ({ day, metric, value })));

export type RollResult =
  | { skipped: "up_to_date" | "writes_paused"; days: string[]; rows: MetricRow[] }
  | { skipped?: undefined; days: string[]; rows: MetricRow[] };

/**
 * The daily rollup, for runMaintenance. One indexed read when yesterday is already rolled (every pass but the first
 * after midnight UTC). Otherwise, unless optional writes are paused, it rolls the missing completed days (at most the
 * last 7): flow metrics for each, stock metrics for yesterday. Idempotent: upserts on (day, metric).
 */
export async function rollPlatformMetrics(deps: Deps, now: Date = deps.now()): Promise<RollResult> {
  const yesterday = addDays(dayOf(now), -1);
  // platform_metrics_daily_metric_idx (metric, day): max(day) for one metric is a single index probe.
  const last = (await deps.db.select({ day: max(platformMetricsDaily.day) }).from(platformMetricsDaily).where(eq(platformMetricsDaily.metric, ROLL_MARKER)).get())?.day ?? null;
  if (last && last >= yesterday) return { skipped: "up_to_date", days: [], rows: [] };
  if (await optionalWritesPaused(deps)) {
    deps.log?.warn("metrics.rollup_skipped", { reason: "writes_paused" });
    return { skipped: "writes_paused", days: [], rows: [] };
  }
  const earliest = addDays(yesterday, -(MAX_CATCH_UP_DAYS - 1));
  const from = last && addDays(last, 1) > earliest ? addDays(last, 1) : earliest;
  const byDay = await computeFlows(deps, from, yesterday, now);
  byDay.set(yesterday, { ...byDay.get(yesterday), ...(await computeStocks(deps, yesterday)) });
  const rows = toRows(byDay);
  await upsert(deps, rows);
  deps.log?.info("metrics.rollup", { from, to: yesterday, rows: rows.length });
  return { days: daysBetween(from, yesterday), rows };
}

/**
 * Recomputes flow metrics for the last `days` completed days (1 to 90) and upserts them. Stock metrics are never
 * written here. Days outside a metric's source retention are left as they are. Idempotent; refused while optional
 * writes are paused.
 */
export async function backfillFlowMetrics(deps: Deps, days: number): Promise<RollResult> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) throw new RangeError(`days must be a whole number from 1 to ${MAX_BACKFILL_DAYS}`);
  if (await optionalWritesPaused(deps)) return { skipped: "writes_paused", days: [], rows: [] };
  const now = deps.now();
  const to = addDays(dayOf(now), -1);
  const from = addDays(to, -(days - 1));
  const rows = toRows(await computeFlows(deps, from, to, now));
  await upsert(deps, rows);
  deps.log?.info("metrics.backfill", { from, to, rows: rows.length });
  return { days: daysBetween(from, to), rows };
}

// ---- read ------------------------------------------------------------------------------------------------------

function checkRange(from: string, to: string) {
  if (!isDay(from) || !isDay(to)) throw new RangeError("from and to must be days (YYYY-MM-DD)");
  if (from > to) throw new RangeError("from is after to");
  if (daysBetween(from, to).length > MAX_READ_DAYS) throw new RangeError(`at most ${MAX_READ_DAYS} days at once`);
}

export interface MetricsRead {
  from: string;
  to: string;
  /** Today (UTC) when the range includes it: its values are computed live, not stored. */
  liveDay: string | null;
  days: string[];
  /** One value per day, aligned with `days`. null: nothing stored (or computable) for that day. */
  series: Partial<Record<MetricKey, (number | null)[]>>;
  /** The first stored day per metric (null: none yet). For stock metrics, where their history starts. */
  firstDay: Partial<Record<MetricKey, string | null>>;
}

/**
 * Stored days for the asked metrics plus today computed live. Two indexed reads on platform_metrics_daily_metric_idx
 * and, when the range reaches today, computeDay for today (only the asked metrics). Days after today are left out.
 */
export async function readMetrics(deps: Deps, q: { metrics: readonly string[]; from: string; to: string }): Promise<MetricsRead> {
  const keys = [...new Set(q.metrics)];
  const bad = keys.filter((k) => !isMetricKey(k));
  if (bad.length) throw new RangeError(`unknown metric: ${bad.join(", ")}`);
  if (!keys.length) throw new RangeError("no metrics asked for");
  checkRange(q.from, q.to);
  const metrics = keys as MetricKey[];
  const today = dayOf(deps.now());
  const to = q.to > today ? today : q.to;
  const days = q.from > to ? [] : daysBetween(q.from, to);
  const t = platformMetricsDaily;
  const [stored, first, live] = await Promise.all([
    days.length ? deps.db.select({ day: t.day, metric: t.metric, value: t.value }).from(t)
      .where(and(inArray(t.metric, [...metrics]), gte(t.day, q.from), lte(t.day, to))) : Promise.resolve([]),
    deps.db.select({ metric: t.metric, day: min(t.day) }).from(t).where(inArray(t.metric, [...metrics])).groupBy(t.metric),
    days.length && to === today ? computeDay(deps, today, metrics) : Promise.resolve(null),
  ]);
  const at = new Map(days.map((d, i) => [d, i]));
  const series: MetricsRead["series"] = {};
  for (const k of metrics) series[k] = days.map(() => null);
  for (const r of stored) {
    const i = at.get(r.day);
    if (i !== undefined && r.day !== today) series[r.metric as MetricKey]![i] = r.value;
  }
  if (live) {
    const i = at.get(today)!;
    for (const k of metrics) series[k]![i] = live[k] ?? null;
  }
  const firstDay: MetricsRead["firstDay"] = {};
  for (const k of metrics) firstDay[k] = null;
  for (const r of first) if (r.day) firstDay[r.metric as MetricKey] = r.day;
  return { from: q.from, to, liveDay: live ? today : null, days, series, firstDay };
}

export interface WorkspaceTrends {
  from: string;
  to: string;
  days: string[];
  /**
   * One value per day, aligned with `days`: deliveries_sent, deliveries_failed, deliveries_received (complete, so 0 is
   * a real 0), ai_calls and ai_units (null before ai_usage_daily's 2 day retention), and `usage:<metric>` for each
   * daily usage counter the workspace has (null on a day with no counter row).
   */
  series: Record<string, (number | null)[]>;
}

/**
 * One workspace's trends, computed on read with no table of its own: three indexed reads (deliveries_org_idx,
 * the ai_usage_daily and usage_counters primary keys).
 */
export async function readWorkspaceTrends(deps: Deps, orgId: string, q: { from: string; to: string }): Promise<WorkspaceTrends> {
  checkRange(q.from, q.to);
  const today = dayOf(deps.now());
  const to = q.to > today ? today : q.to;
  const days = q.from > to ? [] : daysBetween(q.from, to);
  if (!days.length) return { from: q.from, to, days, series: {} };
  const start = new Date(startOf(q.from));
  const end = new Date(startOf(to) + DAY_MS);
  const db = deps.db;
  const aiRows = [orgId, `ask:${orgId}`, `socialwrite:${orgId}`];
  const [mail, ai, counters] = await Promise.all([
    db.select({
      day: dayExpr(deliveries.createdAt),
      sent: sql<number>`sum(case when ${deliveries.direction} = 'outbound' and ${deliveries.status} not in ('failed', 'rejected', 'suppressed') then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${deliveries.direction} = 'outbound' and ${deliveries.status} in ('failed', 'rejected', 'bounced') then 1 else 0 end)`,
      received: sql<number>`sum(case when ${deliveries.direction} = 'inbound' then 1 else 0 end)`,
    }).from(deliveries).where(and(eq(deliveries.orgId, orgId), gte(deliveries.createdAt, start), lt(deliveries.createdAt, end))).groupBy(sql`1`),
    // The workspace's own row holds its tools AI units; its Ask and social writing rows count questions and posts, so
    // they add calls but not units.
    db.select({ day: aiUsageDaily.day, calls: sql<number>`sum(${aiUsageDaily.calls})`, units: sql<number>`sum(case when ${aiUsageDaily.orgId} = ${orgId} then ${aiUsageDaily.units} else 0 end)` })
      .from(aiUsageDaily).where(and(gte(aiUsageDaily.day, q.from), lte(aiUsageDaily.day, to), inArray(aiUsageDaily.orgId, [...aiRows]))).groupBy(aiUsageDaily.day),
    db.select({ day: usageCounters.period, metric: usageCounters.metric, n: usageCounters.count }).from(usageCounters)
      .where(and(eq(usageCounters.orgId, orgId), gte(usageCounters.period, q.from), lte(usageCounters.period, to), sql`length(${usageCounters.period}) = 10`)),
  ]);
  const mailBy = new Map(mail.map((r) => [r.day, r]));
  const aiBy = new Map(ai.map((r) => [r.day, r]));
  const aiFrom = addDays(today, -BY_KEY.get("ai_calls")!.retentionDays!);
  const series: Record<string, (number | null)[]> = {
    deliveries_sent: days.map((d) => num(mailBy.get(d)?.sent)),
    deliveries_failed: days.map((d) => num(mailBy.get(d)?.failed)),
    deliveries_received: days.map((d) => num(mailBy.get(d)?.received)),
    ai_calls: days.map((d) => (d < aiFrom ? null : num(aiBy.get(d)?.calls))),
    ai_units: days.map((d) => (d < aiFrom ? null : num(aiBy.get(d)?.units))),
  };
  const at = new Map(days.map((d, i) => [d, i]));
  for (const r of counters) {
    const key = `usage:${r.metric}`;
    const s = (series[key] ??= days.map(() => null));
    const i = at.get(r.day);
    if (i !== undefined) s[i] = num(r.n);
  }
  return { from: q.from, to, days, series };
}

/** For callers that filter a metric list from a query string. */
export const metricDef = (k: MetricKey) => BY_KEY.get(k)!;
