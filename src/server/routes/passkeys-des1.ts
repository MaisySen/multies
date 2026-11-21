/**
 * DES1 passkeys (flag PASSKEY_DES1): /api/passkeys. While the flag is off every path answers 404 and nothing else runs.
 *
 * Signed in (session only, API keys 404): GET / (list), POST /register/options, POST /register, PATCH /:id (rename),
 * DELETE /:id (remove; needs a sign in from the last 15 minutes). Signed out: POST /sign-in/options and POST /sign-in,
 * rate limited per address. The challenge rides an HttpOnly cookie scoped to this path; never cached.
 */
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";
import { sessions } from "../db/schema";
import { authFor } from "../auth/options";
import { markWorkspace } from "../auth/workspace-mark";
import {
  CHALLENGE_TTL_MS, PK_COOKIE, authenticationOptions, listPasskeys, registerPasskey, registrationOptions, removePasskey, renamePasskey,
  verifyAuthentication, type Who,
} from "../services/passkeys-des1";
import { featureOn } from "../services/console/flags"; // OPS1 feature flags

const PATH = "/api/passkeys";

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
};

function setChallenge(c: Context<AppEnv>, nonce: string) {
  setCookie(c, PK_COOKIE, nonce, { path: PATH, httpOnly: true, secure: c.var.deps.config.appUrl.startsWith("https:"), sameSite: "Strict", maxAge: Math.floor(CHALLENGE_TTL_MS / 1000) });
}
function takeCookie(c: Context<AppEnv>) {
  const v = getCookie(c, PK_COOKIE);
  deleteCookie(c, PK_COOKIE, { path: PATH, secure: c.var.deps.config.appUrl.startsWith("https:") });
  return v;
}

const who = (c: Context<AppEnv>): Who => {
  const a = c.var.auth;
  return { userId: a.userId, email: a.email, name: a.name, orgId: a.orgId, sessionId: a.sessionId };
};

export function passkeyDes1Routes() {
  const writes = new RateLimiter(60, 15 * 60_000);
  const signInLimiter = rateLimit("auth", (c) => `pkdes1:${c.var.ip}`);
  const signedIn = new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (c.var.apiKeyOrg) throw new HttpError(404, "not_found", "Page not found.");
      if (c.req.method !== "GET" && !writes.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many tries. Wait a few minutes and try again.");
      await next();
    })
    .get("/", async (c) => c.json({ passkeys: await listPasskeys(c.var.deps, c.var.auth.userId) }))
    .post("/register/options", async (c) => {
      const { options, nonce } = await registrationOptions(c.var.deps, who(c));
      setChallenge(c, nonce);
      return c.json({ options });
    })
    .post("/register", async (c) => {
      const nonce = takeCookie(c);
      const r = await registerPasskey(c.var.deps, who(c), nonce, await body(c), { ip: c.var.ip, ua: c.req.header("user-agent") });
      return c.json(r, 201);
    })
    .patch("/:id", async (c) => c.json(await renamePasskey(c.var.deps, who(c), c.req.param("id"), (await body(c)).name, { ip: c.var.ip })))
    .delete("/:id", async (c) => c.json(await removePasskey(c.var.deps, who(c), c.req.param("id"), { ip: c.var.ip })));

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      if (!featureOn(c.var.deps, "passkeyDes1")) throw new HttpError(404, "not_found", "Page not found."); // OPS1: the platform wide flag
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .post("/sign-in/options", signInLimiter, async (c) => {
      const { options, nonce } = await authenticationOptions(c.var.deps);
      setChallenge(c, nonce);
      return c.json({ options });
    })
    .post("/sign-in", signInLimiter, async (c) => {
      const deps = c.var.deps;
      const nonce = takeCookie(c);
      const { userId, orgId } = await verifyAuthentication(deps, nonce, await body(c), { ip: c.var.ip });
      let headers: Headers;
      let sessionId: string;
      try {
        const r = await authFor(deps).api.mobileWebSession({ body: { userId }, returnHeaders: true });
        headers = r.headers;
        sessionId = r.response.sessionId;
      } catch (err) {
        deps.log?.warn("passkey.session_failed", { error: String(err).slice(0, 120) });
        throw new HttpError(500, "session_failed", "We couldn't sign you in just now. Try again in a minute.");
      }
      // A passkey session is not single sign on: a workspace that requires SSO still asks for it (auth/guards.ts).
      await deps.db.update(sessions).set({ loginMethod: "passkey", ...(orgId ? { activeOrganizationId: orgId } : {}) }).where(eq(sessions.id, sessionId));
      for (const sc of headers.getSetCookie()) c.header("Set-Cookie", sc, { append: true });
      if (orgId) markWorkspace(c, orgId);
      return c.json({ ok: true });
    })
    .route("/", signedIn);
}
