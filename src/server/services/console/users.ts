/**
 * OPS1 Phase 1: the operator console's read model for user accounts, plus its data actions (clear a sign-in lockout,
 * mark an address verified, ban and unban, end sessions). No routes and no guards: the route layer (routes/console/users.ts) adds
 * requireOperator, the reason prompt and the platform audit, and drops any cached auth for the person.
 *
 * Never returned: password hashes, OAuth access, refresh or id tokens, session tokens, TOTP secrets or backup codes.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import type { AppConfig } from "../../config";
import { accounts, loginThrottle, members, organizations, sessions, twoFactors, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { containsAny, normalizeQuery } from "../../lib/like-search";
import { clearFailures, lockedUntil } from "../lockout";
import { effectivePlanId } from "../plans";
import { iso, keysetPage, pageOut, type PageRequest, type Paged, type SortColumn } from "./workspaces";
import type { PlanId } from "@/shared/plans";
import { OPERATOR_ROLES, isOperatorRole } from "@/shared/operator-permissions";

/** The platform operator roles stored in users.role (the shared list in src/shared/operator-permissions.ts). */
export const CONSOLE_OPERATOR_ROLES = OPERATOR_ROLES;
const OPERATOR_ROLE_SQL = sql.raw(`(${OPERATOR_ROLES.map((r) => `'${r}'`).join(", ")})`);

/** The most sessions listSessions returns for one person (newest first). */
export const USER_SESSIONS_CAP = 100;

// ---- users list ------------------------------------------------------------------------------------------------

export const USER_SORTS = ["createdAt", "email", "name"] as const;
export type UserSort = (typeof USER_SORTS)[number];
const USER_SORT_COLUMNS: Record<UserSort, SortColumn> = {
  createdAt: { col: users.createdAt, type: "time" },
  email: { col: users.email, type: "text" },
  name: { col: users.name, type: "text" },
};

export interface UserFilters {
  banned?: boolean;
  /** true: address not confirmed; false: confirmed. */
  unverified?: boolean;
  /** true: holds a platform operator role. */
  operator?: boolean;
  twoFactor?: boolean;
}
export interface ListUsersInput { q?: string; filters?: UserFilters; page: PageRequest }

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** users.role as stored ("user", null, or an operator role). */
  role: string | null;
  operator: boolean;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  twoFactorEnabled: boolean;
  lastLoginMethod: string | null;
  /** "agent" when the account is only an AI agent member (no sign in of its own). */
  kind: "person" | "agent";
  /** Workspaces the account belongs to. */
  workspaces: number;
  createdAt: string;
}

const searchText = (q: string | undefined) => normalizeQuery(q ?? "").slice(0, 100);

/** Accounts matching a search (address, name, id) and filters, one page at a time. */
export async function listUsers(deps: Pick<Deps, "db">, input: ListUsersInput): Promise<Paged<UserListItem>> {
  const p = keysetPage(input.page, USER_SORT_COLUMNS, users.id);
  const q = searchText(input.q);
  const f = input.filters ?? {};
  const conds: (SQL | undefined)[] = [p.where];
  if (q) conds.push(containsAny([users.email, users.name, users.id], q));
  if (f.banned !== undefined) conds.push(f.banned ? sql`coalesce(${users.banned}, 0) = 1` : sql`coalesce(${users.banned}, 0) = 0`);
  if (f.unverified !== undefined) conds.push(eq(users.emailVerified, !f.unverified));
  if (f.twoFactor !== undefined) conds.push(f.twoFactor ? sql`coalesce(${users.twoFactorEnabled}, 0) = 1` : sql`coalesce(${users.twoFactorEnabled}, 0) = 0`);
  if (f.operator !== undefined) conds.push(f.operator ? sql`coalesce(${users.role}, '') in ${OPERATOR_ROLE_SQL}` : sql`coalesce(${users.role}, '') not in ${OPERATOR_ROLE_SQL}`);
  const rows = await deps.db.select({
    id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified, role: users.role, banned: users.banned,
    banReason: users.banReason, banExpires: users.banExpires, twoFactorEnabled: users.twoFactorEnabled, lastLoginMethod: users.lastLoginMethod,
    createdAt: users.createdAt,
    // Hand qualified: Drizzle renders columns unqualified in a one table select.
    workspaces: sql<number>`(select count(*) from "members" m where m."user_id" = "users"."id")`,
    agentRows: sql<number>`(select count(*) from "members" m where m."user_id" = "users"."id" and m."kind" = 'agent')`,
  }).from(users).where(and(...conds)).orderBy(...p.orderBy).limit(p.limit + 1);
  return pageOut(rows, p.limit, p.field, (r) => ({
    id: r.id, email: r.email, name: r.name, emailVerified: !!r.emailVerified, role: r.role, operator: isOperatorRole(r.role), banned: !!r.banned,
    banReason: r.banReason, banExpires: iso(r.banExpires), twoFactorEnabled: !!r.twoFactorEnabled, lastLoginMethod: r.lastLoginMethod,
    kind: Number(r.agentRows) > 0 && Number(r.agentRows) === Number(r.workspaces) ? "agent" : "person",
    workspaces: Number(r.workspaces ?? 0), createdAt: iso(r.createdAt)!,
  }));
}

