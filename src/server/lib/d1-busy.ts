/**
 * R28 (found by Haajir, tsk_0mvomqzifj95btq7snu): a database that is briefly unavailable is a 503, not a 500.
 *
 * At 02:20 UTC on 26 Oct 2026 a `wrangler d1 export` of the production database ran. D1 blocks
 * queries for the length of an export, so three writes failed within seconds and the API answered
 * 500 "Something went wrong". Those failures are not bugs: the client should wait and try again.
 * The error handler answers them with 503, `Retry-After` and the code "busy", and they are logged
 * as warnings instead of being sent to error tracking. Every other error stays a 500 and still
 * goes to error tracking, so real bugs are not hidden.
 *
 * The messages are Cloudflare's documented D1 errors that are safe to retry
 * (developers.cloudflare.com/d1/observability/debug-d1/), plus SQLite's busy and locked errors
 * for the self hosted Node build. Drizzle wraps the driver's error as `cause`, so the chain is read.
 */

export type BusyKind = "export" | "overloaded" | "network" | "reset" | "locked" | "unavailable";

const CLASSES: { kind: BusyKind; pattern: RegExp; retryAfter: number }[] = [
  // "D1_ERROR: Currently processing a long-running export." An export can take a minute or more.
  { kind: "export", pattern: /long[- ]running export|export (is )?(currently )?(in progress|running)|processing (an? )?(long[- ]running )?export/i, retryAfter: 30 },
  // "D1 DB is overloaded. Too many requests queued." and "Requests queued for too long."
  { kind: "overloaded", pattern: /\boverloaded\b|too many requests queued|requests? queued for too long/i, retryAfter: 5 },
  // "D1_ERROR: Network connection lost." and "Cannot resolve D1 DB due to transient issue on remote node."
  { kind: "network", pattern: /network connection lost|transient issue on remote node|cannot resolve d1 db/i, retryAfter: 2 },
  // "Internal error while starting up D1 DB storage caused object to be reset.", "D1 DB storage operation
  // exceeded timeout which caused object to be reset.", "Durable Object reset because its code was updated."
  { kind: "reset", pattern: /caused object to be reset|object (was )?reset because its code was updated|code (was|has been) updated, this version can no longer access storage/i, retryAfter: 2 },
  // SQLite (self hosted): SQLITE_BUSY, SQLITE_LOCKED, "database is locked".
  { kind: "locked", pattern: /SQLITE_BUSY|SQLITE_LOCKED|database (table )?is locked/i, retryAfter: 2 },
  // Any other D1 error that says it is temporary.
  { kind: "unavailable", pattern: /D1_ERROR.*(temporarily unavailable|try again later|please retry)/i, retryAfter: 5 },
];

/** The busy class of an error (or of its causes), or null for every other error. */
export function d1BusyKind(err: unknown): { kind: BusyKind; retryAfter: number } | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = typeof (cur as { code?: unknown }).code === "string" ? (cur as { code: string }).code : "";
    const message = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : typeof (cur as { message?: unknown }).message === "string" ? (cur as { message: string }).message : "";
    const text = `${code} ${message}`;
    for (const c of CLASSES) if (c.pattern.test(text)) return { kind: c.kind, retryAfter: c.retryAfter };
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return null;
}

export const isD1BusyError = (err: unknown) => d1BusyKind(err) !== null;

export const BUSY_MESSAGE = "The database is busy for a moment. Please try again in a few seconds.";
export const busyBody = (kind: BusyKind) => ({ error: { code: "busy", message: BUSY_MESSAGE, details: { reason: kind } } });

const READ_ONLY_SQL = /^\s*select\b/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stmt = { bind?: (...args: unknown[]) => Stmt; all?: (...a: unknown[]) => Promise<unknown>; raw?: (...a: unknown[]) => Promise<unknown>; first?: (...a: unknown[]) => Promise<unknown> };

/**
 * Reads retry once, after a short pause, when D1 is briefly unavailable (a lost connection or a
 * reset usually clears in well under a second). Only plain SELECT statements retry, so a write
 * is never sent twice. The real statement objects are kept (their methods are wrapped in place),
 * so D1's batch() still receives D1 statements.
 */
export function withReadRetry<T extends object>(db: T, opts: { delayMs?: number; wait?: (ms: number) => Promise<void>; onRetry?: (kind: BusyKind) => void } = {}): T {
  const d = db as T & { prepare?: (sql: string) => Stmt; __readRetry?: boolean };
  if (typeof d.prepare !== "function" || d.__readRetry) return db;
  const delay = opts.delayMs ?? 150;
  const wait = opts.wait ?? sleep;
  const prepare = d.prepare.bind(db);
  const wrap = (stmt: Stmt, sql: string): Stmt => {
    if (!stmt || typeof stmt !== "object") return stmt;
    if (typeof stmt.bind === "function") {
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => wrap(bind(...args), sql);
    }
    if (!READ_ONLY_SQL.test(sql)) return stmt;
    for (const m of ["all", "raw", "first"] as const) {
      const fn = stmt[m];
      if (typeof fn !== "function") continue;
      const call = fn.bind(stmt);
      stmt[m] = async (...args: unknown[]) => {
        try { return await call(...args); } catch (err) {
          const busy = d1BusyKind(err);
          if (!busy || busy.kind === "export") throw err; // an export lasts far longer than one short pause
          opts.onRetry?.(busy.kind);
          await wait(delay);
          return call(...args);
        }
      };
    }
    return stmt;
  };
  try {
    Object.defineProperty(d, "prepare", { value: (sql: string) => wrap(prepare(sql), sql), configurable: true, writable: true });
    Object.defineProperty(d, "__readRetry", { value: true });
  } catch { /* a binding that can't be extended works as before, without the retry */ }
  return db;
}
