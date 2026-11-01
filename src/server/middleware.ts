import type { Context, MiddlewareHandler } from "hono";
import { z, type ZodType } from "zod";
import type { AppEnv } from "./context";
import { HttpError, zodToHttp } from "./lib/errors";

// The guards live in the auth module; re-exported here for the existing imports.
export { resolveAuth, requireAuth, requirePlatformAdmin, requireAdmin } from "./auth/guards";

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
  } else if (c.req.header("sec-fetch-site") === "cross-site") {
    // A browser that leaves out Origin still says where the request came from.
    throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
  }
  const hasBody = c.req.header("content-length") !== "0" && (m === "POST" || m === "PATCH" || m === "PUT");
  // Tools P1: a file upload to the Tools engine is a streamed form upload, not JSON. It must carry the
  // custom upload header, which a cross-site form cannot send without a CORS preflight (the Origin check above still runs).
  // Tools P2: the same for every upload under /api/tools/ (AI documents, share, sign), each with the header.
  // R77: a workspace logo upload (raw image bytes) under /api/branding/logo/ with the same header.
  if (hasBody && c.req.header("x-multies-upload") === "1" && ((m === "POST" && c.req.path.startsWith("/api/tools/")) || (m === "PUT" && c.req.path.startsWith("/api/branding/logo/")) || (m === "POST" && c.req.path === "/api/direct/tiktok/videos" /* R83: a TikTok video upload */) || (m === "POST" && /^\/api\/portals\/[^/]+\/files$/.test(c.req.path) /* R120: a file shared into a client portal */) || (m === "PUT" && (c.req.path === "/api/drive/upload" || /^\/api\/drive\/items\/[^/]+\/content$/.test(c.req.path)) /* R101: a drive upload or new version */) || (m === "PUT" && c.req.path === "/api/expenses/upload" /* R106: a receipt photo or PDF */))) return next();
  if (hasBody && !isJsonContentType(c.req.header("content-type"))) throw new HttpError(403, "bad_content_type", "Requests must be JSON.");
  await next();
};

/**
 * True only when the media type itself is JSON. "text/plain; x=application/json" is a
 * CORS-safelisted type that a cross-site page can send without a preflight, so a substring
 * match is not enough.
 */
export function isJsonContentType(header: string | undefined): boolean {
  const essence = (header ?? "").split(";")[0].trim().toLowerCase();
  return essence === "application/json" || (essence.startsWith("application/") && essence.endsWith("+json"));
}

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

/** Validates the query string with zod (all values arrive as strings; use z.coerce). */
export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw zodToHttp(parsed.error);
  return parsed.data;
}

/** Common list query: page size and a created-before cursor. */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional().transform((v) => (v ? new Date(v) : undefined)),
});

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
