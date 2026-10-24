/**
 * Database tool for self-hosted Multies (SQLite through better-sqlite3).
 *
 *   node dist/selfhost/db-tool.js import <dump.sql> [db]   load a D1 export, then apply migrations
 *   node dist/selfhost/db-tool.js backup [db] <out.db>      online, consistent copy while the app runs
 *   node dist/selfhost/db-tool.js restore <in.db> [db]      replace the database (stop the app first)
 *   node dist/selfhost/db-tool.js migrate [db]              apply pending migrations
 *   node dist/selfhost/db-tool.js summary [db]              row counts, to check an import
 *
 * [db] defaults to DATABASE_PATH, then /data/mymail.db. Every replace keeps the old file as
 * <db>.before-<time> so nothing is lost by mistake.
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { migrate } from "../../src/server/db";
import { openSqlite } from "../../src/server/db/node";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

/** Statements in a D1 export that plain SQLite should skip: Cloudflare's own tables. */
export function cleanD1Dump(sql: string): string {
  return sql
    .split(/\n(?=CREATE TABLE|INSERT INTO|CREATE INDEX|CREATE UNIQUE INDEX|CREATE TRIGGER|CREATE VIEW|PRAGMA|DELETE FROM)/)
    .filter((stmt) => !/^(CREATE TABLE( IF NOT EXISTS)?|INSERT INTO|DELETE FROM)\s+["`]?(_cf_|sqlite_sequence\b)/i.test(stmt.trim()))
    .join("\n");
}

function keepOld(dbPath: string) {
  if (!existsSync(dbPath)) return undefined;
  const kept = `${dbPath}.before-${stamp()}`;
  renameSync(dbPath, kept);
  for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
  return kept;
}

/** Loads a `wrangler d1 export` SQL file into a fresh database at dbPath, then runs Multies' migrations. */
export async function importDump(sqlPath: string, dbPath: string): Promise<{ applied: string[]; kept?: string; tables: number }> {
  const sql = cleanD1Dump(readFileSync(sqlPath, "utf8"));
  const tmp = `${dbPath}.importing`;
  if (existsSync(tmp)) rmSync(tmp);
  const raw = new Database(tmp);
  try {
    raw.pragma("foreign_keys = OFF");
    raw.exec(sql);
    const bad = raw.pragma("foreign_key_check") as unknown[];
    if (bad.length) console.warn(`[import] ${bad.length} rows point at missing parents (kept as they were in D1).`);
  } finally {
    raw.close();
  }
  const db = openSqlite(tmp);
  const applied = await migrate(db);
  (db as unknown as { $client: Database.Database }).$client.close();
  const kept = keepOld(dbPath);
  renameSync(tmp, dbPath);
  for (const ext of ["-wal", "-shm"]) if (existsSync(tmp + ext)) rmSync(tmp + ext);
  return { applied, kept, tables: summary(dbPath).length };
}

/** Online backup through SQLite's backup API: safe while Multies is running. */
export async function backup(dbPath: string, outPath: string): Promise<number> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(outPath);
  } finally {
    db.close();
  }
  // A single self-contained file: no -wal or -shm beside it.
  const check = new Database(outPath);
  check.pragma("journal_mode = DELETE");
  const ok = (check.pragma("integrity_check", { simple: true }) as string) === "ok";
  check.close();
  if (!ok) throw new Error("The backup copy failed its integrity check.");
  return statSync(outPath).size;
}

/** Puts a backup in place of the live database. Stop Multies first. */
export function restore(inPath: string, dbPath: string): string | undefined {
  const check = new Database(inPath, { readonly: true, fileMustExist: true });
  const ok = (check.pragma("integrity_check", { simple: true }) as string) === "ok";
  check.close();
  if (!ok) throw new Error(`${inPath} is not a healthy SQLite database.`);
  const kept = keepOld(dbPath);
  copyFileSync(inPath, dbPath);
  return kept;
}

export function summary(dbPath: string): { table: string; rows: number }[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return tables.map(({ name }) => ({ table: name, rows: (db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n }));
  } finally {
    db.close();
  }
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const defaultDb = process.env.DATABASE_PATH ?? "/data/mymail.db";
  switch (cmd) {
    case "import": {
      if (!args[0]) throw new Error("Usage: import <dump.sql> [db]");
      const r = await importDump(args[0], args[1] ?? defaultDb);
      console.log(`imported ${r.tables} tables; migrations applied after import: ${r.applied.length ? r.applied.join(", ") : "none needed"}${r.kept ? `; previous database kept at ${r.kept}` : ""}`);
      break;
    }
    case "backup": {
      const [dbPath, out] = args.length >= 2 ? args : [defaultDb, args[0]];
      if (!out) throw new Error("Usage: backup [db] <out.db>");
      console.log(`backup written: ${out} (${await backup(dbPath, out)} bytes)`);
      break;
    }
    case "restore": {
      if (!args[0]) throw new Error("Usage: restore <in.db> [db]");
      const kept = restore(args[0], args[1] ?? defaultDb);
      console.log(`restored ${args[0]}${kept ? `; previous database kept at ${kept}` : ""}`);
      break;
    }
    case "migrate": {
      const db = openSqlite(args[0] ?? defaultDb);
      const applied = await migrate(db);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
      break;
    }
    case "summary": {
      for (const r of summary(args[0] ?? defaultDb)) console.log(`${r.table.padEnd(32)} ${r.rows}`);
      break;
    }
    default:
      console.log("Commands: import, backup, restore, migrate, summary (see the top of scripts/selfhost/db-tool.ts).");
      process.exitCode = cmd ? 1 : 0;
  }
}

const isMain = process.argv[1] && /db-tool\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((err) => { console.error((err as Error).message); process.exit(1); });
}
