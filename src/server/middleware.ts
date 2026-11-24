import type { Context, MiddlewareHandler } from "hono";
import { z, type ZodType } from "zod";
import { getConnInfo } from "@hono/node-server/conninfo";
export { CLIENT_IP_HEADER } from "./lib/client-ip-header";
import { CLIENT_IP_HEADER as CLIENT_IP_HEADER_NAME } from "./lib/client-ip-header";
import type { AppEnv, Deps } from "./context";
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
  // R112: a report, a reply or a handler message with files is a form upload with the same custom header.
  if (hasBody && m === "POST" && c.req.header("x-multies-upload") === "1" && /^\/api\/(pub\/report\/[a-z0-9]{8,40}\/(cases|reply)|reporting\/cases\/[A-Za-z0-9_]{1,80}\/messages)$/.test(c.req.path)) return next();
  // TD2: a file or signature for a public form question, raw bytes with the same custom header.
  if (hasBody && m === "POST" && c.req.header("x-multies-upload") === "1" && /^\/api\/public\/forms\/[a-z0-9]{4,40}\/uploads$/i.test(c.req.path)) return next();
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

/**
 * The client's address. Round 2: on Workers only CF-Connecting-IP, which Cloudflare sets and a client can't. On Node
 * (self host, local) the forwarded headers are believed only with TRUST_PROXY (a proxy the operator runs sets them);
 * otherwise the socket's address, so a client can't name its own address to dodge per address limits or plant one in
 * the audit log. "unknown" when there is none (app.request in tests has no socket). Requests reuse the value the app
 * worked out first (c.var.ip), so every route agrees.
 */
/**
 * Wave 1 review V10: drops any client-sent x-multies-client-ip before anything else runs. Only the /api/auth handler
 * sets it (to clientIp), but in-process Better Auth calls (getSession in guards, sign out and delete in account.ts,
 * team.ts) pass the request's own headers, and Better Auth reads the client address from that header.
 */
export const stripClientIpHeader: MiddlewareHandler = async (c, next) => {
  if (c.req.raw.headers.has(CLIENT_IP_HEADER_NAME)) {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER_NAME);
    c.req.raw = new Request(c.req.raw, { headers });
  }
  await next();
};

export function clientIp(c: Context): string {
  const v = c.var as { ip?: string; deps?: Pick<Deps, "runtime" | "config"> };
  if (v.ip && !v.ip.startsWith("unknown")) return v.ip;
  const cf = c.req.header("cf-connecting-ip")?.trim() || undefined;
  if (v.deps?.runtime === "workers") return cf ?? "unknown";
  // Wave 1 review V9: only the one header the trusted proxy sets (TRUST_PROXY_HEADER), so a client can't pick another.
  // X-Forwarded-For: the rightmost entry, which the trusted proxy appended; entries to its left came from the client.
  if (v.deps?.config.auth.trustProxy) {
    const name = v.deps.config.auth.trustProxyHeader || "x-forwarded-for";
    const raw = c.req.header(name);
    const picked = name === "x-forwarded-for" ? raw?.split(",").map((x) => x.trim()).filter(Boolean).pop() : raw?.trim();
    return picked || socketAddress(c) || "unknown";
  }
  return socketAddress(c) ?? "unknown";
}

/** The Node socket's remote address (@hono/node-server). Undefined on Workers and in app.request. */
function socketAddress(c: Context): string | undefined {
  try { return getConnInfo(c).remote.address || undefined; } catch { return undefined; }
}
