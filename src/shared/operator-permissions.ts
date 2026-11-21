/**
 * OPS1: platform operator roles and what each may do in the operator console (/console and /api/console).
 * Shared by the server guards (src/server/auth/operator.ts) and the web console (sidebar, buttons).
 *
 * Roles live in users.role. "admin" is the owner tier (the value Better Auth's admin plugin and PLATFORM_ADMIN_EMAILS
 * already use); the ops_* tiers are new. Any other value (null, "user") is not an operator.
 *
 * Rules of thumb for later areas: every list or detail is "<area>.read"; every change is a separate permission so the
 * matrix below stays the one place that decides who can do it.
 */

export const OPERATOR_ROLES = ["admin", "ops_admin", "ops_billing", "ops_support", "ops_readonly"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** Plain labels for the console (the owner tier is stored as "admin"). */
export const OPERATOR_ROLE_LABELS: Record<OperatorRole, string> = {
  admin: "Owner",
  ops_admin: "Operations admin",
  ops_billing: "Billing",
  ops_support: "Support",
  ops_readonly: "Read only",
};

/** One line on what each role is for, shown when granting a role. */
export const OPERATOR_ROLE_HINTS: Record<OperatorRole, string> = {
  admin: "Everything, including operators, global flags, deleting accounts and exporting the audit log.",
  ops_admin: "Runs the platform: workspaces, users, billing, agents, developer tools, jobs, app config, workspace flags, and sees who the operators are.",
  ops_billing: "Reads everything but the operator list and changes plans, comps, credits and trials. Can add notes and help with sign in.",
  ops_support: "Reads everything but the operator list, helps customers sign in, suspends and moderates, and can view a workspace as a member.",
  ops_readonly: "Reads everything except the operator list. Changes nothing.",
};

/** The read permissions every operator role has (operators.read is the one read kept for ops_admin and owners). */
export const READ_PERMISSIONS = [
  "console.view",
  "overview.read",
  "workspaces.read",
  "users.read",
  "impersonation.read",
  "billing.read",
  "mail.read",
  "agents.read",
  "developer.read",
  "jobs.read",
  "moderation.read",
  "flags.read",
  "system.read",
  "metrics.read",
  "mobile.read",
  "announcements.read",
  "audit.read",
] as const;

/** Support tier changes (support, billing, ops_admin and owner unless noted in the matrix). */
const SUPPORT_HELP = [
  "workspaces.notes", // notes on a workspace or person
  "users.sessions", // revoke sessions
  "users.unlock", // clear a sign in lockout
  "users.verify", // mark an address confirmed
] as const;

const SUPPORT_ENFORCE = [
  "workspaces.suspend", // suspend and restore
  "workspaces.limits", // send cap, sending switch, call minutes cap, queued sends
  "users.ban", // ban and unban
  "moderation.act", // reports and abuse signals
  "mail.manage", // suppressions, force send, domain re-check
  "impersonation.view", // view a workspace as a member (read only)
] as const;

const BILLING = ["billing.manage"] as const;

const OPS_ADMIN = [
  // Who holds which operator role (and their two-step state) is for the people who run the platform, not every tier.
  "operators.read",
  "impersonation.act",
  "agents.manage",
  "developer.manage",
  "jobs.manage",
  "mobile.manage",
  "announcements.manage",
  "system.manage",
  "flags.workspace",
] as const;

const OWNER = [
  "flags.global",
  "users.delete",
  "operators.manage",
  "audit.export",
] as const;

export type Permission =
  | (typeof READ_PERMISSIONS)[number]
  | (typeof SUPPORT_HELP)[number]
  | (typeof SUPPORT_ENFORCE)[number]
  | (typeof BILLING)[number]
  | (typeof OPS_ADMIN)[number]
  | (typeof OWNER)[number];

/** Every permission, for the tests' role by permission matrix. */
export const ALL_PERMISSIONS: readonly Permission[] = [...READ_PERMISSIONS, ...SUPPORT_HELP, ...SUPPORT_ENFORCE, ...BILLING, ...OPS_ADMIN, ...OWNER];

export const ROLE_PERMISSIONS: Record<OperatorRole, ReadonlySet<Permission>> = {
  ops_readonly: new Set<Permission>([...READ_PERMISSIONS]),
  ops_support: new Set<Permission>([...READ_PERMISSIONS, ...SUPPORT_HELP, ...SUPPORT_ENFORCE]),
  ops_billing: new Set<Permission>([...READ_PERMISSIONS, ...SUPPORT_HELP, ...BILLING]),
  ops_admin: new Set<Permission>([...READ_PERMISSIONS, ...SUPPORT_HELP, ...SUPPORT_ENFORCE, ...BILLING, ...OPS_ADMIN]),
  admin: new Set<Permission>(ALL_PERMISSIONS),
};

export function isOperatorRole(role: string | null | undefined): role is OperatorRole {
  return !!role && (OPERATOR_ROLES as readonly string[]).includes(role);
}

/** True when this platform role may do this. Not an operator: always false. */
export function can(role: string | null | undefined, permission: Permission): boolean {
  return isOperatorRole(role) && ROLE_PERMISSIONS[role].has(permission);
}

/** The permissions of a role, as a sorted list (empty for a non operator). */
export function permissionsOf(role: string | null | undefined): Permission[] {
  return isOperatorRole(role) ? [...ROLE_PERMISSIONS[role]].sort() : [];
}

export function operatorRoleLabel(role: string | null | undefined): string {
  return isOperatorRole(role) ? OPERATOR_ROLE_LABELS[role] : "Not an operator";
}
