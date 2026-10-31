/**
 * R83: linked TikTok and Threads accounts. Tokens are encrypted with APP_SECRET on the way in and decrypted only to
 * call the network. One account per network per workspace: connecting again replaces the old link.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { directSocialLinks } from "../../db/schema";
import { decryptSecret, encryptSecret, newId, safeEqual } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import type { DirectAccountView, DirectProvider } from "../../../shared/direct-social";

export type LinkRow = typeof directSocialLinks.$inferSelect;

export const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
export function requireManager(auth: AuthContext) {
  if (!isAdmin(auth)) throw new HttpError(403, "forbidden", "Only owners and admins can change connections.");
}

export function available(deps: Deps, p: DirectProvider) {
  return p === "tiktok" ? !!deps.config.direct.tiktok : !!deps.config.direct.threads;
}

export async function getLink(deps: Deps, orgId: string, p: DirectProvider) {
  return deps.db.select().from(directSocialLinks).where(and(eq(directSocialLinks.orgId, orgId), eq(directSocialLinks.provider, p))).get();
}

export interface SaveLink {
  providerUserId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string | null;
}

/** Writes (or replaces) the workspace's link for a network. */
export async function saveLink(deps: Deps, auth: AuthContext, p: DirectProvider, v: SaveLink) {
  const secret = deps.config.appSecret;
  const now = deps.now();
  const enc = { accessTokenEnc: await encryptSecret(secret, v.accessToken), refreshTokenEnc: v.refreshToken ? await encryptSecret(secret, v.refreshToken) : null };
  const values = {
    providerUserId: v.providerUserId, username: v.username, displayName: v.displayName, avatarUrl: v.avatarUrl, ...enc,
    accessExpiresAt: v.accessExpiresAt, refreshExpiresAt: v.refreshExpiresAt, scopes: v.scopes, status: "active" as const, updatedAt: now,
  };
  await deps.db.insert(directSocialLinks).values({ id: newId("dsl"), orgId: auth.orgId, provider: p, createdBy: auth.userId, createdAt: now, ...values })
    .onConflictDoUpdate({ target: [directSocialLinks.orgId, directSocialLinks.provider], set: { ...values, createdBy: auth.userId, createdAt: now } });
}

export async function updateTokens(deps: Deps, id: string, t: { accessToken: string; refreshToken?: string | null; accessExpiresAt: Date | null; refreshExpiresAt?: Date | null }) {
  const secret = deps.config.appSecret;
  await deps.db.update(directSocialLinks).set({
    accessTokenEnc: await encryptSecret(secret, t.accessToken),
    ...(t.refreshToken ? { refreshTokenEnc: await encryptSecret(secret, t.refreshToken) } : {}),
    accessExpiresAt: t.accessExpiresAt,
    ...(t.refreshExpiresAt !== undefined ? { refreshExpiresAt: t.refreshExpiresAt } : {}),
    status: "active", updatedAt: deps.now(),
  }).where(eq(directSocialLinks.id, id));
}

export async function markExpired(deps: Deps, id: string) {
  await deps.db.update(directSocialLinks).set({ status: "expired", updatedAt: deps.now() }).where(eq(directSocialLinks.id, id));
}

export async function deleteLink(deps: Deps, id: string) {
  await deps.db.delete(directSocialLinks).where(eq(directSocialLinks.id, id));
}

/** Removes every workspace's link to one network account (the network said the person took their access back). */
export async function deleteByProviderUser(deps: Deps, p: DirectProvider, providerUserId: string) {
  const rows = await deps.db.delete(directSocialLinks).where(and(eq(directSocialLinks.provider, p), eq(directSocialLinks.providerUserId, providerUserId))).returning({ id: directSocialLinks.id, orgId: directSocialLinks.orgId });
  return rows;
}

export const accessToken = (deps: Deps, l: LinkRow) => decryptSecret(deps.config.appSecret, l.accessTokenEnc);
export const refreshToken = (deps: Deps, l: LinkRow) => (l.refreshTokenEnc ? decryptSecret(deps.config.appSecret, l.refreshTokenEnc) : Promise.resolve(null));

function profileUrl(p: DirectProvider, username: string | null) {
  if (!username) return null;
  return p === "tiktok" ? `https://www.tiktok.com/@${encodeURIComponent(username)}` : `https://www.threads.net/@${encodeURIComponent(username)}`;
}

export function viewOf(deps: Deps, p: DirectProvider, l: LinkRow | undefined): DirectAccountView {
  return {
    provider: p,
    available: available(deps, p),
    testMode: p === "tiktok" ? !!deps.config.direct.tiktok?.sandbox : false,
    connected: !!l,
    status: l ? l.status : null,
    username: l?.username ?? null,
    displayName: l?.displayName ?? null,
    avatarUrl: l?.avatarUrl ?? null,
    profileUrl: l ? profileUrl(p, l.username) : null,
    connectedAt: l ? l.createdAt.toISOString() : null,
  };
}

/** A failure from a network call, with one of our own codes (DIRECT_ERROR_COPY). */
export class DirectError extends HttpError {
  constructor(public reason: string, message: string, status: ConstructorParameters<typeof HttpError>[0] = 502) { super(status, reason, message); }
}

export async function challengeS256(verifier: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** TikTok's PKCE wants the SHA-256 of the verifier as hex (its own docs), not base64url. */
export async function challengeHex(verifier: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** n: a nonce also kept in an httpOnly cookie on this browser, cleared at the return, so a state works once and only where it started. */
export interface OAuthState { p: DirectProvider; u: string; o: string; v: string; t: number; n?: string }

export async function makeState(deps: Deps, auth: AuthContext, p: DirectProvider, verifier: string, nonce?: string) {
  return encryptSecret(deps.config.appSecret, JSON.stringify({ p, u: auth.userId, o: auth.orgId, v: verifier, t: deps.now().getTime(), ...(nonce ? { n: nonce } : {}) } satisfies OAuthState));
}

export async function readState(deps: Deps, auth: AuthContext, p: DirectProvider, raw: string, nonce?: string | null): Promise<OAuthState> {
  let s: OAuthState;
  try { s = JSON.parse(await decryptSecret(deps.config.appSecret, raw)) as OAuthState; } catch { throw new HttpError(400, "oauth_state", "That sign in link is not valid. Start again from Connections."); }
  if (s.p !== p || s.u !== auth.userId || s.o !== auth.orgId || deps.now().getTime() - s.t > 15 * 60_000) {
    throw new HttpError(400, "oauth_state", "That sign in link expired or belongs to someone else. Start again from Connections.");
  }
  if (s.n && (!nonce || !safeEqual(s.n, nonce))) throw new HttpError(400, "oauth_state", "That sign in was already used or started in another browser. Start again from Connections.");
  return s;
}

export const redirectUri = (deps: Deps, p: DirectProvider) => `${deps.config.appUrl}/api/connections/oauth/${p}/callback`;
