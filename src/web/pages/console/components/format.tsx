/**
 * OPS1: the one place the operator console turns raw values into words, dates, badges and links. Every console page
 * uses these, so the same thing reads and looks the same in every section.
 *
 * Usage:
 *   import { RelTime, formatDay, Empty, EMPTY, planLabel, StatusBadge, WorkspaceLink, PersonLink, EmptyRow, LoadError } from "../components/format";
 *
 *   <RelTime at={row.createdAt} />                       "3 min ago", exact local time in the title ("21 Nov 2026, 10:12 pm")
 *   formatDay(row.renewsAt)                              "21 Nov 2026" (EMPTY when missing)
 *   {value ?? <Empty />}                                 the one word for an empty value: "None"
 *   planLabel(org.plan)                                  "Free", "Pro", "Business" (the customer app's names)
 *   compPlanLabel(org.compPlan)                          "Free Business plan" (a plan given for free)
 *   <StatusBadge state="failed" />                       red "Failed"; <StatusBadge state="past_due" label="Past due" />
 *   <JobStatusBadge status="dead" />                     red "Failed for good"
 *   <IntegrationBadge on={cfg.billing} />                "Connected" / "Not connected"
 *   <OperatorRoleBadge role="ops_support" />             "Support"
 *   <TwoStepBadge on={u.twoFactor} />                    green "On" / amber "Off"
 *   <WorkspaceLink id={orgId} name={name} hint={ownerEmail} />
 *   <PersonLink id={userId} name={name} email={email} />
 *   <Labelled raw={job.type} label={jobTypeLabel(job.type)} />   plain words, the raw id in the title
 *   jobTypeLabel("mail.deliver"), eventTypeLabel("message.bounced"), dnsRecordLabel("return_mx"),
 *   auditActionLabel("workspace.unsuspended"), auditFieldLabel("sendCapDaily"), humanize("mail.send") -> "Mail send"
 *   <EmptyRow>No API keys yet.</EmptyRow>                a one-line empty state inside a section card
 *   <LoadError error={q.error} retry={() => q.refetch()} what="the workspace" />   403 reads "You don't have access"
 *   <BackLink to="/console/workspaces">All workspaces</BackLink>
 *
 * Page rules that go with these:
 *   - A whole page or tab with nothing in it: the big EmptyState (components/ui/misc). A sub-section inside a page:
 *     EmptyRow.
 *   - List pages: PageHeader with eyebrow = the sidebar group ("Customers", "Product", "Platform", "Access").
 *     Detail pages: BackLink "All <things>" above the title and no eyebrow.
 *   - Tab count badges only where the number is work waiting (TabCount, e.g. open reports); none elsewhere.
 *   - Search placeholders are short ("Search workspaces", "Search audit log").
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { PLANS, isPlanId } from "@/shared/plans";
import { LOCALE } from "@/shared/locale";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { Badge } from "@/web/components/ui/misc";
import { IconArrowLeft } from "@/web/components/ui/icon";
import { tz } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

export { EmptyRow, LoadError, NoAccess, consoleErrorMessage, isNoAccess } from "./states";

// ------------------------------------------------------------------ empty values

/** The one word for an empty value everywhere in the console. */
export const EMPTY = "None";

/** A quiet "None" (or your own words) for a missing value. */
export function Empty({ children = EMPTY, className }: { children?: ReactNode; className?: string }) {
  return <span className={cn("text-subtle", className)}>{children}</span>;
}

// ------------------------------------------------------------------ dates

export type DateInput = string | number | Date | null | undefined;
export interface DateOptions { locale?: string; timeZone?: string }

function toDate(at: DateInput): Date | null {
  if (at === null || at === undefined || at === "") return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

const zoneOf = (o?: DateOptions) => o?.timeZone ?? tz();

/** A calendar date, day first: "21 Nov 2026". EMPTY when missing or not a date. */
export function formatDay(at: DateInput, o?: DateOptions): string {
  const d = toDate(at);
  if (!d) return EMPTY;
  return d.toLocaleDateString(o?.locale ?? LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: zoneOf(o) });
}

