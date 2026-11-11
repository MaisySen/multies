import { and, desc, eq, gte, lt, or, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import { auditLogs } from "../db/schema";
import { newId } from "../lib/crypto";
import { containsText, startsWithText } from "../lib/like-search";
import { stampFor } from "../lib/request-caller";

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
  /** R29: when it happened, for callers that run on the deps clock (agent triggers). Defaults to now. */
  at?: Date;
}

/**
 * Appends an immutable audit record. Actions are dotted verbs, e.g. `domain.verified`.
 * AIS1: inside a request, an entry the caller made also gets the request's IP when none was passed, and, when the caller
 * is an API key or a connected AI app, `metadata.caller` naming it (lib/request-caller.ts). Same row, no extra write.
 */
export async function audit(db: DB, e: AuditEntry): Promise<void> {
  const req = stampFor(e);
  const metadata = req?.caller && !(e.metadata && "caller" in e.metadata) ? { ...(e.metadata ?? {}), caller: req.caller } : e.metadata;
  await db.insert(auditLogs).values({
    id: newId("aud"),
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    actorEmail: e.actorEmail ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    ip: e.ip ?? req?.ip ?? null,
    agentId: e.agentId ?? null,
    ...(e.at ? { createdAt: e.at } : {}),
  });
}

/**
 * R39 security hotfix: an invitation's id is its invite link, so audit output never carries one in
 * full, not even for admins. Only a short masked form (the last 4 characters) is shown.
 */
export function maskInviteId(id: string): string {
  return id.length <= 4 ? "****" : `****${id.slice(-4)}`;
}
const INVITE_KEY = /invit|token/i;
const INVITE_LINK = /(\/invites?\/)([A-Za-z0-9_-]{8,})/g;
function maskValue(v: unknown, key: string): unknown {
  if (typeof v === "string") {
    const linked = v.replace(INVITE_LINK, (_m, p: string, id: string) => `${p}${maskInviteId(id)}`);
    return INVITE_KEY.test(key) && linked === v ? maskInviteId(v) : linked;
  }
  if (Array.isArray(v)) return v.map((x) => maskValue(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskValue(x, k)]));
  return v;
}
/** Masks invitation ids in an audit row's target and metadata (parsed object or raw JSON text). */
export function redactAuditRow<T extends { targetType?: string | null; targetId?: string | null; metadata?: unknown }>(row: T): T {
  const out = { ...row };
  if (out.targetId && /invit/i.test(out.targetType ?? "")) out.targetId = maskInviteId(out.targetId);
  if (typeof out.metadata === "string" && out.metadata) {
    try { out.metadata = JSON.stringify(maskValue(JSON.parse(out.metadata), "")); } catch { out.metadata = maskValue(out.metadata, ""); }
  } else if (out.metadata && typeof out.metadata === "object") {
    out.metadata = maskValue(out.metadata, "");
  }
  return out;
}

const PRIVATE_KEYS = /email|^ip$|ipAddress|userAgent|invit|token|^subject$/i;
/**
 * What a plain member may see of an audit row: no IP, no addresses or invite details in its metadata. AIS1: and no mail
 * subject (an agent's read or send names its thread, which may be in a mailbox the member can't open). Used by the
 * dashboard and, since AIS1, by an agent's audit log (app and v1).
 */
export function memberSafeAudit<T extends { ip?: string | null; actorEmail?: string | null; metadata?: Record<string, unknown> | null }>(row: T): T {
  const metadata = row.metadata ? Object.fromEntries(Object.entries(row.metadata).filter(([k]) => !PRIVATE_KEYS.test(k))) : row.metadata;
  return { ...row, ip: null, metadata };
}

/** R111: Audit log filters (Activity > Audit log, flag MAIL_ARCHIVE_R111): action prefixes, who did it, a date range. */
export interface AuditFilter { prefixes?: string[]; actor?: string; from?: Date; to?: Date }
export function auditFilterCond(f: AuditFilter | undefined): SQL | undefined {
  if (!f) return undefined;
  const c: (SQL | undefined)[] = [];
  if (f.prefixes?.length) c.push(or(...f.prefixes.map((p) => startsWithText(auditLogs.action, p))));
  if (f.actor) c.push(containsText(auditLogs.actorEmail, f.actor));
  if (f.from) c.push(gte(auditLogs.createdAt, f.from));
  if (f.to) c.push(lt(auditLogs.createdAt, f.to));
  return c.length ? and(...c) : undefined;
}

export async function listAudit(db: DB, orgId: string, opts: { limit?: number; before?: Date; agentId?: string; filter?: AuditFilter } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.orgId, orgId), opts.before ? lt(auditLogs.createdAt, opts.before) : undefined, opts.agentId ? eq(auditLogs.agentId, opts.agentId) : undefined, auditFilterCond(opts.filter)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map((r) => redactAuditRow({ ...r, metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null }));
}
