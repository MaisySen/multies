import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import type { Deps } from "../context";
import { IDP_ID, displayName, idpLogoutUrl } from "./providers";
import { IdTokenError, verifyIdToken } from "./tokens";

/**
 * Two endpoints Multies adds to Better Auth, served under /api/auth:
 *
 * POST /api/auth/mobile/exchange: the mobile app signs in at the identity provider itself
 * (Authorization Code with PKCE through the system browser, as a public native client) and
 * sends the ID token here. The server verifies it against the provider's JWKS (signature,
 * issuer, audience = the native or web client id, expiry, nonce), requires a verified email,
 * links or creates the account exactly like the web callback does, and answers with a normal
 * Multies session cookie. Provider tokens never become Multies credentials.
 *
 * GET /api/auth/logout/idp: ends the provider's own session after the app session is gone,
 * through its /v2/logout endpoint with returnTo set to this deployment's sign in page.
 */
export function multiesAuthPlugin(deps: Deps) {
  return {
    id: "multies-auth",
    endpoints: {
      mobileExchange: createAuthEndpoint("/mobile/exchange", {
        method: "POST",
        body: z.object({ idToken: z.string().min(20).max(8192), nonce: z.string().min(8).max(200).optional() }),
      }, async (ctx) => {
        const idp = deps.config.auth.auth0;
        if (!idp) throw new APIError("NOT_FOUND", { message: "Sign in with this method is not set up here." });
        const audience = [idp.nativeClientId, idp.clientId].filter((x): x is string => !!x);
        let claims;
        try {
          claims = await verifyIdToken(ctx.body.idToken, { domain: idp.domain, audience, nonce: ctx.body.nonce });
        } catch (err) {
          if (err instanceof IdTokenError) {
            deps.log?.warn("auth.mobile_exchange_refused", { reason: err.reason });
            throw new APIError("UNAUTHORIZED", { code: "INVALID_ID_TOKEN", message: err.message });
          }
          throw err;
        }
        if (!claims.emailVerified) {
          throw new APIError("FORBIDDEN", { code: "EMAIL_NOT_VERIFIED", message: "Please confirm your email first, then sign in again." });
        }
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: { id: claims.sub, email: claims.email, emailVerified: true, name: displayName(claims as unknown as Record<string, unknown>), image: claims.picture },
          account: { providerId: IDP_ID, accountId: claims.sub, idToken: ctx.body.idToken },
        });
        if (result.error || !result.data) {
          throw new APIError("UNAUTHORIZED", { code: "SIGN_IN_FAILED", message: "We could not sign you in with that account. Please try again." });
        }
        await setSessionCookie(ctx, { session: result.data.session, user: result.data.user });
        return ctx.json({ ok: true, user: { id: result.data.user.id, email: result.data.user.email, name: result.data.user.name } });
      }),
      idpLogout: createAuthEndpoint("/logout/idp", { method: "GET" }, async (ctx) => {
        const url = idpLogoutUrl(deps.config) ?? `${deps.config.appUrl.replace(/\/$/, "")}/login`;
        throw ctx.redirect(url);
      }),
    },
  } satisfies BetterAuthPlugin;
}
