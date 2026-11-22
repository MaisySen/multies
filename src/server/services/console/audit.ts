/**
 * OPS1: the platform audit log (table platform_audit_logs) and the one wrapper every operator change goes through.
 *
 * Usage in a console route (later areas copy this):
 *
 *   .post("/workspaces/:id/suspend", requireOperator("workspaces.suspend"), async (c) => {
 *     const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
 *     const org = await getOrg(c.var.deps.db, c.req.param("id"));
 *     await operatorAction(c, {
 *       action: "workspace.suspended", targetType: "workspace", targetId: org.id, orgId: org.id, reason,
 *       before: { suspendedAt: org.suspendedAt }, workspaceAudit: true,
 *     }, () => doTheChange());
 *     return c.json({ ok: true });
 *   })
 *
 * operatorAction runs the change, then writes one platform audit row (actor, role, IP, user agent, request id) and,
 * with workspaceAudit, the workspace's own audit row too, so the customer's Activity page shows operator actions.
 * Nothing is written when the change throws. Every /api/console change needs a reason (reasonSchema, 3 to 300
 * characters); the older /api/admin routes take an optional one (optionalReasonSchema).
 */
import type { Context } from "hono";
import { and, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../../context";
import type { DB } from "../../db";
import { organizations, platformAuditLogs, users } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { flagDef } from "@/shared/feature-flags";
import { containsAny, startsWithText } from "../../lib/like-search";
import { audit, redactAuditRow } from "../audit";
import { listParams } from "./listing";

/** The reason every console change asks for. */
export const reasonSchema = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(300, "Keep the reason under 300 characters.");
/** The older /api/admin routes keep their request shapes, so the reason is optional there. */
export const optionalReasonSchema = reasonSchema.optional();

export interface PlatformAuditEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  orgId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  impersonationId?: string | null;
  at?: Date;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Appends one platform audit row. */
export async function platformAudit(db: DB, e: PlatformAuditEntry): Promise<string> {
  const id = newId("paud");
  await db.insert(platformAuditLogs).values({
    id,
    actorUserId: e.actorUserId ?? null,
    actorEmail: e.actorEmail ?? null,
    actorRole: e.actorRole ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    orgId: e.orgId ?? null,
    reason: e.reason ?? null,
    before: json(e.before),
    after: json(e.after),
    metadata: json(e.metadata),
    ip: e.ip && e.ip !== "unknown" ? e.ip : null,
    userAgent: e.userAgent ? e.userAgent.slice(0, 300) : null,
    requestId: e.requestId ?? null,
    impersonationId: e.impersonationId ?? null,
    ...(e.at ? { createdAt: e.at } : {}),
  });
  return id;
}

/** Who did it and from where, from the request (after operatorSession). */
export function auditActor(c: Context<AppEnv>): Pick<PlatformAuditEntry, "actorUserId" | "actorEmail" | "actorRole" | "ip" | "userAgent" | "requestId"> {
  const auth = c.var.auth;
  return {
    actorUserId: auth?.userId ?? null,
    actorEmail: auth?.email ?? null,
    actorRole: c.var.operator?.role ?? auth?.platformRole ?? null,
    ip: c.var.ip ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.var.requestId ?? null,
  };
}

export interface OperatorActionSpec<T> {
  action: string;
  targetType?: string;
  /** A function receives the change's result (for a target the change finds or makes). */
  targetId?: string | ((result: T) => string | null | undefined);
  orgId?: string | null;
  reason?: string | null;
  /** The state before. A function receives the change's result, for a service that reads the old state itself. */
  before?: unknown | ((result: T) => unknown);
  /** The state after; a function receives the change's result. */
  after?: unknown | ((result: T) => unknown);
  metadata?: Record<string, unknown>;
  /**
   * Also write the workspace's own audit row (needs orgId). true uses the same action; an object can rename it or add
   * metadata. The row says by: "operator" and carries the reason, so the customer sees why.
   */
  workspaceAudit?: boolean | { action?: string; metadata?: Record<string, unknown> };
}

/** Runs an operator change, then audits it. Returns the change's result. */
export async function operatorAction<T>(c: Context<AppEnv>, spec: OperatorActionSpec<T>, run: () => Promise<T> | T): Promise<T> {
  const result = await run();
  const db = c.var.deps.db;
  const of = <V>(v: V | ((r: T) => V)): V => (typeof v === "function" ? (v as (r: T) => V)(result) : v);
  const targetId = of(spec.targetId) ?? undefined;
  await platformAudit(db, {
    ...auditActor(c),
    action: spec.action, targetType: spec.targetType, targetId, orgId: spec.orgId ?? null,
    reason: spec.reason ?? null, before: of(spec.before), after: of(spec.after), metadata: spec.metadata,
  });
  if (spec.workspaceAudit && spec.orgId) {
    const extra = typeof spec.workspaceAudit === "object" ? spec.workspaceAudit : {};
    const auth = c.var.auth;
    await audit(db, {
      orgId: spec.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: extra.action ?? spec.action,
      targetType: spec.targetType, targetId: targetId ?? undefined,
      metadata: { ...(spec.metadata ?? {}), ...(extra.metadata ?? {}), by: "operator", ...(spec.reason ? { reason: spec.reason } : {}) },
      ip: c.var.ip,
    });
  }
  return result;
}

export interface PlatformAuditFilter {
  /** Actor email contains, or the exact actor user id. */
  actor?: string;
  /** Action prefix, e.g. "workspace." or "operator.role_changed". */
  action?: string;
  targetType?: string;
  targetId?: string;
  orgId?: string;
  from?: Date;
  to?: Date;
}

function filterCond(f: PlatformAuditFilter): SQL | undefined {
  const c: (SQL | undefined)[] = [];
  if (f.actor) c.push(or(eq(platformAuditLogs.actorUserId, f.actor), containsAny([platformAuditLogs.actorEmail], f.actor)));
  if (f.action) c.push(startsWithText(platformAuditLogs.action, f.action));
  if (f.targetType) c.push(eq(platformAuditLogs.targetType, f.targetType));
  if (f.targetId) c.push(eq(platformAuditLogs.targetId, f.targetId));
  if (f.orgId) c.push(eq(platformAuditLogs.orgId, f.orgId));
  if (f.from) c.push(gte(platformAuditLogs.createdAt, f.from));
  if (f.to) c.push(lt(platformAuditLogs.createdAt, f.to));
  return c.length ? and(...c) : undefined;
}

export type PlatformAuditRow = Omit<typeof platformAuditLogs.$inferSelect, "before" | "after" | "metadata"> & { before: unknown; after: unknown; metadata: Record<string, unknown> | null };

const parse = (s: string | null): unknown => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
};

