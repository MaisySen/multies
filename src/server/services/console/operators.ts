/**
 * OPS1: platform operators (users.role holds an operator role). Owners ("admin") manage them from the console.
 * Operators listed in PLATFORM_ADMIN_EMAILS (ids, or verified emails) are env managed: their sign in makes them owners
 * again, so the console refuses to change them (409 env_managed). The last owner can't be removed or demoted
 * (409 last_owner).
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { appSettings, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { OPERATOR_ROLES, isOperatorRole, operatorRoleLabel, type OperatorRole } from "@/shared/operator-permissions";
import { listParams } from "./listing";

export function isEnvManagedOperator(deps: Pick<Deps, "config">, u: { id: string; email: string; emailVerified: boolean }): boolean {
  const listed = deps.config.platformAdmins;
  return listed.includes(u.id.toLowerCase()) || (u.emailVerified && listed.includes(u.email.toLowerCase()));
}

export interface OperatorRow {
  id: string; email: string; name: string; role: OperatorRole; roleLabel: string;
  twoFactor: boolean; lastLoginMethod: string | null; lastSignInAt: string | null; envManaged: boolean; createdAt: string;
}

export async function listOperators(deps: Deps, query: Record<string, string | undefined>): Promise<{ items: OperatorRow[]; nextCursor: string | null }> {
  const p = listParams(query, {
    id: users.id,
    sort: { createdAt: users.createdAt, email: users.email },
    defaultSort: "email:asc",
    search: [users.email, users.name],
  });
  const rows = await deps.db.select({
    id: users.id, email: users.email, name: users.name, role: users.role, twoFactor: users.twoFactorEnabled, emailVerified: users.emailVerified,
    lastLoginMethod: users.lastLoginMethod, createdAt: users.createdAt,
    lastSignInAt: sql<number | null>`(select max(s."created_at") from "sessions" s where s."user_id" = "users"."id")`,
  }).from(users).where(and(inArray(users.role, [...OPERATOR_ROLES]), p.where)).orderBy(...p.orderBy).limit(p.take);
  const page = p.page(rows, (r) => ({ sort: p.sortField === "email" ? r.email : r.createdAt, id: r.id }));
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      id: r.id, email: r.email, name: r.name, role: r.role as OperatorRole, roleLabel: operatorRoleLabel(r.role),
      twoFactor: !!r.twoFactor, lastLoginMethod: r.lastLoginMethod ?? null,
      lastSignInAt: r.lastSignInAt ? new Date(Number(r.lastSignInAt)).toISOString() : null,
      envManaged: isEnvManagedOperator(deps, { id: r.id, email: r.email, emailVerified: !!r.emailVerified }), createdAt: r.createdAt.toISOString(),
    })),
  };
}

async function ownerCount(deps: Deps): Promise<number> {
  return (await deps.db.select({ n: count() }).from(users).where(eq(users.role, "admin")).get())?.n ?? 0;
}

type Target = { id: string; email: string; name: string; role: string | null; emailVerified: boolean; banned: boolean | null; twoFactor: boolean | null };

async function target(deps: Deps, where: ReturnType<typeof eq>): Promise<Target | undefined> {
  return deps.db.select({ id: users.id, email: users.email, name: users.name, role: users.role, emailVerified: users.emailVerified, banned: users.banned, twoFactor: users.twoFactorEnabled }).from(users).where(where).get();
}

function refuseEnvManaged(deps: Deps, t: Target) {
  if (isEnvManagedOperator(deps, t)) {
    throw new HttpError(409, "env_managed", "This operator is set in PLATFORM_ADMIN_EMAILS on the server. Change it there, not here.");
  }
}

async function refuseLastOwner(deps: Deps, t: Target, nextRole: string) {
  if (t.role === "admin" && nextRole !== "admin" && (await ownerCount(deps)) <= 1) {
    throw new HttpError(409, "last_owner", "This is the only owner. Make someone else an owner first.");
  }
}

/**
 * OPS1 security review M2: the owner must ask a person to turn on two-step sign in before giving them any operator
 * role, so nobody holding only their password can enrol an authenticator after the grant unnoticed.
 */
function refuseWithoutTwoFactor(t: Target) {
  if (!t.twoFactor) {
    throw new HttpError(409, "two_factor_off", `${t.email} doesn't have two-step sign in turned on. Ask them to turn it on in Account and security first, then try again.`);
  }
}

export type OperatorFactorChange = "on" | "off" | "passkey";

/** One alert per operator per kind of change per hour reaches the owners (the audit log keeps every change). */
export const OWNER_ALERT_WINDOW_MS = 60 * 60_000;

/**
 * Claims the owner alert for one operator and one kind of change, across every isolate: an app_settings row holds when
 * the last alert went out, and only a claim older than the window replaces it. True when claimed.
 */
const ownerAlertKey = (userId: string, change: OperatorFactorChange) => `operator_alert:${userId}:${change}`;

async function claimOwnerAlert(deps: Pick<Deps, "db" | "now">, userId: string, change: OperatorFactorChange): Promise<boolean> {
  const key = ownerAlertKey(userId, change);
  const now = deps.now();
  const value = now.toISOString();
  const cutoff = new Date(now.getTime() - OWNER_ALERT_WINDOW_MS).toISOString();
  const won = await deps.db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value }, setWhere: sql`${appSettings.value} < ${cutoff}` })
    .returning({ key: appSettings.key });
  return won.length > 0;
}

