import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { MIGRATIONS } from "./migrations.generated";

export { schema };

/**
 * The database handle used everywhere on the server. It is either a better-sqlite3
 * database (Node, tests) or a Cloudflare D1 database (Workers); all code awaits
 * queries so the same services run on both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = BaseSQLiteDatabase<"sync" | "async", any, typeof schema>;

/** Applies bundled migrations that have not run yet. Safe to call on every boot. */
export async function migrate(db: DB): Promise<string[]> {
  await db.run(sql.raw(
    "CREATE TABLE IF NOT EXISTS _mymail_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  ));
  const rows = (await db.all(sql.raw("SELECT name FROM _mymail_migrations"))) as { name: string }[];
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    for (const stmt of m.statements) await db.run(sql.raw(stmt));
    await db.run(sql`INSERT INTO _mymail_migrations (name, applied_at) VALUES (${m.name}, ${Date.now()})`);
    applied.push(m.name);
  }
  return applied;
}
