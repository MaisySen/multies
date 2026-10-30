/**
 * The daily D1 write budget. Cloudflare's Free plan allows 100,000 rows written per day per account
 * (reset at 00:00 UTC), and production and staging share that account. On 24 October 2026 staging's
 * test runs and demo seeds took about 69,000 of them and production went read only by 03:00 UTC.
 *
 * This reads the account wide count from Cloudflare's GraphQL analytics (read only, no database
 * writes), keeps it per isolate for a few minutes, and turns it into a level:
 *   ok     below `warnAt` of the budget
 *   warn   from `warnAt`: alert, and staging (WRITE_BUDGET_GUARD=strict) refuses writes
 *   shed   from `shedAt`: production stops the optional writers too (new demo workspaces) and skips
 *          deferrable writes (services/write-priority.ts: visits, read markers, last used touches)
 *   off    no analytics token configured, so nothing is known and nothing is refused
 * Sign in and normal work on production are never refused here; only optional writers stop.
 *
 * R32: no local fallback counter. A count of this isolate's own writes would see a sliver of one database,
 * never staging, so it would read "ok" on exactly the day it matters. When analytics cannot be read the last
 * good reading for the day stands; when D1 itself refuses a write for the daily limit (`noteD1LimitHit`, from
 * the app's error handler) the level is "shed" for the rest of the UTC day whatever analytics say.
 */
import type { Deps } from "../context";
import { appSettings } from "../db/schema";

/** R32: the two D1 databases on the account (wrangler.toml), so the meter can say production or staging. */
export const DATABASE_LABELS: Record<string, string> = {
  "e467919b-f7d8-4961-86b9-9cd861708efc": "production",
  "72494627-4880-4fb9-9586-e2175f16e8d3": "staging",
};

/** The reading as /api/health shows it: counts by environment, never database ids. */
export function healthView(r: WriteBudgetReading, cfg: Pick<Deps["config"]["writeBudget"], "warnAt" | "shedAt">, now: Date) {
  const byEnvironment: Record<string, number> = {};
  for (const [id, n] of Object.entries(r.byDatabase)) { const k = DATABASE_LABELS[id] ?? "other"; byEnvironment[k] = (byEnvironment[k] ?? 0) + n; }
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return {
    today: r.rowsWritten, budget: r.budget, level: r.level, at: r.at,
    pct: Math.round((r.rowsWritten / r.budget) * 1000) / 10,
    warnAt: Math.round(cfg.warnAt * 100), shedAt: Math.round(cfg.shedAt * 100),
    resetAt: next.toISOString(), byEnvironment,
  };
}

/** R61a: against the configured daily read budget (D1_DAILY_READ_BUDGET: the Free plan's 5M by default, larger on Workers Paid). */
export function readsView(rowsRead: number | undefined, cfg: { readsDaily: number; readsWarnAt: number } = { readsDaily: D1_DAILY_READS, readsWarnAt: READ_BUDGET_WARN_PCT / 100 }) {
  if (rowsRead === undefined) return null;
  const pct = Math.round((rowsRead / cfg.readsDaily) * 1000) / 10;
  const warnAt = Math.round(cfg.readsWarnAt * 100);
  return { today: rowsRead, budget: cfg.readsDaily, pct, level: pct >= 100 ? "limit" : pct >= warnAt ? "warn" : "ok", warnAt, loadStopAt: READ_BUDGET_LOAD_STOP_PCT };
}

/** R32: alert and degrade from 60% (warn) and 85% (shed) of the daily budget, unless overridden by env. */
export const WRITE_BUDGET_WARN_PCT = 60;
export const WRITE_BUDGET_SHED_PCT = 85;

export type WriteBudgetLevel = "ok" | "warn" | "shed" | "off";

export interface WriteBudgetReading {
  level: WriteBudgetLevel;
  /** Rows written today (UTC) across every D1 database on the account. */
  rowsWritten: number;
  budget: number;
  /** Rows written today per database id. */
  byDatabase: Record<string, number>;
  /** When the count was read (ISO). */
  at: string;
  /** R39: rows read today (UTC) across the account. The free plan blocks every read past 5 million a day. */
  rowsRead?: number;
}

/** R39: D1's free plan daily rows read limit (account wide). Past it every query that reads a row fails until 00:00 UTC. */
export const D1_DAILY_READS = 5_000_000;
/** R39: /api/health warns from 60% of it; load and QA scripts refuse to run from 50% (load/reads-guard.mjs). */
export const READ_BUDGET_WARN_PCT = 60;
export const READ_BUDGET_LOAD_STOP_PCT = 50;

