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
 * tick, so each pass also has its own limit, CRON_STEP_MS, for true hangs only. A pass past its limit is reported as
 * timed out and the next one starts; it can't be cancelled, so it is handed to `keepAlive` (the Worker's waitUntil) to
 * finish rather than be cut off mid write, with its later failure reported.
 * W3 (round 2): the limit no longer shrinks to what is left of the budget (that gave late passes seconds, and cut a
 * digest pass between sending and saving its next time, so the digest went twice); instead a pass is not started with
 * less than CRON_MIN_START_MS of the budget left. And a pass that reports its own error (lazy, guard) flushes too.
 */
import type { Deps } from "../context";

export interface CronStep { name: string; run: () => Promise<unknown> }

export const CRON_BUDGET_MS = 10 * 60_000;
/** F3: the longest one pass may hold the sequence. */
export const CRON_STEP_MS = 3 * 60_000;
/** W3: no pass starts with less than this left of the budget. Budget plus one pass limit stays under the 15 minutes a cron invocation may run. */
export const CRON_MIN_START_MS = 60_000;

const TIMED_OUT = Symbol("timed out");

export async function runCronSteps(
  deps: Deps,
  steps: CronStep[],
  opts: { budgetMs?: number; stepMs?: number; clock?: () => number; flush?: () => Promise<unknown>; keepAlive?: (p: Promise<unknown>) => void } = {},
): Promise<{ ran: string[]; skipped: string[]; timedOut: string[] }> {
  const clock = opts.clock ?? (() => Date.now());
  const budget = opts.budgetMs ?? CRON_BUDGET_MS;
  const limit = opts.stepMs ?? CRON_STEP_MS;
  const start = clock();
  const ran: string[] = [];
  const skipped: string[] = [];
  const timedOut: string[] = [];
  // W3: passes wrapped by lazy or guard report their own errors and resolve; count reports to know a pass had trouble.
  const realReport = deps.reportError;
  let reports = 0;
  if (realReport) deps.reportError = (err, context) => { reports++; realReport(err, context); };
  try {
    for (const step of steps) {
      const left = budget - (clock() - start);
      if (left < Math.min(CRON_MIN_START_MS, budget)) { skipped.push(step.name); continue; }
      const before = reports;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let troubled = false;
      const running = Promise.resolve().then(() => step.run()); // a pass that throws at once counts as failed
      try {
        const out = await Promise.race([
          running,
          new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), limit); }),
        ]);
        if (out === TIMED_OUT) {
          troubled = true;
          timedOut.push(step.name);
          deps.log?.warn("cron.step_timed_out", { step: step.name, limitMs: limit });
          deps.reportError?.(new Error(`cron step ${step.name} did not finish within ${limit} ms`), { where: `cron.${step.name}` });
          // W3: left running, it may still finish its write; kept alive and its failure reported, never cut off silently.
          const tail = running.catch((err: unknown) => {
            deps.log?.warn("cron.step_failed_late", { step: step.name, error: err instanceof Error ? err.message : String(err) });
            (realReport ?? deps.reportError)?.(err, { where: `cron.${step.name}` });
          });
          opts.keepAlive?.(tail);
        }
      } catch (err) {
        troubled = true;
        deps.log?.warn("cron.step_failed", { step: step.name, error: err instanceof Error ? err.message : String(err) });
        deps.reportError?.(err, { where: `cron.${step.name}` });
      } finally {
        if (timer) clearTimeout(timer);
      }
      ran.push(step.name);
      // F3, W3: what was reported so far goes out now (the pass's own reports too), so a later pass that hangs the
      // invocation can't lose it.
      if ((troubled || reports > before) && opts.flush) await opts.flush().catch(() => undefined);
    }
  } finally {
    if (realReport) deps.reportError = realReport;
  }
  if (skipped.length) deps.log?.warn("cron.steps_skipped", { skipped, budgetMs: budget });
  return { ran, skipped, timedOut };
}
