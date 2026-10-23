import { pruneDeliveries, retryDueDeliveries } from "./developer/webhooks";
import { sql } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { appSettings } from "../db/schema";
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

/**
 * Periodic housekeeping: drain the job queue, record the uptime self check, re-check
 * DNS, expire sessions, purge old sandboxes, apply billing grace periods and prune
 * short-lived tables. Each step is isolated so one failure cannot stop the others.
 */
export async function runMaintenance(deps: Deps) {
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (err) { deps.log?.error("maintenance.step_failed", { step: name, error: err }); deps.reportError?.(err, { maintenance: name }); return undefined; }
  };
  const jobsRun = await step("jobs", () => runDueJobs(deps, 50));
  const uptime = await step("uptime", () => recordUptimeCheck(deps));
  const crossChecks = await step("cross_check", () => crossCheck(deps));
  const legacy = await step("legacy", () => legacyMaintenance(deps));
  await step("prune", async () => {
    await pruneRateLimits(deps.db, deps.now().getTime());
    await pruneIdempotencyKeys(deps.db, deps.now());
    await pruneLockouts(deps.db, deps.now());
    await pruneJobs(deps);
  });
  return { ...legacy, jobs: jobsRun, uptime, crossChecks };
}

async function legacyMaintenance(deps: Deps) {
  const rechecked = await recheckStaleDomains(deps);
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, deps.now()));
  await deps.db.delete(verifications).where(lt(verifications.expiresAt, deps.now()));
  const purged = deps.config.demoEnabled ? await purgeDemoWorkspaces(deps) : 0;
  const webhooksRetried = await retryDueDeliveries(deps);
  await pruneDeliveries(deps);
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
