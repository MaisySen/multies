import { and, desc, eq, lt } from "drizzle-orm";
import type { DB } from "../db";
import { auditLogs } from "../db/schema";
import { newId } from "../lib/crypto";

export interface AuditEntry {
  orgId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  /** The agent that acted, or that a person acted on. */
  agentId?: string | null;
}

/** Appends an immutable audit record. Actions are dotted verbs, e.g. `domain.verified`. */
export async function audit(db: DB, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId("aud"),
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    actorEmail: e.actorEmail ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    metadata: e.metadata ? JSON.stringify(e.metadata) : null,
    ip: e.ip ?? null,
    agentId: e.agentId ?? null,
  });
}

export async function listAudit(db: DB, orgId: string, opts: { limit?: number; before?: Date; agentId?: string } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.orgId, orgId), opts.before ? lt(auditLogs.createdAt, opts.before) : undefined, opts.agentId ? eq(auditLogs.agentId, opts.agentId) : undefined))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null }));
}
