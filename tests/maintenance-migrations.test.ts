import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openSqlite } from "@/server/db/node";
import { migrate, migrationDriver } from "@/server/db";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { loadConfig } from "@/server/config";
import { StaticResolver } from "@/server/services/dns/resolver";
import { LogOutbound } from "@/server/services/mail/outbound";
import { nullLogger } from "@/server/lib/logger";
import { runMaintenance, runMaintenanceIfMigrated } from "@/server/services/maintenance";
import type { Deps } from "@/server/context";

/**
 * Sentry MYMAIL-API-7 and MYMAIL-API-8 (preview): maintenance ran on the first request after
 * a deploy, before migration 0013 created agent_events and send_approvals, and failed with
 * "no such table". These rebuild that state: a database one migration behind the code.
 */
async function behindByAgentMigration() {
  const db = openSqlite(":memory:");
  const driver = migrationDriver((db as unknown as { $client: unknown }).$client);
  await driver.atomic(["CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"]);
  for (const m of MIGRATIONS.filter((x) => x.name < "0013")) await driver.atomic([...m.statements, `INSERT INTO d1_migrations (name) VALUES ('${m.name}.sql')`]);
  const errors: unknown[] = [];
  const deps: Deps = {
    db, config: loadConfig({ APP_SECRET: "t".repeat(40) }), dns: new StaticResolver(), outbound: new LogOutbound(), now: () => new Date(),
    fetch: (async () => { throw new Error("network disabled in tests"); }) as typeof fetch, log: nullLogger,
    reportError: (err) => { errors.push(err); return undefined; },
  };
  return { db, deps, errors };
}

const messages = (errors: unknown[]) => errors.map((e) => String((e as { cause?: unknown }).cause ?? e));

describe("maintenance right after a deploy", () => {
  it("does not report a missing table as an error when maintenance runs on a database that is behind", async () => {
    // This used to reach Sentry as "no such table: send_approvals" (MYMAIL-API-P and Q on the preview).
    const { deps, errors } = await behindByAgentMigration();
    await runMaintenance(deps);
    expect(messages(errors).join("\n")).not.toMatch(/no such table/);
  });

  it("waits for migrations, then runs cleanly once they are applied", async () => {
    const { db, deps, errors } = await behindByAgentMigration();
    const skipped = await runMaintenanceIfMigrated(deps);
    expect(skipped).toMatchObject({ skipped: "migrations_pending", pending: expect.arrayContaining([expect.stringMatching(/^0013_/)]) });
    expect(errors).toEqual([]);

    await migrate(db);
    const ran = await runMaintenanceIfMigrated(deps);
    expect(ran).not.toHaveProperty("skipped");
    expect(ran).toMatchObject({ approvalsExpired: 0 });
    expect(errors).toEqual([]);
  });

  it("expires stale approvals and prunes old agent events with timestamp binds SQLite accepts", async () => {
    const { db, deps, errors } = await behindByAgentMigration();
    await migrate(db);
    await db.run(sql`INSERT INTO organizations (id, name, created_at) VALUES ('org_1', 'Acme', 0)`);
    await db.run(sql`INSERT INTO agent_events (org_id, type, data, created_at) VALUES ('org_1', 'message.received', '{}', 0)`);
    await db.run(sql`INSERT INTO agent_events (org_id, type, data, created_at) VALUES ('org_1', 'message.received', '{}', ${Date.now()})`);
    await runMaintenanceIfMigrated(deps);
    const left = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM agent_events`);
    expect(left[0].n).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("health while migrations are pending", () => {
  it("answers 200, degraded, so uptime checks page only on a real database failure", async () => {
    const { createApp } = await import("@/server/app");
    const { deps } = await behindByAgentMigration();
    const res = await createApp(deps).request("/api/health", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, degraded: true, db: "migrations_pending" });
  });
});
