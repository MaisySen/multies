import { enforceGracePeriods } from "./billing/dunning";
import { isD1LimitError } from "../lib/d1-limit";
import { expireApprovals, pruneAgentEvents } from "./agents";
import { pruneImports } from "./import";
import { pruneDeliveries, retryDueDeliveries } from "./developer/webhooks";
import { and, eq, inArray, isNull, lte, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { appSettings } from "../db/schema";
import { migrationDriver, pendingMigrations } from "../db";
import { lt } from "drizzle-orm";
import { agentTriggers, automations, dataMoves, flowDigestItems, flowRuns, flowWatches, jobs, mailConnections, mailSchedules, organizations, sendApprovals, sessions, socialPosts, verifications, webhookDeliveries } from "../db/schema";
import { purgeDemoWorkspaces } from "./demo";
import { recheckStaleDomains } from "./domains";
import { checkWriteBudget } from "./write-budget";
import { randomToken } from "../lib/crypto";
import { pruneRateLimits } from "../lib/rate-limit";
import { pruneIdempotencyKeys } from "../lib/idempotency";
import { pruneLockouts } from "./lockout";
import { pruneJobs, runDueJobs } from "./jobs";
import { crossCheck, recordUptimeCheck } from "./status";
import "./mail/deliver-job";
import "./system-mail";
import "./suite/push";
import "./billing/referral-job";

/**
 * Periodic housekeeping: drain the job queue, record the uptime self check, re-check
 * DNS, expire sessions, purge old sandboxes, apply billing grace periods and prune
 * short-lived tables. Each step is isolated so one failure cannot stop the others.
 */
export async function runMaintenance(deps: Deps, opts: { rotate?: boolean; probe?: boolean } = {}) {
  // R50 (CPU limit): the 15 minute cron pass cost the Worker 50 to 60 ms of CPU, about 27 statements each time. With
  // rotate (the cron sets it) housekeeping that can wait an hour runs in one of the four passes of each hour, a
  // different group each quarter, so a pass carries about 10 fewer statements. Work people wait on (jobs, mail,
  // imports, reminders, triggers, webhook retries, approvals) still runs every pass. Without rotate everything runs.
  const slot = opts.rotate ? Math.floor(deps.now().getUTCMinutes() / 15) : -1;
  // R51 (CPU): most passes find nothing to do. With probe (the cron sets it, through rotate) one statement asks which
  // of the steps below have anything waiting, and a step with nothing waiting is skipped (about 10 statements to 1 on
  // an idle pass). If the probe itself fails, every step runs as before.
  const has = (opts.probe ?? opts.rotate) ? await probeWaiting(deps) : ALL_WAITING;
  const inSlot = (k: number) => slot < 0 || slot === k;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (err) {
      // A busy or briefly unavailable database is not a bug: the step runs again on the next pass.
      if (isTransientDbError(err) || isD1LimitError(err)) { deps.log?.warn("maintenance.step_skipped", { step: name, error: err }); return undefined; }
      deps.log?.error("maintenance.step_failed", { step: name, error: err }); deps.reportError?.(err, { maintenance: name }); return undefined;
    }
  };
  // The demo seed makes hundreds of queries, enough with the other steps to pass the Workers
  // limit on calls per invocation, so it runs in its own request (POST /api/account/demo/seed).
  // Each run takes at most 20 jobs and about 10 seconds of them; the rest wait five minutes.
  // R41: imports left behind (page closed for 10 minutes): at most 5 a pass get their one "paused" email. One indexed
  // read when none. R42: it runs before the jobs step, so the email it queues goes out in this same pass (staging's
  // cron is hourly, so after the jobs step the email waited a whole extra hour).
  // R43: kept imports (the upload waits in KV) carry on here when their page has closed: at most 2 runs a pass, each a
  // few steps as the person who started it. Runs before the jobs step, so a "finished" email goes out in this pass.
  if (has.moves) await step("data_move_continue", async () => (await import("./data-move/continue")).continueKeptMoves(deps));
  if (has.moves) await step("data_move_nudge", async () => (await import("./data-move/service")).nudgeLeftBehindMoves(deps));
  const jobsRun = !has.jobs ? { ran: 0, failed: 0, dead: 0 } : await step("jobs", () => runDueJobs(deps, 20, { excludeTypes: ["demo.seed_suite"], budgetMs: 10_000 }));
  // The remaining steps touch different tables and don't depend on each other, so they run
  // together: one after another they were a chain of round trips (Sentry MYMAIL-API-4).
  const [uptime, crossChecks, legacy, dunning, approvalsExpired, reminders, , writes] = await Promise.all([
    step("uptime", () => recordUptimeCheck(deps)),
    inSlot(2) ? step("cross_check", () => crossCheck(deps)) : Promise.resolve(undefined),
    step("legacy", () => legacyMaintenance(deps, inSlot(0), has.webhooks)),
    inSlot(2) ? step("dunning", () => enforceGracePeriods(deps)) : Promise.resolve(undefined),
    has.approvals ? step("approvals", () => expireApprovals(deps)) : Promise.resolve(0),
    !has.dueSoon ? Promise.resolve(undefined) : step("due_reminders", async () => (await import("./suite/automations")).runDueReminders(deps)),
    // R24.4: due_passed rules (reads only when there are none; pauses at a warn or shed write budget).
    !has.duePassed ? Promise.resolve(undefined) : step("due_passed", async () => (await import("./suite/automations-r24")).runDuePassed(deps)),
    // Reads the account's D1 writes today from analytics (no database write) and alerts past 60%.
    step("write_budget", () => checkWriteBudget(deps)),
  ]);
  // Connected mailboxes: each due one is handed to its own invocation (services/connect/sync.ts).
  const mailSync = !has.mailSync ? { dispatched: 0 } : await step("mail_sync", async () => (await import("./connect/sync")).runDueMailSyncs(deps));
  // Round 20: scheduled sends, snoozes and reminders that are due. Reads first; an idle pass writes nothing.
  const mailSchedules = !has.mailSchedules ? undefined : await step("mail_schedules", async () => (await import("./mail/schedules")).runMailSchedules(deps));
  // R28 (DF-3 slice 3): schedule triggers that are due queue agent runs. One read on a partial index; idle writes nothing.
  const agentTriggersRun = !has.agentTriggers ? undefined : await step("agent_triggers", async () => (await import("./suite/agent-triggers")).runDueTriggers(deps));
  // R80C: social posts that are due go out (one read on (status, run_at) when none); old post images go once an hour.
  const socialRun = !has.social || !deps.config.integrations.composio ? undefined : await step("social_posts", async () => (await import("./integrations/social")).runDueSocialPosts(deps));
  if (inSlot(1) && deps.config.integrations.composio) await step("social_media_prune", async () => (await import("./integrations/social")).pruneSocialMedia(deps));
  // R90: flows. Waits that are over carry on, a few due page and feed watches are checked, due digests go out. Idle: three reads in the probe, nothing here.
  if (deps.config.flows !== false && (has.flowRuns || has.flowWatches || has.flowDigests)) await step("flows", async () => {
    const fl = await import("./suite/flows");
    if (has.flowRuns) await fl.resumeDueRuns(deps);
    if (has.flowWatches) await (await import("./suite/flow-watch")).runDueWatches(deps);
    if (has.flowDigests) await fl.sendDueDigests(deps);
  });
  // R35 (Apple 1.2): mails the operator about open reports at most once per 15 minutes. One read when none are open.
  if (inSlot(3)) await step("ugc_reports_mail", async () => (await import("./suite/reports-r35")).mailOperator(deps));
  // Independent deletes on different tables, sent together rather than one after another.
  // R48 (MB-235): write out this isolate's per workspace write tallies, and drop daily counters older than a week.
  await step("workspace_budget", async () => {
    const wb = await import("./workspace-budget");
    await wb.flushAllWorkspaces(deps);
    if (deps.now().getUTCHours() === 1 && deps.now().getUTCMinutes() < 15) await wb.pruneWorkspaceCounters(deps);
  });
  if (inSlot(1)) await step("prune", async () => {
    await Promise.all([
      pruneRateLimits(deps.db, deps.now().getTime()), pruneIdempotencyKeys(deps.db, deps.now()), pruneLockouts(deps.db, deps.now()),
      pruneJobs(deps), pruneAgentEvents(deps), pruneImports(deps),
      import("./suite/flows").then((m) => m.pruneFlowRuns(deps)),
    ]);
  });
  // Tools P1: keep the document engine's free host awake (no D1), and prune old usage rows once an hour.
  if (deps.config.tools.enabled) await step("tools", async () => {
    const t = await import("./tools/maintenance");
    await t.toolsMaintenance(deps, inSlot(1));
  });
  return { ...legacy, socialPosts: socialRun, jobs: jobsRun, mailSync, mailSchedules, agentTriggers: agentTriggersRun, uptime, crossChecks, dunning, approvalsExpired, reminders, writes: writes ? { level: writes.level, rowsWritten: writes.rowsWritten } : undefined };
}

