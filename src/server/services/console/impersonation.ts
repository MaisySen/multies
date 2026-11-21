/**
 * OPS1 impersonation: the rules and records behind "View as" in the operator console.
 *
 * An operator with impersonation.view (or impersonation.act) opens a 30 minute Better Auth session as a person
 * (routes/console/impersonation.ts). Each one has a row in operator_impersonations, keyed by the session id; that row,
 * not Better Auth's own expiry, decides whether the session may still be used (auth/guards.ts resolveAuth). The rest of
 * this file is what an impersonated session may not do (requireAuth and the Better Auth hook in auth/options.ts read it).
 *
 * Modes:
 * - view: reads only. Every write (anything but GET, HEAD and OPTIONS) is refused, except the Stop route.
 * - act: normal writes work and are stamped with the operator (metadata.impersonatedBy on audit entries).
 * Both modes: everything in IMPERSONATION_ALWAYS_BLOCKED is refused, reads included where the rule says "*".
 */
import { and, desc, eq, gt, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DB } from "../../db";
import { members, operatorImpersonations, organizations, sessions, users } from "../../db/schema";
import { listParams } from "./listing";
import { can } from "@/shared/operator-permissions";

export const IMPERSONATION_SECONDS = 30 * 60;
export type ImpersonationMode = "view" | "act";
/** Why an impersonation ended (operator_impersonations.ended_reason). */
export type ImpersonationEndReason = "stopped" | "expired" | "operator_session_gone" | "revoked" | "invalid";

/** The one console route an impersonated session may reach (auth/operator.ts lets it through). */
export const IMPERSONATION_STOP_PATH = "/api/console/impersonation/stop";

export const VIEW_ONLY_MESSAGE = "You are viewing as this person. Changes are turned off.";
export const ALWAYS_BLOCKED_MESSAGE = "This is turned off while you view or act as someone else.";

/** What an impersonated AuthContext carries (one indexed read in resolveAuth, kept in the 15 s read cache). */
export interface ActiveImpersonation {
  id: string;
  mode: ImpersonationMode;
  expiresAt: Date;
  operatorUserId: string;
  operatorEmail: string | null;
}

export interface BlockedRule {
  /** Plain name of the group, for the test and for reviewers. */
  group: string;
  /** Methods refused; "*" is every method, GET included. */
  methods: "*" | readonly string[];
  pattern: RegExp;
  /** A real request this rule refuses (the test walks these). */
  example: { method: string; path: string };
  /**
   * Where it is enforced: requireAuth (guards.ts), the Better Auth hook (options.ts, every /api/auth/* call over HTTP),
   * or operatorSession (auth/operator.ts, 403 impersonating). app.ts answers 404 for a few /api/auth paths first.
   */
  enforcedBy: "requireAuth" | "betterAuth" | "operatorSession";
}

const ALL = "*" as const;

/**
 * Refused to an impersonated session in BOTH modes. Paths are the real mounts in src/server/app.ts and its routers.
 * A path not listed here is a normal feature route: readable in both modes, writable in act mode only.
 */
