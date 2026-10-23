import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openSqlite } from "@/server/db/node";
import { applyMigrations, migrate, migrationDriver, pendingMigrations } from "@/server/db";
import { MIGRATIONS } from "@/server/db/migrations.generated";

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const db = openSqlite(":memory:");
    const first = await migrate(db);
    expect(first.length).toBe(MIGRATIONS.length);
    expect(await migrate(db)).toEqual([]);
  });

  it("record runs in the table wrangler uses, with the file names wrangler expects", async () => {
    const raw = new Database(":memory:");
    await applyMigrations(migrationDriver(raw));
    const rows = raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => `${m.name}.sql`));
  });

  it("carries over the record kept by earlier builds instead of re-running", async () => {
    const raw = new Database(":memory:");
    const driver = migrationDriver(raw);
    for (const m of MIGRATIONS) for (const s of m.statements) raw.exec(s);
    raw.exec("CREATE TABLE _mymail_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS) raw.prepare("INSERT INTO _mymail_migrations VALUES (?, ?)").run(m.name, Date.now());
    expect(await applyMigrations(driver)).toEqual([]);
    expect(await pendingMigrations(driver)).toEqual([]);
  });

  it("applies each file atomically, so a failure leaves nothing half done", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE app_settings (x TEXT)"); // collides with a table in the first migration
    await expect(applyMigrations(migrationDriver(raw))).rejects.toThrow();
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='aliases'").all();
    expect(tables).toEqual([]);
  });
});
