/**
 * M1 (1.10.9): Mail archive and retention on the phone (web Settings > Archive and retention, flag mailArchive).
 * Everyone sees the policy that applies, read only. Owners and admins also see legal holds, saved cases and a read only
 * workspace mail search. Changing the policy, holds and the ZIP export stay on the web.
 */
export interface RetentionView {
  enabled: boolean; keepYears: number | null; startsAt: string | null; lastRunAt: string | null; lastRunDeleted: number; totalDeleted: number;
  timeZone: string; canManage: boolean; activeHolds?: number;
}
export interface LegalHoldView {
  id: string; kind: "mailbox" | "person"; targetId: string; targetLabel: string; name: string; note: string | null;
  createdBy: string | null; createdAt: string; releasedAt: string | null; releasedBy: string | null;
}
export interface ArchiveHit {
  id: string; mailbox: string; folder: string; fromAddress: string; fromName: string | null; to: string[]; subject: string; snippet: string;
  date: string; hasAttachments: boolean; held: boolean;
}
export interface MailCaseView { id: string; name: string; filters: Record<string, unknown>; createdBy: string | null; createdAt: string; lastExportedAt: string | null; exportCount: number }
export interface PolicyResponse { policy: RetentionView }
export interface HoldsResponse { holds: LegalHoldView[] }
export interface CasesResponse { cases: MailCaseView[] }
export interface ArchiveSearchResponse { hits: ArchiveHit[]; next: string | null }

export const ARCHIVE_WEB = "/app/settings/mail-archive";
/** The server takes up to 200 characters for the search words. */
export const ARCHIVE_Q_MAX = 200;

export function keepLine(p: RetentionView): string {
  if (!p.enabled || p.keepYears == null) return "Kept until someone deletes it";
  return p.keepYears === 1 ? "1 year, then deleted" : `${p.keepYears} years, then deleted`;
}

/** The archive search words, trimmed and cut to what the server takes (whole characters). */
export function archiveQuery(q: string): string {
  return Array.from(q.trim().replace(/\s+/g, " ")).slice(0, ARCHIVE_Q_MAX).join("");
}

export const activeHolds = (h: LegalHoldView[]) => h.filter((x) => !x.releasedAt);

export function hitFrom(h: ArchiveHit): string { return h.fromName ? `${h.fromName} (${h.fromAddress})` : h.fromAddress; }
