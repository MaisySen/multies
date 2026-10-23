import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ZodType } from "zod";
import type { AppEnv } from "./context";
import { forbidden, HttpError, unauthorized, zodToHttp } from "./lib/errors";
import { resolveSession, SESSION_COOKIE } from "./services/auth";

/** Requires a valid session; populates `c.var.auth`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw unauthorized();
  const auth = await resolveSession(c.var.deps.db, token, c.var.deps.now());
  if (!auth) throw unauthorized("Your session has expired. Sign in again.");
  c.set("auth", auth);
  await next();
};

/** Owners and admins only. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.role === "member") throw forbidden("Only workspace admins can do that.");
  await next();
};

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the request must
 * be JSON (a cross-site form cannot send that without a CORS preflight) and, when the
 * browser sends an Origin, it must match this host.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* invalid origin */ }
    if (!host || originHost !== host) throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
  }
  const ct = c.req.header("content-type") ?? "";
  const hasBody = c.req.header("content-length") !== "0" && (m === "POST" || m === "PUT" || m === "PATCH");
  if (hasBody && !ct.includes("application/json")) throw new HttpError(403, "bad_content_type", "Requests must be JSON.");
  await next();
};

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try { raw = JSON.parse(text); } catch { throw new HttpError(400, "bad_json", "Malformed JSON body."); }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw zodToHttp(parsed.error);
  return parsed.data;
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
