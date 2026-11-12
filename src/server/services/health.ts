/**
 * Health. QUAL1 (audit row 36): the public answer on /api/health, /health and /healthz is only what an uptime check,
 * the deploy smoke test (scripts/smoke.sh reads "ok" and "db") and the e2e web server wait need: `{ ok, db }`, plus
 * `degraded: true` while migrations are pending. It never shows the release, the database budgets, the shed levels,
 * the busiest workspaces or the production and staging split; those are for platform operators at
 * GET /api/admin/health (routes/admin.ts). Deploys are confirmed by the release on /api/config (docs/runbooks/deploy.md).
 */
import { sql } from "drizzle-orm";
import type { Deps } from "../context";
import { migrationDriver, pendingMigrations } from "../db";
import { workspaceHealthView } from "./workspace-budget";
import { healthView, readsView, writeBudget } from "./write-budget";
import { deferredCounts } from "./write-priority";

/** Migrations run at deploy time, so once a database is current it stays current for this isolate (per database). */
const current = new WeakSet<object>();

async function pending(deps: Deps): Promise<string[]> {
  const key = deps.db as unknown as object;
  if (current.has(key)) return [];
  const list = await pendingMigrations(migrationDriver((deps.db as unknown as { $client: unknown }).$client));
  if (!list.length) current.add(key);
  return list;
}

export type HealthAnswer = { status: 200 | 503; body: Record<string, unknown> };

/**
 * The public answer. The database must be reachable (one statement that reads no rows) and fully migrated. Pending
 * migrations are a deploy step not yet run, not an outage: 200 and `degraded`, so uptime checks page only when the
 * database itself fails.
 */
export async function publicHealth(deps: Deps): Promise<HealthAnswer> {
  try {
    if ((await pending(deps)).length) return { status: 200, body: { ok: true, degraded: true, db: "migrations_pending" } };
    await deps.db.run(sql`select 1`);
    return { status: 200, body: { ok: true, db: "ok" } };
  } catch {
    return { status: 503, body: { ok: false, db: "unreachable" } };
  }
}

/** The operators' answer: the same check with the release, the pending list, writes, reads and the busiest workspaces. */
export async function operatorHealth(deps: Deps): Promise<HealthAnswer> {
  try {
    const list = await pending(deps);
    if (list.length) return { status: 200, body: { ok: true, degraded: true, mode: deps.config.mode, db: "migrations_pending", pending: list, release: deps.config.release } };
    // The account's D1 writes today (cached per isolate; absent when the guard is off).
    const wb = await writeBudget(deps);
    return {
      status: 200,
      body: {
        ok: true, mode: deps.config.mode, db: "ok", release: deps.config.release,
        ...(wb.level !== "off" ? { writes: { ...healthView(wb, deps.config.writeBudget, deps.now()), deferred: deferredCounts() }, reads: readsView(wb.rowsRead, deps.config.writeBudget) } : {}),
        workspaces: await workspaceHealthView(deps).catch(() => null),
      },
    };
  } catch {
    return { status: 503, body: { ok: false, mode: deps.config.mode, db: "unreachable" } };
  }
}
