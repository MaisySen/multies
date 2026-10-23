import { sql } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { appSettings } from "../db/schema";
import { purgeExpiredSessions } from "./auth";
import { purgeDemoWorkspaces } from "./demo";
import { recheckStaleDomains } from "./domains";
import { randomToken } from "../lib/crypto";

/** Periodic housekeeping: re-check DNS, expire sessions, purge old sandboxes. */
export async function runMaintenance(deps: Deps) {
  const rechecked = await recheckStaleDomains(deps);
  await purgeExpiredSessions(deps.db, deps.now());
  const purged = deps.config.demoEnabled ? await purgeDemoWorkspaces(deps) : 0;
  return { rechecked: rechecked.length, purged };
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
