import type { Context, MiddlewareHandler } from "hono";
import { checkWorkspaceBudget, isBudgetExempt, WORKSPACE_BUDGET_CODE, workspaceBudgetMessage } from "../services/workspace-budget";
import { authHeaders } from "../lib/host-cookie";
import { and, desc, eq, gt } from "drizzle-orm";
import type { AppEnv, AuthContext, Deps } from "../context";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import { isLostRequestState, withAuthRequestState } from "../lib/request-state";
import { invitations, members, organizations, sessions, users } from "../db/schema";
import { newId } from "../lib/crypto";
import { audit } from "../services/audit";
import { authFor } from "./options";
import { SSO_METHODS } from "./session";
import { workspaceMark } from "./workspace-mark";
import { DEFAULT_COUNTRY, DEFAULT_TIMEZONE, isCountry } from "@/shared/locale";
import { autoWorkspaceName } from "@/shared/person-name";

/*
 * Route guards. Every route that acts for a person goes through requireAuth (the session
 * cookie, from any sign in path), then requireAdmin or requirePlatformAdmin where the action
 * needs a role. API keys and MCP tokens for agents have their own guard in routes/v1.ts and
 * routes/mcp.ts, so a person's session and an agent's key never stand in for each other.
 */

/**
 * Resolves the Better Auth session and the workspace it points at. Someone with no
 * workspace yet (a brand-new or social sign-in) gets a personal one here, so every
 * sign-in path ends in the same place.
 */
export async function resolveAuth(deps: Deps, rawHeaders: Headers): Promise<AuthContext | null> {
  // R32: the WebSocket upgrades reach here without the app's cookie middleware; read the __Host- cookie too.
  const headers = authHeaders(rawHeaders, deps.config.mode === "production");
  const getSession = () => authFor(deps).api.getSession({ headers });
  let s: Awaited<ReturnType<typeof getSession>>;
  try {
    s = await getSession();
  } catch (err) {
    if (!isLostRequestState(err)) throw err;
    s = await withAuthRequestState(getSession);
  }
  if (!s) return null;
  const { db } = deps;
  // The membership and the workspace's SSO rule in one query: on D1 each query is a round trip.
  const memberWithOrg = (where: ReturnType<typeof and>) => db.select({ member: members, requireSso: organizations.requireSso })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(where).get();
  let found = s.session.activeOrganizationId
    ? await memberWithOrg(and(eq(members.userId, s.user.id), eq(members.organizationId, s.session.activeOrganizationId)))
    : undefined;
  found ??= await memberWithOrg(eq(members.userId, s.user.id));
  let member = found?.member;
  let requireSso = found?.requireSso ?? false;
  // R41 (MB-221, MB-202): a brand new person whose confirmed email has a pending invitation joins that
  // workspace on their first sign in, instead of getting a personal workspace and its setup. One indexed
  // lookup by email, only on this first sign in path (never on a signed in read).
  if (!member && s.user.emailVerified) {
    const joined = await joinPendingInviteOnFirstSignIn(deps, headers, s.user, s.session.id);
    if (joined) {
      found = await memberWithOrg(and(eq(members.userId, s.user.id), eq(members.organizationId, joined)));
      member = found?.member;
      requireSso = found?.requireSso ?? false;
    }
  }
  if (!member) {
    const orgId = newId("org");
    // No zone is assumed: UTC until onboarding saves the person's own (from their browser). The
    // country starts from the edge's guess (Cloudflare's CF-IPCountry) when it is a real country.
    const edgeCountry = (headers.get("cf-ipcountry") ?? "").toUpperCase();
    await db.insert(organizations).values({
      id: orgId, name: autoWorkspaceName(s.user.name, s.user.email), slug: orgId, // R56 (MB-248): never the raw email
      timezone: DEFAULT_TIMEZONE, country: isCountry(edgeCountry) ? edgeCountry : DEFAULT_COUNTRY,
    });
    const memberId = newId("mem");
    await db.insert(members).values({ id: memberId, organizationId: orgId, userId: s.user.id, role: "owner" });
    member = (await db.select().from(members).where(eq(members.id, memberId)).get())!;
    requireSso = false;
    await audit(db, { orgId, actorUserId: s.user.id, actorEmail: s.user.email, action: "account.created" });
  }
  if (member.organizationId !== s.session.activeOrganizationId) {
    await db.update(sessions).set({ activeOrganizationId: member.organizationId }).where(eq(sessions.id, s.session.id));
  }
  let platformRole = s.user.role ?? "user";
  // Bootstrap operators: listed user ids, or listed emails once the address is verified
  // (an unverified address proves nothing; anyone could have signed up with it).
  const listed = deps.config.platformAdmins.includes(s.user.id.toLowerCase())
    || (s.user.emailVerified && deps.config.platformAdmins.includes(s.user.email.toLowerCase()));
  if (platformRole !== "admin" && listed) {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, s.user.id));
    platformRole = "admin";
  }
  // Workspaces that require SSO: everyone but the owner (the break glass account) must
  // have signed in this session through an SSO provider.
  const loginMethod = (s.session as { loginMethod?: string | null }).loginMethod ?? "email";
  const ssoBlocked = requireSso && member.role !== "owner" && !SSO_METHODS.has(loginMethod);
  return {
    ssoBlocked, loginMethod,
    userId: s.user.id, email: s.user.email, name: s.user.name, orgId: member.organizationId, role: member.role,
    sessionId: s.session.id, emailVerified: s.user.emailVerified, twoFactor: !!s.user.twoFactorEnabled,
    platformRole,
  };
}

