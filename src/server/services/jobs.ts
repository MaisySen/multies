/**
 * Durable background jobs in D1 (the transactional outbox pattern). Work that talks to
 * a provider that may be down, such as sending mail, is recorded here and retried
 * with exponential backoff and jitter until it succeeds or runs out of attempts. Then
 * it moves to the dead-letter state, where an operator can read the error and
 * replay it from the console.
 *
 * Why D1 and not Cloudflare Queues: the same code runs on Workers (cron every 5
 * minutes plus a drain after each request), on Node (a timer) and on the hosted
 * preview, which cannot bind a queue. docs/architecture/queues.md covers the swap.
 */
import { and, asc, desc, eq, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { jobs } from "../db/schema";
import { newId } from "../lib/crypto";

export type JobType = "mail.deliver" | "system-mail.send" | "push.send" | "demo.seed_suite" | `test.${string}`;

export class RetryableJobError extends Error {}
export class PermanentJobError extends Error {}

export interface JobContext { id: string; attempts: number; maxAttempts: number; orgId: string | null }
type Handler = (deps: Deps, payload: unknown, job: JobContext) => Promise<void>;
type DeadHandler = (deps: Deps, payload: unknown, job: JobContext, error: string) => Promise<void>;

const handlers = new Map<string, { run: Handler; onDead?: DeadHandler }>();

export function registerJob(type: JobType, run: Handler, onDead?: DeadHandler) {
  handlers.set(type, { run, onDead });
}

/** Delay before retry n (1-based): 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h, 24 h (about 52 hours in all). */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 43_200_000, 86_400_000];

export function backoff(attempt: number, random = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  // Up to 20% jitter so retries after an outage do not arrive all at once.
  return Math.round(base * (1 + random() * 0.2));
}

export async function enqueue(deps: Deps, type: JobType, payload: unknown, opts: { orgId?: string | null; delayMs?: number; maxAttempts?: number } = {}) {
  const id = newId("job");
  await deps.db.insert(jobs).values({
    id, type, orgId: opts.orgId ?? null, payload: JSON.stringify(payload), status: "pending",
    maxAttempts: opts.maxAttempts ?? BACKOFF_MS.length + 1, runAt: new Date(deps.now().getTime() + (opts.delayMs ?? 0)),
    createdAt: deps.now(), updatedAt: deps.now(),
  });
  return id;
}

const LEASE_MS = 2 * 60_000;
/** Jobs that run inside a visitor's request get a short lease, so one cut off by the CPU limit is picked up again by their next request. */
const SHORT_LEASE: Partial<Record<JobType, number>> = { "demo.seed_suite": 15_000 };

/**
 * Runs due jobs. Each job is claimed with a conditional update (a lease), so two
 * workers running at once never take the same job; a crashed worker's lease expires
 * and the job runs again.
 */
