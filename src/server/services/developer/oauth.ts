/**
 * OAuth 2.1 for the MCP endpoint (round 20), so Claude, ChatGPT, Cursor and other MCP clients can add
 * Multies by its URL and sign in, instead of pasting an API key.
 *
 * - Dynamic client registration (RFC 7591): public clients only, PKCE with S256 is required.
 * - A grant is one person's sign in of one client to one workspace, as read only or read and write.
 * - The authorisation code and the refresh token carry the grant id and are kept only as hashes.
 * - Access tokens are signed with a key derived from APP_SECRET and never stored (0 writes). Each use
 *   reads the grant, so a revoke in Settings takes effect on the next request.
 * - D1 writes: registration 1 row; sign in 2 (row + org index); code exchange 2; refresh 2; revoke 2;
 *   last used at most once an hour per grant (2). API keys keep working unchanged.
 */
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { members, oauthClients, oauthGrants, organizations, users } from "../../db/schema";
import { hmacSha256Hex, newId, randomToken, safeEqual, sha256Hex, tryFromB64 } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import type { ApiKeyAuth, ApiKeyScope } from "./api-keys";
import { deferrableWrite } from "../write-priority";
import { ssoBlocks } from "../../auth/session";

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 3600_000;
export const CODE_TTL_MS = 60_000;
/** last_used_at is written at most this often per grant (D1 daily write budget). */
export const GRANT_LAST_USED_EVERY_MS = 60 * 60_000;
export const OAUTH_SCOPES = ["mcp:read", "mcp:write"] as const;
const MAX_REDIRECT_URIS = 10;

/** An OAuth error in the shape RFC 6749 section 5.2 asks for. */
export class OAuthError extends Error {
  constructor(public status: number, public error: string, public description: string) { super(description); }
  body() { return { error: this.error, error_description: this.description }; }
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// R49: the shared tolerant decode; a token part that is not base64url reads as "" so JSON.parse fails and the token is refused (401), never an atob throw.
const fromB64url = (s: string) => { const b = tryFromB64(s); return b ? new TextDecoder().decode(b) : ""; };

/** S256 of a PKCE verifier, base64url without padding (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return b64url(bin);
}

/**
 * Redirect URIs a client may register: https anywhere, http only on this machine (loopback, for
 * desktop clients), and app schemes such as cursor:// or vscode://. Never script, data or file URLs,
 * and never a fragment.
 */
export function checkRedirectUri(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OAuthError(400, "invalid_redirect_uri", `Not a valid URL: ${raw.slice(0, 200)}`); }
  if (raw.length > 2000) throw new OAuthError(400, "invalid_redirect_uri", "A redirect URI can be at most 2,000 characters.");
  if (u.hash) throw new OAuthError(400, "invalid_redirect_uri", "A redirect URI can't have a fragment.");
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") return raw;
  if (scheme === "http") {
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return raw;
    throw new OAuthError(400, "invalid_redirect_uri", "Plain http redirect URIs are allowed only for localhost.");
  }
  if (["javascript", "data", "file", "blob", "vbscript", "about", "ftp", "ws", "wss"].includes(scheme)) throw new OAuthError(400, "invalid_redirect_uri", `The ${scheme}: scheme can't be a redirect URI.`);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new OAuthError(400, "invalid_redirect_uri", "That redirect URI scheme is not valid.");
  return raw;
}

export interface ClientRegistration { redirect_uris?: unknown; client_name?: unknown; client_uri?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown; response_types?: unknown }