const FACTOR_CHANGE_TEXT: Record<OperatorFactorChange, { what: string; subject: string; advice: string }> = {
  on: {
    what: "turned on two-step sign in (a new authenticator app)",
    subject: "An operator turned on two-step sign in",
    advice: "If they did not do this themselves, someone else may have their password. Check with them, and remove their operator access on the Operators page until it is sorted out.",
  },
  off: {
    what: "turned off two-step sign in",
    subject: "An operator turned off two-step sign in",
    advice: "The operator console stays closed to them until they turn it on again and sign in with the code. Check with them that this was them.",
  },
  passkey: {
    what: "added a passkey to their account",
    subject: "An operator added a passkey",
    advice: "Signing in with that passkey opens the operator console. If they did not add it themselves, remove their operator access on the Operators page until it is sorted out.",
  },
};

/**
 * OPS1 security review M2: tells every owner that an operator turned two-step sign in on or off, or added a passkey.
 * At most one email per operator per kind of change per hour (claimOwnerAlert), except that turning it on again after
 * turning it off always emails. Never throws.
 */
export async function notifyOwnersOfTwoFactorChange(deps: Deps, user: { id: string; email: string; role?: string | null }, change: OperatorFactorChange) {
  // Turning two-step on again after turning it off always emails: whoever turned it off may now be setting up an
  // authenticator of their own, and an earlier "on" alert in the same hour must not hide that.
  if (change === "off") await deps.db.delete(appSettings).where(eq(appSettings.key, ownerAlertKey(user.id, "on")));
  const owners = await deps.db.select({ email: users.email }).from(users).where(eq(users.role, "admin"));
  if (!owners.length) return;
  if (!(await claimOwnerAlert(deps, user.id, change))) return;
  const { sendSystemEmail } = await import("../system-mail");
  const when = deps.now().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const t = FACTOR_CHANGE_TEXT[change];
  const subject = `${t.subject}: ${user.email}`;
  const text = `${user.email} (operator role: ${operatorRoleLabel(user.role ?? null)}) ${t.what} on ${when}.\n\n${t.advice}`;
  for (const o of owners) {
    await sendSystemEmail(deps, { to: o.email, subject, text, template: "notice", action: { label: "Open the Operators page", url: `${deps.config.appUrl}/console/operators` } })
      .catch((err) => deps.reportError?.(err, { where: "operator.two_factor_mail" }));
  }
}

/**
 * OPS1 security (M2): an operator turned two-step sign in on or off, or added a passkey. One platform audit row each
 * time (operator.two_factor_enrolled, operator.two_factor_disabled, operator.passkey_added), and an email to every
 * owner (role admin), so a password thief who enrols their own authenticator or passkey is noticed. Never throws.
 */
export async function operatorFactorChanged(deps: Deps, user: { id: string; email: string; role?: string | null }, change: OperatorFactorChange) {
  try {
    const { platformAudit } = await import("./audit");
    const action = { on: "operator.two_factor_enrolled", off: "operator.two_factor_disabled", passkey: "operator.passkey_added" }[change];
    await platformAudit(deps.db, { actorUserId: user.id, actorEmail: user.email, actorRole: user.role ?? null, targetType: "user", targetId: user.id, action });
    await notifyOwnersOfTwoFactorChange(deps, user, change);
  } catch (err) {
    deps.reportError?.(err, { where: "operator.two_factor_changed" });
  }
}

/** Grants an operator role to an existing, confirmed account found by email. */
export async function grantOperator(deps: Deps, email: string, role: OperatorRole) {
  const t = await target(deps, eq(users.email, email.trim().toLowerCase()));
  if (!t) throw new HttpError(404, "not_found", "No account uses that email. Ask them to sign up first.");
  if (isOperatorRole(t.role)) throw new HttpError(409, "already_operator", `${t.email} is already an operator. Change their role instead.`);
  if (!t.emailVerified) throw new HttpError(422, "email_not_verified", "That account hasn't confirmed its email yet.");
  if (t.banned) throw new HttpError(422, "banned", "That account is banned.");
  refuseWithoutTwoFactor(t); // OPS1 security (M2)
  await deps.db.update(users).set({ role }).where(eq(users.id, t.id));
  return { before: { role: t.role ?? null }, after: { role }, user: { id: t.id, email: t.email } };
}

/** Changes an operator's role. */
export async function changeOperatorRole(deps: Deps, id: string, role: OperatorRole) {
  const t = await target(deps, eq(users.id, id));
  if (!t || !isOperatorRole(t.role)) throw notFound("Operator");
  refuseEnvManaged(deps, t);
  await refuseLastOwner(deps, t, role);
  refuseWithoutTwoFactor(t); // OPS1 security (M2)
  await deps.db.update(users).set({ role }).where(eq(users.id, t.id));
  await (await import("./impersonation")).endImpersonationsNotAllowed(deps, t.id, role); // OPS1 security (L2)
  return { before: { role: t.role }, after: { role }, user: { id: t.id, email: t.email } };
}

/** Removes operator access (the account becomes an ordinary user). */
export async function removeOperator(deps: Deps, id: string) {
  const t = await target(deps, eq(users.id, id));
  if (!t || !isOperatorRole(t.role)) throw notFound("Operator");
  refuseEnvManaged(deps, t);
  await refuseLastOwner(deps, t, "user");
  await deps.db.update(users).set({ role: "user" }).where(eq(users.id, t.id));
  await (await import("./impersonation")).endImpersonationsNotAllowed(deps, t.id, "user"); // OPS1 security (L2)
  return { before: { role: t.role }, after: { role: "user" }, user: { id: t.id, email: t.email } };
}
