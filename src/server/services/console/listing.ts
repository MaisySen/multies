/**
 * OPS1: the one list convention for the operator console. Every console list takes
 *   ?q=&limit=&cursor=&sort=field:dir&<filters>
 * and answers { items, nextCursor }. Paging is keyset on (sort field, id), so a page never skips or repeats rows
 * while new ones arrive. Sort fields are a whitelist per list; anything else falls back to the default sort.
 *
 * Usage in a route (later areas copy this):
 *
 *   const p = listParams(c.req.query(), {
 *     id: organizations.id,
 *     sort: { createdAt: organizations.createdAt, name: organizations.name },
 *     defaultSort: "createdAt:desc",
 *     search: [organizations.name, organizations.id],
 *   });
 *   const rows = await db.select({ ... }).from(organizations)
 *     .where(and(myFilters, p.where)).orderBy(...p.orderBy).limit(p.take);
 *   return c.json(p.page(rows, (r) => ({ sort: r.createdAt, id: r.id })));
 *
 * Rules: sort fields must be NOT NULL columns (a null breaks the keyset); `limit` defaults to 50 and is capped at 200;
 * `q` is trimmed and capped at 100 characters and matches any search column (case blind, D1 safe).
 * A bad cursor is a 400 (bad_cursor), never a silent first page.
 */
import { and, asc, desc, eq, gt, lt, or, type Column, type SQL } from "drizzle-orm";
import { HttpError } from "../../lib/errors";
import { containsAny } from "../../lib/like-search";

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

type Dir = "asc" | "desc";
type SortValue = Date | number | string;

interface CursorShape { v: number | string; t: "d" | "n" | "s"; id: string }

export function encodeCursor(sort: SortValue, id: string): string {
  const shape: CursorShape = sort instanceof Date ? { v: sort.getTime(), t: "d", id } : typeof sort === "number" ? { v: sort, t: "n", id } : { v: String(sort), t: "s", id };
  return base64UrlEncode(JSON.stringify(shape));
}

export function decodeCursor(cursor: string): { sort: SortValue; id: string } {
  try {
    const shape = JSON.parse(base64UrlDecode(cursor)) as CursorShape;
    if (!shape || typeof shape.id !== "string" || !shape.id) throw new Error("no id");
    if (shape.t === "d" && typeof shape.v === "number") return { sort: new Date(shape.v), id: shape.id };
    if (shape.t === "n" && typeof shape.v === "number") return { sort: shape.v, id: shape.id };
    if (shape.t === "s" && typeof shape.v === "string") return { sort: shape.v, id: shape.id };
    throw new Error("bad type");
  } catch {
    throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
  }
}

export interface ListOptions<F extends string> {
  /** The row's unique id column (the tie breaker). */
  id: Column;
  /** Whitelisted sort fields and their columns (NOT NULL columns only). */
  sort: Record<F, Column>;
  defaultSort: `${NoInfer<F>}:${Dir}`;
  /** Columns `q` searches. Leave out for a list with no search box. */
  search?: Column[];
}

export interface ListParams<F extends string> {
  q: string;
  limit: number;
  /** limit + 1: one extra row tells whether there is a next page. */
  take: number;
  sortField: F;
  sortDir: Dir;
  /** Search and keyset conditions; combine with the list's own filters in and(). */
  where: SQL | undefined;
  orderBy: SQL[];
  /** Cuts the extra row and makes the next cursor from the last item. */
  page<T>(rows: T[], key: (row: T) => { sort: SortValue; id: string }): { items: T[]; nextCursor: string | null };
}

/** Reads ?q, ?limit, ?cursor and ?sort for one list. */
export function listParams<F extends string>(query: Record<string, string | undefined>, opts: ListOptions<F>): ListParams<F> {
  const q = (query.q ?? "").trim().slice(0, 100);
  const rawLimit = Number.parseInt(query.limit ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
  const [defField, defDir] = opts.defaultSort.split(":") as [F, Dir];
  let sortField = defField;
  let sortDir = defDir;
  const [f, d] = (query.sort ?? "").split(":");
  if (f && Object.prototype.hasOwnProperty.call(opts.sort, f)) {
    sortField = f as F;
    sortDir = d === "asc" || d === "desc" ? d : defDir;
  }
  const col = opts.sort[sortField];
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conds: (SQL | undefined)[] = [];
  if (q && opts.search?.length) conds.push(containsAny(opts.search, q));
  if (cursor) {
    const past = sortDir === "desc" ? lt : gt;
    conds.push(or(past(col, cursor.sort), and(eq(col, cursor.sort), past(opts.id, cursor.id))));
  }
  const by = sortDir === "desc" ? desc : asc;
  return {
    q, limit, take: limit + 1, sortField, sortDir,
    where: conds.length ? and(...conds) : undefined,
    orderBy: [by(col), by(opts.id)],
    page(rows, key) {
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor = rows.length > limit && last ? (() => { const k = key(last); return encodeCursor(k.sort, k.id); })() : null;
      return { items, nextCursor };
    },
  };
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}