/** A date and time to the minute, day first: "21 Nov 2026, 10:12 pm". No seconds. EMPTY when missing. */
export function formatDateTime(at: DateInput, o?: DateOptions): string {
  const d = toDate(at);
  if (!d) return EMPTY;
  const day = formatDay(d, o);
  const time = d.toLocaleTimeString(o?.locale ?? LOCALE, { hour: "numeric", minute: "2-digit", timeZone: zoneOf(o) });
  return `${day}, ${time}`;
}

/**
 * Relative time from `now`: "just now", "5 min ago", "3 h ago", "2 days ago", "in 4 h", "in 3 days". Past a week either
 * way it is the calendar date ("21 Nov 2026"). EMPTY when missing.
 */
export function relativeTime(at: DateInput, now: number = Date.now(), o?: DateOptions): string {
  const d = toDate(at);
  if (!d) return EMPTY;
  const diff = Math.round((d.getTime() - now) / 1000);
  const s = Math.abs(diff);
  const future = diff > 0;
  if (s < 45) return future ? "in a moment" : "just now";
  const say = (n: number, unit: string) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (s < 3600) return say(Math.max(1, Math.round(s / 60)), "min");
  if (s < 86_400) return say(Math.round(s / 3600), "h");
  if (s < 7 * 86_400) { const n = Math.round(s / 86_400); return say(n, n === 1 ? "day" : "days"); }
  return formatDay(d, o);
}

/** Relative time with the exact local time in the title (and a machine readable dateTime). */
export function RelTime({ at, empty, className }: { at: DateInput; empty?: ReactNode; className?: string }) {
  const d = toDate(at);
  if (!d) return <Empty className={className}>{empty ?? EMPTY}</Empty>;
  return <time dateTime={d.toISOString()} title={formatDateTime(d)} className={cn("whitespace-nowrap", className)}>{relativeTime(d)}</time>;
}

/** A calendar date with the exact local time in the title. */
export function Day({ at, empty, className }: { at: DateInput; empty?: ReactNode; className?: string }) {
  const d = toDate(at);
  if (!d) return <Empty className={className}>{empty ?? EMPTY}</Empty>;
  return <time dateTime={d.toISOString()} title={formatDateTime(d)} className={cn("whitespace-nowrap", className)}>{formatDay(d)}</time>;
}

// ------------------------------------------------------------------ plain labels

