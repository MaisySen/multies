import type { Context, MiddlewareHandler } from "hono";
import { checkWorkspaceBudget, isBudgetExempt, WORKSPACE_BUDGET_CODE, workspaceBudgetMessage } from "../services/workspace-budget";
import { authHeaders } from "../lib/host-cookie";
import { and, desc, eq, gt } from "drizzle-orm";
import type { AppEnv, AuthContext, Deps } from "../context";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import { isLostRequestState, withAuthRequestState } from "../lib/request-state";
import { noteRequestCaller } from "../lib/request-caller";
import { invitations, members, organizations, platformAuditLogs, sessions, users } from "../db/schema";
import { newId } from "../lib/crypto";
import { audit } from "../services/audit";
import { authFor } from "./options";
import { ssoBlocks } from "./session";
import { workspaceMark } from "./workspace-mark";
import { DEFAULT_COUNTRY, DEFAULT_TIMEZONE, isCountry } from "@/shared/locale";
import { autoWorkspaceName } from "@/shared/person-name";
import { REFERRAL_COOKIE } from "@/shared/referral-link";
import { isOperatorRole } from "@/shared/operator-permissions";
import { activeImpersonationFor, closeImpersonationSockets, ALWAYS_BLOCKED_MESSAGE, impersonationBlock, VIEW_ONLY_MESSAGE } from "../services/console/impersonation"; // OPS1 impersonation

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
  // OPS1 impersonation: an operator's "View as" session. Its operator_impersonations row (one indexed read) decides
  // whether it is still usable, and with what mode; no row, an ended row or one past OUR expiry deletes the session.
  // Such a session never runs the sign in side effects below (invite joins, a new workspace, referral, operator
  // bootstrap): a page load while viewing as someone must never write on their behalf.
  const impersonatedBy = (s.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
  const impersonation = impersonatedBy
    ? await activeImpersonationFor(db, { id: s.session.id, userId: s.user.id, impersonatedBy }, deps.now(), (row) => closeImpersonationSockets(deps, row)) // OPS1 security (L2)
    : null;
  if (impersonatedBy && !impersonation) return null;
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
  if (!member && s.user.emailVerified && !impersonation) { // OPS1 impersonation: never joins for the person
    const joined = await joinPendingInviteOnFirstSignIn(deps, headers, s.user, s.session.id);
    if (joined) {
      found = await memberWithOrg(and(eq(members.userId, s.user.id), eq(members.organizationId, joined)));
      member = found?.member;
      requireSso = found?.requireSso ?? false;
    }
  }
  // OPS1 impersonation: a person with no workspace left is not set up one while viewed (the session reads as signed out).
  if (!member && impersonation) return null;
  if (!member) {
    // AIS1 (audit row 1): an account made before the fix whose address reaches an AI agent never gets a workspace of
    // its own either. Only on this no workspace path (a first sign in), never on a member's signed in read: a few
    // indexed reads. Such a session lands here on every request, so the refusal is flagged once a day, not each time.
    const { refuseAgentAddress } = await import("../services/agents/agent-address");
    try {
      await refuseAgentAddress(deps, s.user.email, { action: "member.join_refused", actorUserId: s.user.id, actorEmail: s.user.email, metadata: { via: "new_workspace" }, oncePerDay: true });
    } catch (err) {
      if (err instanceof HttpError) throw forbidden(err.message);
      throw err;
    }
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
    // R62: came through a referral link (the web app keeps the code in a cookie until sign up). Only on this path,
    // and only when the cookie is there: one indexed read and one write. Never blocks sign in.
    // The module loads only then, so sign in and every signed in request load nothing new.
    const cookie = rawHeaders.get("cookie") ?? "";
    if (cookie.includes(`${REFERRAL_COOKIE}=`)) {
      const ref = await import("../services/billing/referrals");
      const refCode = ref.referralCodeFromCookie(cookie);
      if (refCode) await ref.recordReferralSignup(deps, { orgId, userId: s.user.id, email: s.user.email, code: refCode });
    }
  }
  if (member.organizationId !== s.session.activeOrganizationId) {
    await db.update(sessions).set({ activeOrganizationId: member.organizationId }).where(eq(sessions.id, s.session.id));
  }
  // OPS1 impersonation: an impersonated session is never an operator, whatever the person's role.
  let platformRole = impersonation ? "user" : s.user.role ?? "user";
  // Bootstrap operators: listed user ids, or listed emails once the address is verified
  // (an unverified address proves nothing; anyone could have signed up with it).
  const listedId = deps.config.platformAdmins.includes(s.user.id.toLowerCase());
  let listed = listedId || (s.user.emailVerified && deps.config.platformAdmins.includes(s.user.email.toLowerCase()));
  // OPS1 security (H2): an address an operator marked confirmed (console Verify) proves nothing about who owns it, so
  // it never makes an owner. Only on this rare path (listed by address and not yet admin): one indexed read.
  if (listed && !listedId && !impersonation && platformRole !== "admin" && await operatorVerifiedEmail(deps, s.user.id)) listed = false;
  if (!impersonation && platformRole !== "admin" && listed) { // OPS1 impersonation: no bootstrap promotion
    await db.update(users).set({ role: "admin" }).where(eq(users.id, s.user.id));
    platformRole = "admin";
  }
  // Workspaces that require SSO: everyone but the owner (the break glass account) must
  // have signed in this session through an SSO provider.
  const loginMethod = (s.session as { loginMethod?: string | null }).loginMethod ?? "email";
  // OPS1 impersonation: support can open a workspace that requires SSO (the operator signed in to the console instead).
  const ssoBlocked = impersonation ? false : ssoBlocks(requireSso, member.role, loginMethod);
  return {
    ssoBlocked, loginMethod,
    userId: s.user.id, email: s.user.email, name: s.user.name, orgId: member.organizationId, role: member.role,
    sessionId: s.session.id, emailVerified: s.user.emailVerified, twoFactor: !!s.user.twoFactorEnabled,
    platformRole,
    // OPS1: Better Auth's session row carries createdAt, and impersonatedBy from the admin plugin's schema.
    sessionCreatedAt: s.session.createdAt instanceof Date ? s.session.createdAt : new Date(s.session.createdAt),
    impersonatedBy,
    impersonation, // OPS1 impersonation
  };
}

