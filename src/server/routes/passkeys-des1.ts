/**
 * DES1 passkeys (flag PASSKEY_DES1): /api/passkeys. While the flag is off every path answers 404 and nothing else runs.
 *
 * Signed in (session only, API keys 404): GET / (list), POST /register/options, POST /register, PATCH /:id (rename),
 * DELETE /:id (remove; needs a sign in from the last 15 minutes). Signed out: POST /sign-in/options and POST /sign-in,
 * rate limited per address. The challenge rides an HttpOnly cookie scoped to this path; never cached.
 * OPS1 security (M2 re-check): an operator may add a passkey only from a session that meets the console's two-step
 * rule, and owners are told when they do.
 */
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";
import { sessions, users } from "../db/schema";
import { authFor } from "../auth/options";
import { markWorkspace } from "../auth/workspace-mark";
import {
  CHALLENGE_TTL_MS, PK_COOKIE, authenticationOptions, listPasskeys, registerPasskey, registrationOptions, removePasskey, renamePasskey,
  verifyAuthentication, type Who,
} from "../services/passkeys-des1";
import { featureOn } from "../services/console/flags"; // OPS1 feature flags
import { secondFactorChangeRefusal } from "../auth/operator"; // OPS1 security (M2 re-check)
import { isOperatorRole } from "@/shared/operator-permissions";

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

/**
 * OPS1 security (M2 re-check): an operator's session that never gave the two-step code (from before the enrolment, a
 * trusted device, OAuth or the phone's exchange) may not add a passkey, since signing in with it would open the
 * console. 403 two_factor_required with the same reasons the console gives.
 */
async function refuseUnprovenOperator(c: Context<AppEnv>) {
  const reason = await secondFactorChangeRefusal(c.var.deps, c.var.auth);
  if (!reason) return;
  throw new HttpError(403, "two_factor_required", reason === "not_enrolled"
    ? "Operator accounts need two-step sign in before they can add a passkey. Turn it on in Account and security, then try again."
    : "For your safety, sign out and sign in again with your password and two-step code, then add the passkey.", { reason });
}

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
      await refuseUnprovenOperator(c);
      const { options, nonce } = await registrationOptions(c.var.deps, who(c));
      setChallenge(c, nonce);
      return c.json({ options });
    })
    .post("/register", async (c) => {
      await refuseUnprovenOperator(c);
      const nonce = takeCookie(c);
      const deps = c.var.deps;
      const r = await registerPasskey(deps, who(c), nonce, await body(c), { ip: c.var.ip, ua: c.req.header("user-agent") });
      // OPS1 security (M2 re-check): a passkey added from a session that proved a second factor counts as one when it
      // signs in (auth/two-factor-session.ts). An operator adding one is audited and every owner is told.
      const a = c.var.auth;
      const tf = await import("../auth/two-factor-session");
      if (await tf.sessionHasSecondFactor(deps, a.userId, a.sessionId)) await tf.notePasskeyCounts(deps, a.userId, r.id);
      if (isOperatorRole(a.platformRole)) await (await import("../services/console/operators")).operatorFactorChanged(deps, { id: a.userId, email: a.email, role: a.platformRole }, "passkey");
      return c.json(r, 201);
    })
    .patch("/:id", async (c) => c.json(await renamePasskey(c.var.deps, who(c), c.req.param("id"), (await body(c)).name, { ip: c.var.ip })))
    .delete("/:id", async (c) => {
      const r = await removePasskey(c.var.deps, who(c), c.req.param("id"), { ip: c.var.ip });
      await (await import("../auth/two-factor-session")).forgetPasskey(c.var.deps, c.var.auth.userId, c.req.param("id"));
      return c.json(r);
    });

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
      const { userId, orgId, passkeyId } = await verifyAuthentication(deps, nonce, await body(c), { ip: c.var.ip });
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
      // OPS1 security (M2): these passkeys require user verification (passkeys-des1.ts), so the sign in proved a second
      // factor: an operator's session is marked for the console (auth/two-factor-session.ts). Others: no write. Only a
      // passkey added from a session that had itself proved a second factor counts (M2 re-check).
      const who = await deps.db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).get();
      const tf = await import("../auth/two-factor-session");
      if (who && await tf.passkeyCounts(deps, userId, passkeyId)) await tf.markTwoFactorSession(deps, who, sessionId, "passkey");
      for (const sc of headers.getSetCookie()) c.header("Set-Cookie", sc, { append: true });
      if (orgId) markWorkspace(c, orgId);
      return c.json({ ok: true });
    })
    .route("/", signedIn);
}
