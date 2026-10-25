/**
 * The daily D1 write budget. Cloudflare's Free plan allows 100,000 rows written per day per account
 * (reset at 00:00 UTC), and production and staging share that account. On 24 October 2026 staging's
 * test runs and demo seeds took about 69,000 of them and production went read only by 03:00 UTC.
 *
 * This reads the account wide count from Cloudflare's GraphQL analytics (read only, no database
 * writes), keeps it per isolate for a few minutes, and turns it into a level:
 *   ok     below `warnAt` of the budget
 *   warn   from `warnAt`: alert, and staging (WRITE_BUDGET_GUARD=strict) refuses writes
 *   shed   from `shedAt`: production stops the optional writers too (new demo workspaces)
 *   off    no analytics token configured, so nothing is known and nothing is refused
 * Sign in and normal work on production are never refused here; only optional writers stop.
 */
import type { Deps } from "../context";

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
}

const CACHE_MS = 5 * 60_000;
let cached: { key: string; at: number; reading: WriteBudgetReading } | null = null;
let inflight: Promise<WriteBudgetReading> | null = null;
const alerted = new Set<string>();

/** Test hook: forget the cached reading and the alerts sent. */
export function resetWriteBudgetCache() { cached = null; inflight = null; alerted.clear(); }

export function levelFor(rowsWritten: number, cfg: Deps["config"]["writeBudget"]): WriteBudgetLevel {
  if (rowsWritten >= cfg.daily * cfg.shedAt) return "shed";
  if (rowsWritten >= cfg.daily * cfg.warnAt) return "warn";
  return "ok";
}

// The date is a dimension and an exact filter: grouped only by database with date_geq, the analytics API
// answered 111 rows for 25 Oct while the same day grouped by date read 13,550 (checked 25 Oct 00:30 UTC).
const QUERY = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:50,filter:{date:$d}){sum{rowsWritten} dimensions{databaseId date}}}}}`;

async function fetchReading(deps: Deps): Promise<WriteBudgetReading> {
  const cfg = deps.config.writeBudget;
  const now = deps.now();
  const res = await deps.fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { a: cfg.accountId, d: now.toISOString().slice(0, 10) } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`analytics answered ${res.status}`);
  const json = (await res.json()) as { data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: { sum: { rowsWritten: number }; dimensions: { databaseId: string } }[] }[] } }; errors?: { message: string }[] | null };
  if (json.errors?.length) throw new Error(`analytics: ${json.errors[0].message}`);
  const groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (!groups) throw new Error("analytics: no D1 data in the answer");
  const byDatabase: Record<string, number> = {};
  for (const g of groups) byDatabase[g.dimensions.databaseId] = (byDatabase[g.dimensions.databaseId] ?? 0) + (g.sum.rowsWritten ?? 0);
  const rowsWritten = Object.values(byDatabase).reduce((a, n) => a + n, 0);
  return { level: levelFor(rowsWritten, cfg), rowsWritten, budget: cfg.daily, byDatabase, at: now.toISOString() };
}

/**
 * The current reading, from cache when it is under five minutes old. Never throws: a failed read
 * keeps the last good reading (or answers "off"), so a slow analytics API cannot break a request.
 */
export async function writeBudget(deps: Deps, opts: { fresh?: boolean } = {}): Promise<WriteBudgetReading> {
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

/**
 * The scheduled check: one log line with the count (searchable in Workers Logs as d1.write_budget),
 * and an error report once per level per UTC day per isolate when the count passes a threshold.
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
  }
  return r;
}