/** RFC 7591 registration. One row, no index. */
export async function registerClient(deps: Deps, input: ClientRegistration) {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (!uris.length || uris.some((u) => typeof u !== "string")) throw new OAuthError(400, "invalid_redirect_uri", "Send redirect_uris: a list of one or more URLs.");
  if (uris.length > MAX_REDIRECT_URIS) throw new OAuthError(400, "invalid_redirect_uri", `Up to ${MAX_REDIRECT_URIS} redirect URIs per client.`);
  const redirectUris = (uris as string[]).map(checkRedirectUri);
  const method = input.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new OAuthError(400, "invalid_client_metadata", "Multies registers public clients: use token_endpoint_auth_method none with PKCE.");
  const grantTypes = Array.isArray(input.grant_types) ? input.grant_types : ["authorization_code", "refresh_token"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError(400, "invalid_client_metadata", "Supported grant types: authorization_code and refresh_token.");
  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : "An MCP client";
  let clientUri: string | null = null;
  if (typeof input.client_uri === "string" && /^https:\/\//.test(input.client_uri) && input.client_uri.length <= 500) clientUri = input.client_uri;
  const id = newId("mcpc");
  const now = deps.now();
  await deps.db.insert(oauthClients).values({ id, name, redirectUris: JSON.stringify(redirectUris), clientUri, createdAt: now });
  return {
    client_id: id, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name, redirect_uris: redirectUris,
    ...(clientUri ? { client_uri: clientUri } : {}),
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  };
}

export async function getClient(deps: Deps, clientId: string) {
  const row = await deps.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
  if (!row) return null;
  return { ...row, redirectUris: JSON.parse(row.redirectUris) as string[] };
}

export interface AuthorizeRequest { client_id?: string; redirect_uri?: string; response_type?: string; code_challenge?: string; code_challenge_method?: string; scope?: string; state?: string; resource?: string }

/**
 * Checks an authorisation request. Errors that make the redirect URI untrustworthy are shown to the
 * person (never redirected); the rest go back to the client as ?error=.
 */
export async function checkAuthorizeRequest(deps: Deps, q: AuthorizeRequest) {
  if (!q.client_id) throw new OAuthError(400, "invalid_request", "This sign in link has no client_id. Start again from the app you are connecting.");
  const client = await getClient(deps, q.client_id);
  if (!client) throw new OAuthError(400, "invalid_client", "This app is not registered with Multies. Start again from the app you are connecting.");
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "The redirect address does not match what this app registered.");
  if (q.response_type !== "code") throw new OAuthError(400, "unsupported_response_type", "Only response_type=code is supported.");
  if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) throw new OAuthError(400, "invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  const asked = (q.scope ?? "").split(/\s+/).filter(Boolean);
  const unknown = asked.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new OAuthError(400, "invalid_scope", `Unknown scope: ${unknown.join(" ")}. Use mcp:read or mcp:write.`);
  // No scope or mcp:write asks for read and write; the person can still pick read only.
  const requestedScope: ApiKeyScope = asked.length && !asked.includes("mcp:write") ? "read" : "full";
  return { client: { id: client.id, name: client.name, clientUri: client.clientUri }, redirectUri, requestedScope, state: q.state ?? null, codeChallenge: q.code_challenge };
}

/** The workspaces a person can connect: every human membership, with its role. */
export async function workspacesFor(deps: Deps, userId: string) {
  return deps.db.select({ id: organizations.id, name: organizations.name, role: members.role, suspendedAt: organizations.suspendedAt, requireSso: organizations.requireSso })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.userId, userId), eq(members.kind, "human"))).all();
}

export const scopeWord = (s: ApiKeyScope) => (s === "read" ? "mcp:read" : "mcp:read mcp:write");

/** The person said yes: a grant row with the code's hash. Returns the URL to send the browser to. */
export async function approve(deps: Deps, user: Pick<AuthContext, "userId" | "loginMethod">, q: AuthorizeRequest, choice: { orgId: string; scope: ApiKeyScope }, issuer = deps.config.appUrl) {
  const req = await checkAuthorizeRequest(deps, q);
  const ws = (await workspacesFor(deps, user.userId)).find((w) => w.id === choice.orgId);
  if (!ws) throw new HttpError(403, "forbidden", "You are not a member of that workspace.");
  if (ws.suspendedAt) throw new HttpError(403, "workspace_suspended", "This workspace is suspended.");
  // PRIV1b (P41): the guards' "Require SSO" rule holds for the chosen workspace, not only the session's active one.
  if (ssoBlocks(ws.requireSso, ws.role, user.loginMethod)) throw new HttpError(403, "sso_required", "This workspace requires single sign on. Sign out, then sign in with your company's SSO.");
  // Never more than the app asked for.
  const scope: "full" | "read" = req.requestedScope === "read" || choice.scope === "read" ? "read" : "full"; // R36: OAuth grants keep the two presets
  const id = newId("mcpg");
  const secret = randomToken(24);
  const code = `${id}.${secret}`;
  const now = deps.now();
  await deps.db.insert(oauthGrants).values({
    id, clientId: req.client.id, orgId: ws.id, userId: user.userId, scope, redirectUri: req.redirectUri,
    codeHash: await sha256Hex(code), codeChallenge: req.codeChallenge, codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now,
  });
  const url = new URL(req.redirectUri);
  url.searchParams.set("code", code);
  if (req.state) url.searchParams.set("state", req.state);
  url.searchParams.set("iss", issuer);
  return { redirectTo: url.toString(), grantId: id, scope, orgId: ws.id };
}