type Waiting = { moves: boolean; jobs: boolean; webhooks: boolean; approvals: boolean; dueSoon: boolean; duePassed: boolean; mailSync: boolean; mailSchedules: boolean; agentTriggers: boolean; social: boolean; flowRuns: boolean; flowWatches: boolean; flowDigests: boolean };
const ALL_WAITING: Waiting = { moves: true, jobs: true, webhooks: true, approvals: true, dueSoon: true, duePassed: true, mailSync: true, mailSchedules: true, agentTriggers: true, social: true, flowRuns: true, flowWatches: true, flowDigests: true };

/**
 * R51 (CPU): one statement that answers, for each step of the maintenance pass that can be idle, whether it has
 * anything waiting. Each part is the same condition (or a wider one) as the first read of that step, so a step is
 * only skipped when its own read would have found nothing. Any error: run everything.
 */
export async function probeWaiting(deps: Deps): Promise<Waiting> {
  const now = deps.now();
  const db = deps.db;
  // A query builder inside sql`` renders in its own parentheses, so exists takes it as written.
  const ex = (q: SQLWrapper) => sql`exists ${q}`;
  const one = { one: sql`1` };
  // The data move steps read runs idle for 2 (kept) or 10 (left behind) minutes; the shorter wait covers both.
  const movesBefore = new Date(now.getTime() - 2 * 60_000);
  const returnedBefore = new Date(now.getTime() - 14 * 86_400_000);
  const rule = (trigger: string) => db.select(one).from(automations).innerJoin(organizations, eq(organizations.id, automations.orgId))
    .where(and(sql`${automations.trigger} = ${trigger}`, eq(automations.enabled, true), isNull(automations.deletedAt), eq(organizations.isDemo, false))).limit(1);
  const parts: Record<keyof Waiting, SQLWrapper> = {
    moves: db.select(one).from(dataMoves).where(and(inArray(dataMoves.status, ["running", "stopped"]), lt(dataMoves.lastStepAt, movesBefore), eq(dataMoves.kind, "import"))).limit(1),
    jobs: db.select(one).from(jobs).where(and(or(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)), and(eq(jobs.status, "running"), lt(jobs.lockedUntil, now))), ne(jobs.type, "demo.seed_suite"))).limit(1),
    webhooks: db.select(one).from(webhookDeliveries).where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now))).limit(1),
    approvals: db.select(one).from(sendApprovals).where(and(eq(sendApprovals.status, "pending"), lt(sendApprovals.expiresAt, now))).limit(1),
    dueSoon: rule("due_soon"),
    duePassed: rule("due_passed"),
    mailSync: db.select(one).from(mailConnections).where(and(sql`${mailConnections.status} in ('active', 'error', 'syncing')`, sql`coalesce(${mailConnections.nextSyncAt}, 0) <= ${now.getTime()}`)).limit(1),
    mailSchedules: db.select(one).from(mailSchedules).where(or(and(eq(mailSchedules.status, "pending"), lte(mailSchedules.dueAt, now)), and(eq(mailSchedules.status, "returned"), lte(mailSchedules.dueAt, returnedBefore)))).limit(1),
    agentTriggers: db.select(one).from(agentTriggers).where(and(eq(agentTriggers.enabled, true), eq(agentTriggers.kind, "schedule"), lte(agentTriggers.nextRunAt, now))).limit(1),
    // R80C: social posts that are due, or stuck mid send for 15 minutes.
    social: db.select(one).from(socialPosts).where(or(and(eq(socialPosts.status, "scheduled"), lte(socialPosts.runAt, now)), and(eq(socialPosts.status, "sending"), lt(socialPosts.updatedAt, new Date(now.getTime() - 15 * 60_000))))).limit(1),
    // R90: flow runs whose wait is over, page and feed watches that are due, digests that are due.
    flowRuns: db.select(one).from(flowRuns).where(and(eq(flowRuns.status, "waiting"), lte(flowRuns.resumeAt, now))).limit(1),
    flowWatches: db.select(one).from(flowWatches).where(lte(flowWatches.nextCheckAt, now)).limit(1),
    flowDigests: db.select(one).from(flowDigestItems).where(and(isNull(flowDigestItems.sentAt), lte(flowDigestItems.sendAt, now))).limit(1),
  };
  const keys = Object.keys(parts) as (keyof Waiting)[];
  try {
    const cols = sql.join(keys.map((k) => sql`${ex(parts[k])} as ${sql.identifier(k)}`), sql`, `);
    const rows = (await db.all(sql`select ${cols}`)) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return ALL_WAITING;
    const out = {} as Waiting;
    for (const k of keys) out[k] = Number(row[k]) !== 0;
    if (!deps.config.mailConnect.enabled) out.mailSync = false;
    if (!deps.config.integrations.composio) out.social = false;
    return out;
  } catch (err) {
    deps.log?.warn("maintenance.probe_failed", { error: err });
    return ALL_WAITING;
  }
}

