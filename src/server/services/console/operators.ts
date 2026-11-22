/**
 * OPS1: platform operators (users.role holds an operator role). Owners ("admin") manage them from the console.
 * Operators listed in PLATFORM_ADMIN_EMAILS (ids, or verified emails) are env managed: their sign in makes them owners
 * again, so the console refuses to change them (409 env_managed). The last owner can't be removed or demoted
 * (409 last_owner).
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { users } from "../../db/schema";
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

/** OPS1 security review M2: tells every owner that an operator turned two-step sign in on or off. Never throws. */
export async function notifyOwnersOfTwoFactorChange(deps: Deps, user: { id: string; email: string; role?: string | null }, change: "on" | "off") {
  const owners = await deps.db.select({ email: users.email }).from(users).where(eq(users.role, "admin"));
  if (!owners.length) return;
  const { sendSystemEmail } = await import("../system-mail");
  const when = deps.now().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const what = change === "on" ? "turned on two-step sign in (a new authenticator app)" : "turned off two-step sign in";
  const subject = change === "on" ? `An operator turned on two-step sign in: ${user.email}` : `An operator turned off two-step sign in: ${user.email}`;
  const text = `${user.email} (operator role: ${operatorRoleLabel(user.role ?? null)}) ${what} on ${when}.\n\n`
    + (change === "on"
      ? "If they did not do this themselves, someone else may have their password. Check with them, and remove their operator access on the Operators page until it is sorted out."
      : "The operator console stays closed to them until they turn it on again and sign in with the code. Check with them that this was them.");
  for (const o of owners) {
    await sendSystemEmail(deps, { to: o.email, subject, text, template: "notice", action: { label: "Open the Operators page", url: `${deps.config.appUrl}/console/operators` } })
      .catch((err) => deps.reportError?.(err, { where: "operator.two_factor_mail" }));
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