/**
 * One page of the platform audit log, newest first. `query` is the request's query string (q, limit, cursor, sort);
 * q searches the action, actor email, target id and reason.
 */
export async function listPlatformAudit(db: DB, query: Record<string, string | undefined>, filter: PlatformAuditFilter = {}): Promise<{ items: PlatformAuditRow[]; nextCursor: string | null }> {
  const p = listParams(query, {
    id: platformAuditLogs.id,
    sort: { createdAt: platformAuditLogs.createdAt },
    defaultSort: "createdAt:desc",
  });
  // OPS1 security (M1 audit): q never matches a value the list hides. An invite's target id is masked in the answer
  // (redactAuditRow), so it is searched only on rows whose target is not an invite.
  const q = p.q;
  const qCond = q ? or(
    containsAny([platformAuditLogs.action, platformAuditLogs.actorEmail, platformAuditLogs.reason], q),
    and(sql`coalesce(${platformAuditLogs.targetType}, '') not like '%invit%'`, containsAny([platformAuditLogs.targetId], q)),
  ) : undefined;
  const rows = await db.select().from(platformAuditLogs).where(and(filterCond(filter), qCond, p.where)).orderBy(...p.orderBy).limit(p.take);
  const page = p.page(rows, (r) => ({ sort: r.createdAt, id: r.id }));
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => redactAuditRow({ ...r, before: parse(r.before), after: parse(r.after), metadata: parse(r.metadata) as Record<string, unknown> | null })),
  };
}

export type NamedAuditRow = PlatformAuditRow & {
  /** The target's name: a workspace's name, a person's email, a flag's label. Null when unknown or gone. */
  targetLabel: string | null;
  /** The name of the workspace in orgId, when it still exists. */
  orgName: string | null;
};

/**
 * Names for a page of audit rows, for the list: two batched reads at most (workspaces by id, people by id; inIds
 * keeps each one bound variable over 20 ids, so the D1 variable limit is never near) and flag labels from the
 * registry in code. Never one read per row. Takes platform rows or a workspace's own audit rows (anything with a
 * target and an optional orgId).
 */
export async function withAuditNames<T extends { orgId?: string | null; targetType: string | null; targetId: string | null } = PlatformAuditRow>(
  db: DB, rows: T[],
): Promise<(T & { targetLabel: string | null; orgName: string | null })[]> {
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.orgId) orgIds.add(r.orgId);
    if (r.targetId && r.targetType === "workspace") orgIds.add(r.targetId);
    if (r.targetId && r.targetType === "user") userIds.add(r.targetId);
  }
  const [orgRows, userRows] = await Promise.all([
    orgIds.size ? db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inIds(organizations.id, [...orgIds])).all() : [],
    userIds.size ? db.select({ id: users.id, email: users.email }).from(users).where(inIds(users.id, [...userIds])).all() : [],
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const userEmail = new Map(userRows.map((u) => [u.id, u.email]));
  return rows.map((r) => {
    let targetLabel: string | null = null;
    if (r.targetId) {
      if (r.targetType === "workspace") targetLabel = orgName.get(r.targetId) ?? null;
      else if (r.targetType === "user") targetLabel = userEmail.get(r.targetId) ?? null;
      else if (r.targetType === "flag") targetLabel = flagDef(r.targetId)?.label ?? null;
    }
    return { ...r, targetLabel, orgName: r.orgId ? orgName.get(r.orgId) ?? null : null };
  });
}
