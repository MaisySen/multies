/**
 * R112 Anonymous reporting channel and data requests (REPORTING_R112): shared rules, labels and deadline math.
 * Used by the server (services/suite/reporting-r112.ts, data-requests-r112.ts) and the web pages.
 */
import { randomBytes } from "./random";

export const REPORT_STATUSES = ["new", "acknowledged", "investigating", "closed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = { new: "New", acknowledged: "Acknowledged", investigating: "Investigating", closed: "Closed" };
export const isReportStatus = (v: unknown): v is ReportStatus => typeof v === "string" && (REPORT_STATUSES as readonly string[]).includes(v);

export const DATA_KINDS = ["contacts", "forms", "bookings"] as const;
export type DataKind = (typeof DATA_KINDS)[number];
export const DATA_KIND_LABELS: Record<DataKind, string> = { contacts: "Contacts", forms: "Form answers", bookings: "Bookings" };
export const DATA_REQUEST_TYPES = ["export", "delete"] as const;
export type DataRequestType = (typeof DATA_REQUEST_TYPES)[number];
export const DATA_REQUEST_STATUSES = ["unverified", "verified", "done", "expired", "cancelled"] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];
export const DATA_STATUS_LABELS: Record<DataRequestStatus, string> = {
  unverified: "Waiting for email check", verified: "Ready to review", done: "Done", expired: "Link expired", cancelled: "Cancelled",
};

export const REPORT_LIMITS = {
  bodyChars: 20_000,
  replyChars: 10_000,
  /** Files per message and per case. The workspace file limit applies too; public uploads are capped lower. */
  filesPerMessage: 3,
  filesPerCase: 10,
  fileBytes: 5 * 1024 * 1024,
  /** New reports a workspace takes per day (spam guard that needs no IP). */
  reportsPerDay: 50,
  /** Follow up sign in: wrong tries before a lock, the first lock, the longest lock. */
  maxTries: 5,
  lockMs: 15 * 60_000,
  maxLockMs: 24 * 60 * 60_000,
  /** A follow up sign in is good for this long (held in the page's memory only). */
  readerMs: 30 * 60_000,
  ackDays: 7,
  outcomeMonths: 3,
  listMax: 200,
} as const;

export const DATA_LIMITS = {
  dueDays: 30,
  verifyMs: 48 * 60 * 60_000,
  downloadMs: 7 * 24 * 60 * 60_000,
  requestsPerDay: 30,
  /** Most rows of one kind a request matches (bounded queries). */
  maxRows: 2000,
  listMax: 200,
} as const;