/** A raw id in plain words: "mail.send" -> "Mail send", "sendCapDaily" -> "Send cap daily", "past_due" -> "Past due". */
export function humanize(raw: string | null | undefined): string {
  if (!raw) return EMPTY;
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const lookup = (map: Record<string, string>, raw: string | null | undefined) => (raw ? map[raw] ?? humanize(raw) : EMPTY);

/** The customer app's plan names (shared/plans.ts): starter -> "Free", pro -> "Pro", business -> "Business". */
export function planLabel(planId: string | null | undefined): string {
  if (!planId) return EMPTY;
  return isPlanId(planId) ? PLANS[planId].name : humanize(planId);
}

/** A plan an operator gave for free: "Free Business plan". */
export function compPlanLabel(planId: string | null | undefined): string {
  if (!planId) return EMPTY;
  return `Free ${planLabel(planId)} plan`;
}

export const JOB_TYPE_LABELS: Record<string, string> = {
  "mail.deliver": "Mail delivery",
  "system-mail.send": "Account email",
  "notify.mail": "Notification email",
  "push.send": "Push notification",
  "demo.seed_suite": "Demo workspace setup",
  "data-move.notify": "Data move notice",
  "billing.referral_grant": "Referral reward",
  "tools.merge_send": "Mail merge send",
  "campaign.batch": "Campaign batch",
  "campaign.send": "Campaign send",
  "journey.step": "Journey step",
};
/** A background job type in plain words ("mail.deliver" -> "Mail delivery"). */
export const jobTypeLabel = (type: string | null | undefined) => lookup(JOB_TYPE_LABELS, type);

export const EVENT_TYPE_LABELS: Record<string, string> = {
  "*": "Every event",
  "incoming_hook.received": "Incoming hook received",
  "chat.channel.created": "Chat channel created",
  "chat.message.created": "Chat message sent",
  "chat.message.updated": "Chat message edited",
  "chat.message.deleted": "Chat message deleted",
  "chat.mention": "Chat mention",
  "task.file_added": "Task file added",
  "time_entry.created": "Time entry added",
  "time_entry.updated": "Time entry changed",
};
/** A webhook event type in plain words ("message.bounced" -> "Message bounced"). */
export const eventTypeLabel = (type: string | null | undefined) => lookup(EVENT_TYPE_LABELS, type);

export const DNS_RECORD_LABELS: Record<string, string> = {
  mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC",
  return_mx: "Return path MX", return_spf: "Return path SPF", return_cname: "Return path CNAME",
};
/** A DNS check id as the record people know ("return_mx" -> "Return path MX"). */
export const dnsRecordLabel = (code: string | null | undefined) => (code ? DNS_RECORD_LABELS[code] ?? code.toUpperCase() : EMPTY);
/** Failing records as one line: ["mx", "spf"] -> "MX, SPF missing". */
export const dnsFailingText = (codes: readonly string[]) => (codes.length ? `${codes.map(dnsRecordLabel).join(", ")} missing` : EMPTY);

/** Every operator action, worded like the button that made it. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "workspace.suspended": "Workspace suspended",
  "workspace.unsuspended": "Workspace restored",
  "workspace.send_cap_changed": "Daily send cap changed",
  "workspace.meeting_cap_changed": "Call minutes cap changed",
  "workspace.sending_on": "Sending turned on",
  "workspace.sending_off": "Sending turned off",
  "user.banned": "User banned",
  "user.unbanned": "User unbanned",
  "user.deleted": "User deleted",
  "admin.user_deleted": "User deleted",
  "user.email_verified": "Email marked as confirmed",
  "user.lockout_cleared": "Sign-in lockout cleared",
  "user.session_revoked": "Session signed out",
  "user.sessions_revoked": "All sessions signed out",
  "note.added": "Note added",
  "note.deleted": "Note deleted",
  "impersonation.started": "Started viewing as someone",
  "impersonation.stopped": "Stopped viewing as someone",
  "impersonation.ended": "Viewing as someone ended",
  "support.session_started": "Support access started",
  "support.session_ended": "Support access ended",
  "billing.plan_changed": "Plan changed",
  "billing.credit_added": "Credit added",
  "billing.grace_extended": "Grace period extended",
  "billing.trial_extended": "Trial extended",
  "billing.comp_expired": "Free plan ended",
  "billing.resynced": "Billing synced from Stripe",
  "mail.domain_rechecked": "Domain DNS checked again",
  "mail.suppression_removed": "Suppression removed",
  "mail.queued_send_forced": "Held send sent now",
  "message.queued_send_forced": "Held send sent now",
  "agent_run.cancelled": "Agent run cancelled",
  "agent_trigger.paused": "Agent trigger paused",
  "agent_trigger.resumed": "Agent trigger resumed",
  "developer.api_key_revoked": "API key revoked",
  "developer.oauth_grant_revoked": "Connected app disconnected",
  "developer.webhook_redelivered": "Webhook sent again",
  "developer.webhook_enabled": "Webhook endpoint turned on",
  "developer.webhook_disabled": "Webhook endpoint turned off",
  "jobs.replayed": "Jobs run again",
  "jobs.replayed_all": "All failed jobs run again",
  "jobs.marked_dead": "Job marked failed for good",
  "report.resolved": "Report resolved",
  "report.dismissed": "Report dismissed",
  "report.message_removed": "Reported message removed",
  "report.user_suspended": "Reported user suspended",
  "report.resolve": "Report resolved",
  "report.dismiss": "Report dismissed",
  "report.remove_message": "Reported message removed",
  "report.suspend_user": "Reported user suspended",
  "abuse.resolved": "Abuse signal dismissed",
  "flags.global_set": "Platform flag changed",
  "flags.global_cleared": "Platform flag reset",
  "flags.workspace_set": "Workspace flag changed",
  "flags.workspace_cleared": "Workspace flag reset",
  "announcement.published": "Announcement published",
  "announcement.cleared": "Announcement cleared",
  "app_config.updated": "Mobile app settings saved",
  "metrics.backfilled": "Trends filled in",
  "metrics.rolled": "Trends updated",
  "system.sentry_test": "Sentry test error sent",
  "operator.granted": "Operator added",
  "operator.removed": "Operator removed",
  "operator.role_changed": "Operator role changed",
  "audit.exported": "Audit log downloaded",
};
/** An audit action in plain words ("flags.workspace_set" -> "Workspace flag changed"). */
export const auditActionLabel = (action: string | null | undefined) => lookup(AUDIT_ACTION_LABELS, action);

/** Actions that need no reason (a note is its own reason): the audit log shows no "No reason" badge for them. */
export const AUDIT_ACTIONS_WITHOUT_REASON: ReadonlySet<string> = new Set(["note.added", "note.deleted", "audit.exported", "impersonation.ended"]);

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  suspendedAt: "Suspended", suspendedReason: "Suspension reason", resolvedAbuseEvents: "Abuse signals dismissed",
  sendCapDaily: "Daily send cap", meetingMinutesCap: "Call minutes cap", cap: "Cap", enabled: "On",
  plan: "Plan", compPlan: "Free plan", compUntil: "Free plan until", effectivePlan: "Plan in use",
  role: "Role", email: "Email", name: "Name", banned: "Banned", banReason: "Ban reason", banExpires: "Ban ends",
  emailVerified: "Email confirmed", status: "Status", value: "Value", locked: "Locked", note: "Note",
  graceEndsAt: "Grace period ends", trialEndsAt: "Trial ends", pastDueSince: "Past due since", amount: "Amount",
  replayed: "Jobs run again", count: "Count", rows: "Rows", scope: "Scope", label: "Label", reason: "Reason",
  sessions: "Sessions", revoked: "Signed out", failures: "Failed attempts", lockedUntil: "Locked until",
  orgId: "Workspace", userId: "Person", targetUserId: "Person", workspaceId: "Workspace", action: "Action",
  publishedAt: "Published", expiresAt: "Ends", title: "Title", body: "Text", severity: "Level",
};
/** A before or after field in plain words. Dotted paths read part by part ("override.value" -> "Override: Value"). */
export function auditFieldLabel(key: string | null | undefined): string {
  if (!key) return EMPTY;
  if (AUDIT_FIELD_LABELS[key]) return AUDIT_FIELD_LABELS[key]!;
  return key.split(".").map((p) => AUDIT_FIELD_LABELS[p] ?? humanize(p)).join(": ");
}