/** The person said no: the client hears access_denied. */
export async function deny(deps: Deps, q: AuthorizeRequest) {
  const req = await checkAuthorizeRequest(deps, q);
  const url = new URL(req.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "The person did not allow access.");
  if (req.state) url.searchParams.set("state", req.state);
  return { redirectTo: url.toString() };
}

async function signingKey(deps: Deps) { return hmacSha256Hex(deps.config.appSecret, "multies-mcp-oauth-access-v1"); }

async function issueTokens(deps: Deps, grant: typeof oauthGrants.$inferSelect) {
  const now = deps.now();
  const exp = Math.floor(now.getTime() / 1000) + ACCESS_TOKEN_TTL_S;
  const payload = b64url(JSON.stringify({ g: grant.id, exp }));
  const sig = await hmacSha256Hex(await signingKey(deps), payload);
  const access = `mm_oat_${payload}.${sig}`;
  const refresh = `mm_ort_${grant.id}.${randomToken(30)}`;
  return { access, refresh, refreshHash: await sha256Hex(refresh), refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS) };
}

const tokenBody = (t: { access: string; refresh: string }, scope: ApiKeyScope) => ({ access_token: t.access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: t.refresh, scope: scopeWord(scope) });

async function grantByToken(deps: Deps, token: string, prefix: string) {
  const m = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  const id = m.split(".")[0];
  if (!/^mcpg_[A-Za-z0-9]+$/.test(id ?? "")) return null;
  return (await deps.db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).get()) ?? null;
}

export interface TokenRequest { grant_type?: string; code?: string; redirect_uri?: string; client_id?: string; code_verifier?: string; refresh_token?: string; resource?: string }

/** The token endpoint: authorization_code (with PKCE) and refresh_token (rotating). */
export async function token(deps: Deps, r: TokenRequest) {
  const now = deps.now();
  if (r.grant_type === "authorization_code") {
    if (!r.code || !r.code_verifier || !r.client_id) throw new OAuthError(400, "invalid_request", "Send code, code_verifier and client_id.");
    const grant = await grantByToken(deps, r.code, "");
    if (!grant || !grant.codeHash || !safeEqual(grant.codeHash, await sha256Hex(r.code))) throw new OAuthError(400, "invalid_grant", "That code is not valid.");
    if (grant.codeUsedAt) {
      // A code used twice may have been stolen: end the grant (OAuth 2.1, section 4.1.3).
      await deps.db.update(oauthGrants).set({ revokedAt: now, refreshHash: null }).where(eq(oauthGrants.id, grant.id));
      throw new OAuthError(400, "invalid_grant", "That code was already used.");
    }
    if (grant.revokedAt || !grant.codeExpiresAt || grant.codeExpiresAt.getTime() < now.getTime()) throw new OAuthError(400, "invalid_grant", "That code has expired. Sign in again.");
    if (grant.clientId !== r.client_id) throw new OAuthError(400, "invalid_grant", "That code belongs to another client.");
    if (r.redirect_uri && r.redirect_uri !== grant.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the sign in request.");
    if (!grant.codeChallenge || (await pkceChallenge(r.code_verifier)) !== grant.codeChallenge) throw new OAuthError(400, "invalid_grant", "The PKCE code_verifier does not match.");
    const t = await issueTokens(deps, grant);
    // PRIV1b (P70): tokens only when this request is the one that marked the code used; a racing second exchange ends the grant.
    const won = await deps.db.update(oauthGrants).set({ codeUsedAt: now, refreshHash: t.refreshHash, refreshExpiresAt: t.refreshExpiresAt, lastUsedAt: now })
      .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.codeUsedAt), isNull(oauthGrants.revokedAt))).returning({ id: oauthGrants.id }).get();
    if (!won) {
      await deps.db.update(oauthGrants).set({ revokedAt: now, refreshHash: null }).where(eq(oauthGrants.id, grant.id));
      throw new OAuthError(400, "invalid_grant", "That code was already used.");
    }
    return tokenBody(t, grant.scope);
  }
  if (r.grant_type === "refresh_token") {
    if (!r.refresh_token) throw new OAuthError(400, "invalid_request", "Send refresh_token.");
    const grant = await grantByToken(deps, r.refresh_token, "mm_ort_");
    const presented = await sha256Hex(r.refresh_token);
    if (!grant || grant.revokedAt || !grant.refreshHash) throw new OAuthError(400, "invalid_grant", "That refresh token is not valid. Sign in again.");
    if (!safeEqual(grant.refreshHash, presented)) {
      // PRIV1b (P70): an old (rotated) refresh token for a live grant was replayed: one copy is stolen, so end the grant (OAuth 2.1 section 4.3.1).
      await revokeGrantRow(deps, grant.id);
      throw new OAuthError(400, "invalid_grant", "That refresh token is not valid. Sign in again.");
    }
    if (r.client_id && r.client_id !== grant.clientId) throw new OAuthError(400, "invalid_grant", "That refresh token belongs to another client.");
    if (!grant.refreshExpiresAt || grant.refreshExpiresAt.getTime() < now.getTime()) throw new OAuthError(400, "invalid_grant", "That refresh token has expired. Sign in again.");
    const t = await issueTokens(deps, grant);
    // PRIV1b (P70): rotate only from the token just checked; a racing refresh with the same token loses and ends the grant.
    const won = await deps.db.update(oauthGrants).set({ refreshHash: t.refreshHash, refreshExpiresAt: t.refreshExpiresAt, lastUsedAt: now })
      .where(and(eq(oauthGrants.id, grant.id), eq(oauthGrants.refreshHash, presented), isNull(oauthGrants.revokedAt))).returning({ id: oauthGrants.id }).get();
    if (!won) {
      await revokeGrantRow(deps, grant.id);
      throw new OAuthError(400, "invalid_grant", "That refresh token is not valid. Sign in again.");
    }
    return tokenBody(t, grant.scope);
  }
  throw new OAuthError(400, "unsupported_grant_type", "Supported grant types: authorization_code and refresh_token.");
}