/**
 * OPS1 security (H2): true when an operator marked this account's address confirmed from the console (a platform audit
 * row user.email_verified on the user; platform_audit_target_idx). Such an address was never proven by the person, so
 * it never bootstraps an owner and never auto-joins a pending invite. Called only on rare paths (a listed address not
 * yet promoted; a first sign in with no workspace and a pending invite).
 */
export async function operatorVerifiedEmail(deps: Pick<Deps, "db">, userId: string): Promise<boolean> {
  const row = await deps.db.select({ id: platformAuditLogs.id }).from(platformAuditLogs)
    .where(and(eq(platformAuditLogs.targetId, userId), eq(platformAuditLogs.targetType, "user"), eq(platformAuditLogs.action, "user.email_verified")))
    .limit(1).get();
  return !!row;
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
  // OPS1 security (H2): an address an operator confirmed is not proof the person owns it, so it is never joined
  // silently; the person can still choose Join on the invite banner.
  if (await operatorVerifiedEmail(deps, user.id)) return null;
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
  const read = (method === "GET" || method === "HEAD") && (me || !path.startsWith("/api/account")) && !path.startsWith("/api/admin") && !path.startsWith("/api/console");
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
  // OPS1 impersonation: an impersonated session is never kept, so ending it (Stop, the console, a demoted operator) shows at once.
  if (auth && !auth.impersonatedBy) {
    if (authCache.size >= AUTH_CACHE_MAX) authCache.delete(authCache.keys().next().value as string);
    authCache.set(key, { auth, until: now + AUTH_CACHE_MS, mark });
  } else {
    authCache.delete(key);
  }
  return auth;
}