export async function runDueJobs(deps: Deps, limit = 25, only: { types?: JobType[]; excludeTypes?: JobType[]; orgId?: string; budgetMs?: number } = {}): Promise<{ ran: number; failed: number; dead: number }> {
  const now = deps.now();
  const started = Date.now();
  const due = await deps.db.select().from(jobs).where(and(
    or(
      and(eq(jobs.status, "pending"), lte(jobs.runAt, now)),
      and(eq(jobs.status, "running"), lt(jobs.lockedUntil, now)),
    ),
    only.types ? inArray(jobs.type, only.types) : undefined,
    only.excludeTypes ? notInArray(jobs.type, only.excludeTypes) : undefined,
    only.orgId ? eq(jobs.orgId, only.orgId) : undefined,
  )).orderBy(asc(jobs.runAt)).limit(limit);
  let ran = 0, failed = 0, dead = 0;
  for (const job of due) {
    // Leave the rest for the next run rather than run past this invocation's budget.
    if (only.budgetMs !== undefined && Date.now() - started > only.budgetMs) break;
    const lease = new Date(now.getTime() + (SHORT_LEASE[job.type as JobType] ?? LEASE_MS));
    const claimed = await deps.db.update(jobs).set({ status: "running", lockedUntil: lease, updatedAt: now })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, job.status), job.lockedUntil ? eq(jobs.lockedUntil, job.lockedUntil) : sql`${jobs.lockedUntil} IS NULL`))
      .returning({ id: jobs.id });
    if (!claimed.length) continue;
    const attempts = job.attempts + 1;
    const ctx: JobContext = { id: job.id, attempts, maxAttempts: job.maxAttempts, orgId: job.orgId };
    const h = handlers.get(job.type);
    try {
      if (!h) throw new PermanentJobError(`No handler for job type ${job.type}`);
      await h.run(deps, JSON.parse(job.payload), ctx);
      await deps.db.update(jobs).set({ status: "done", attempts, lockedUntil: null, lastError: null, updatedAt: deps.now() }).where(eq(jobs.id, job.id));
      ran++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const permanent = err instanceof PermanentJobError;
      if (permanent || attempts >= job.maxAttempts) {
        await deps.db.update(jobs).set({ status: "dead", attempts, lockedUntil: null, lastError: message, updatedAt: deps.now() }).where(eq(jobs.id, job.id));
        dead++;
        deps.log?.error("job.dead", { jobId: job.id, type: job.type, attempts, error: message });
        await h?.onDead?.(deps, JSON.parse(job.payload), ctx, message).catch((e) => deps.log?.error("job.on_dead_failed", { jobId: job.id, error: e }));
      } else {
        await deps.db.update(jobs).set({
          status: "pending", attempts, lockedUntil: null, lastError: message, runAt: new Date(deps.now().getTime() + backoff(attempts)), updatedAt: deps.now(),
        }).where(eq(jobs.id, job.id));
        failed++;
        deps.log?.warn("job.retry", { jobId: job.id, type: job.type, attempts, error: message });
      }
    }
  }
  return { ran, failed, dead };
}

/** Moves dead jobs back to pending with a fresh attempt budget. */
export async function replayJobs(deps: Deps, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await deps.db.update(jobs).set({ status: "pending", attempts: 0, runAt: deps.now(), lastError: null, updatedAt: deps.now() })
    .where(and(inArray(jobs.id, ids), eq(jobs.status, "dead"))).returning({ id: jobs.id });
  return rows.length;
}

export async function queueStats(deps: Deps) {
  const rows = (await deps.db.select({ status: jobs.status, n: sql<number>`count(*)`, oldest: sql<number>`min(${jobs.runAt})` })
    .from(jobs).groupBy(jobs.status)) as { status: string; n: number; oldest: number | null }[];
  const get = (s: string) => rows.find((r) => r.status === s);
  const oldestPending = get("pending")?.oldest;
  return {
    pending: Number(get("pending")?.n ?? 0),
    running: Number(get("running")?.n ?? 0),
    dead: Number(get("dead")?.n ?? 0),
    oldestPendingAgeMs: oldestPending ? Math.max(0, deps.now().getTime() - Number(oldestPending)) : 0,
  };
}

export async function listJobs(deps: Deps, status: "pending" | "running" | "dead" | "done", limit = 50) {
  return deps.db.select().from(jobs).where(eq(jobs.status, status)).orderBy(desc(jobs.updatedAt)).limit(limit);
}

/** Drops finished jobs after 7 days; dead jobs are kept 30 days for inspection. */
export async function pruneJobs(deps: Deps) {
  const now = deps.now().getTime();
  await deps.db.delete(jobs).where(or(
    and(eq(jobs.status, "done"), lt(jobs.updatedAt, new Date(now - 7 * 86_400_000))),
    and(eq(jobs.status, "dead"), lt(jobs.updatedAt, new Date(now - 30 * 86_400_000))),
  ));
}