async function revokeGrantRow(deps: Deps, id: string) {
  await deps.db.update(oauthGrants).set({ revokedAt: deps.now(), refreshHash: null }).where(and(eq(oauthGrants.id, id), isNull(oauthGrants.revokedAt)));
}

/** PRIV1b (P48): account recovery (password change or reset, sign out everywhere, a ban) ends every app the person signed in. */
export async function revokeUserGrants(deps: Deps, userId: string) {
  await deps.db.update(oauthGrants).set({ revokedAt: deps.now(), refreshHash: null }).where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
}

/**
 * PRIV1b (P41): when a workspace starts requiring SSO, grants made before (possibly from a password session) end,
 * except the owner's (the break glass account the rule exempts). New grants pass the same rule in approve().
 */
export async function revokeGrantsForSso(deps: Deps, orgId: string) {
  const owners = (await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.role, "owner"))).all()).map((m) => m.userId);
  await deps.db.update(oauthGrants).set({ revokedAt: deps.now(), refreshHash: null })
    .where(and(eq(oauthGrants.orgId, orgId), isNull(oauthGrants.revokedAt), owners.length ? notInArray(oauthGrants.userId, owners) : undefined));
}

/** A platform ban that is in force (Better Auth's admin plugin lifts an expired one at the next sign in). */
export const banActive = (u: { banned: boolean | null; banExpires: Date | null }, now: Date) => !!u.banned && (!u.banExpires || u.banExpires.getTime() > now.getTime());

/** RFC 7009: revoking either token ends the grant. Unknown tokens are not an error. */
export async function revokeToken(deps: Deps, tokenValue: string) {
  let grantId: string | null = null;
  if (tokenValue.startsWith("mm_oat_")) grantId = (await verifyAccessToken(deps, tokenValue))?.g ?? null;
  else if (tokenValue.startsWith("mm_ort_")) {
    const g = await grantByToken(deps, tokenValue, "mm_ort_");
    if (g?.refreshHash && safeEqual(g.refreshHash, await sha256Hex(tokenValue))) grantId = g.id;
  }
  if (grantId) await deps.db.update(oauthGrants).set({ revokedAt: deps.now(), refreshHash: null }).where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
}

