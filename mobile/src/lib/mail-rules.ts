import { tr } from "@/i18n";
/**
 * 1.10.7: inbox tabs, labels, snoozed mail and mail rules on the phone. The shapes and words match the web (R85,
 * src/shared/mail-rules-r85.ts on the server); everything here is plain logic so it can be tested without a screen.
 */

export type TabStyle = "classic" | "categories" | "off";
export const TAB_STYLES: { id: TabStyle; label: string; hint: string }[] = [
  { id: "categories", label: "Primary, Updates and Promotions", hint: "People first, then updates and offers" },
  { id: "classic", label: "Important and Other", hint: "Mail from people you know, then the rest" },
  { id: "off", label: "No tabs", hint: "One Inbox, as before" },
];
export const tabStyleLabel = (s: TabStyle) => TAB_STYLES.find((x) => x.id === s)?.label ?? "No tabs";

/** One Inbox tab with its unread count (GET /api/mail/splits). */
export interface InboxTab { id: string; name: string; unread: number; builtIn: boolean }
export interface InboxTabs { tabs: InboxTab[]; style: TabStyle; defaultTab: string }

/** What Inbox tab is open: the remembered one when it still exists, else the style's first tab. */
export function activeTab(tabs: InboxTab[], remembered: string | null | undefined, fallback?: string): string {
  if (!tabs.length) return "";
  if (remembered && tabs.some((t) => t.id === remembered)) return remembered;
  if (fallback && tabs.some((t) => t.id === fallback)) return fallback;
  return tabs[0].id;
}

/** "12", or "99+" past 99; nothing for 0. */
export function countLabel(n: number | undefined | null): string {
  if (!n || n < 0) return "";
  return n > 99 ? "99+" : String(Math.floor(n));
}

/** What a screen reader says for a tab: "Updates, 12 unread". */
export function tabA11yLabel(t: InboxTab): string {
  const name = tabName(t);
  return t.unread > 0 ? tr("m.common.label_count_unread", { label: name, count: t.unread > 99 ? tr("m.inbox.more_than_99") : t.unread }) : name;
}

/** MPAR2: built in tabs (Primary, Updates, Promotions, Social, Forums) in the app's language; your own tabs as named. */
export function tabName(t: Pick<InboxTab, "id" | "name" | "builtIn">): string {
  const k = `m.inbox.tab_${t.id}`;
  return t.builtIn && ["primary", "updates", "promotions", "social", "forums"].includes(t.id) ? tr(k) : t.name;
}

// ---------------------------------------------------------------- rules

export const RULE_NAME_MAX = 80;
export const RULE_CONDITIONS_MAX = 10;
export const RULE_ACTIONS_MAX = 8;
export const RULE_VALUE_MAX = 200;
export const LABEL_MAX = 40;

export type RuleField = "from" | "to" | "subject" | "domain" | "hasAttachment";
export const RULE_FIELDS: { id: RuleField; label: string; placeholder?: string }[] = [
  { id: "from", label: "From contains", placeholder: "name or address" },
  { id: "to", label: "Sent to contains", placeholder: "address" },
  { id: "subject", label: "Subject contains", placeholder: "word or phrase" },
  { id: "domain", label: "From domain is", placeholder: "example.com" },
  { id: "hasAttachment", label: "Has an attachment" },
];
export const fieldLabel = (f: RuleField) => RULE_FIELDS.find((x) => x.id === f)?.label ?? f;
export const fieldNeedsValue = (f: RuleField) => f !== "hasAttachment";

export type RuleActionKind = "label" | "move_to_tab" | "mark_read" | "archive" | "star" | "forward" | "auto_reply" | "create_task" | "notify";
export const ACTION_LABEL: Record<RuleActionKind, string> = {
  label: "Add a label",
  move_to_tab: "Move to a tab",
  mark_read: "Mark as read",
  archive: "Archive",
  star: "Star",
  forward: "Forward to",
  auto_reply: "Reply with a saved reply",
  create_task: "Make a task",
  notify: "Notify me",
};
/** Actions that send mail to other people: made and changed on the web only (owner's answer, 31 Oct). */
export const SENDING_ACTIONS: RuleActionKind[] = ["forward", "auto_reply"];
/** What the phone's rule form offers, in this order. */
export const PHONE_ACTIONS: RuleActionKind[] = ["label", "move_to_tab", "mark_read", "archive", "star", "create_task", "notify"];