// R61a: one minute (was five). On 30 Oct a 1.1M row burst landed after the cached reading and health kept showing 57.7%.
const CACHE_MS = 60_000;
let cached: { key: string; at: number; reading: WriteBudgetReading } | null = null;
let inflight: Promise<WriteBudgetReading> | null = null;
const alerted = new Set<string>();

let limitHitDay: string | null = null;

/** Test hook: forget the cached reading and the alerts sent. */
export function resetWriteBudgetCache() { cached = null; inflight = null; alerted.clear(); limitHitDay = null; }

/**
 * R32: D1 refused a write for the daily limit. Until 00:00 UTC this isolate treats the budget as spent
 * (level "shed"), so deferrable writes stop at once instead of failing one by one.
 */
export function noteD1LimitHit(now: Date = new Date()) { limitHitDay = now.toISOString().slice(0, 10); }

/** Seconds until the daily budget resets (00:00 UTC). */
export function secondsUntilReset(now: Date) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, Math.round((next - now.getTime()) / 1000));
}

export function levelFor(rowsWritten: number, cfg: Deps["config"]["writeBudget"]): WriteBudgetLevel {
  if (rowsWritten >= cfg.daily * cfg.shedAt) return "shed";
  if (rowsWritten >= cfg.daily * cfg.warnAt) return "warn";
  return "ok";
}