// ---- user detail -----------------------------------------------------------------------------------------------

export interface UserMembership {
  memberId: string; orgId: string; orgName: string; plan: PlanId; effectivePlan: PlanId; isDemo: boolean; suspendedAt: string | null;
  role: "owner" | "admin" | "member"; kind: "human" | "agent"; joinedAt: string;
}
export interface UserLinkedAccount {
  id: string;
  /** "credential" for a password, else the sign in provider (google, github, auth0, ...). */
  providerId: string;
  /** The provider's id for the person (not a secret). */
  accountId: string;
  hasPassword: boolean;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UserLockoutState {
  locked: boolean;
  lockedUntil: string | null;
  /** Failed password sign ins in the current window. */
  failures: number;
  windowStart: string | null;
}
export interface UserTwoFactorState {
  /** users.two_factor_enabled. */
  enabled: boolean;
  /** A TOTP secret is set up (its value is never returned). */
  configured: boolean;
  verified: boolean | null;
  failedAttempts: number;
  lockedUntil: string | null;
}
export interface UserDetail {
  profile: {
    id: string; email: string; name: string; emailVerified: boolean; image: string | null; role: string | null; operator: boolean;
    banned: boolean; banReason: string | null; banExpires: string | null; lastLoginMethod: string | null;
    timezone: string | null; locale: string | null; createdAt: string; updatedAt: string;
  };
  memberships: UserMembership[];
  accounts: UserLinkedAccount[];
  twoFactor: UserTwoFactorState;
  lockout: UserLockoutState;
  /** Sessions that have not expired. */
  activeSessions: number;
}

/** One account's profile, workspaces, sign in methods, 2FA and lockout state. 404 when it does not exist. */
export async function getUserDetail(deps: Pick<Deps, "db" | "now">, userId: string): Promise<UserDetail> {
  const u = await deps.db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  const now = deps.now();
  const [ms, acc, tf, throttle, until, active] = await Promise.all([
    deps.db.select({
      memberId: members.id, orgId: organizations.id, orgName: organizations.name, plan: organizations.plan, compPlan: organizations.compPlan,
      isDemo: organizations.isDemo, suspendedAt: organizations.suspendedAt, role: members.role, kind: members.kind, createdAt: members.createdAt,
    }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, userId))
      .orderBy(desc(members.createdAt), desc(members.id)).limit(500),
    deps.db.select({
      id: accounts.id, providerId: accounts.providerId, accountId: accounts.accountId, scope: accounts.scope, createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt, hasPassword: sql<number>`(${accounts.password} is not null)`,
    }).from(accounts).where(eq(accounts.userId, userId)).orderBy(desc(accounts.createdAt)),
    deps.db.select({ verified: twoFactors.verified, failed: twoFactors.failedVerificationCount, lockedUntil: twoFactors.lockedUntil })
      .from(twoFactors).where(eq(twoFactors.userId, userId)).get(),
    deps.db.select().from(loginThrottle).where(eq(loginThrottle.email, u.email.trim().toLowerCase())).get(),
    lockedUntil(deps.db, u.email, now),
    deps.db.select({ n: sql<number>`count(*)` }).from(sessions).where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > ${now.getTime()}`)).get(),
  ]);
  return {
    profile: {
      id: u.id, email: u.email, name: u.name, emailVerified: !!u.emailVerified, image: u.image, role: u.role, operator: isOperatorRole(u.role),
      banned: !!u.banned, banReason: u.banReason, banExpires: iso(u.banExpires), lastLoginMethod: u.lastLoginMethod,
      timezone: u.timezone, locale: u.locale, createdAt: iso(u.createdAt)!, updatedAt: iso(u.updatedAt)!,
    },
    memberships: ms.map((m) => ({
      memberId: m.memberId, orgId: m.orgId, orgName: m.orgName, plan: m.plan, effectivePlan: effectivePlanId(m), isDemo: !!m.isDemo,
      suspendedAt: iso(m.suspendedAt), role: m.role, kind: m.kind, joinedAt: iso(m.createdAt)!,
    })),
    accounts: acc.map((a) => ({
      id: a.id, providerId: a.providerId, accountId: a.accountId, hasPassword: !!Number(a.hasPassword), scope: a.scope,
      createdAt: iso(a.createdAt)!, updatedAt: iso(a.updatedAt)!,
    })),
    twoFactor: {
      enabled: !!u.twoFactorEnabled, configured: !!tf, verified: tf ? tf.verified ?? null : null, failedAttempts: tf?.failed ?? 0,
      lockedUntil: tf?.lockedUntil && tf.lockedUntil > now ? tf.lockedUntil.toISOString() : null,
    },
    lockout: {
      locked: !!until, lockedUntil: iso(until), failures: throttle?.failures ?? 0, windowStart: iso(throttle?.windowStart),
    },
    activeSessions: Number(active?.n ?? 0),
  };
}

// ---- sessions --------------------------------------------------------------------------------------------------

export interface UserSession {
  id: string;
  createdAt: string; updatedAt: string; expiresAt: string;
  /** Not expired. */
  active: boolean;
  ipAddress: string | null; userAgent: string | null; loginMethod: string | null; activeOrganizationId: string | null;
  /** The operator who started this session by impersonation, if any. */
  impersonatedBy: string | null;
}

/** One account's sessions, newest first (at most USER_SESSIONS_CAP). Never the session token. */
export async function listUserSessions(deps: Pick<Deps, "db" | "now">, userId: string): Promise<UserSession[]> {
  const u = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  const now = deps.now();
  const rows = await deps.db.select({
    id: sessions.id, createdAt: sessions.createdAt, updatedAt: sessions.updatedAt, expiresAt: sessions.expiresAt, ipAddress: sessions.ipAddress,
    userAgent: sessions.userAgent, loginMethod: sessions.loginMethod, activeOrganizationId: sessions.activeOrganizationId, impersonatedBy: sessions.impersonatedBy,
  }).from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt), desc(sessions.id)).limit(USER_SESSIONS_CAP);
  return rows.map((s) => ({
    id: s.id, createdAt: iso(s.createdAt)!, updatedAt: iso(s.updatedAt)!, expiresAt: iso(s.expiresAt)!, active: s.expiresAt > now,
    ipAddress: s.ipAddress, userAgent: s.userAgent, loginMethod: s.loginMethod, activeOrganizationId: s.activeOrganizationId, impersonatedBy: s.impersonatedBy,
  }));
}

// ---- actions (the route layer adds the guard, the reason and the audit) ---------------------------------------

export interface ClearLockoutResult { userId: string; email: string; wasLocked: boolean; failures: number }

/** Clears the account's failed password sign in count and any lock (services/lockout.ts). Idempotent. */
export async function clearUserLockout(deps: Pick<Deps, "db" | "now">, userId: string): Promise<ClearLockoutResult> {
  const u = await deps.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  const [until, row] = await Promise.all([
    lockedUntil(deps.db, u.email, deps.now()),
    deps.db.select({ failures: loginThrottle.failures }).from(loginThrottle).where(eq(loginThrottle.email, u.email.trim().toLowerCase())).get(),
  ]);
  await clearFailures(deps.db, u.email);
  return { userId: u.id, email: u.email, wasLocked: !!until, failures: row?.failures ?? 0 };
}

export interface MarkVerifiedResult { userId: string; email: string; alreadyVerified: boolean }

/** Marks the account's address as confirmed. Idempotent: an already confirmed address is left as it is. */
export async function markEmailVerified(deps: Pick<Deps, "db">, userId: string): Promise<MarkVerifiedResult> {
  const u = await deps.db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  if (!u.emailVerified) await deps.db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
  return { userId: u.id, email: u.email, alreadyVerified: !!u.emailVerified };
}

// ---- ban, sessions and delete (OPS1 Phase 1 routes) --------------------------------------------------------------
//
// Why not auth.api.banUser / revokeUserSession(s): Better Auth's admin plugin is set up with adminRoles ["admin"]
// (src/server/auth/options.ts), so it refuses every lower operator tier (ops_admin, ops_support) that holds users.ban
// or users.sessions. These do what the plugin does (users.banned, ban_reason, ban_expires; delete the sessions) plus
// what options.ts runs after /admin/ban-user and /revoke-sessions (end the person's app grants, close live sockets),
// the same path reports-r35.ts uses to suspend a person. The plugin's session hook still refuses a banned person's
// next sign in, and lifts a ban whose expiry has passed.

export interface UserTarget { id: string; email: string; role: string | null; operator: boolean }

/** The account an operator acts on (404 when it does not exist). */
export async function getUserTarget(deps: Pick<Deps, "db">, userId: string): Promise<UserTarget> {
  const u = await deps.db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  return { ...u, operator: isOperatorRole(u.role) };
}

/**
 * OPS1 security: true when the account's id or address is listed in PLATFORM_ADMIN_EMAILS (config.platformAdmins),
 * whether or not it has signed in or been promoted yet.
 */
export function isBootstrapListed(config: Pick<AppConfig, "platformAdmins">, u: { id: string; email: string }): boolean {
  return config.platformAdmins.includes(u.id.toLowerCase()) || config.platformAdmins.includes(u.email.trim().toLowerCase());
}

/** OPS1 security: an account the console never bans, suspends, deletes or vouches for: any operator role, or bootstrap listed. */
export function isProtectedAccount(config: Pick<AppConfig, "platformAdmins">, u: { id: string; email: string; role: string | null }): boolean {
  return isOperatorRole(u.role) || isBootstrapListed(config, u);
}

/**
 * OPS1 security: the check every service that bans, suspends or deletes an account runs itself, so no caller (a route
 * written later, a script) can skip it. 403 target_is_operator for an operator or a bootstrap listed account.
 */
export async function assertNotProtectedTarget(deps: Pick<Deps, "db" | "config">, userId: string, verb: string): Promise<UserTarget> {
  const t = await getUserTarget(deps, userId);
  if (isProtectedAccount(deps.config, t)) {
    throw new HttpError(403, "target_is_operator", `This person is a platform operator, so you can't ${verb} here. Change their access on the Operators page first.`);
  }
  return t;
}

export interface BanState { banned: boolean; banReason: string | null; banExpires: string | null }
const banState = (u: { banned: boolean | null; banReason: string | null; banExpires: Date | null }): BanState => ({ banned: !!u.banned, banReason: u.banReason, banExpires: iso(u.banExpires) });

async function readBan(deps: Pick<Deps, "db">, userId: string): Promise<BanState> {
  const u = await deps.db.select({ banned: users.banned, banReason: users.banReason, banExpires: users.banExpires }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  return banState(u);
}

async function endAppsAndSockets(deps: Deps, userId: string) {
  await (await import("../developer/oauth")).revokeUserGrants(deps, userId);
  await (await import("../../realtime/publish")).closeUserSockets(deps, userId);
}

/** The operator signing the person out, for the workspace's Activity entry when that ends a View as session. */
export interface Actor { userId: string; email: string | null }

/** OPS1: a View as session that ran on the deleted sessions ends with them (services/console/impersonation.ts). */
async function endViewAs(deps: Deps, userId: string, opts: { sessionId?: string; actor?: Actor }) {
  await (await import("./impersonation")).endImpersonationsOfTarget(deps, userId, opts);
}

export const BAN_MAX_DAYS = 3650;

/** Bans the account (sign in refused), optionally until `expiresInDays` from now, and ends its sessions and apps. */
export async function banUser(deps: Deps, userId: string, input: { reason: string; expiresInDays?: number | null }, actor?: Actor): Promise<{ before: BanState; after: BanState; sessionsEnded: number }> {
  await assertNotProtectedTarget(deps, userId, "ban them"); // OPS1 security: here too, not only in the route
  const before = await readBan(deps, userId);
  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > BAN_MAX_DAYS)) throw new HttpError(422, "validation_failed", `A ban lasts 1 to ${BAN_MAX_DAYS} days, or leave it open ended.`);
  const banExpires = days ? new Date(deps.now().getTime() + days * 86_400_000) : null;
  await deps.db.update(users).set({ banned: true, banReason: input.reason, banExpires }).where(eq(users.id, userId));
  const ended = await deps.db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  await endAppsAndSockets(deps, userId);
  await endViewAs(deps, userId, { actor });
  return { before, after: await readBan(deps, userId), sessionsEnded: ended.length };
}