export interface RuleCondition { field: RuleField; value: string }
export type RuleAction =
  | { kind: "label"; label: string }
  | { kind: "move_to_tab"; tab: string }
  | { kind: "mark_read" } | { kind: "archive" } | { kind: "star" } | { kind: "notify" }
  | { kind: "forward"; to: string }
  | { kind: "auto_reply"; snippetId: string }
  | { kind: "create_task"; projectId?: string; priority?: string; dueInDays?: number };

export interface MailRule {
  id: string; name: string; mailboxId: string; match: "all" | "any"; conditions: RuleCondition[]; actions: RuleAction[];
  enabled: boolean; position: number; runCount: number; lastRunAt: string | null; lastError: string | null; createdAt: string; updatedAt: string;
}
export interface MailRuleRun {
  id: string; messageId: string | null; from: string | null; subject: string | null; status: "ok" | "partial" | "failed" | "skipped";
  steps: { action: RuleActionKind; ok: boolean; detail?: string; skipped?: true }[]; createdAt: string;
}
export interface RuleInput { name: string; mailboxId: string; match: "all" | "any"; conditions: RuleCondition[]; actions: RuleAction[]; enabled: boolean }
export interface RuleTestResult { scanned: number; matched: number; sample: { id: string; from: string; subject: string; snippet: string; date: string }[] }

/** True when a rule sends mail (forward or saved reply): the phone shows it, turns it on or off and deletes it, nothing more. */
export const sendsMail = (r: { actions: { kind: string }[] }) => r.actions.some((a) => (SENDING_ACTIONS as string[]).includes(a.kind));
/** True when every action of the rule is one the phone can edit. */
export const phoneEditable = (r: { actions: { kind: string }[] }) => r.actions.every((a) => (PHONE_ACTIONS as string[]).includes(a.kind));

