import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import type { DB } from "./index";

/** Opens a SQLite database file (or ":memory:") for Node and tests. */
export function openSqlite(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema }) as unknown as DB;
}

/**
 * Tools P2 (17): where the separate attachment text index database lives on Node: INDEX_DATABASE_PATH, else next to
 * the main file ("x.db" -> "x-index.db"; ":memory:" stays in memory). "off" leaves it out (search inside attachments off).
 */
export function indexDbPath(mainPath: string, env: Record<string, string | undefined> = process.env): string | null {
  const p = env.INDEX_DATABASE_PATH ?? (mainPath === ":memory:" ? ":memory:" : mainPath.replace(/(\.db)?$/, "-index.db"));
  return p === "off" ? null : p;
}
