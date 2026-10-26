/**
 * Earned autonomy: an agent's record on approvals, and a suggestion to loosen or tighten its
 * approval mode from that record. Read only: it counts the agent's latest approval requests and
 * the audit rows that say whether a person edited them, and writes nothing.
 */
import { and, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { agents, auditLogs, sendApprovals } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";

export type ApprovalModeName = "always" | "external" | "never";

/** How many of the latest requests the record looks at. */
export const RECORD_WINDOW = 50;
/** Clean decisions in a row before Multies suggests the next step up. */
export const LOOSEN_AFTER: Record<Exclude<ApprovalModeName, "never">, number> = { always: 20, external: 50 };

export interface TrackRecord {
  window: number;
  decided: number;
  approvedAsIs: number;
  approvedEdited: number;
  rejected: number;
  expired: number;
  failed: number;
  pending: number;
  /** Approved without edits in a row, newest first, ending at the first edit, rejection or expiry. */
  cleanStreak: number;
}

export interface ModeSuggestion { mode: ApprovalModeName; direction: "loosen" | "tighten"; reason: string }

/** Counts a list of requests, newest first. `edited` holds the ids a person changed before approving. */
export function tallyRecord(rows: { id: string; status: string }[], edited: Set<string>): TrackRecord {
  const r: TrackRecord = { window: RECORD_WINDOW, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, failed: 0, pending: 0, cleanStreak: 0 };
  let streakOpen = true;
  for (const row of rows) {
    if (row.status === "pending") { r.pending++; continue; }
    r.decided++;
    const clean = row.status === "sent" && !edited.has(row.id);
    if (row.status === "sent") { if (edited.has(row.id)) r.approvedEdited++; else r.approvedAsIs++; }
    else if (row.status === "rejected") r.rejected++;
    else if (row.status === "expired") r.expired++;
    else if (row.status === "failed") r.failed++;
    // A failed delivery is not the agent's judgement, so it neither builds nor breaks the streak.
    if (row.status === "failed") continue;
    if (streakOpen && clean) r.cleanStreak++;
    else streakOpen = false;
  }
  return r;
}

/**
 * The next approval mode worth offering, or null. Loosening needs a clean streak; tightening
 * follows rejections among the latest decisions in the window.
 */
export function suggestMode(mode: ApprovalModeName, r: TrackRecord): ModeSuggestion | null {
  const recentBad = r.rejected;
  if (mode !== "always" && r.decided >= 5 && recentBad >= 3 && recentBad / r.decided >= 0.2) {
    return { mode: "always", direction: "tighten", reason: `People rejected ${recentBad} of this agent's last ${r.decided} requests. Ask for approval on every message until that settles.` };
  }
  if (mode === "always" && r.cleanStreak >= LOOSEN_AFTER.always) {
    return { mode: "external", direction: "loosen", reason: `The last ${r.cleanStreak} messages were approved without a change. Let it send to Multies addresses on its own and keep approval for mail leaving Multies.` };
  }
  if (mode === "external" && r.cleanStreak >= LOOSEN_AFTER.external) {
    return { mode: "never", direction: "loosen", reason: `The last ${r.cleanStreak} outside messages were approved without a change. It could send on its own; the daily cap and allowed recipients still apply.` };
  }
  return null;
}

export async function agentTrackRecord(deps: Deps, actor: Pick<AuthContext, "orgId">, agentId: string) {
  const a = await deps.db.select({ id: agents.id, approvalMode: agents.approvalMode }).from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, actor.orgId))).get();
  if (!a) throw notFound("Agent");
  const rows = await deps.db.select({ id: sendApprovals.id, status: sendApprovals.status }).from(sendApprovals)
    .where(and(eq(sendApprovals.orgId, actor.orgId), eq(sendApprovals.agentId, a.id)))
    .orderBy(desc(sendApprovals.createdAt), desc(sendApprovals.id)).limit(RECORD_WINDOW);
  const sentIds = rows.filter((r) => r.status === "sent").map((r) => r.id);
  const edited = new Set<string>();
  if (sentIds.length) {
    const approvals = await deps.db.select({ targetId: auditLogs.targetId, metadata: auditLogs.metadata }).from(auditLogs)
      .where(and(eq(auditLogs.orgId, actor.orgId), eq(auditLogs.action, "approval.approved"), inIds(auditLogs.targetId, sentIds)));
    for (const x of approvals) {
      try { if (x.targetId && (JSON.parse(x.metadata ?? "{}") as { edited?: boolean }).edited) edited.add(x.targetId); } catch { /* old rows without metadata */ }
    }
  }
  const record = tallyRecord(rows, edited);
  const mode = a.approvalMode as ApprovalModeName;
  return { mode, record, suggestion: suggestMode(mode, record) };
}
