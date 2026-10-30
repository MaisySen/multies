/**
 * Sign in with Google or Microsoft for connected mailboxes (round 18), behind MAIL_OAUTH=on.
 *
 * Off on production until the owner finishes the providers' reviews (docs/runbooks/mail-oauth.md):
 * Gmail's IMAP and SMTP scope (https://mail.google.com/) is a restricted scope that needs Google's
 * verification and a security assessment, and Microsoft wants a verified publisher on the app.
 * Until then the app password path is the live one.
 *
 * The flow is the authorization code flow with PKCE. The state (who started it, the verifier, a
 * nonce and a time) is encrypted with APP_SECRET and travels in the URL, so nothing is written to
 * the database before the person comes back. The refresh token is stored like an app password
 * (encrypted), and IMAP and SMTP sign in with XOAUTH2 using short lived access tokens.
 */
import type { AuthContext, Deps } from "../../context";
import { decryptSecret, encryptSecret, randomToken } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import type { Connection } from ".";

export type OAuthProvider = "google" | "microsoft";

const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  scope: "openid email https://mail.google.com/",
};
const microsoft = (tenant: string) => ({
  auth: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  scope: "openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
});

/** Which sign in buttons the app shows. Both stay hidden while MAIL_OAUTH is off. */
export function oauthAvailable(deps: Deps): OAuthProvider[] {
  const o = deps.config.mailConnect.oauth;
  if (!o.enabled) return [];
  return [...(o.google ? ["google" as const] : []), ...(o.microsoft ? ["microsoft" as const] : [])];
}

function endpoints(deps: Deps, p: OAuthProvider) {
  const o = deps.config.mailConnect.oauth;
  if (!o.enabled) throw new HttpError(404, "oauth_off", "Signing in with a provider isn't switched on yet. Use an app password.");
  if (p === "google" && o.google) return { ...GOOGLE, client: o.google };
  if (p === "microsoft" && o.microsoft) return { ...microsoft(o.microsoft.tenant), client: o.microsoft };
  throw new HttpError(404, "oauth_off", "That provider isn't set up here yet. Use an app password.");
}

const redirectUri = (deps: Deps, p: OAuthProvider) => `${deps.config.appUrl}/api/connections/oauth/${p}/callback`;

async function challenge(verifier: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The provider's sign in URL. */
export async function oauthStart(deps: Deps, auth: AuthContext, p: OAuthProvider) {
  const e = endpoints(deps, p);
  const verifier = randomToken(32);
  const state = await encryptSecret(deps.config.appSecret, JSON.stringify({ p, u: auth.userId, o: auth.orgId, v: verifier, t: deps.now().getTime() }));
  const q = new URLSearchParams({
    client_id: e.client.clientId, redirect_uri: redirectUri(deps, p), response_type: "code", scope: e.scope, state,
    code_challenge: await challenge(verifier), code_challenge_method: "S256",
    ...(p === "google" ? { access_type: "offline", prompt: "consent" } : { prompt: "select_account" }),
  });
  return `${e.auth}?${q}`;
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { email?: string; preferred_username?: string; upn?: string };
    return (payload.email ?? payload.preferred_username ?? payload.upn ?? null)?.toLowerCase() ?? null;
  } catch { return null; }
}

async function tokenRequest(deps: Deps, p: OAuthProvider, body: Record<string, string>) {
  const e = endpoints(deps, p);
  const res = await deps.fetch(e.token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.client.clientId, client_secret: e.client.clientSecret, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    const err = new HttpError(400, "oauth_failed", json.error === "invalid_grant" ? "The sign in expired or was withdrawn. Connect the account again." : "The provider didn't finish the sign in. Try again.");
    (err as unknown as { authenticationFailed: boolean }).authenticationFailed = json.error === "invalid_grant";
    throw err;
  }
  return json;
}

/** Finishes the sign in: checks the state, swaps the code for tokens. Returns what createConnection needs. */
export async function oauthFinish(deps: Deps, auth: AuthContext, p: OAuthProvider, code: string, stateRaw: string) {
  let state: { p: string; u: string; o: string; v: string; t: number };
  try { state = JSON.parse(await decryptSecret(deps.config.appSecret, stateRaw)); } catch { throw new HttpError(400, "oauth_state", "That sign in link is not valid. Start again from Connected accounts."); }
  if (state.p !== p || state.u !== auth.userId || state.o !== auth.orgId || deps.now().getTime() - state.t > 15 * 60_000) {
    throw new HttpError(400, "oauth_state", "That sign in link expired or belongs to someone else. Start again from Connected accounts.");
  }
  const tokens = await tokenRequest(deps, p, { grant_type: "authorization_code", code, redirect_uri: redirectUri(deps, p), code_verifier: state.v });
  const email = emailFromIdToken(tokens.id_token);
  if (!email) throw new HttpError(400, "oauth_failed", "The provider didn't share the email address. Try again.");
  if (!tokens.refresh_token) throw new HttpError(400, "oauth_failed", "The provider didn't allow offline access. Try again and accept every permission.");
  const workspace = !/@(gmail|googlemail)\.com$/.test(email);
  const preset = p === "google" ? (workspace ? "google_workspace" : "gmail") : /@(outlook|hotmail|live|msn)\./.test(email) ? "outlook" : "microsoft365";
  return { email, preset: preset as "gmail" | "google_workspace" | "outlook" | "microsoft365", refreshToken: tokens.refresh_token };
}

const cache = new Map<string, { token: string; until: number }>();

/** A fresh access token for an OAuth connection (kept in memory until a minute before it expires). */
export async function accessTokenFor(deps: Deps, c: Pick<Connection, "id" | "provider">, refreshToken: string) {
  const hit = cache.get(c.id);
  if (hit && hit.until > deps.now().getTime()) return hit.token;
  const p: OAuthProvider = c.provider === "gmail" || c.provider === "google_workspace" ? "google" : "microsoft";
  const t = await tokenRequest(deps, p, { grant_type: "refresh_token", refresh_token: refreshToken });
  cache.set(c.id, { token: t.access_token!, until: deps.now().getTime() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000 });
  return t.access_token!;
}

export function clearTokenCache() { cache.clear(); }
