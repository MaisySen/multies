/**
 * R31: split inbox. Inbox shows Important, Other and the person's own splits as tabs.
 * Important = mail from people (someone you wrote to, a teammate, a saved contact, or a reply in a thread you
 * are in, or since R32 a first time sender whose message passed SPF and DKIM) that is not bulk. Other = the rest. A split with leavesImportant takes its matching mail out of
 * Important and Other, so each thread shows under one tab.
 */
import { z } from "zod";

export const SPLIT_NAME_MAX = 40;
export const SPLIT_RULES_MAX = 10;
export const SPLITS_MAX = 12;
export const SPLIT_VALUE_MAX = 200;

/** What a rule looks at. fromTeammate and calendarInvite take no value. */
export const SPLIT_FIELDS = ["fromContains", "fromDomain", "to", "subjectContains", "calendarInvite", "fromTeammate"] as const;
export type SplitField = (typeof SPLIT_FIELDS)[number];

export const SPLIT_FIELD_LABEL: Record<SplitField, string> = {
  fromContains: "From contains",
  fromDomain: "From domain",
  to: "Sent to",
  subjectContains: "Subject contains",
  calendarInvite: "Is a calendar invite",
  fromTeammate: "From a teammate",
};
export const fieldNeedsValue = (f: SplitField) => f !== "calendarInvite" && f !== "fromTeammate";

export const SplitRule = z.object({
  field: z.enum(SPLIT_FIELDS),
  value: z.string().max(SPLIT_VALUE_MAX).optional().default(""),
}).refine((r) => !fieldNeedsValue(r.field) || r.value.trim().length > 0, { message: "This rule needs a value." });
export type SplitRuleT = z.infer<typeof SplitRule>;

export const SplitCreate = z.object({
  name: z.string().trim().min(1).max(SPLIT_NAME_MAX),
  rules: z.array(SplitRule).min(1).max(SPLIT_RULES_MAX),
  match: z.enum(["all", "any"]).optional().default("all"),
  leavesImportant: z.boolean().optional().default(true),
  position: z.number().int().min(0).max(100).optional(),
});
export const SplitPatch = z.object({
  name: z.string().trim().min(1).max(SPLIT_NAME_MAX).optional(),
  rules: z.array(SplitRule).min(1).max(SPLIT_RULES_MAX).optional(),
  match: z.enum(["all", "any"]).optional(),
  leavesImportant: z.boolean().optional(),
  position: z.number().int().min(0).max(100).optional(),
});
export const SplitPreview = z.object({
  rules: z.array(SplitRule).min(1).max(SPLIT_RULES_MAX),
  match: z.enum(["all", "any"]).optional().default("all"),
  mailboxId: z.string().max(64).optional(),
});

export interface MailSplit {
  id: string;
  name: string;
  rules: SplitRuleT[];
  match: "all" | "any";
  leavesImportant: boolean;
  position: number;
}

/** The tabs Inbox shows, in order, each with its unread count. */
export interface SplitTab { id: string; name: string; unread: number; builtIn: boolean }

/** "important" | "other" | a split id. */
export const splitParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** Sender local parts that are never a person (no reply expected). */
export const BULK_LOCAL_PARTS = ["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply", "notifications", "notification", "notify", "mailer-daemon", "newsletter", "news", "updates", "marketing", "bounce", "bounces"];

/** True when the address's local part says no person is behind it (noreply@, notifications@, ...). */
export function isRobotSender(address: string): boolean {
  const local = address.toLowerCase().split("@")[0] ?? "";
  return BULK_LOCAL_PARTS.some((p) => local === p || local.startsWith(`${p}+`) || local.startsWith(`${p}-`) || local.startsWith(`${p}.`));
}

/** Bulk mail by its headers (lower-cased keys), read on inbound ingest. */
export function isBulkMail(headers: Record<string, string | undefined>, from: string): boolean {
  if (headers["list-unsubscribe"] || headers["list-id"]) return true;
  const prec = (headers["precedence"] ?? "").toLowerCase().trim();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  const auto = (headers["auto-submitted"] ?? "").toLowerCase().trim();
  if (auto && auto !== "no") return true;
  if (headers["x-campaign"] || headers["x-mailchimp-campaign"] || headers["feedback-id"]) return true;
  return isRobotSender(from);
}

/** Read status line for a sent message: "Opened 2x, last 3:14 PM" or "Not opened yet". */
export interface ReadStatus { tracked: boolean; opens: number; firstOpenAt: string | null; lastOpenAt: string | null }
export function readStatusLine(s: ReadStatus | null | undefined, fmt: (iso: string) => string): string | null {
  if (!s || !s.tracked) return null;
  if (!s.opens || !s.lastOpenAt) return "Not opened yet";
  return `Opened ${s.opens}x, last ${fmt(s.lastOpenAt)}`;
}

/** Next or previous tab id (Tab / Shift+Tab in Inbox), wrapping around. */
export function stepSplit(tabs: { id: string }[], current: string, dir: 1 | -1): string {
  if (!tabs.length) return current;
  const i = Math.max(0, tabs.findIndex((t) => t.id === current));
  return tabs[(i + dir + tabs.length) % tabs.length].id;
}