/**
 * Errors from the database that say "try again later" rather than "this query is wrong": SQLite busy
 * or locked (several local servers or test runs sharing one file), D1 overloaded or reset, and a
 * table a preview database has not migrated yet. Drizzle wraps the driver's error as `cause`.
 */
export function isTransientDbError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const text = `${(e as { code?: string }).code ?? ""} ${(e as Error).message ?? ""}`;
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|no such table|D1_ERROR.*(overloaded|reset|timed out|Network connection lost|internal error)|storage caused object to be reset/i.test(text)) return true;
  }
  return false;
}

const migratedClients = new WeakSet<object>();
/** Set once this isolate has seen a fully migrated database; the binding object can differ per invocation. */
let migratedInIsolate = false;

/**
 * Runs maintenance only once the database has every migration this release ships.
 * Right after a deploy the new code can serve requests before its migrations are applied
 * (the hosted preview applies them through a hook after upload), and maintenance would then
 * query tables that don't exist yet. Sentry MYMAIL-API-7 and MYMAIL-API-8 were exactly that:
 * `agent_events` and `send_approvals` queried seconds before migration 0013 ran. Once the
 * database is fully migrated the answer is cached, so the check costs one query per isolate.
 */
export async function runMaintenanceIfMigrated(deps: Deps, opts: { rotate?: boolean } = {}) {
  const client = (deps.db as unknown as { $client: object }).$client;
  if (!migratedInIsolate && !migratedClients.has(client)) {
    const pending = await pendingMigrations(migrationDriver(client));
    if (pending.length) {
      deps.log?.warn("maintenance.skipped", { reason: "migrations_pending", pending });
      return { skipped: "migrations_pending" as const, pending };
    }
    migratedClients.add(client);
    migratedInIsolate = true;
  }
  return runMaintenance(deps, opts);
}

