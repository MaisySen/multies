/**
 * OPS1 Phase 1: the operator console's read model for user accounts, plus two plain data actions (clear a sign-in
 * lockout, mark an address verified). No routes and no guards: the route layer (routes/console/users.ts) adds
 * requireOperator, the reason prompt and the platform audit, and drops any cached auth for the person.
 *
 * Never returned: password hashes, OAuth access, refresh or id tokens, session tokens, TOTP secrets or backup codes.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { accounts, loginThrottle, members, organizations, sessions, twoFactors, users } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { containsAny, normalizeQuery } from "../../lib/like-search";
import { clearFailures, lockedUntil } from "../lockout";
import { effectivePlanId } from "../plans";
import { iso, keysetPage, pageOut, type PageRequest, type Paged, type SortColumn } from "./workspaces";
import type { PlanId } from "@/shared/plans";

/**
 * The platform operator roles stored in users.role (plan: Operator roles). Phase 0 adds the shared list in
 * src/shared/operator-permissions.ts; this filter should use its OPERATOR_ROLES once that lands.
 */
export const CONSOLE_OPERATOR_ROLES = ["admin", "ops_admin", "ops_billing", "ops_support", "ops_readonly"] as const;
const OPERATOR_ROLE_SQL = sql.raw(`(${CONSOLE_OPERATOR_ROLES.map((r) => `'${r}'`).join(", ")})`);

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

const isOperatorRole = (role: string | null | undefined) => !!role && (CONSOLE_OPERATOR_ROLES as readonly string[]).includes(role);
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
