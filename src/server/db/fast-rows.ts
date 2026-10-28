import { getTableColumns, getTableName, sql, type Column, type InferSelectModel, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export interface RowMapper<T extends SQLiteTable> {
  /** The table's columns, for `db.select(mapper.columns)` (same order as the mapper reads). */
  columns: T["_"]["columns"];
  /** The select list in the same order, built once ("t"."col", ...), for queries written with sql``. */
  selectList: SQL;
  map(rows: unknown[][]): InferSelectModel<T>[];
}

/**
 * R52: a row mapper built once per table. Drizzle maps every selected value through a generic per field loop
 * (type checks and a path walk for each value); on a 50 row task list that was the largest single block of warm
 * CPU after the query itself. Select the table's columns (`columns` or `selectList`), read the raw rows with
 * `db.values(query)` and map them here: the same keys, the same column order and the same driver value decoding
 * (timestamps to Date), so the result equals `db.select().from(table)`. tests/fast-rows-r52.test.ts checks that.
 */
export function rowMapper<T extends SQLiteTable>(table: T): RowMapper<T> {
  const columns = getTableColumns(table);
  const entries = Object.entries(columns) as [string, Column][];
  const keys = entries.map(([k]) => k);
  const decoders = entries.map(([, c]) => c);
  const n = keys.length;
  const tableName = getTableName(table);
  return {
    columns,
    selectList: sql.raw(entries.map(([, c]) => `"${tableName}"."${c.name}"`).join(", ")),
    map(rows) {
      const out = new Array<InferSelectModel<T>>(rows.length);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const v = row[i];
          o[keys[i]] = v === null ? null : decoders[i].mapFromDriverValue(v);
        }
        out[r] = o as InferSelectModel<T>;
      }
      return out;
    },
  };
}

/** Reads a query built on the mapper's columns as raw rows and maps them (see rowMapper). */
export async function selectMapped<T extends SQLiteTable>(db: { values: (q: SQLWrapper) => unknown }, mapper: RowMapper<T>, query: SQLWrapper): Promise<InferSelectModel<T>[]> {
  return mapper.map((await db.values(query)) as unknown[][]);
}