async function verifyAccessToken(deps: Deps, tokenValue: string): Promise<{ g: string; exp: number } | null> {
  const m = tokenValue.match(/^mm_oat_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/);
  if (!m) return null;
  if (!safeEqual(await hmacSha256Hex(await signingKey(deps), m[1]), m[2])) return null;
  try {
    const p = JSON.parse(fromB64url(m[1])) as { g?: unknown; exp?: unknown };
    if (typeof p.g !== "string" || typeof p.exp !== "number") return null;
    if (p.exp * 1000 < deps.now().getTime()) return null;
    return { g: p.g, exp: p.exp };
  } catch { return null; }
}

/**
 * Resolves `Authorization: Bearer mm_oat_...` to the same shape an API key gives, acting as the person
 * who signed in, with their role in the workspace. Read only grants are limited exactly like read keys.
 */
export async function resolveOAuthToken(deps: Deps, header: string | undefined): Promise<(ApiKeyAuth & { oauthGrantId: string; clientName: string }) | null> {
  const tokenValue = header?.match(/^Bearer\s+(mm_oat_\S+)$/)?.[1];
  if (!tokenValue) return null;
  const p = await verifyAccessToken(deps, tokenValue);
  if (!p) return null;
  const row = await deps.db.select({ g: oauthGrants, role: members.role, kind: members.kind, name: users.name, email: users.email, banned: users.banned, banExpires: users.banExpires, suspendedAt: organizations.suspendedAt, clientName: oauthClients.name })
    .from(oauthGrants)
    .innerJoin(organizations, eq(organizations.id, oauthGrants.orgId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .leftJoin(members, and(eq(members.userId, oauthGrants.userId), eq(members.organizationId, oauthGrants.orgId)))
    .where(eq(oauthGrants.id, p.g)).get();
  // Revoked, or the person left the workspace: the token stops working at once.
  if (!row || row.g.revokedAt || !row.role || row.kind !== "human") return null;
  const now = deps.now();
  if (banActive(row, now)) return null; // PRIV1b (P48): a banned person's apps stop at once
  if (!row.g.lastUsedAt || now.getTime() - row.g.lastUsedAt.getTime() > GRANT_LAST_USED_EVERY_MS) {
    await deferrableWrite(deps, "last_used", `grant:${row.g.id}`, () => deps.db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.g.id))); // R32: deferrable
  }
  return {
    userId: row.g.userId, email: row.email, name: row.name, orgId: row.g.orgId, role: row.role,
    sessionId: `oauth:${row.g.id}`, apiKeyId: `oauth:${row.g.id}`, scope: row.g.scope, orgSuspended: !!row.suspendedAt, agentId: null,
    oauthGrantId: row.g.id, clientName: row.clientName,
  };
}

/** Settings, Developers: the AI apps signed in to this workspace. Admins see all; members see their own. */
export async function listGrants(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId" | "role">) {
  const admin = auth.role === "owner" || auth.role === "admin";
  const rows = await deps.db.select({ g: oauthGrants, clientName: oauthClients.name, userName: users.name, userEmail: users.email })
    .from(oauthGrants).innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId)).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthGrants.orgId, auth.orgId), admin ? undefined : eq(oauthGrants.userId, auth.userId), isNull(oauthGrants.revokedAt)))
    .orderBy(desc(oauthGrants.createdAt)).limit(200).all();
  // A code nobody exchanged is not a connection.
  return rows.filter((r) => r.g.codeUsedAt).map((r) => ({
    id: r.g.id, client: r.clientName, scope: r.g.scope, user: { id: r.g.userId, name: r.userName, email: r.userEmail },
    createdAt: r.g.createdAt, lastUsedAt: r.g.lastUsedAt, mine: r.g.userId === auth.userId,
  }));
}

export async function revokeGrant(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId" | "role">, id: string) {
  const g = await deps.db.select().from(oauthGrants).where(and(eq(oauthGrants.id, id), eq(oauthGrants.orgId, auth.orgId))).get();
  if (!g || g.revokedAt) throw notFound("Connected app");
  const admin = auth.role === "owner" || auth.role === "admin";
  if (!admin && g.userId !== auth.userId) throw new HttpError(403, "forbidden", "Only an admin can disconnect someone else's app.");
  await deps.db.update(oauthGrants).set({ revokedAt: deps.now(), refreshHash: null }).where(eq(oauthGrants.id, g.id));
  return g;
}

/** RFC 9728 and RFC 8414 metadata. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/v1/mcp`, authorization_servers: [origin], scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"], resource_name: "Multies", resource_documentation: `${origin}/agents`,
  };
}
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/agents`,
  };
}
