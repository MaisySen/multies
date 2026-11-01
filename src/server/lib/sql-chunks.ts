import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * D1 refuses a statement with more than 100 bound variables ("too many SQL variables"). Every IN list built from a
 * page of rows (tasks, messages, comments, files, ids from a request) goes through `inChunks`, which leaves room for
 * the other conditions in the same statement. Round 25, Sentry MYMAIL-API-V and MYMAIL-API-W.
 */
export const SQL_IN_CHUNK = 90;

/** Splits `ids` into lists of at most SQL_IN_CHUNK. */
export function chunkIds<T>(ids: readonly T[], size = SQL_IN_CHUNK): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  return parts;
}

/** Runs `q` once per chunk of `ids` (in parallel) and joins the rows. No ids, no query. */
export async function inChunks<T, I = string>(ids: readonly I[], q: (chunk: I[]) => Promise<T[]>): Promise<T[]> {
  if (!ids.length) return [];
  return (await Promise.all(chunkIds(ids).map(q))).flat();
}

/**
 * Round 27: `column IN (ids)` that binds ONE variable whatever the length, for lists that can grow with the workspace
 * (a person's mailbox scope, the channels they can read, ids a request sends). Up to INLINE_IN_MAX ids it is a plain
 * `IN (?, ?, ...)`; past that the ids travel as one JSON array and SQLite (and D1) unpack it with json_each, so one
 * statement still answers with the right order, limit and paging. An empty list matches nothing.
 */
export const INLINE_IN_MAX = 20;
export function inIds(column: SQLWrapper, ids: readonly string[]): SQL {
  const list = [...new Set(ids)];
  if (!list.length) return sql`0`;
  if (list.length <= INLINE_IN_MAX) return sql`${column} in (${sql.join(list.map((v) => sql`${v}`), sql`, `)})`;
  return sql`${column} in (select value from json_each(${JSON.stringify(list)}))`;
}
export function notInIds(column: SQLWrapper, ids: readonly string[]): SQL | undefined {
  const list = [...new Set(ids)];
  if (!list.length) return undefined;
  if (list.length <= INLINE_IN_MAX) return sql`${column} not in (${sql.join(list.map((v) => sql`${v}`), sql`, `)})`;
  return sql`${column} not in (select value from json_each(${JSON.stringify(list)}))`;
}
/** A mailbox scope (null = every mailbox) as a condition on `column`: no condition, nothing, or inIds. */
export function inScope(column: SQLWrapper, scope: readonly string[] | null | undefined): SQL | undefined {
  return scope ? inIds(column, scope) : undefined;
}

/**
 * D1 refuses a LIKE pattern longer than 50 bytes ("LIKE or GLOB pattern too complex"), so a pattern built from an
 * email address (`%"address":"someone@example.com"%`) fails for any address of 37 characters or more. Contact pages
 * on staging answered 500 for exactly those (R99). `instr` has no such limit and needs no escaping: these match the
 * lower cased column against a literal needle.
 */
export function containsLower(column: SQLWrapper, needle: string): SQL {
  return sql`instr(lower(${column}), ${needle.toLowerCase()}) > 0`;
}
/** True when the lower cased column ends with `suffix` (a LIKE '%suffix' without the pattern length limit). */
export function endsWithLower(column: SQLWrapper, suffix: string): SQL {
  const s = suffix.toLowerCase();
  return sql`substr(lower(${column}), ${-s.length}) = ${s}`;
}
/** The JSON address list columns (to, cc) hold `"address":"<email>"`; this is the needle for one address. */
export const addressNeedle = (email: string) => `"address":"${email.toLowerCase().replace(/"/g, "")}"`;