async function legacyMaintenance(deps: Deps, housekeeping = true, webhooks = true) {
  const skip = Promise.resolve(undefined);
  const [rechecked, , , purged, webhooksRetried] = await Promise.all([
    housekeeping ? recheckStaleDomains(deps) : Promise.resolve([]),
    housekeeping ? deps.db.delete(sessions).where(lt(sessions.expiresAt, deps.now())) : skip,
    housekeeping ? deps.db.delete(verifications).where(lt(verifications.expiresAt, deps.now())) : skip,
    housekeeping && deps.config.demoEnabled ? purgeDemoWorkspaces(deps) : Promise.resolve(0),
    webhooks ? retryDueDeliveries(deps) : Promise.resolve(0),
    housekeeping ? pruneDeliveries(deps) : skip,
  ]);
  return { rechecked: rechecked.length, purged, webhooksRetried };
}

/**
 * Returns a platform secret persisted in the database, creating it once.
 * Only for hosted previews without a secret store; real deployments set APP_SECRET.
 */
export async function getOrCreateStoredSecret(db: DB, key = "generated_app_secret"): Promise<string> {
  await db.run(sql`INSERT OR IGNORE INTO ${appSettings} (key, value) VALUES (${key}, ${randomToken(48)})`);
  const row = (await db.all(sql`SELECT value FROM ${appSettings} WHERE key = ${key}`)) as { value: string }[];
  return row[0].value;
}
