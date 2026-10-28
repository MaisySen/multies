import { and, eq, lt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import type { DB } from "../db";
import { idempotencyKeys } from "../db/schema";
import { HttpError } from "./errors";
import { newId } from "./crypto";

/** How long a key and its stored response are kept. */
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const KEY = /^[A-Za-z0-9_.:-]{8,255}$/;
/**
 * R40 (MB-201): a first attempt that is still "running" after this long was cut off (the platform stopped the
 * Worker, or the connection dropped) and may or may not have committed. A retry runs it again, and creates that
 * use idempotentId() get the same id, so the retry returns the item the first attempt made instead of a copy.
 */
export const IDEMPOTENCY_STALE_MS = 30_000;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** The idempotency row behind this request (its id and first attempt time), for idempotentId(). */
const seeds = new WeakMap<Request, { seed: string; at: number; retry?: boolean }>();

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Idempotent retries for POST, PATCH and DELETE, with the semantics Stripe made
 * standard: send an `Idempotency-Key` header and a retry with the same key and the
 * same body gets the first response back (marked `idempotent-replayed: true`)
 * instead of doing the work twice. The same key with a different body is a 422; a
 * retry while the first call is still running is a 409. Keys live for 24 hours and
 * are scoped to the caller, so two tenants can never collide.
 *
 * `scopeOf` names the caller (API key, user) and runs after authentication.
 */
/** R40 (MB-201): the scope for signed-in app calls: one person in one workspace. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sessionIdempotencyScope = (c: any): string | undefined => (c.var.auth ? `org:${c.var.auth.orgId}:user:${c.var.auth.userId}` : undefined);

export function idempotency(scopeOf: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = c.req.method;
    const key = c.req.header("idempotency-key");
    if (!key || (m !== "POST" && m !== "PATCH" && m !== "DELETE" && m !== "PUT")) return next();
    if (!KEY.test(key)) throw new HttpError(400, "bad_idempotency_key", "Idempotency-Key must be 8 to 255 letters, digits, dots, dashes, underscores or colons.");
    const scope = scopeOf(c);
    if (!scope) return next();
    const { db } = c.var.deps;
    const now = c.var.deps.now();
    const body = await c.req.raw.clone().text();
    const hash = await sha256(`${m} ${c.req.path}\n${body}`);

    const existing = await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))).get();
    const fresh = existing && now.getTime() - new Date(existing.createdAt).getTime() < IDEMPOTENCY_TTL_MS;
    let id: string;
    if (existing && fresh) {
      // nosemgrep: node_timing_attack (compares request body hashes, not secrets)
      if (existing.requestHash !== hash) {
        throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
      }
      if (existing.state === "done") {
        return new Response(existing.responseBody ?? "", {
          status: existing.responseStatus ?? 200,
          headers: { "content-type": "application/json", "idempotent-replayed": "true" },
        });
      }
      // R40: "running" with a stored 5xx means the first attempt failed and may be retried; with no status it
      // is either in flight (409) or was cut off long ago (stale: retry it under the same row and seed).
      const failed = existing.responseStatus !== null && existing.responseStatus !== undefined;
      const age = now.getTime() - new Date(existing.createdAt).getTime();
      if (!failed && age < IDEMPOTENCY_STALE_MS) throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
      id = existing.id;
      // Write: essential (claims the retry so a parallel repeat sees it in flight).
      await db.update(idempotencyKeys).set({ responseStatus: null, responseBody: null }).where(eq(idempotencyKeys.id, id));
      seeds.set(c.req.raw, { seed: id, at: new Date(existing.createdAt).getTime(), retry: true });
    } else {
      // Write: essential (the 24 h key row; pruned by maintenance).
      if (existing) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      id = newId("idem");
      try {
        await db.insert(idempotencyKeys).values({ id, scope, key, method: m, path: c.req.path, requestHash: hash, state: "running", createdAt: now });
      } catch {
        // Lost a race with a concurrent request carrying the same key.
        throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
      }
      seeds.set(c.req.raw, { seed: id, at: now.getTime() });
    }
    const markRetryable = (status: number) =>
      // Write: essential. The row is kept (not deleted) so a retry reuses its seed and ids: a failed answer can
      // still have committed (MB-201), and the retry must find that item rather than make a second one.
      db.update(idempotencyKeys).set({ responseStatus: status, responseBody: null }).where(eq(idempotencyKeys.id, id));
    try {
      await next();
    } catch (err) {
      // Errors thrown before a response exists are not stored as answers: the caller may retry.
      await markRetryable(err instanceof HttpError ? err.status : 500);
      throw err;
    }
    const status = c.res.status;
    if (status >= 500 || status === 429) {
      await markRetryable(status);
      return;
    }
    const text = await c.res.clone().text();
    // Write: essential (the stored answer a retry replays).
    await db.update(idempotencyKeys).set({ state: "done", responseStatus: status, responseBody: text }).where(eq(idempotencyKeys.id, id));
  };
}

/**
 * R40 (MB-201): the id a create should use when the request carries an Idempotency-Key, the same on every retry
 * of that key (time part from the first attempt, so ids still sort by creation). Undefined without a key: the
 * create makes its own random id as before.
 */
export async function idempotentId(req: Request, prefix: string): Promise<string | undefined> {
  const s = seeds.get(req);
  if (!s) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${s.seed}:${prefix}`)));
  let rand = "";
  for (const b of digest.slice(0, 10)) rand += ALPHABET[b % 36];
  return `${prefix}_${s.at.toString(36).padStart(9, "0")}${rand}`;
}

/**
 * R52 (MB-239): true when this request retries an earlier attempt under the same Idempotency-Key (the first one
 * answered 5xx or was cut off, and may have committed). Creates use it to look for the row the first attempt
 * made before inserting, so the check costs a read only on a retry, never on a first attempt.
 */
export function idempotentRetry(req: Request): boolean {
  return seeds.get(req)?.retry === true;
}

/** R52 (MB-239): idempotentId() plus whether this is a retry, as one options object for a service create. */
export async function idempotentCreate(req: Request, prefix: string): Promise<{ id?: string; retry?: boolean }> {
  const id = await idempotentId(req, prefix);
  return id ? { id, retry: idempotentRetry(req) } : {};
}

/** R52 (MB-239): n stable ids for a create that makes several rows in one call (checklist items). */
export async function idempotentIds(req: Request, prefix: string, n: number): Promise<string[] | undefined> {
  if (!seeds.get(req)) return undefined;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await idempotentId(req, i === 0 ? prefix : `${prefix}:${i}`))!.replace(`${prefix}:${i}_`, `${prefix}_`));
  return out;
}

export async function pruneIdempotencyKeys(db: DB, now: Date) {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)));
}
