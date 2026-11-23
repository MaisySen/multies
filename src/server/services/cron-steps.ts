/**
 * MPLAT-96 (D1 load): the cron passes, one after another. The scheduled handler used to hand about ten database
 * passes to ctx.waitUntil at once (maintenance, the Tools passes, retention, invoices, courses, Team AI, digests), so
 * every 15 minute tick opened them all in the same second, on production and staging together; every D1 error Sentry
 * saw in the week to 12 Nov 2026 landed in the first minute of such a tick. Now each pass starts when the one before
 * it ends, so the database sees one pass at a time. A cron invocation may run 15 minutes of wall time and its CPU
 * time does not grow by waiting, so running in order costs nothing but a few seconds of wall time.
 *
 * Each pass keeps its own error handling: one that throws is reported and the next one still runs. A pass not
 * started within the time budget (10 minutes, well before the next tick) is skipped and logged, so two ticks never
 * overlap.
 */
import type { Deps } from "../context";

export interface CronStep { name: string; run: () => Promise<unknown> }

export const CRON_BUDGET_MS = 10 * 60_000;

export async function runCronSteps(deps: Deps, steps: CronStep[], opts: { budgetMs?: number; clock?: () => number } = {}): Promise<{ ran: string[]; skipped: string[] }> {
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
