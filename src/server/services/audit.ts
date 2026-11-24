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

// MB-367: "address", "destinations", "recipients" and "replyTo" carried mailbox addresses (a personal Gmail someone
// connected, a personal mailbox's Reply-To) into a member's recent activity; those keys are private too. Under them
// text, lists and objects go, while a number or a yes/no stays (a send's `recipients: 3` count).
const ADDRESS_KEYS = /email|address|destination|recipient|replyTo|reply_to|^subject$/i;
// W5 (round 2): under a secret key every value goes, numbers included (an IP stored as a number, a numeric token).
const SECRET_KEYS = /^ip$|ipAddress|userAgent|invit|token/i;
// W5: a display name beside an address in the same object is that address's person.
const NAME_KEYS = /^(name|displayName|display_name|fromName|toName|senderName)$/i;
// W5: the domain ends in an alphabetic label, so a version like pkg@1.2.3 is not an address; quoted local parts count.
// Wave 1 review V13: the label's letters are any script's (x@primer.рф, a .भारत address), with its combining marks.
const ADDRESS = /(?:"[^"]*"|[^\s@<>"]+)@(?:[^\s@<>"]+\.)+\p{L}[\p{L}\p{M}]+/u;
const DROP = Symbol("drop");

/** W5: an address in any spelling: fullwidth ＠ (NFKC), percent encoded (%40), quoted local part. Prefers hiding. */
function holdsAddress(s: string): boolean {
  const n = s.normalize("NFKC");
  if (ADDRESS.test(n)) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(n); } catch { decoded = n.replace(/%40/gi, "@"); }
  return decoded !== n && ADDRESS.test(decoded.normalize("NFKC"));
}

/**
 * AIS1 review and MB-367: what a member may see of one metadata value. A string that holds a mail address goes, under
 * any key and at any depth; so does any text, list or object under an address key. F7: numbers and booleans under an
 * address key stay (they cannot hold an address), and in a nested object or list only the parts that hold an address
 * go, not the whole value; a list or object left with nothing in it goes. W5: under a secret key everything goes, and
 * in an object that holds an address, a name beside it goes too.
 */
function memberValue(v: unknown, key: "plain" | "address" | "secret"): unknown {
  if (key === "secret") return v === null || v === undefined ? v : DROP;
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  if (key === "address") return DROP;
  if (typeof v === "string") return holdsAddress(v) ? DROP : v;
  if (Array.isArray(v)) {
    const kept = v.map((x) => memberValue(x, "plain")).filter((x) => x !== DROP);
    return v.length && !kept.length ? DROP : kept;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    const kindOf = (k: string) => (SECRET_KEYS.test(k) ? "secret" : ADDRESS_KEYS.test(k) ? "address" : "plain") as "plain" | "address" | "secret";
    const hasAddress = entries.some(([k, x]) => (kindOf(k) === "address" && typeof x === "string") || (typeof x === "string" && holdsAddress(x)));
    const kept = entries.map(([k, x]) => [k, hasAddress && NAME_KEYS.test(k) ? DROP : memberValue(x, kindOf(k))] as const).filter(([, x]) => x !== DROP);
    return entries.length && !kept.length ? DROP : Object.fromEntries(kept);
  }
  return DROP;
}
/**
 * What a plain member may see of an audit row: no IP, no addresses or invite details in its metadata. AIS1: and no mail
 * subject (an agent's read or send names its thread, which may be in a mailbox the member can't open), and no field
 * that holds a mail address under any name, so an agent send's recipients and sender stay hidden while a plan change's
 * from and to stay readable. Used by the dashboard and, since AIS1, by an agent's audit log (app and v1).
 */
export function memberSafeAudit<T extends { ip?: string | null; actorEmail?: string | null; metadata?: Record<string, unknown> | null }>(row: T): T {
  if (!row.metadata) return { ...row, ip: null };
  const kept = memberValue(row.metadata, "plain");
  return { ...row, ip: null, metadata: kept === DROP ? {} : kept as Record<string, unknown> };
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