/**
 * R41: accepts the newest pending, unexpired invitation for this confirmed address through the same
 * Better Auth call the invite page uses (seat limits, email match and confirmation all checked there).
 * Returns the workspace id, or null when there is none or accepting fails (the person then gets a
 * personal workspace as before, and the Join banner still offers the invite).
 */
export async function joinPendingInviteOnFirstSignIn(deps: Deps, headers: Headers, user: { id: string; email: string }, sessionId: string): Promise<string | null> {
  const { db } = deps;
  const inv = await db.select({ id: invitations.id, orgId: invitations.organizationId, title: invitations.title, bio: invitations.bio, role: invitations.role })
    .from(invitations)
    .where(and(eq(invitations.email, user.email.toLowerCase()), eq(invitations.status, "pending"), gt(invitations.expiresAt, deps.now())))
    .orderBy(desc(invitations.createdAt)).limit(1).get();
  if (!inv) return null;
  try {
    await authFor(deps).api.acceptInvitation({ headers, body: { invitationId: inv.id } });
  } catch (err) {
    deps.log?.warn?.("invite.auto_join_failed", { error: String(err).slice(0, 200) });
    return null;
  }
  if (inv.title || inv.bio) {
    await db.update(members).set({ title: inv.title, bio: inv.bio }).where(and(eq(members.organizationId, inv.orgId), eq(members.userId, user.id)));
  }
  await db.update(sessions).set({ activeOrganizationId: inv.orgId }).where(eq(sessions.id, sessionId));
  await audit(db, { orgId: inv.orgId, actorUserId: user.id, actorEmail: user.email, action: "invite.accepted", metadata: { role: inv.role ?? "member", via: "first_sign_in" } }).catch(() => undefined);
  return inv.orgId;
}

/*
 * R40 (MB-199): the free plan stops a Worker at 10 ms of CPU, and resolving a session through Better Auth
 * plus the membership query was about 3 ms of every signed in request before the route did any work.
 * Reads (GET and HEAD) reuse a resolved session for a few seconds inside the same isolate, keyed by the exact
 * session cookie value (only a value that already resolved is ever stored). Writes always resolve afresh and
 * drop the cached copy for that cookie first, so signing out, switching workspace or a role change made by the
 * person is seen at once. A change made by someone else (an admin removing a member, revoking a session) is
 * seen by reads within AUTH_CACHE_MS. Memory only: never a D1 write, nothing shared across isolates.
 */
export const AUTH_CACHE_MS = 15_000;
const AUTH_CACHE_MAX = 2_000;
const authCache = new Map<string, { auth: AuthContext; until: number; mark: string }>();

/** The session cookie value a request carries (either cookie name), or null. */
export function sessionCookieKey(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie || !cookie.includes("session_token=")) return null;
  const m = cookie.match(/(?:^|;\s*)(?:__Host-|__Secure-)?mymail\.session_token=([^;]+)/);
  return m ? m[1] : null;
}

const SESSION_NAMES = ["mymail.session_token", "__Secure-mymail.session_token", "__Host-mymail.session_token"];

/** Every session cookie value in the header, under any of the three names. */
function sessionCookieValues(cookie: string | null): { name: string; value: string }[] {
  if (!cookie) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (SESSION_NAMES.includes(name)) out.push({ name, value: part.slice(i + 1).trim() });
  }
  return out;
}

