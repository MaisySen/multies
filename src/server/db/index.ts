import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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

/**
 * Migrations are tracked in `d1_migrations`, the same table `wrangler d1 migrations apply`
 * uses, so a database migrated by wrangler and one migrated here agree on what ran.
 * Each migration file is applied atomically (a D1 batch or a SQLite transaction), so a
 * failure leaves no half-created tables behind. This never runs on a request: it runs
 * from the deploy pipeline, `npm run db:migrate`, the Node server's boot, or tests.
 */
const TRACKING_TABLE = "d1_migrations";
const LEGACY_TABLE = "_mymail_migrations";

interface D1Like {
  prepare(query: string): { all(): Promise<{ results?: unknown[] }>; run(): Promise<unknown> };
  batch(statements: unknown[]): Promise<unknown>;
}
interface SqliteLike {
  prepare(query: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  exec(query: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

export interface MigrationDriver {
  all(query: string): Promise<Record<string, unknown>[]>;
  /** Runs the statements atomically. */
  atomic(statements: string[]): Promise<void>;
}

export function migrationDriver(client: unknown): MigrationDriver {
  const c = client as Partial<D1Like & SqliteLike>;
  if (typeof c.batch === "function") {
    const d1 = client as D1Like;
    return {
      async all(query) { return ((await d1.prepare(query).all()).results ?? []) as Record<string, unknown>[]; },
      async atomic(statements) { await d1.batch(statements.map((s) => d1.prepare(s))); },
    };
  }
  if (typeof c.transaction === "function") {
    const db = client as SqliteLike;
    return {
      async all(query) { return db.prepare(query).all() as Record<string, unknown>[]; },
      async atomic(statements) { db.transaction(() => { for (const s of statements) db.exec(s); })(); },
    };
  }
  throw new Error("Unsupported database client for migrations");
}

const fileName = (name: string) => `${name}.sql`;

export async function pendingMigrations(driver: MigrationDriver): Promise<string[]> {
  const tables = await driver.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('${TRACKING_TABLE}','${LEGACY_TABLE}')`);
  const names = new Set(tables.map((t) => String(t.name)));
  const done = new Set<string>();
  if (names.has(TRACKING_TABLE)) for (const r of await driver.all(`SELECT name FROM ${TRACKING_TABLE}`)) done.add(String(r.name));
  if (names.has(LEGACY_TABLE)) for (const r of await driver.all(`SELECT name FROM ${LEGACY_TABLE}`)) done.add(fileName(String(r.name)));
  return MIGRATIONS.map((m) => fileName(m.name)).filter((n) => !done.has(n));
}

const esc = (s: string) => s.replace(/'/g, "''");

/** Applies pending migrations and returns their file names. Safe to run any number of times. */
export async function applyMigrations(driver: MigrationDriver): Promise<string[]> {
  await driver.atomic([
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
  ]);
  // Databases migrated by earlier builds kept their record in a different table: carry it over once.
  const legacy = await driver.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${LEGACY_TABLE}'`);
  if (legacy.length) {
    const rows = await driver.all(`SELECT name FROM ${LEGACY_TABLE} ORDER BY name`);
    await driver.atomic([
      ...rows.map((r) => `INSERT OR IGNORE INTO ${TRACKING_TABLE} (name) VALUES ('${esc(fileName(String(r.name)))}')`),
      `DROP TABLE ${LEGACY_TABLE}`,
    ]);
  }
  const pending = new Set(await pendingMigrations(driver));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    const name = fileName(m.name);
    if (!pending.has(name)) continue;
    await driver.atomic([...m.statements, `INSERT INTO ${TRACKING_TABLE} (name) VALUES ('${esc(name)}')`]);
    applied.push(name);
  }
  return applied;
}

/** Convenience for Node and tests: migrate a Drizzle handle. */
export async function migrate(db: DB): Promise<string[]> {
  return applyMigrations(migrationDriver((db as unknown as { $client: unknown }).$client));
}
