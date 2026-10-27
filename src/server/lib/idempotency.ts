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
    if (existing && now.getTime() - new Date(existing.createdAt).getTime() < IDEMPOTENCY_TTL_MS) {
      // nosemgrep: node_timing_attack (compares request body hashes, not secrets)
      if (existing.requestHash !== hash) {
        throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
      }
      if (existing.state === "running") throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
      return new Response(existing.responseBody ?? "", {
        status: existing.responseStatus ?? 200,
        headers: { "content-type": "application/json", "idempotent-replayed": "true" },
      });
    }
    if (existing) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));

    const id = newId("idem");
    try {
      await db.insert(idempotencyKeys).values({ id, scope, key, method: m, path: c.req.path, requestHash: hash, state: "running", createdAt: now });
    } catch {
      // Lost a race with a concurrent request carrying the same key.
      throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
    }
    try {
      await next();
    } catch (err) {
      // Errors thrown before a response exists are not stored: the caller may retry.
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
      throw err;
    }
    const status = c.res.status;
    if (status >= 500 || status === 429) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
      return;
    }
    const text = await c.res.clone().text();
    await db.update(idempotencyKeys).set({ state: "done", responseStatus: status, responseBody: text }).where(eq(idempotencyKeys.id, id));
  };
}

export async function pruneIdempotencyKeys(db: DB, now: Date) {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)));
}
