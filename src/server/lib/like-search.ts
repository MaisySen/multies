/**
 * LK1: safe text search for D1.
 *
 * D1 refuses a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too complex"), so every search that
 * built `%${query}%` answered 500 once the query (plus its wildcards and escapes) passed 50 bytes in UTF 8: about 48
 * plain letters, 16 Devanagari letters or 12 emoji. The fix for contains searches is `instr`, which has no pattern
 * limit and no wildcards: `instr(lower(col), lower(q)) > 0` keeps the rows `col LIKE '%q%'` kept (SQLite's LIKE and
 * lower both fold ASCII letters only), takes % and _ literally, and finds the item for a query of any length, so
 * LIMIT and paging stay exact with no filtering in code.
 *
 * Where a real LIKE pattern is still wanted (a prefix scan that can use an index), `likePattern` builds one that is
 * escaped and never longer than D1's limit; when the query had to be shortened it says so (`complete: false`) and
 * `textMatches` filters the rows in code by the whole query.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** D1's LIKE / GLOB pattern limit, in bytes of UTF 8. */
export const D1_LIKE_MAX_BYTES = 50;
/** The escape character every pattern from this file uses (pass it as ESCAPE '\'). */
export const LIKE_ESCAPE = "\\";

const enc = new TextEncoder();
/** Bytes of `s` in UTF 8. */
export const utf8Bytes = (s: string) => enc.encode(s).length;

/** The longest start of `s` within `maxBytes` of UTF 8, never cutting a character (or a surrogate pair). */
export function clipUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** `s` with %, _ and the escape character taken literally (use with ESCAPE '\'). */
export const escapeLikeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A search query as typed: trimmed, inner runs of white space made one space. */
export const normalizeQuery = (q: string) => q.replace(/\s+/g, " ").trim();

/** True when `column` contains `query` (ASCII case folded, like LIKE). No pattern limit, % and _ literal. */
export function containsText(column: SQLWrapper | SQL, query: string): SQL {
  return sql`instr(lower(${column}), lower(${query})) > 0`;
}
/** True when any of `columns` contains `query`. */
export function containsAny(columns: readonly (SQLWrapper | SQL)[], query: string): SQL {
  const parts = columns.map((c) => containsText(c, query));
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}
/** True when `column` starts with `prefix` (ASCII case folded, like LIKE 'prefix%'). No pattern limit. */
export function startsWithText(column: SQLWrapper | SQL, prefix: string): SQL {
  return sql`substr(lower(${column}), 1, length(${prefix})) = lower(${prefix})`;
}

/** SQLite's lower(): ASCII letters only, so code side checks agree with the database. */
export const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
/** Code side twin of containsText: does `text` contain `query`, ASCII case folded. */
export const textMatches = (text: string | null | undefined, query: string) => asciiLower(text ?? "").includes(asciiLower(query));

/**
 * A LIKE pattern for `query` that D1 accepts: escaped (ESCAPE '\'), wrapped in % as asked, and at most 50 bytes.
 * A query too long for that is searched on its longest word (clipped at a character boundary when even that is too
 * long); `complete` is then false and the caller filters the rows with `textMatches(row, query)`.
 */
export function likePattern(query: string, mode: "contains" | "prefix" = "contains"): { pattern: string; complete: boolean } {
  const q = normalizeQuery(query);
  const wrap = (s: string) => (mode === "contains" ? `%${s}%` : `${s}%`);
  const room = D1_LIKE_MAX_BYTES - (mode === "contains" ? 2 : 1);
  const whole = escapeLikeText(q);
  if (utf8Bytes(whole) <= room) return { pattern: wrap(whole), complete: true };
  // Prefix: the start of the query is the useful part. Contains: its longest word.
  const piece = mode === "prefix" ? q : [...q.split(" ")].sort((a, b) => utf8Bytes(b) - utf8Bytes(a))[0] ?? q;
  let out = "";
  let used = 0;
  for (const ch of piece) {
    const e = escapeLikeText(ch);
    const n = utf8Bytes(e);
    if (used + n > room) break;
    out += e;
    used += n;
  }
  return { pattern: wrap(out), complete: false };
}