/** Plain words on screen, the raw value in the title (for support and searching). */
export function Labelled({ raw, label, className }: { raw: string | null | undefined; label: string; className?: string }) {
  return <span title={raw ?? undefined} className={className}>{label}</span>;
}

// ------------------------------------------------------------------ status badges

export type StatusTone = "ok" | "warn" | "bad" | "neutral" | "brand";

const BAD = new Set(["failed", "failure", "fail", "error", "refused", "bounced", "rejected", "dead", "blocked", "suspended", "banned", "complained", "revoked", "disabled", "down"]);
const WARN = new Set(["waiting", "pending", "retrying", "queued", "held", "past_due", "pastdue", "needs_attention", "open", "near", "warn", "degraded", "half-open", "half_open", "trialing", "grace", "locked", "paused", "incomplete", "unpaid"]);
const OK = new Set(["ok", "active", "delivered", "done", "sent", "connected", "verified", "resolved", "on", "healthy", "operational", "succeeded", "success", "paid", "enabled", "closed", "normal"]);
const BRAND = new Set(["running", "in_progress", "processing"]);

/**
 * The tone for a state, the same in every section: failures red, things waiting amber, healthy green, in progress
 * brand, everything else (off, none, dismissed) grey.
 */
export function statusTone(state: string | null | undefined): StatusTone {
  const s = (state ?? "").toLowerCase().replace(/\s+/g, "_");
  if (BAD.has(s)) return "bad";
  if (WARN.has(s)) return "warn";
  if (OK.has(s)) return "ok";
  if (BRAND.has(s)) return "brand";
  return "neutral";
}

