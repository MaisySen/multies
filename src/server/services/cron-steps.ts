/**
 * MPLAT-96 (D1 load): the cron passes, one after another, under a single-holder database lease.
 *
 * The scheduled handler used to hand about ten database passes to ctx.waitUntil at once (maintenance, Tools passes,
 * retention, invoices, courses, Team AI, digests), so every 15 minute tick opened them all in the same second, on
 * production and staging together. Now each pass starts when the one before it ends, and a tick claims a conditional
 * lease in D1 before starting passes so overlapping ticks skip cleanly until the prior tick releases or expires.
 */
import { and, eq, lte } from "drizzle-orm";
import type { Deps } from "../context";
import { cronTickLeases } from "../db/schema";

export interface CronStep { name: string; run: () => Promise<unknown> }

export const CRON_BUDGET_MS = 10 * 60_000;
export const CRON_LEASE_TTL_MS = 12 * 60_000;

/**
 * Atomically claims (or takes over once expired) the named cron lease for `holder`.
 * Returns true only when `holder` owns the lease row after the statement finishes.
 */
export async function claimCronLease(
  deps: Deps,
  name: string,
  holder: string,
  ttlMs = CRON_LEASE_TTL_MS,
  nowMs = deps.now().getTime(),
): Promise<boolean> {
  const expiresAt = nowMs + ttlMs;
  const rows = await deps.db
    .insert(cronTickLeases)
    .values({ name, holder, expiresAt })
    .onConflictDoUpdate({
      target: cronTickLeases.name,
      set: { holder, expiresAt },
      setWhere: lte(cronTickLeases.expiresAt, nowMs),
    })
    .returning({ holder: cronTickLeases.holder });
  return rows.length > 0 && rows[0].holder === holder;
}

/** Releases the lease only if it is still held by `holder`. Returns true when a row was deleted. */
export async function releaseCronLease(deps: Deps, name: string, holder: string): Promise<boolean> {
  const rows = await deps.db
    .delete(cronTickLeases)
    .where(and(eq(cronTickLeases.name, name), eq(cronTickLeases.holder, holder)))
    .returning({ name: cronTickLeases.name });
  return rows.length > 0;
}

export async function runCronSteps(
  deps: Deps,
  steps: CronStep[],
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<{ ran: string[]; skipped: string[] }> {
  const clock = opts.clock ?? (() => Date.now());
  const budget = opts.budgetMs ?? CRON_BUDGET_MS;
  const start = clock();
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const step of steps) {
    if (clock() - start >= budget) { skipped.push(step.name); continue; }
    try {
      await step.run();
    } catch (err) {
      deps.log?.warn("cron.step_failed", { step: step.name, error: err instanceof Error ? err.message : String(err) });
      deps.reportError?.(err, { where: `cron.${step.name}` });
    }
    ran.push(step.name);
  }
  if (skipped.length) deps.log?.warn("cron.steps_skipped", { skipped, budgetMs: budget });
  return { ran, skipped };
}