export const IMPERSONATION_ALWAYS_BLOCKED: readonly BlockedRule[] = [
  // The operator console and the older operator routes: an impersonated session is never an operator. Stop is the one
  // exception (IMPERSONATION_STOP_PATH).
  { group: "operator console", methods: ALL, pattern: /^\/api\/console(\/|$)/, example: { method: "GET", path: "/api/console/me" }, enforcedBy: "operatorSession" },
  { group: "operator console", methods: ALL, pattern: /^\/api\/admin(\/|$)/, example: { method: "GET", path: "/api/admin/users" }, enforcedBy: "operatorSession" },
  // The team password vault: no reads either.
  { group: "vault", methods: ALL, pattern: /^\/api\/vault(\/|$)/, example: { method: "GET", path: "/api/vault/state" }, enforcedBy: "requireAuth" },
  // Better Auth over HTTP: password, email, two-step, passkeys, sessions, sign out (Stop replaces it), linking, deleting
  // the user, the mobile web link. Only GET /api/auth/get-session is allowed (reading the session the app runs on).
  { group: "sign in and security", methods: ALL, pattern: /^\/api\/auth(\/|$)/, example: { method: "POST", path: "/api/auth/change-password" }, enforcedBy: "betterAuth" },
  { group: "sign in and security", methods: ALL, pattern: /^\/api\/auth\/mobile\/web-link$/, example: { method: "POST", path: "/api/auth/mobile/web-link" }, enforcedBy: "requireAuth" },
  // Passkeys (DES1): list, add, rename, remove.
  { group: "sign in and security", methods: ALL, pattern: /^\/api\/passkeys(\/|$)/, example: { method: "GET", path: "/api/passkeys" }, enforcedBy: "requireAuth" },
  // The person's own sessions list can revoke a session.
  { group: "sign in and security", methods: ["POST"], pattern: /^\/api\/account\/sessions\/[^/]+\/revoke$/, example: { method: "POST", path: "/api/account/sessions/ses_x/revoke" }, enforcedBy: "requireAuth" },
  // Deleting the account or a workspace.
  { group: "account deletion", methods: ["DELETE"], pattern: /^\/api\/account\/?$/, example: { method: "DELETE", path: "/api/account" }, enforcedBy: "requireAuth" },
  { group: "account deletion", methods: ["DELETE"], pattern: /^\/api\/account\/workspace$/, example: { method: "DELETE", path: "/api/account/workspace" }, enforcedBy: "requireAuth" },
  // Bulk data export: the person's data, the workspace ZIP, data moves, data requests, archive cases, the audit CSV.
  { group: "data export", methods: ["GET"], pattern: /^\/api\/account\/export$/, example: { method: "GET", path: "/api/account/export" }, enforcedBy: "requireAuth" },
  { group: "data export", methods: ["GET"], pattern: /^\/api\/account\/workspace\/export$/, example: { method: "GET", path: "/api/account/workspace/export" }, enforcedBy: "requireAuth" },
  { group: "data export", methods: ALL, pattern: /^\/api\/data-moves\/exports(\/|$)/, example: { method: "POST", path: "/api/data-moves/exports" }, enforcedBy: "requireAuth" },
  { group: "data export", methods: ALL, pattern: /^\/api\/data-requests(\/|$)/, example: { method: "GET", path: "/api/data-requests" }, enforcedBy: "requireAuth" },
  { group: "data export", methods: ["GET"], pattern: /^\/api\/mail-archive\/cases\/[^/]+\/export$/, example: { method: "GET", path: "/api/mail-archive/cases/x/export" }, enforcedBy: "requireAuth" },
  { group: "data export", methods: ["GET"], pattern: /^\/api\/org\/audit\/export$/, example: { method: "GET", path: "/api/org/audit/export" }, enforcedBy: "requireAuth" },
  // Billing: checkout, the Stripe portal, plan changes and add on purchases.
  { group: "billing", methods: ["POST"], pattern: /^\/api\/billing\/(checkout|checkout\/confirm|portal|change|addons)$/, example: { method: "POST", path: "/api/billing/portal" }, enforcedBy: "requireAuth" },
  // New credentials and secrets: API keys, agent keys, inbound keys, signing secrets, incoming hook URLs.
  { group: "keys and secrets", methods: ["POST", "PATCH"], pattern: /^\/api\/developer\/keys(\/[^/]+)?$/, example: { method: "POST", path: "/api/developer/keys" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["GET"], pattern: /^\/api\/developer\/webhooks\/[^/]+\/secret$/, example: { method: "GET", path: "/api/developer/webhooks/x/secret" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/agents\/[^/]+\/keys$/, example: { method: "POST", path: "/api/agents/x/keys" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/team\/agents\/[^/]+\/keys$/, example: { method: "POST", path: "/api/team/agents/x/keys" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/inbound-keys\/?$/, example: { method: "POST", path: "/api/inbound-keys" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/agent-triggers\/[^/]+\/rotate-secret$/, example: { method: "POST", path: "/api/agent-triggers/x/rotate-secret" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/forms-plus\/forms\/[^/]+\/webhook\/secret$/, example: { method: "POST", path: "/api/forms-plus/forms/x/webhook/secret" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/auth-email-settings\/secret$/, example: { method: "POST", path: "/api/auth-email-settings/secret" }, enforcedBy: "requireAuth" },
  { group: "keys and secrets", methods: ["POST"], pattern: /^\/api\/incoming-hooks\/?$/, example: { method: "POST", path: "/api/incoming-hooks" }, enforcedBy: "requireAuth" },
  // Connected AI apps (OAuth for MCP): approving a new app (the consent page reads too), and removing one. Clients
  // register themselves without a session (POST /api/oauth/register), so there is no client secret a session creates.
  { group: "connected apps", methods: ALL, pattern: /^\/api\/oauth\/authorize$/, example: { method: "GET", path: "/api/oauth/authorize" }, enforcedBy: "requireAuth" },
  { group: "connected apps", methods: ["DELETE"], pattern: /^\/api\/oauth\/grants\/[^/]+$/, example: { method: "DELETE", path: "/api/oauth/grants/x" }, enforcedBy: "requireAuth" },
  // App passwords for a mailbox (IMAP and SMTP) and for calendar and contacts sync, and the profile that carries one.
  { group: "app passwords", methods: ALL, pattern: /^\/api\/mail-access\/(mailboxes\/[^/]+\/)?app-passwords(\/|$)/, example: { method: "POST", path: "/api/mail-access/mailboxes/x/app-passwords" }, enforcedBy: "requireAuth" },
  { group: "app passwords", methods: ALL, pattern: /^\/api\/dav\/(passwords|profile\.mobileconfig)(\/|$)/, example: { method: "GET", path: "/api/dav/passwords" }, enforcedBy: "requireAuth" },
  // Long lived ways in that would outlive the session: public share links, secret links, file request links, dashboard
  // links, client portal magic links, a fresh calendar feed address, outbound webhooks, and push to a new device or browser.
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/share-links\/?$/, example: { method: "POST", path: "/api/share-links" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/tools\/share(\/from)?\/?$/, example: { method: "POST", path: "/api/tools/share/from" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/tools\/(secrets|requests)\/?$/, example: { method: "POST", path: "/api/tools/secrets" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/dashboards-plus\/[^/]+\/shares$/, example: { method: "POST", path: "/api/dashboards-plus/x/shares" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/portals\/[^/]+\/people\/[^/]+\/(link|invite)$/, example: { method: "POST", path: "/api/portals/x/people/y/link" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST", "PATCH"], pattern: /^\/api\/calendar\/feed$/, example: { method: "POST", path: "/api/calendar/feed" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST", "PATCH"], pattern: /^\/api\/developer\/webhooks(\/[^/]+)?$/, example: { method: "POST", path: "/api/developer/webhooks" }, enforcedBy: "requireAuth" },
  { group: "outlives the session", methods: ["POST"], pattern: /^\/api\/push\/(web|devices)\/?$/, example: { method: "POST", path: "/api/push/devices" }, enforcedBy: "requireAuth" },
  // Who controls the workspace: ownership transfer, member roles, removing or disabling members (people and AI agent
  // members), invites (the invite body carries the role and requireAuth does not read bodies, so every invite action is
  // refused, member invites included), joining a workspace from an invite, and the workspace's SSO rule and plan.
  { group: "workspace control", methods: ["POST"], pattern: /^\/api\/team\/transfer$/, example: { method: "POST", path: "/api/team/transfer" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["PATCH", "DELETE"], pattern: /^\/api\/team\/members\/[^/]+$/, example: { method: "PATCH", path: "/api/team/members/x" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["POST", "PATCH", "DELETE"], pattern: /^\/api\/team\/agents(\/[^/]+)?$/, example: { method: "POST", path: "/api/team/agents" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["POST", "DELETE"], pattern: /^\/api\/team\/invites(\/|$)/, example: { method: "POST", path: "/api/team/invites" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["POST"], pattern: /^\/api\/invites\/[^/]+\/accept$/, example: { method: "POST", path: "/api/invites/x/accept" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["PUT"], pattern: /^\/api\/org\/sso$/, example: { method: "PUT", path: "/api/org/sso" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["POST"], pattern: /^\/api\/org\/plan$/, example: { method: "POST", path: "/api/org/plan" }, enforcedBy: "requireAuth" },
  { group: "workspace control", methods: ["PUT"], pattern: /^\/api\/share-links\/settings$/, example: { method: "PUT", path: "/api/share-links/settings" }, enforcedBy: "requireAuth" },
  // Attaching outside accounts in the person's name: mail (Google, Microsoft, IMAP) and TikTok and Threads (all under /api/connections), the Connections
  // hub, WhatsApp channels, AI providers, Xero, and outside calendars. Start, callback and credential changes.
  { group: "outside accounts", methods: ALL, pattern: /^\/api\/connections\/oauth(\/|$)/, example: { method: "GET", path: "/api/connections/oauth/google/start" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ["POST"], pattern: /^\/api\/connections\/?$/, example: { method: "POST", path: "/api/connections" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ["PUT"], pattern: /^\/api\/connections\/[^/]+$/, example: { method: "PUT", path: "/api/connections/x" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ["POST"], pattern: /^\/api\/apps\/(connect|accounts\/[^/]+\/(confirm|reconnect))$/, example: { method: "POST", path: "/api/apps/connect" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ["POST"], pattern: /^\/api\/channels\/connect(-mock)?$/, example: { method: "POST", path: "/api/channels/connect" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ALL, pattern: /^\/api\/ai\/(connect|oauth)(\/|$)/, example: { method: "POST", path: "/api/ai/connect" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ALL, pattern: /^\/api\/integrations\/xero\/(connect|callback)$/, example: { method: "GET", path: "/api/integrations/xero/connect" }, enforcedBy: "requireAuth" },
  { group: "outside accounts", methods: ["POST"], pattern: /^\/api\/calendar\/sources\/?$/, example: { method: "POST", path: "/api/calendar/sources" }, enforcedBy: "requireAuth" },
];

/**
 * POSTs a view mode session may still make. Deliberately empty: the candidates looked at (thread presence heartbeats,
 * typing signals, search and preview POSTs) either tell teammates the person is there, call outside services or write
 * rows, so when in doubt they are blocked. Stop (IMPERSONATION_STOP_PATH) is not here because it never meets requireAuth.
 */
export const VIEW_MODE_ALLOWED_WRITES: readonly RegExp[] = [];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether this request is refused to an impersonated session: "always" (both modes), "view" (a write in view mode) or null. */
export function impersonationBlock(mode: ImpersonationMode, method: string, path: string): "always" | "view" | null {
  const m = method.toUpperCase();
  if (m === "POST" && path === IMPERSONATION_STOP_PATH) return null;
  // GET /api/auth/get-session is how the app reads the session it runs on.
  if (m === "GET" && path === "/api/auth/get-session") return null;
  for (const r of IMPERSONATION_ALWAYS_BLOCKED) {
    if (r.pattern.test(path) && (r.methods === ALL || r.methods.includes(m))) return "always";
  }
  if (mode === "view" && !READ_METHODS.has(m) && !VIEW_MODE_ALLOWED_WRITES.some((p) => p.test(path))) return "view";
  return null;
}

/** The impersonation row for a session (one indexed read). */
export async function impersonationBySession(db: DB, sessionId: string) {
  return db.select().from(operatorImpersonations).where(eq(operatorImpersonations.sessionId, sessionId)).get();
}

/** The row plus the operator's current role and ban (same read, joined by primary key). */
async function impersonationWithOperator(db: DB, sessionId: string) {
  const r = await db.select({ row: operatorImpersonations, operatorRole: users.role, operatorBanned: users.banned })
    .from(operatorImpersonations).leftJoin(users, eq(users.id, operatorImpersonations.operatorUserId))
    .where(eq(operatorImpersonations.sessionId, sessionId)).get();
  return r ? { ...r.row, operatorRole: r.operatorRole ?? null, operatorBanned: !!r.operatorBanned } : undefined;
}

type Row = typeof operatorImpersonations.$inferSelect;

/** True when the row still allows its session: not ended, not past our own expiry, and matching the session. */
export function impersonationUsable(row: Row | undefined, s: { userId: string; impersonatedBy: string }, now: Date): boolean {
  return !!row && !row.endedAt && row.expiresAt.getTime() > now.getTime() && row.operatorUserId === s.impersonatedBy && row.targetUserId === s.userId;
}

/** Marks a row ended (only the first end counts). */
export async function endImpersonationRow(db: DB, id: string, reason: ImpersonationEndReason, now: Date): Promise<boolean> {
  const r = await db.update(operatorImpersonations).set({ endedAt: now, endedReason: reason })
    .where(and(eq(operatorImpersonations.id, id), isNull(operatorImpersonations.endedAt))).returning({ id: operatorImpersonations.id });
  return r.length > 0;
}

/**
 * Checks an impersonated Better Auth session against its row. A session with no row, an ended row or a row past its
 * expiry is deleted (defence in depth: Better Auth stretches a 30 minute session to 30 days when the dont_remember
 * cookie is missing) and null is returned.
 */
export async function activeImpersonationFor(db: DB, s: { id: string; userId: string; impersonatedBy: string }, now: Date): Promise<ActiveImpersonation | null> {
  const row = await impersonationWithOperator(db, s.id);
  // The operator must still hold the permission for the mode (a demoted, removed or banned operator's session ends).
  const operatorMayStill = !!row && !row.operatorBanned && can(row.operatorRole, row.mode === "act" ? "impersonation.act" : "impersonation.view");
  if (row && operatorMayStill && impersonationUsable(row, s, now)) {
    return { id: row.id, mode: row.mode, expiresAt: row.expiresAt, operatorUserId: row.operatorUserId, operatorEmail: row.operatorEmail };
  }
  await db.delete(sessions).where(eq(sessions.id, s.id));
  if (row && !row.endedAt) await endImpersonationRow(db, row.id, row.expiresAt.getTime() <= now.getTime() ? "expired" : "invalid", now);
  return null;
}

export interface ImpersonationListItem {
  id: string;
  operatorUserId: string;
  operatorEmail: string | null;
  targetUserId: string;
  targetEmail: string | null;
  targetName: string | null;
  orgId: string | null;
  orgName: string | null;
  mode: ImpersonationMode;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
  /** Not ended and not past its expiry. */
  active: boolean;
}

export interface ImpersonationFilter {
  status?: "active" | "ended";
  operator?: string;
  target?: string;
  orgId?: string;
}

/** One page of impersonations, newest first. q searches the operator and target addresses and the reason. */
export async function listImpersonations(db: DB, query: Record<string, string | undefined>, f: ImpersonationFilter, now: Date): Promise<{ items: ImpersonationListItem[]; nextCursor: string | null }> {
  const target = alias(users, "target");
  const p = listParams(query, {
    id: operatorImpersonations.id,
    sort: { startedAt: operatorImpersonations.startedAt, expiresAt: operatorImpersonations.expiresAt },
    defaultSort: "startedAt:desc",
    search: [operatorImpersonations.operatorEmail, target.email, operatorImpersonations.reason],
  });
  const conds: (SQL | undefined)[] = [p.where];
  if (f.status === "active") conds.push(and(isNull(operatorImpersonations.endedAt), gt(operatorImpersonations.expiresAt, now)));
  if (f.status === "ended") conds.push(or(isNotNull(operatorImpersonations.endedAt), lte(operatorImpersonations.expiresAt, now)));
  if (f.operator) conds.push(eq(operatorImpersonations.operatorUserId, f.operator));
  if (f.target) conds.push(eq(operatorImpersonations.targetUserId, f.target));
  if (f.orgId) conds.push(eq(operatorImpersonations.targetOrgId, f.orgId));
  const rows = await db.select({
    row: operatorImpersonations, targetEmail: target.email, targetName: target.name, orgName: organizations.name,
  }).from(operatorImpersonations)
    .leftJoin(target, eq(target.id, operatorImpersonations.targetUserId))
    .leftJoin(organizations, eq(organizations.id, operatorImpersonations.targetOrgId))
    .where(and(...conds)).orderBy(...p.orderBy).limit(p.take);
  const page = p.page(rows, (r) => ({ sort: p.sortField === "expiresAt" ? r.row.expiresAt : r.row.startedAt, id: r.row.id }));
  return {
    nextCursor: page.nextCursor,
    items: page.items.map(({ row, targetEmail, targetName, orgName }) => ({
      id: row.id, operatorUserId: row.operatorUserId, operatorEmail: row.operatorEmail, targetUserId: row.targetUserId,
      targetEmail: targetEmail ?? null, targetName: targetName ?? null, orgId: row.targetOrgId, orgName: orgName ?? null,
      mode: row.mode, reason: row.reason, startedAt: row.startedAt, expiresAt: row.expiresAt, endedAt: row.endedAt, endedReason: row.endedReason,
      active: !row.endedAt && row.expiresAt.getTime() > now.getTime(),
    })),
  };
}

/** The target's workspaces (ids), for the start checks. */
export async function membershipsOf(db: DB, userId: string): Promise<string[]> {
  return (await db.select({ orgId: members.organizationId }).from(members).where(eq(members.userId, userId)).orderBy(desc(members.createdAt))).map((m) => m.orgId);
}