/** A status pill that never wraps. `label` overrides the humanised state; `tone` overrides statusTone. */
export function StatusBadge({ state, label, tone, dot = true, className }: { state: string | null | undefined; label?: ReactNode; tone?: StatusTone; dot?: boolean; className?: string }) {
  return (
    <span title={state ?? undefined} className="inline-flex shrink-0">
      <Badge tone={tone ?? statusTone(state)} dot={dot} className={cn("whitespace-nowrap", className)}>{label ?? humanize(state)}</Badge>
    </span>
  );
}

export type JobStatus = "pending" | "running" | "dead" | "done";
export const JOB_STATUS: Record<JobStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Waiting", tone: "warn" },
  running: { label: "Running", tone: "brand" },
  dead: { label: "Failed for good", tone: "bad" },
  done: { label: "Done", tone: "ok" },
};
export const jobStatusLabel = (s: string) => JOB_STATUS[s as JobStatus]?.label ?? humanize(s);
export function JobStatusBadge({ status }: { status: string }) {
  const j = JOB_STATUS[status as JobStatus];
  return <StatusBadge state={status} label={j?.label} tone={j?.tone} />;
}

/** "Connected" or "Not connected" for an integration. */
export const integrationLabel = (on: boolean) => (on ? "Connected" : "Not connected");
export function IntegrationBadge({ on }: { on: boolean }) {
  return <StatusBadge state={on ? "connected" : "off"} label={integrationLabel(on)} tone={on ? "ok" : "neutral"} />;
}

/** An operator's role: the owner tier in brand colour, the rest grey. Unknown roles read "Not an operator". */
export function OperatorRoleBadge({ role }: { role: string | null | undefined }) {
  return <Badge tone={role === "admin" ? "brand" : "neutral"} className="whitespace-nowrap">{operatorRoleLabel(role)}</Badge>;
}

/** Two-step sign in: green "On", amber "Off". `long` says "Two-step on" / "Two-step off" where no column names it. */
export function TwoStepBadge({ on, long }: { on: boolean; long?: boolean }) {
  const text = on ? "On" : "Off";
  return <Badge tone={on ? "ok" : "warn"} dot className="whitespace-nowrap">{long ? `Two-step ${text.toLowerCase()}` : text}</Badge>;
}

/** A count on a tab, only where it is work waiting. */
export function TabCount({ n, tone = "neutral" }: { n: number; tone?: StatusTone }) {
  if (!n) return null;
  return <Badge tone={tone} className="tabular-nums">{n.toLocaleString(LOCALE)}</Badge>;
}

// ------------------------------------------------------------------ links

export const workspaceHref = (id: string) => `/console/workspaces/${encodeURIComponent(id)}`;
export const personHref = (id: string) => `/console/users/${encodeURIComponent(id)}`;

/**
 * A workspace by name, linked to its console page. `hint` (an owner email or a short id) shows underneath so two
 * workspaces with the same name can be told apart. The id is in the title. A deleted one reads "Deleted workspace".
 */
export function WorkspaceLink({ id, name, hint, className }: { id: string | null | undefined; name: string | null | undefined; hint?: string | null; className?: string }) {
  if (!id) return <Empty className={className} />;
  return (
    <span className={cn("inline-flex min-w-0 flex-col", className)}>
      <Link to={workspaceHref(id)} title={id} className="truncate font-medium hover:underline">{name || "Deleted workspace"}</Link>
      {hint && <span className="truncate text-xs text-subtle">{hint}</span>}
    </span>
  );
}

/** A person by name with their email underneath (or just the email), linked to their console page. */
export function PersonLink({ id, name, email, className }: { id: string | null | undefined; name?: string | null; email?: string | null; className?: string }) {
  const primary = name || email;
  if (!primary && !id) return <Empty className={className} />;
  const main = id
    ? <Link to={personHref(id)} title={id} className="truncate hover:underline">{primary || "Deleted user"}</Link>
    : <span className="truncate">{primary}</span>;
  return (
    <span className={cn("inline-flex min-w-0 flex-col", className)}>
      {main}
      {name && email && <span className="truncate text-xs text-subtle">{email}</span>}
    </span>
  );
}

/** "All workspaces" above a detail page's title. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg" data-testid="console-back-link">
      <IconArrowLeft className="h-3.5 w-3.5" aria-hidden />{children}
    </Link>
  );
}
