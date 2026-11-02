/**
 * MH1 (MOBILE_WEB_LINK): app to web sign in handoff.
 *
 * POST /api/auth/mobile/web-link: the phone app, signed in with its normal session, asks for a one time code.
 * GET /auth/mobile/web?code=..&next=/app/..: the in app browser opens this; the code is burned on the first
 * attempt, a normal web session cookie is set for the same person and workspace, then 302 to next.
 *
 * The code is 256 random bits, lives 60 s, and only its SHA-256 is stored (Better Auth's verifications table,
 * identifier "mwl:<hash>"). Threat list: files/catalogue/mh1/DESIGN.md. Never log or report the code.
 */
import type { Hono, Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "./guards";
import { authFor } from "./options";
import { rateLimit } from "../lib/rate-limit";
import { randomBytes, sha256Hex, newId } from "../lib/crypto";
import { members, sessions, users, verifications } from "../db/schema";
import { markWorkspace } from "./workspace-mark";

export const WEB_LINK_TTL_SECONDS = 60;
const IDENT_PREFIX = "mwl:";
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_NEXT = 2048;

/** 32 random bytes as base64url without padding (43 characters). */
export function newWebLinkCode(): string {
  const b = randomBytes(32);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isWellFormedCode(code: unknown): code is string {
  return typeof code === "string" && CODE_RE.test(code);
}

/** The stored identifier: a hash only, never the code. */
export async function webLinkIdentifier(code: string): Promise<string> {
  return IDENT_PREFIX + (await sha256Hex(code));
}

/**
 * The redirect target after a handoff: a relative path inside the web app, else "/app".
 * Refuses anything that a browser could read as another origin or that hides one behind encoding.
 */
export function safeNext(raw: unknown): string {
  const fallback = "/app";
  if (typeof raw !== "string" || !raw || raw.length > MAX_NEXT) return fallback;
  if (raw !== "/app" && !raw.startsWith("/app/") && !raw.startsWith("/app?") && !raw.startsWith("/app#")) return fallback;
  // No control characters or spaces, no backslash, no protocol relative "//" anywhere, no scheme.
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(raw)) return fallback;
  if (raw.includes("//")) return fallback;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return fallback;
  // Encoded slash, backslash, dot dot or control characters (any depth of percent encoding).
  let decoded = raw;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return fallback; }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded !== raw) {
    if (/%2f|%5c/i.test(raw) || /[\u0000-\u0020\u007f-\u009f\\]/.test(decoded) || decoded.includes("//")) return fallback;
  }
  // Path traversal out of /app ("/app/../x") after the browser normalises it.
  try {
    const u = new URL(raw, "https://example.invalid");
    if (u.origin !== "https://example.invalid") return fallback;
    if (u.pathname !== "/app" && !u.pathname.startsWith("/app/")) return fallback;
    const out = u.pathname + u.search + u.hash;
    if (out.includes("//") || out.includes("\\")) return fallback;
    return out;
  } catch {
    return fallback;
  }
}

interface Bound { u: string; o: string; m: string; c: number }

function notFound(c: Context<AppEnv>) {
  return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
}

function handoffHeaders(c: Context<AppEnv>) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

/** Registers both routes. Call before the Better Auth catch all for /api/auth/*. */
export function installMobileWebLink(app: Hono<AppEnv>) {
  const userLimiter = rateLimit("handoff", (c) => `u:${c.var.auth?.userId ?? c.var.ip}`);
  const ipLimiter = rateLimit("handoff", (c) => `ip:${c.var.ip}`, { countReads: true });

  app.post("/api/auth/mobile/web-link", async (c, next) => (c.var.deps.config.mobileWebLink ? next() : notFound(c)), requireAuth, userLimiter, async (c) => {
    const { db } = c.var.deps;
    const auth = c.var.auth;
    c.header("Cache-Control", "no-store");
    const src = await db.select({ createdAt: sessions.createdAt, impersonatedBy: sessions.impersonatedBy }).from(sessions).where(eq(sessions.id, auth.sessionId)).get();
    if (!src) return c.json({ error: { code: "unauthorized", message: "Sign in to continue." } }, 401);
    if (src.impersonatedBy) return c.json({ error: { code: "forbidden", message: "This is not available while viewing as someone else." } }, 403);
    const code = newWebLinkCode();
    const now = Date.now();
    const bound: Bound = { u: auth.userId, o: auth.orgId, m: auth.loginMethod ?? "email", c: new Date(src.createdAt).getTime() };
    await db.insert(verifications).values({
      id: newId("vrf"), identifier: await webLinkIdentifier(code), value: JSON.stringify(bound),
      expiresAt: new Date(now + WEB_LINK_TTL_SECONDS * 1000),
    });
    return c.json({ code, expires_in: WEB_LINK_TTL_SECONDS });
  });

  app.get("/auth/mobile/web", async (c, next) => {
    if (!c.var.deps.config.mobileWebLink) return notFound(c);
    handoffHeaders(c);
    return next();
  }, ipLimiter, async (c) => {
    handoffHeaders(c);
    const deps = c.var.deps;
    const { db } = deps;
    const target = safeNext(c.req.query("next"));
    const refuse = (reason: string) => {
      deps.log?.warn("auth.mobile_web_refused", { reason });
      const res = c.redirect("/login", 302);
      res.headers.set("Referrer-Policy", "no-referrer");
      res.headers.set("Cache-Control", "no-store");
      return res;
    };
    const code = c.req.query("code");
    if (!isWellFormedCode(code)) return refuse("malformed");
    // Burn first: one atomic delete; a second attempt (or a racing one) finds nothing.
    const row = await db.delete(verifications).where(eq(verifications.identifier, await webLinkIdentifier(code)))
      .returning({ value: verifications.value, expiresAt: verifications.expiresAt }).get();
    if (!row) return refuse("unknown");
    if (new Date(row.expiresAt).getTime() <= Date.now()) return refuse("expired");
    let bound: Bound;
    try { bound = JSON.parse(row.value) as Bound; } catch { return refuse("bad_row"); }
    if (!bound?.u || !bound?.o) return refuse("bad_row");
    const user = await db.select({ id: users.id, banned: users.banned }).from(users).where(eq(users.id, bound.u)).get();
    if (!user || user.banned) return refuse("user");
    const member = await db.select({ id: members.id }).from(members).where(and(eq(members.userId, bound.u), eq(members.organizationId, bound.o))).get();
    if (!member) return refuse("member");
    let headers: Headers;
    let sessionId: string;
    try {
      const r = await authFor(deps).api.mobileWebSession({ body: { userId: bound.u }, returnHeaders: true });
      headers = r.headers;
      sessionId = r.response.sessionId;
    } catch (err) {
      deps.log?.warn("auth.mobile_web_session_failed", { error: String(err).slice(0, 120) });
      return refuse("session");
    }
    // The new session opens the bound workspace, keeps the source sign in method (SSO rules) and its age (freshness).
    await db.update(sessions).set({
      activeOrganizationId: bound.o, loginMethod: bound.m || "email",
      ...(Number.isFinite(bound.c) && bound.c > 0 ? { createdAt: new Date(Math.min(bound.c, Date.now())) } : {}),
    }).where(eq(sessions.id, sessionId));
    for (const sc of headers.getSetCookie()) c.header("Set-Cookie", sc, { append: true });
    markWorkspace(c, bound.o);
    deps.log?.info("auth.mobile_web_signed_in", { user: bound.u, org: bound.o });
    const res = c.redirect(target, 302);
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Cache-Control", "no-store");
    return res;
  });
}
