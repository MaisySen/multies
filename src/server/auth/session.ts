/**
 * The app session. Better Auth issues it after any sign in path and stores it in the
 * database; the browser holds only an HttpOnly cookie (Secure in production, SameSite=Lax),
 * refreshed once a day and revocable from Account and security.
 */

/** Sign in methods that count as single sign on for a workspace that requires it. */
export const SSO_METHODS = new Set(["auth0", "google"]);

export function cookieOptions(prod: boolean) {
  return {
    cookiePrefix: "mymail",
    useSecureCookies: prod,
    defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const, secure: prod, path: "/" },
  };
}

export function sessionOptions() {
  return {
    additionalFields: { loginMethod: { type: "string" as const, required: false, input: false } },
    expiresIn: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // the cookie and expiry roll forward once a day
    freshAge: 15 * 60, // sensitive changes need a sign in from the last 15 minutes
  };
}

/** How a new session signed in, from the Better Auth endpoint that created it. */
export function loginMethodFor(path?: string, params?: Record<string, string | undefined>): string {
  if (!path) return "email";
  if (path === "/mobile/exchange") return "auth0";
  if (path.startsWith("/oauth2/callback/") || path.startsWith("/callback/")) return params?.providerId ?? params?.id ?? path.split("/").pop() ?? "oauth";
  return "email";
}

/** The lastLoginMethod plugin's resolver: the provider id for OAuth callbacks, else its default. */
export function resolveLoginMethod(ctx: { path?: string; params?: Record<string, string | undefined> }): string | null {
  if (ctx.path === "/mobile/exchange") return "auth0";
  if (ctx.path?.startsWith("/oauth2/callback/") || ctx.path?.startsWith("/callback/")) return ctx.params?.providerId ?? ctx.params?.id ?? ctx.path.split("/").pop() ?? null;
  return null;
}
