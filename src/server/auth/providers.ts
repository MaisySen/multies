import { genericOAuth, auth0 } from "better-auth/plugins/generic-oauth";
import type { AppConfig } from "../config";

/** The provider id; it is also the last segment of the callback path /api/auth/callback/auth0. */
export const IDP_ID = "auth0";

/** Keeps a real display name; falls back to the nickname or the local part of the email. */
export function displayName(p: Record<string, unknown>): string {
  if (typeof p.name === "string" && p.name.trim() && !p.name.includes("@")) return p.name.trim();
  if (typeof p.nickname === "string" && p.nickname.trim()) return p.nickname.trim();
  return String(p.email ?? "").split("@")[0] || "Member";
}

/**
 * The identity provider as an OIDC client. Discovery gives the endpoints, the issuer and the
 * JWKS; Better Auth then sends state, a PKCE S256 challenge and a nonce on every authorize
 * request, and checks the ID token signature, issuer, audience (our client id), expiry and
 * nonce on the callback before any session exists.
 */
export function idpProviderConfig(config: Pick<AppConfig, "auth">) {
  const idp = config.auth.auth0;
  if (!idp) return null;
  return {
    ...auth0({ domain: idp.domain, clientId: idp.clientId, clientSecret: idp.clientSecret, pkce: true, scopes: ["openid", "profile", "email"] }),
    providerId: IDP_ID,
    // Logout at the provider goes through /api/auth/logout/idp (its /v2/logout with returnTo),
    // so sign out stays a plain JSON call for the web and mobile clients.
    disableProviderLogout: true,
    mapProfileToUser: (p: Record<string, unknown>) => ({ name: displayName(p) }),
  };
}

export function idpPlugins(config: Pick<AppConfig, "auth">) {
  const c = idpProviderConfig(config);
  return c ? [genericOAuth({ config: [c] })] : [];
}

/** Direct social sign in for deployments without the identity provider (self host). */
export function socialProviders(config: Pick<AppConfig, "auth">) {
  const s = config.auth.social;
  return {
    ...(s.google ? { google: { clientId: s.google.clientId, clientSecret: s.google.clientSecret } } : {}),
    ...(s.github ? { github: { clientId: s.github.clientId, clientSecret: s.github.clientSecret } } : {}),
  };
}

/** Builds the provider logout URL: its /v2/logout endpoint, back to our sign in page. */
export function idpLogoutUrl(config: Pick<AppConfig, "auth" | "appUrl">): string | null {
  const idp = config.auth.auth0;
  if (!idp) return null;
  const u = new URL(`https://${idp.domain}/v2/logout`);
  u.searchParams.set("client_id", idp.clientId);
  u.searchParams.set("returnTo", `${config.appUrl.replace(/\/$/, "")}/login`);
  return u.toString();
}
