import type { AppConfig } from "../config";

type Mgmt = NonNullable<AppConfig["auth"]["auth0Management"]>;

let cached: { key: string; token: string; expiresAt: number } | null = null;

/** A Management API token for the machine-to-machine client, reused until a minute before it expires. */
async function token(m: Mgmt, now = Date.now()): Promise<string> {
  const key = `${m.domain}|${m.clientId}`;
  if (cached && cached.key === key && cached.expiresAt > now + 60_000) return cached.token;
  const res = await fetch(`https://${m.domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: m.clientId, client_secret: m.clientSecret, audience: `https://${m.domain}/api/v2/` }),
  });
  if (!res.ok) throw new Error(`auth0 token ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cached = { key, token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function call(m: Mgmt, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://${m.domain}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(m)}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Deletes a person from Auth0 by their Auth0 user id (the `sub`). A person Auth0 no longer has counts as deleted. */
export async function deleteAuth0User(m: Mgmt, userId: string): Promise<void> {
  const res = await call(m, "DELETE", `/users/${encodeURIComponent(userId)}`);
  if (!res.ok && res.status !== 404) throw new Error(`auth0 delete ${res.status}`);
}

/**
 * Sends a fresh verification email to an unverified password account with this address.
 * Answers nothing about whether the address exists, so the caller can always say "sent if it exists".
 */
export async function resendAuth0Verification(m: Mgmt, email: string): Promise<{ sent: boolean }> {
  const res = await call(m, "GET", `/users-by-email?email=${encodeURIComponent(email.toLowerCase())}`);
  if (!res.ok) throw new Error(`auth0 lookup ${res.status}`);
  const users = (await res.json()) as { user_id: string; email_verified?: boolean; identities?: { provider: string; connection: string; user_id: string }[] }[];
  const target = users.find((u) => !u.email_verified && (u.identities ?? []).some((i) => i.provider === "auth0"));
  if (!target) return { sent: false };
  const ident = (target.identities ?? []).find((i) => i.provider === "auth0");
  const job = await call(m, "POST", "/jobs/verification-email", { user_id: target.user_id, ...(ident ? { identity: { user_id: ident.user_id, provider: ident.provider } } : {}) });
  if (!job.ok) throw new Error(`auth0 resend ${job.status}`);
  return { sent: true };
}

/**
 * Asks the identity provider to email a password reset link for a password account with this
 * address (its public change password endpoint, which answers the same whether or not the address
 * has an account). Used by "Email me a reset link" after the sign in move on 25 October 2026:
 * people who set a password before then set a new one here.
 */
export async function sendAuth0PasswordReset(idp: { domain: string; clientId: string }, email: string): Promise<void> {
  const res = await fetch(`https://${idp.domain}/dbconnections/change_password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: idp.clientId, email: email.toLowerCase(), connection: "Username-Password-Authentication" }),
  });
  if (!res.ok) throw new Error(`auth0 change_password ${res.status}`);
}

/** For tests: forget the cached token. */
export function resetAuth0TokenCache() { cached = null; }