/** Letters and digits that are hard to mix up when read aloud or copied by hand (no 0/O, 1/I/L). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Case number: "RC" and 8 random characters in two groups, e.g. RC-7KQM-2XPD. Random, so it says nothing about how many reports exist. */
export function formatCaseNo(rand: Uint8Array): string {
  const s = Array.from(rand.slice(0, 8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `RC-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
export const CASE_NO_RE = /^RC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
/** Accepts what people type: lower case, spaces, missing dashes. */
export function normaliseCaseNo(v: string): string | null {
  const s = v.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^RC/, "");
  if (s.length !== 8) return null;
  const out = `RC-${s.slice(0, 4)}-${s.slice(4)}`;
  return CASE_NO_RE.test(out) ? out : null;
}

/** Passphrase: 5 groups of 4 random characters (about 100 bits), e.g. K7QM-2XPD-9FTW-H3VN-R8CZ. Shown once, stored only as a slow hash. */
export function formatPassphrase(rand: Uint8Array): string {
  const s = Array.from(rand.slice(0, 20), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return [0, 4, 8, 12, 16].map((i) => s.slice(i, i + 4)).join("-");
}
export function normalisePassphrase(v: string): string {
  const s = v.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length === 20 ? [0, 4, 8, 12, 16].map((i) => s.slice(i, i + 4)).join("-") : v.trim();
}

/** What a trapped bot is shown: looks like a real answer, matches nothing. */
export function randomPreview(): { caseNo: string; passphrase: string } {
  const r = (n: number) => randomBytes(n);
  return { caseNo: formatCaseNo(r(8)), passphrase: formatPassphrase(r(20)) };
}

/** Calendar months later, clamped to the month's last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(t: number, months: number): number {
  const d = new Date(t);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.getTime();
}
export const DAY_MS = 24 * 60 * 60_000;
export function reportDeadlines(receivedAt: number): { ackDueAt: number; outcomeDueAt: number } {
  return { ackDueAt: receivedAt + REPORT_LIMITS.ackDays * DAY_MS, outcomeDueAt: addMonths(receivedAt, REPORT_LIMITS.outcomeMonths) };
}
export function dataDueAt(createdAt: number): number { return createdAt + DATA_LIMITS.dueDays * DAY_MS; }

/** Which deadline badges a case shows now. */
export function caseFlags(c: { status: ReportStatus; ackDueAt: number; outcomeDueAt: number; acknowledgedAt: number | null; closedAt: number | null }, now: number) {
  const acked = c.acknowledgedAt != null || c.status !== "new";
  const closed = c.status === "closed" || c.closedAt != null;
  return { ackOverdue: !acked && now > c.ackDueAt, outcomeOverdue: !closed && now > c.outcomeDueAt };
}

/** Lock length after the given number of wrong tries (0 until the limit, then 15 min doubling to 24 h). */
export function lockMsFor(fails: number): number {
  if (fails < REPORT_LIMITS.maxTries) return 0;
  const steps = Math.floor(fails / REPORT_LIMITS.maxTries) - 1;
  return Math.min(REPORT_LIMITS.lockMs * 2 ** Math.min(steps, 10), REPORT_LIMITS.maxLockMs);
}

/** Days left (negative when overdue), rounded towards the due side. */
export const daysLeft = (due: number, now: number) => Math.ceil((due - now) / DAY_MS);

export const isEmail = (v: string) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v.trim());
/** a***@example.com for lists; the full address shows in the request itself. */
export function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  if (!u || !d) return e;
  return `${u.slice(0, 1)}${"*".repeat(Math.min(3, Math.max(1, u.length - 1)))}@${d}`;
}

// ------------------------------------------------------------------ API shapes

export interface ReportChannelView {
  enabled: boolean; publicId: string | null; url: string | null; dataRequestUrl: string | null; intro: string; defaultHandlerId: string | null; excluded: boolean;
}
export interface ReportFileView { id: string; name: string; size: number; type: string }
export interface ReportMessageView { id: string; author: "reporter" | "handler" | "system"; authorName: string | null; internal: boolean; body: string; files: ReportFileView[]; createdAt: number }
export interface ReportCaseRow {
  id: string; caseNo: string; status: ReportStatus; handlerId: string | null; handlerName: string | null; summary: string;
  createdAt: number; ackDueAt: number; outcomeDueAt: number; acknowledgedAt: number | null; closedAt: number | null; lastReporterAt: number | null; unread: boolean;
  ackOverdue: boolean; outcomeOverdue: boolean;
}
export interface ReportCaseDetail extends ReportCaseRow { outcome: string; messages: ReportMessageView[] }
export interface ReporterThread {
  caseNo: string; status: ReportStatus; createdAt: number; acknowledgedAt: number | null; closedAt: number | null; outcome: string; workspace: string;
  messages: ReportMessageView[];
}
export interface DataMatchCounts { contacts: number; forms: number; bookings: number }
export interface DataRequestRow {
  id: string; email: string; masked: string; type: DataRequestType; status: DataRequestStatus; source: "public" | "admin"; createdAt: number; dueAt: number; verifiedAt: number | null; doneAt: number | null; overdue: boolean;
}
export interface DataLogRow { id: string; requestId: string | null; actor: string; action: string; kinds: DataKind[]; counts: Partial<DataMatchCounts>; createdAt: number }
