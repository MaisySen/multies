/**
 * OPS1: a hard bound for console lists over busy tables that have no index for the list (indexes cost a D1 row write
 * on every insert, so the console does not add them to hot tables). The condition keeps only the newest `cap` rows by
 * rowid, which SQLite answers as a rowid range (`SEARCH t USING INTEGER PRIMARY KEY (rowid>?)`): the query reads at
 * most `cap` rows whatever the table's size. rowids grow with each insert (pruning old rows does not change that), so
 * these are the most recently added rows. Rows older than the cap are only reachable through an indexed filter (a
 * workspace, say), which each caller documents.
 */
import { sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** Unscoped console lists over a busy table look at this many of its newest rows. */
export const RECENT_ROWS_CAP = 5_000;

export function newestRows(table: SQLiteTable, cap: number = RECENT_ROWS_CAP): SQL {
  return sql`${table}.rowid > (select coalesce(max(rowid), 0) from ${table}) - ${cap}`;
}
