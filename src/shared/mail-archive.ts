/**
 * R111: mail archive and retention, the parts both the server and the web app use. Policy math lives here so the
 * page shows exactly the cutoff the daily pass will use.
 */
import { z } from "zod";

export const KEEP_YEAR_CHOICES = [1, 2, 3, 5, 7, 10] as const;
export const MIN_KEEP_YEARS = 1;
export const MAX_KEEP_YEARS = 10;
/** Deletion starts this long after a policy is turned on or made stricter, so a mistake can be undone. */
export const RETENTION_GRACE_DAYS = 7;
/** Messages deleted per workspace per pass (a pass runs on the 15 minute cron while a backlog remains). */
export const RETENTION_BATCH = 200;
/** One pass a day per workspace once the backlog is gone. */
export const RETENTION_INTERVAL_MS = 23 * 60 * 60 * 1000;
export const ARCHIVE_PAGE = 50;
export const CASE_EXPORT_MAX = 5000;
export const MAX_ACTIVE_HOLDS = 100;

const DAY = 86_400_000;

function localParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}
/** Milliseconds the zone is ahead of UTC at that moment. */
function zoneOffset(at: Date, timeZone: string) {
  const p = localParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}
/** The UTC moment of local midnight on y-m-d in the zone. */
export function zoneMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffset(new Date(guess), timeZone);
  t = guess - zoneOffset(new Date(t), timeZone);
  return new Date(t);
}
export function safeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "UTC"; }
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Mail dated before this moment is past the policy: local midnight, in the workspace's time zone, of today's date
 * N years ago (29 February becomes 28 February in a year without one). Null (forever) means nothing is ever past it.
 */
export function retentionCutoff(now: Date, keepYears: number | null | undefined, timeZone: string): Date | null {
  if (keepYears == null) return null;
  const years = Math.trunc(keepYears);
  if (!(years >= MIN_KEEP_YEARS && years <= MAX_KEEP_YEARS)) return null;
  const tz = safeZone(timeZone);
  const p = localParts(now, tz);
  const y = p.y - years;
  const d = p.m === 2 && p.d === 29 && !isLeap(y) ? 28 : p.d;
  return zoneMidnight(y, p.m, d, tz);
}
export const graceEnd = (from: Date) => new Date(from.getTime() + RETENTION_GRACE_DAYS * DAY);

/** A stricter policy (deletes more) restarts the grace period; a looser one keeps the date already set. */
export function isStricter(prev: { enabled: boolean; keepYears: number | null }, next: { enabled: boolean; keepYears: number | null }): boolean {
  if (!next.enabled || next.keepYears == null) return false;
  if (!prev.enabled || prev.keepYears == null) return true;
  return next.keepYears < prev.keepYears;
}

export function keepLabel(enabled: boolean, keepYears: number | null | undefined): string {
  if (!enabled || keepYears == null) return "Keep forever";
  return `Keep for ${keepYears} ${keepYears === 1 ? "year" : "years"}`;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
export const ArchiveFilters = z.object({
  q: z.string().trim().max(200).optional(),
  from: z.string().trim().max(254).optional(),
  to: z.string().trim().max(254).optional(),
  mailboxId: z.string().max(64).optional(),
  folder: z.enum(["inbox", "sent", "archive", "spam", "trash"]).optional(),
  after: isoDate,
  before: isoDate,
  hasAttachments: z.boolean().optional(),
});
export type ArchiveFilters = z.infer<typeof ArchiveFilters>;

/** Drops empty values, so a case stores only what the admin chose. */
export function cleanFilters(f: ArchiveFilters): ArchiveFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== false) out[k] = v;
  return out as ArchiveFilters;
}
export function describeFilters(f: ArchiveFilters, mailboxName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (f.q) parts.push(`words "${f.q}"`);
  if (f.from) parts.push(`from ${f.from}`);
  if (f.to) parts.push(`to ${f.to}`);
  if (f.mailboxId) parts.push(`in ${mailboxName?.(f.mailboxId) ?? "one mailbox"}`);
  if (f.folder) parts.push(`folder ${f.folder}`);
  if (f.after) parts.push(`on or after ${f.after}`);
  if (f.before) parts.push(`before ${f.before}`);
  if (f.hasAttachments) parts.push("with attachments");
  return parts.length ? parts.join(", ") : "All mail";
}

/** Audit log areas for the filter on Activity, by action prefix. */
export const AUDIT_AREAS: { id: string; label: string; prefixes: string[] }[] = [
  { id: "mail_archive", label: "Mail archive", prefixes: ["mail.retention.", "mail.hold.", "mail.case.", "mail.archive."] },
  { id: "mailboxes", label: "Mailboxes and domains", prefixes: ["mailbox.", "domain.", "alias.", "address."] },
  { id: "team", label: "Team", prefixes: ["member.", "invite.", "team."] },
  { id: "security", label: "Security", prefixes: ["api_key.", "app_password.", "session.", "sso.", "two_factor.", "password."] },
  { id: "billing", label: "Billing", prefixes: ["billing.", "plan.", "subscription."] },
  { id: "workspace", label: "Workspace", prefixes: ["workspace.", "org."] },
];

export interface RetentionView {
  enabled: boolean;
  keepYears: number | null;
  startsAt: string | null;
  lastRunAt: string | null;
  lastRunDeleted: number;
  totalDeleted: number;
  timeZone: string;
  canManage: boolean;
  activeHolds?: number;
}
export interface RetentionPreview {
  keepYears: number | null;
  cutoff: string | null;
  eligible: number;
  heldBack: number;
  connectedSkipped: number;
  startsAt: string | null;
}
export interface LegalHoldView {
  id: string;
  kind: "mailbox" | "person";
  targetId: string;
  targetLabel: string;
  name: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}
export interface ArchiveHit {
  id: string;
  mailbox: string;
  folder: string;
  fromAddress: string;
  fromName: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  hasAttachments: boolean;
  held: boolean;
}
export interface MailCaseView {
  id: string;
  name: string;
  filters: ArchiveFilters;
  createdBy: string | null;
  createdAt: string;
  lastExportedAt: string | null;
  exportCount: number;
}
