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
 * overlap. F3: a pass that never settles would otherwise hold every later pass (and the final report flush) on every
 * tick, so each pass also has its own limit: CRON_STEP_MS, or what is left of the budget if that is less. A pass past
 * its limit is reported as timed out and the next one starts; it cannot be cancelled, but nothing waits on it.
 */
import type { Deps } from "../context";

export interface CronStep { name: string; run: () => Promise<unknown> }

export const CRON_BUDGET_MS = 10 * 60_000;
/** F3: the longest one pass may hold the sequence. */
export const CRON_STEP_MS = 3 * 60_000;

const TIMED_OUT = Symbol("timed out");

export async function runCronSteps(
  deps: Deps,
  steps: CronStep[],
  opts: { budgetMs?: number; stepMs?: number; clock?: () => number; flush?: () => Promise<unknown> } = {},
): Promise<{ ran: string[]; skipped: string[]; timedOut: string[] }> {
  const clock = opts.clock ?? (() => Date.now());
  const budget = opts.budgetMs ?? CRON_BUDGET_MS;
  const perStep = opts.stepMs ?? CRON_STEP_MS;
  const start = clock();
  const ran: string[] = [];
  const skipped: string[] = [];
  const timedOut: string[] = [];
  for (const step of steps) {
    const left = budget - (clock() - start);
    if (left <= 0) { skipped.push(step.name); continue; }
    const limit = Math.min(perStep, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let troubled = false;
    try {
      const out = await Promise.race([
        step.run(),
        new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), limit); }),
      ]);
      if (out === TIMED_OUT) {
        troubled = true;
        timedOut.push(step.name);
        deps.log?.warn("cron.step_timed_out", { step: step.name, limitMs: limit });
        deps.reportError?.(new Error(`cron step ${step.name} did not finish within ${limit} ms`), { where: `cron.${step.name}` });
      }
    } catch (err) {
      troubled = true;
      deps.log?.warn("cron.step_failed", { step: step.name, error: err instanceof Error ? err.message : String(err) });
      deps.reportError?.(err, { where: `cron.${step.name}` });
    } finally {
      if (timer) clearTimeout(timer);
    }
    ran.push(step.name);
    // F3: what was reported so far goes out now, so a later pass that hangs the invocation cannot lose it.
    if (troubled && opts.flush) await opts.flush().catch(() => undefined);
  }
  if (skipped.length) deps.log?.warn("cron.steps_skipped", { skipped, budgetMs: budget });
  return { ran, skipped, timedOut };
}