/** Requires a valid session; populates `c.var.auth`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  let auth = await resolveAuthCached(c.var.deps, c.req.raw.headers, c.req.method, c.req.path);
  if (!auth) throw unauthorized();
  if (auth.impersonatedBy) auth = await enforceImpersonation(c, auth); // OPS1 impersonation
  // A workspace that requires SSO only lets password sessions reach account level routes
  // (profile, export, switching workspaces), so the person can still move or leave.
  if (auth.ssoBlocked && !c.req.path.startsWith("/api/account")) {
    throw new HttpError(403, "sso_required", "This workspace requires single sign on. Sign out, then sign in with your company's SSO.");
  }
  c.set("auth", auth);
  noteRequestCaller(auth); // AIS1: audit entries made in this request carry the IP (lib/request-caller.ts)
  await enforceWorkspaceBudget(c, auth.orgId);
  await next();
};

/**
 * OPS1 impersonation: what an impersonated session may do here. A cached copy past OUR expiry is read afresh (which
 * deletes the session and answers 401); then the always blocked list (both modes) and, in view mode, every write.
 */
async function enforceImpersonation(c: Context<AppEnv>, cached: AuthContext): Promise<AuthContext> {
  let auth: AuthContext | null = cached;
  if (!auth.impersonation || auth.impersonation.expiresAt.getTime() <= c.var.deps.now().getTime()) {
    forgetCachedAuth(c.req.raw.headers);
    auth = await resolveAuth(c.var.deps, c.req.raw.headers);
    if (!auth) throw unauthorized();
  }
  assertImpersonationAllows(auth, c.req.method, c.req.path);
  return auth;
}

/**
 * OPS1 impersonation: THE check for an impersonated session doing `method path`. Throws 401 when the session has no
 * usable impersonation, 403 impersonation_blocked when the always blocked list (both modes) or view mode refuses it.
 * Does nothing for a normal session. requireAuth runs it; any other entry point must use resolveAuthFor below.
 */
export function assertImpersonationAllows(auth: AuthContext, method: string, path: string): void {
  if (!auth.impersonatedBy) return;
  const imp = auth.impersonation;
  if (!imp) throw unauthorized();
  const block = impersonationBlock(imp.mode, method, path);
  if (block === "always") throw new HttpError(403, "impersonation_blocked", ALWAYS_BLOCKED_MESSAGE);
  if (block === "view") throw new HttpError(403, "impersonation_blocked", VIEW_ONLY_MESSAGE);
}

/**
 * OPS1 impersonation: the session for an entry point that does not run requireAuth (the doc and chat WebSockets, and
 * anything added later). Same as resolveAuth, then assertImpersonationAllows for the request it stands for. Callers
 * that hold a connection open must also honour `auth.impersonation.mode` (view: receive only). A source sweep
 * (tests/console-impersonation-entrypoints.test.ts) fails when a new file calls resolveAuth directly.
 */
export async function resolveAuthFor(deps: Deps, headers: Headers, req: { method: string; path: string }): Promise<AuthContext | null> {
  const auth = await resolveAuth(deps, headers);
  if (auth) assertImpersonationAllows(auth, req.method, req.path);
  return auth;
}

/** OPS1 impersonation: true when this session may only receive on a live connection (view mode). */
export const receiveOnly = (auth: Pick<AuthContext, "impersonation">): boolean => auth.impersonation?.mode === "view";

/**
 * Operators only. OPS1: any operator role (src/shared/operator-permissions.ts) passes; routes that need a particular
 * permission use requireOperator (auth/operator.ts) instead. Kept for older callers.
 */
export const requirePlatformAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isOperatorRole(c.var.auth.platformRole)) throw forbidden("Only platform operators can do that.");
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