/*
 * R40 sec: the cache key is the value of the one cookie the sign in library will actually read for this request
 * (after the __Host- rewrite), never simply the first session cookie in the header. Before this, a header such as
 * "mymail.session_token=X; __Host-mymail.session_token=REAL" resolved REAL's session but stored it under X, so
 * whoever could plant cookie X in a victim's browser (a sibling subdomain) could then send X alone and read as
 * the victim. A request whose effective cookie appears more than once, or that carries an Authorization header,
 * is never cached.
 */
export function effectiveSessionKey(headers: Headers, production: boolean): string | null {
  if (headers.has("authorization")) return null;
  const effective = authHeaders(headers, production);
  const want = production ? "__Secure-mymail.session_token" : "mymail.session_token";
  const found = sessionCookieValues(effective.get("cookie")).filter((p) => p.name === want);
  if (found.length !== 1 || !found[0].value) return null;
  return found[0].value;
}

/** Drops the cached session for every session cookie value this request carries (before every write and on sign out). */
export function forgetCachedAuth(headers: Headers) {
  for (const { value } of sessionCookieValues(headers.get("cookie"))) authCache.delete(value);
}

/** Test hook: empties the in-isolate session cache. */
export function clearAuthCache() { authCache.clear(); }

export async function resolveAuthCached(deps: Deps, headers: Headers, method: string, path = ""): Promise<AuthContext | null> {
  const key = effectiveSessionKey(headers, deps.config.mode === "production");
  // Account routes (security, sessions) and the operator console always read the session afresh, so a revoked
  // session or an operator role change shows at once. R41 (MB-199): the app shell's /me reads the copy too, but
  // only once the address is confirmed, so confirming it in another isolate (or on the phone) shows at once; a new
  // workspace, a switch or signing out are writes, which drop the copy first.
  const me = path === "/api/account/me";
  const read = (method === "GET" || method === "HEAD") && (me || !path.startsWith("/api/account")) && !path.startsWith("/api/admin");
  if (!key) return resolveAuth(deps, headers);
  const now = Date.now();
  // Multiws: a copy made before this browser switched workspace (in any isolate) carries another mark and is not used.
  const mark = workspaceMark(headers);
  if (read) {
    const hit = authCache.get(key);
    if (hit && hit.until > now && hit.mark === mark && (!me || (hit.auth.emailVerified && !hit.auth.ssoBlocked))) return hit.auth;
    // /me that does not use the copy also drops it, as it did when /me always read afresh (it is the app's refresh).
    if (me) authCache.delete(key);
  } else {
    authCache.delete(key);
  }
  const auth = await resolveAuth(deps, headers);
  // A write can change what the session points at (accepting an invite, switching workspace), so only reads
  // fill the cache. /me reads a copy another read made but never fills one (it is the first call after sign in).
  if (!read || me) return auth;
  if (auth) {
    if (authCache.size >= AUTH_CACHE_MAX) authCache.delete(authCache.keys().next().value as string);
    authCache.set(key, { auth, until: now + AUTH_CACHE_MS, mark });
  } else {
    authCache.delete(key);
  }
  return auth;
}

/** Requires a valid session; populates `c.var.auth`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await resolveAuthCached(c.var.deps, c.req.raw.headers, c.req.method, c.req.path);
  if (!auth) throw unauthorized();
  // A workspace that requires SSO only lets password sessions reach account level routes
  // (profile, export, switching workspaces), so the person can still move or leave.
  if (auth.ssoBlocked && !c.req.path.startsWith("/api/account")) {
    throw new HttpError(403, "sso_required", "This workspace requires single sign on. Sign out, then sign in with your company's SSO.");
  }
  c.set("auth", auth);
  await enforceWorkspaceBudget(c, auth.orgId);
  await next();
};

/** Operators only (Better Auth admin role). */
export const requirePlatformAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.platformRole !== "admin") throw forbidden("Only platform operators can do that.");
  await next();
};

/** Owners and admins only. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.role === "member") throw forbidden("Only workspace admins can do that.");
  await next();
};


/**
 * R48 (MB-235): a workspace over its own daily write budget gets a calm 429 on writes until 00:00 UTC; reading,
 * sign in, account and billing keep working, and other workspaces are not affected (services/workspace-budget.ts).
 */
export async function enforceWorkspaceBudget(c: Context<AppEnv>, orgId: string | null | undefined) {
  if (!orgId || isBudgetExempt(c.req.method, c.req.path)) return;
  const level = await checkWorkspaceBudget(c.var.deps, orgId);
  if (level === "near") c.header("x-workspace-budget", "near");
  if (level === "over") throw new HttpError(429, WORKSPACE_BUDGET_CODE, workspaceBudgetMessage(), { resetsAt: "00:00 UTC" });
}