/** Lifts a ban. Idempotent. */
export async function unbanUser(deps: Pick<Deps, "db">, userId: string): Promise<{ before: BanState; after: BanState }> {
  const before = await readBan(deps, userId);
  if (before.banned || before.banReason || before.banExpires) await deps.db.update(users).set({ banned: false, banReason: null, banExpires: null }).where(eq(users.id, userId));
  return { before, after: await readBan(deps, userId) };
}

/** Ends one of the account's sessions (404 when it is not theirs). */
export async function revokeUserSession(deps: Deps, userId: string, sessionId: string, actor?: Actor): Promise<{ sessionId: string; ipAddress: string | null; userAgent: string | null }> {
  const s = await deps.db.select({ id: sessions.id, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent }).from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).get();
  if (!s) throw notFound("Session");
  await deps.db.delete(sessions).where(and(eq(sessions.id, s.id), eq(sessions.userId, userId)));
  await endViewAs(deps, userId, { sessionId: s.id, actor });
  return { sessionId: s.id, ipAddress: s.ipAddress, userAgent: s.userAgent };
}

/** Signs the account out everywhere: every session ends, and (as on the person's own "sign out everywhere") their apps' access and live sockets end too. */
export async function revokeAllUserSessions(deps: Deps, userId: string, actor?: Actor): Promise<{ sessionsEnded: number }> {
  await getUserTarget(deps, userId);
  const ended = await deps.db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  await endAppsAndSockets(deps, userId);
  await endViewAs(deps, userId, { actor });
  return { sessionsEnded: ended.length };
}

/**
 * OPS1 security: deletes an account as DELETE /api/account would for the person (services/privacy.ts beforeUserDelete:
 * workspaces where they are the only member go with it, 409 while they are the only owner of a shared workspace).
 * Refuses an operator or a bootstrap listed account itself (403 target_is_operator), whoever calls it.
 */
export async function deleteUserAccount(deps: Deps, userId: string, actor?: Actor): Promise<{ id: string; email: string }> {
  const t = await assertNotProtectedTarget(deps, userId, "delete their account");
  const { beforeUserDelete } = await import("../privacy");
  await beforeUserDelete(deps, t.id);
  await deps.db.delete(users).where(eq(users.id, t.id));
  await endViewAs(deps, t.id, { actor });
  return { id: t.id, email: t.email };
}
