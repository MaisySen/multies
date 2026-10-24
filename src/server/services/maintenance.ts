import { enforceGracePeriods } from "./billing/dunning";
import { isD1LimitError } from "../lib/d1-limit";
import { expireApprovals, pruneAgentEvents } from "./agents";
import { pruneImports } from "./import";
import { pruneDeliveries, retryDueDeliveries } from "./developer/webhooks";
import { sql } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { appSettings } from "../db/schema";
import { migrationDriver, pendingMigrations } from "../db";
import { lt } from "drizzle-orm";
import { sessions, verifications } from "../db/schema";
import { purgeDemoWorkspaces } from "./demo";
import { recheckStaleDomains } from "./domains";
import { randomToken } from "../lib/crypto";
import { pruneRateLimits } from "../lib/rate-limit";
import { pruneIdempotencyKeys } from "../lib/idempotency";
import { pruneLockouts } from "./lockout";
import { pruneJobs, runDueJobs } from "./jobs";
import { crossCheck, recordUptimeCheck } from "./status";
import "./mail/deliver-job";
import "./system-mail";
import "./suite/push";

/**
 * Periodic housekeeping: drain the job queue, record the uptime self check, re-check
 * DNS, expire sessions, purge old sandboxes, apply billing grace periods and prune
 * short-lived tables. Each step is isolated so one failure cannot stop the others.
 */
export async function runMaintenance(deps: Deps) {
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
  const jobsRun = await step("jobs", () => runDueJobs(deps, 20, { excludeTypes: ["demo.seed_suite"], budgetMs: 10_000 }));
  // The remaining steps touch different tables and don't depend on each other, so they run
  // together: one after another they were a chain of round trips (Sentry MYMAIL-API-4).
  const [uptime, crossChecks, legacy, dunning, approvalsExpired, reminders] = await Promise.all([
    step("uptime", () => recordUptimeCheck(deps)),
    step("cross_check", () => crossCheck(deps)),
    step("legacy", () => legacyMaintenance(deps)),
    step("dunning", () => enforceGracePeriods(deps)),
    step("approvals", () => expireApprovals(deps)),
    step("due_reminders", async () => (await import("./suite/automations")).runDueReminders(deps)),
  ]);
  // Independent deletes on different tables, sent together rather than one after another.
  await step("prune", async () => {
    await Promise.all([
      pruneRateLimits(deps.db, deps.now().getTime()), pruneIdempotencyKeys(deps.db, deps.now()), pruneLockouts(deps.db, deps.now()),
      pruneJobs(deps), pruneAgentEvents(deps), pruneImports(deps),
    ]);
  });
  return { ...legacy, jobs: jobsRun, uptime, crossChecks, dunning, approvalsExpired, reminders };
}

/**
 * Errors from the database that say "try again later" rather than "this query is wrong": SQLite busy
 * or locked (several local servers or test runs sharing one file), D1 overloaded or reset, and a
 * table a preview database has not migrated yet. Drizzle wraps the driver's error as `cause`.
 */
export function isTransientDbError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const text = `${(e as { code?: string }).code ?? ""} ${(e as Error).message ?? ""}`;
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|no such table|D1_ERROR.*(overloaded|reset|timed out|Network connection lost)|storage caused object to be reset/i.test(text)) return true;
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
export async function runMaintenanceIfMigrated(deps: Deps) {
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
  return runMaintenance(deps);
}

async function legacyMaintenance(deps: Deps) {
  const [rechecked, , , purged, webhooksRetried] = await Promise.all([
    recheckStaleDomains(deps),
    deps.db.delete(sessions).where(lt(sessions.expiresAt, deps.now())),
    deps.db.delete(verifications).where(lt(verifications.expiresAt, deps.now())),
    deps.config.demoEnabled ? purgeDemoWorkspaces(deps) : Promise.resolve(0),
    retryDueDeliveries(deps),
    pruneDeliveries(deps),
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