// The date is a dimension and an exact filter: grouped only by database with date_geq, the analytics API
// answered 111 rows for 25 Oct while the same day grouped by date read 13,550 (checked 25 Oct 00:30 UTC).
// R61a: the day is now summed from its hours (datetime range, grouped by hour and database). The per date total lags:
// at 01:50 UTC on 30 Oct it still said 2.88M rows read while the hours (and the minute 01:34) already held 3.35M more.
const QUERY = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:200,filter:{datetime_geq:$s,datetime_lt:$e}){sum{rowsWritten rowsRead} dimensions{databaseId datetimeHour}}}}}`;

async function fetchReading(deps: Deps): Promise<WriteBudgetReading> {
  const cfg = deps.config.writeBudget;
  const now = deps.now();
  const res = await deps.fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { a: cfg.accountId, s: `${now.toISOString().slice(0, 10)}T00:00:00Z`, e: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString() } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`analytics answered ${res.status}`);
  const json = (await res.json()) as { data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: { sum: { rowsWritten: number; rowsRead?: number }; dimensions: { databaseId: string } }[] }[] } }; errors?: { message: string }[] | null };
  if (json.errors?.length) throw new Error(`analytics: ${json.errors[0].message}`);
  const groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (!groups) throw new Error("analytics: no D1 data in the answer");
  const byDatabase: Record<string, number> = {};
  for (const g of groups) byDatabase[g.dimensions.databaseId] = (byDatabase[g.dimensions.databaseId] ?? 0) + (g.sum.rowsWritten ?? 0);
  const rowsWritten = Object.values(byDatabase).reduce((a, n) => a + n, 0);
  const rowsRead = groups.reduce((a, g) => a + (g.sum.rowsRead ?? 0), 0);
  return { level: levelFor(rowsWritten, cfg), rowsWritten, budget: cfg.daily, byDatabase, at: now.toISOString(), rowsRead };
}

/**
 * The current reading, from cache when it is under five minutes old. Never throws: a failed read
 * keeps the last good reading (or answers "off"), so a slow analytics API cannot break a request.
 */
export async function writeBudget(deps: Deps, opts: { fresh?: boolean } = {}): Promise<WriteBudgetReading> {
  const r = await readWriteBudget(deps, opts);
  if (limitHitDay && limitHitDay === deps.now().toISOString().slice(0, 10) && r.level !== "shed") {
    return { ...r, level: "shed", rowsWritten: Math.max(r.rowsWritten, r.budget) };
  }
  return r;
}

async function readWriteBudget(deps: Deps, opts: { fresh?: boolean }): Promise<WriteBudgetReading> {
  const cfg = deps.config.writeBudget;
  const off: WriteBudgetReading = { level: "off", rowsWritten: 0, budget: cfg.daily, byDatabase: {}, at: deps.now().toISOString() };
  if (!cfg.token || !cfg.accountId) return off;
  const key = `${cfg.accountId}:${deps.now().toISOString().slice(0, 10)}`;
  if (!opts.fresh && cached && cached.key === key && deps.now().getTime() - cached.at < CACHE_MS) return cached.reading;
  if (!inflight) {
    inflight = fetchReading(deps).finally(() => { inflight = null; });
  }
  try {
    const reading = await inflight;
    cached = { key, at: deps.now().getTime(), reading };
    return reading;
  } catch (err) {
    deps.log?.warn("d1.write_budget_unread", { error: err instanceof Error ? err.message : String(err) });
    return cached && cached.key === key ? cached.reading : off;
  }
}

/** The last reading this isolate holds, without a network call (for /api/health). */
export function cachedWriteBudget(): WriteBudgetReading | null { return cached?.reading ?? null; }

/** True when optional writers (new demo workspaces) should wait until tomorrow. */
export async function optionalWritesPaused(deps: Deps): Promise<boolean> {
  const r = await writeBudget(deps);
  if (r.level === "shed") return true;
  return r.level === "warn" && deps.config.writeBudget.strict;
}

/** "Multies D1 writes at 60% today (60,123 of 100,000)": the alert's subject line. */
export function alertSubject(appName: string, r: Pick<WriteBudgetReading, "rowsWritten" | "budget" | "level">, cfg: Pick<Deps["config"]["writeBudget"], "warnAt" | "shedAt">) {
  const pct = Math.round((r.level === "shed" ? cfg.shedAt : cfg.warnAt) * 100);
  const n = (x: number) => x.toLocaleString("en-US");
  return `${appName} D1 writes at ${pct}% today (${n(r.rowsWritten)} of ${n(r.budget)})`;
}

/**
 * R32: the alert mail, once per level per UTC day for the whole deployment. The dedupe is one app_settings row
 * per alert (at most 2 rows a day, essential), claimed with INSERT OR IGNORE so two isolates cannot both send.
 * If D1 refuses that write (the cap itself), the per isolate memory still sends it once.
 */
async function sendAlert(deps: Deps, r: WriteBudgetReading, fields: Record<string, unknown>) {
  const day = r.at.slice(0, 10);
  const key = `d1_alert:${day}:${r.level}`;
  let claimed = true;
  try {
    const res = await deps.db.insert(appSettings).values({ key, value: String(r.rowsWritten) }).onConflictDoNothing().returning({ key: appSettings.key });
    claimed = res.length > 0;
  } catch (err) {
    deps.log?.warn("d1.write_budget_alert_unclaimed", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!claimed) return false;
  const to = deps.config.writeBudget.alertTo;
  if (!to) return false;
  const cfg = deps.config.writeBudget;
  const byEnv = healthView(r, cfg, deps.now()).byEnvironment;
  const prod = Object.entries(byEnv).sort((a, b) => b[1] - a[1]).map(([env, n]) => `  ${env}: ${n.toLocaleString("en-US")} rows`).join("\n");
  const text = [
    `D1 rows written today (UTC) across the Cloudflare account: ${r.rowsWritten.toLocaleString("en-US")} of ${r.budget.toLocaleString("en-US")} (${fields.pct}%).`,
    `Level: ${r.level}. At ${Math.round(cfg.shedAt * 100)}% deferrable writes (visits, read markers, last used times) are skipped and new demo workspaces stop; mail, sign in and the work people do keep writing.`,
    `The budget resets at 00:00 UTC, in ${Math.round(secondsUntilReset(deps.now()) / 360) / 10} hours.`,
    prod ? `By environment:\n${prod}` : "",
    "What to do: docs/runbooks/d1-daily-limits.md, section \"D1 limit reached\". First stop any test runs and demo seeds against staging.",
  ].filter(Boolean).join("\n\n");
  try {
    const { sendSystemEmail } = await import("./system-mail");
    await sendSystemEmail(deps, { to, subject: alertSubject(deps.config.appName, r, cfg), text, template: "d1-write-budget" });
  } catch (err) {
    deps.log?.warn("d1.write_budget_alert_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/**
 * The scheduled check: one log line with the count (searchable in Workers Logs as d1.write_budget),
 * and an error report plus an alert mail once per level per UTC day when the count passes a threshold.
 */
export async function checkWriteBudget(deps: Deps) {
  const r = await writeBudget(deps, { fresh: true });
  if (r.level === "off") return r;
  const fields = { rowsWritten: r.rowsWritten, budget: r.budget, level: r.level, pct: Math.round((r.rowsWritten / r.budget) * 100), byDatabase: r.byDatabase };
  if (r.level === "ok") { deps.log?.info("d1.write_budget", fields); return r; }
  deps.log?.error("d1.write_budget", fields);
  const key = `${r.at.slice(0, 10)}:${r.level}`;
  if (!alerted.has(key)) {
    alerted.add(key);
    deps.reportError?.(new Error(`D1 writes today: ${r.rowsWritten} of ${r.budget} (${fields.pct}%), level ${r.level}`), { writeBudget: fields });
    // Passing straight from ok to shed sends the 60% mail too, so the inbox tells the whole story.
    if (r.level === "shed" && !alerted.has(`${r.at.slice(0, 10)}:warn`)) { alerted.add(`${r.at.slice(0, 10)}:warn`); await sendAlert(deps, { ...r, level: "warn" }, fields); }
    await sendAlert(deps, r, fields);
  }
  return r;
}