/** "From contains acme and Subject contains invoice" (sentence case, like the web). */
export function describeConditions(r: { match: "all" | "any"; conditions: RuleCondition[] }): string {
  const parts = r.conditions.map((c) => (fieldNeedsValue(c.field) ? `${fieldLabel(c.field).toLowerCase()} "${c.value}"` : fieldLabel(c.field).toLowerCase()));
  const s = parts.join(r.match === "any" ? " or " : " and ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function describeAction(a: RuleAction, tabName?: (id: string) => string | undefined): string {
  switch (a.kind) {
    case "label": return `Add the label ${a.label}`;
    case "move_to_tab": return `Move to ${tabName?.(a.tab) ?? a.tab}`;
    case "forward": return `Forward to ${a.to}`;
    case "auto_reply": return "Reply with a saved reply";
    default: return ACTION_LABEL[a.kind];
  }
}

/** "Add the label Invoices, then archive" */
export function describeActions(actions: RuleAction[], tabName?: (id: string) => string | undefined): string {
  return actions.map((a, i) => {
    const s = describeAction(a, tabName);
    return i === 0 ? s : s[0].toLowerCase() + s.slice(1);
  }).join(", then ");
}

/** The one line under a rule's name in the list. */
export function ruleSummary(r: MailRule, tabName?: (id: string) => string | undefined): string {
  const when = describeConditions(r);
  const then = describeActions(r.actions, tabName);
  return when && then ? `${when}: ${then[0].toLowerCase()}${then.slice(1)}` : when || then;
}

export interface RuleDraft { name: string; mailboxId: string; match: "all" | "any"; conditions: RuleCondition[]; actions: RuleAction[]; enabled: boolean }
export const emptyDraft = (mailboxId: string): RuleDraft => ({ name: "", mailboxId, match: "all", conditions: [{ field: "from", value: "" }], actions: [], enabled: true });
export const draftOf = (r: MailRule): RuleDraft => ({ name: r.name, mailboxId: r.mailboxId, match: r.match, conditions: r.conditions.map((c) => ({ ...c })), actions: r.actions.map((a) => ({ ...a })) as RuleAction[], enabled: r.enabled });

export interface DraftProblems { name?: string; conditions?: string; actions?: string; condition?: Record<number, string>; action?: Record<number, string> }

/** The same checks the server makes, in plain words, so the form says what is missing before it is sent. */
export function checkDraft(d: RuleDraft): DraftProblems {
  const p: DraftProblems = {};
  if (!d.name.trim()) p.name = "Name the rule.";
  else if (d.name.trim().length > RULE_NAME_MAX) p.name = `Keep the name under ${RULE_NAME_MAX} letters.`;
  if (!d.conditions.length) p.conditions = "Add at least one condition.";
  else if (d.conditions.length > RULE_CONDITIONS_MAX) p.conditions = `Up to ${RULE_CONDITIONS_MAX} conditions.`;
  d.conditions.forEach((c, i) => {
    const v = c.value.trim();
    if (fieldNeedsValue(c.field) && !v) (p.condition ??= {})[i] = "This condition needs a value.";
    else if (v.length > RULE_VALUE_MAX) (p.condition ??= {})[i] = "That is too long.";
  });
  if (!d.actions.length) p.actions = "Add at least one action.";
  else if (d.actions.length > RULE_ACTIONS_MAX) p.actions = `Up to ${RULE_ACTIONS_MAX} actions.`;
  const seen = new Set<string>();
  d.actions.forEach((a, i) => {
    if (a.kind !== "label" && a.kind !== "forward") {
      if (seen.has(a.kind)) (p.action ??= {})[i] = "This action is already in the rule.";
      seen.add(a.kind);
    }
    if (a.kind === "label") {
      const v = a.label.trim();
      if (!v) (p.action ??= {})[i] = "Name the label.";
      else if (v.length > LABEL_MAX) (p.action ??= {})[i] = `Keep labels under ${LABEL_MAX} letters.`;
      else if (/^tab:/i.test(v)) (p.action ??= {})[i] = "Pick another label name.";
    }
    if (a.kind === "move_to_tab" && !a.tab) (p.action ??= {})[i] = "Pick a tab.";
    if (!(PHONE_ACTIONS as string[]).includes(a.kind)) (p.action ??= {})[i] = "Change this action on the web.";
  });
  return p;
}
export const draftOk = (p: DraftProblems) => !p.name && !p.conditions && !p.actions && !p.condition && !p.action;

/** The request body for POST or PATCH /api/mail/rules: trimmed, with no value on "Has an attachment". */
export function toInput(d: RuleDraft): RuleInput {
  return {
    name: d.name.trim(), mailboxId: d.mailboxId, match: d.match, enabled: d.enabled,
    conditions: d.conditions.map((c) => ({ field: c.field, value: fieldNeedsValue(c.field) ? c.value.trim() : "" })),
    actions: d.actions.map((a) => (a.kind === "label" ? { kind: "label", label: a.label.trim() } : a)) as RuleAction[],
  };
}

/** A new action with sensible defaults (the first tab for Move to a tab). */
export function newAction(kind: RuleActionKind, firstTab = ""): RuleAction {
  switch (kind) {
    case "label": return { kind, label: "" };
    case "move_to_tab": return { kind, tab: firstTab };
    case "create_task": return { kind };
    case "forward": return { kind, to: "" };
    case "auto_reply": return { kind, snippetId: "" };
    default: return { kind } as RuleAction;
  }
}

/** A run's problem in plain words, or nothing when it went fine. */
export function runProblem(r: MailRuleRun): string | null {
  if (r.status === "ok") return null;
  const bad = r.steps.find((s) => !s.ok && !s.skipped);
  if (bad) return `${ACTION_LABEL[bad.action]} didn't work${bad.detail ? `: ${bad.detail}` : ""}`;
  if (r.status === "skipped") return "Skipped";
  return r.status === "partial" ? "Some steps didn't work" : "It didn't work";
}

// ---------------------------------------------------------------- snoozed

/** "Mon 8:00 am", "Tomorrow 8:00 am", "Today 4:30 pm": when a snoozed mail comes back. */
export function backLabel(dueAt: string, now = Date.now()): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const time = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (diff <= 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${time}`;
}
