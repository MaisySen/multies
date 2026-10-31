/**
 * R85: Inbox tab styles (Important and Other, or Primary, Updates and Promotions, or no tabs), and mail rules: conditions
 * on new mail with several actions run in order. Shared by the server (services/mail/rules-r85.ts, splits.ts) and the web.
 */
import { z } from "zod";

// ---------------------------------------------------------------- inbox tabs

export const TAB_STYLES = ["classic", "categories", "off"] as const;
export type TabStyle = (typeof TAB_STYLES)[number];
export const TAB_STYLE_LABEL: Record<TabStyle, string> = {
  classic: "Important and Other",
  categories: "Primary, Updates and Promotions",
  off: "No tabs",
};

/** Built in tab ids per style; the first is where Inbox opens. */
export const BUILT_IN_TABS: Record<Exclude<TabStyle, "off">, { id: string; name: string }[]> = {
  classic: [{ id: "important", name: "Important" }, { id: "other", name: "Other" }],
  categories: [{ id: "primary", name: "Primary" }, { id: "updates", name: "Updates" }, { id: "promotions", name: "Promotions" }],
};
export const CATEGORY_IDS = ["primary", "updates", "promotions"] as const;
export const BUILT_IN_IDS = ["important", "other", ...CATEGORY_IDS] as const;
export const isBuiltInTab = (id: string) => (BUILT_IN_IDS as readonly string[]).includes(id);
export const defaultTabOf = (style: TabStyle) => (style === "off" ? "" : BUILT_IN_TABS[style][0].id);

/** Most senders and threads a person can pin to a tab (oldest pins drop off first). */
export const PIN_SENDERS_MAX = 400;
export const PIN_THREADS_MAX = 200;
export interface TabPins { s: Record<string, string>; t: Record<string, string> }
export const emptyPins = (): TabPins => ({ s: {}, t: {} });

export function parsePins(raw: string | null | undefined): TabPins {
  if (!raw) return emptyPins();
  try {
    const v = JSON.parse(raw) as Partial<TabPins>;
    return { s: v && typeof v.s === "object" && v.s ? v.s : {}, t: v && typeof v.t === "object" && v.t ? v.t : {} };
  } catch {
    return emptyPins();
  }
}

/** Adds a pin, newest last; past the cap the oldest drop off. */
export function addPin(map: Record<string, string>, key: string, tab: string, max: number): Record<string, string> {
  const next = { ...map };
  delete next[key];
  next[key] = tab;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
  return next;
}

/** Promotions: marketing senders and offer words, unless the subject reads like a receipt, a code or an alert. */
export const PROMO_LOCAL_PARTS = ["marketing", "newsletter", "newsletters", "news", "promo", "promos", "promotions", "offers", "offer", "deals", "sales", "shop", "store", "email", "emails", "mailer", "campaigns", "hello", "hi", "community", "events"];
export const PROMO_WORDS = ["% off", "sale", "discount", "deal", "offer", "coupon", "promo", "free shipping", "limited time", "newsletter", "webinar", "black friday", "cyber monday", "save ", "new arrivals", "don't miss", "last chance", "exclusive"];
export const NOT_PROMO_WORDS = ["receipt", "invoice", "order", "shipped", "shipping update", "delivery", "delivered", "password", "verify", "verification", "code", "security", "sign in", "sign-in", "login", "statement", "payment", "booking", "confirm", "reminder", "alert", "ticket", "account"];

export interface CategoryInput { from: string; subject: string; isBulk: boolean | null }
/** The same rule the server runs in SQL (services/mail/splits.ts), for tests and the rule tester. */
export function categoryOf(m: CategoryInput, isRobot: (a: string) => boolean): "primary" | "updates" | "promotions" {
  const local = m.from.toLowerCase().split("@")[0] ?? "";
  const robot = isRobot(m.from) || local.startsWith("noreply") || local.startsWith("no-reply") || local.startsWith("notification");
  if (!m.isBulk && !robot) return "primary";
  const subject = m.subject.toLowerCase();
  const promo = (PROMO_LOCAL_PARTS.includes(local) || PROMO_WORDS.some((w) => subject.includes(w))) && !NOT_PROMO_WORDS.some((w) => subject.includes(w));
  return promo ? "promotions" : "updates";
}

export const TabStylePatch = z.object({ style: z.enum(TAB_STYLES) });
export const TabTeach = z.object({
  messageId: z.string().min(1).max(64),
  tab: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** Also send this sender's future mail to the tab (default true). */
  sender: z.boolean().optional().default(true),
});

// ---------------------------------------------------------------- mail rules

export const RULE_NAME_MAX = 80;
export const RULE_CONDITIONS_MAX = 10;
export const RULE_ACTIONS_MAX = 8;
export const RULES_MAX = 50;
export const RULE_VALUE_MAX = 200;
export const LABEL_MAX = 40;
export const RULE_TEST_SCAN = 200;
/** A rule that replies or forwards does that at most this many times a day. */
export const RULE_SENDS_PER_DAY = 50;

export const RULE_FIELDS = ["from", "to", "subject", "domain", "hasAttachment"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export const RULE_FIELD_LABEL: Record<RuleField, string> = {
  from: "From contains",
  to: "Sent to contains",
  subject: "Subject contains",
  domain: "From domain is",
  hasAttachment: "Has an attachment",
};
export const ruleFieldNeedsValue = (f: RuleField) => f !== "hasAttachment";

export const MailRuleCondition = z.object({
  field: z.enum(RULE_FIELDS),
  value: z.string().trim().max(RULE_VALUE_MAX).optional().default(""),
}).refine((c) => !ruleFieldNeedsValue(c.field) || c.value.length > 0, { message: "This condition needs a value." });
export type MailRuleConditionT = z.infer<typeof MailRuleCondition>;

export const RULE_ACTIONS = ["label", "move_to_tab", "mark_read", "archive", "star", "forward", "auto_reply", "create_task", "notify"] as const;
export type RuleActionKind = (typeof RULE_ACTIONS)[number];
export const RULE_ACTION_LABEL: Record<RuleActionKind, string> = {
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
/** Actions that send mail outside: they need a confirmed sender and have a daily cap. */
export const SENDING_ACTIONS: RuleActionKind[] = ["forward", "auto_reply"];

const email = z.string().trim().toLowerCase().email("Enter an email address.").max(254);
export const MailRuleAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), label: z.string().trim().min(1, "Name the label.").max(LABEL_MAX).refine((v) => !/^tab:/i.test(v), "Pick another label name.") }),
  z.object({ kind: z.literal("move_to_tab"), tab: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
  z.object({ kind: z.literal("mark_read") }),
  z.object({ kind: z.literal("archive") }),
  z.object({ kind: z.literal("star") }),
  z.object({ kind: z.literal("forward"), to: email }),
  z.object({ kind: z.literal("auto_reply"), snippetId: z.string().min(1, "Choose a saved reply.").max(64) }),
  z.object({ kind: z.literal("create_task"), projectId: z.string().max(64).optional(), priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(), dueInDays: z.number().int().min(0).max(365).optional() }),
  z.object({ kind: z.literal("notify") }),
]);
export type MailRuleActionT = z.infer<typeof MailRuleAction>;

export const MailRuleInput = z.object({
  name: z.string().trim().min(1, "Name the rule.").max(RULE_NAME_MAX),
  mailboxId: z.string().min(1).max(64),
  match: z.enum(["all", "any"]).optional().default("all"),
  conditions: z.array(MailRuleCondition).min(1, "Add at least one condition.").max(RULE_CONDITIONS_MAX),
  actions: z.array(MailRuleAction).min(1, "Add at least one action.").max(RULE_ACTIONS_MAX),
  enabled: z.boolean().optional().default(true),
});
export type MailRuleInputT = z.infer<typeof MailRuleInput>;
export const MailRulePatch = z.object({
  name: z.string().trim().min(1).max(RULE_NAME_MAX).optional(),
  mailboxId: z.string().min(1).max(64).optional(),
  match: z.enum(["all", "any"]).optional(),
  conditions: z.array(MailRuleCondition).min(1).max(RULE_CONDITIONS_MAX).optional(),
  actions: z.array(MailRuleAction).min(1).max(RULE_ACTIONS_MAX).optional(),
  enabled: z.boolean().optional(),
});
export const MailRuleTest = z.object({
  mailboxId: z.string().min(1).max(64),
  match: z.enum(["all", "any"]).optional().default("all"),
  conditions: z.array(MailRuleCondition).min(1).max(RULE_CONDITIONS_MAX),
});

export interface MailRule {
  id: string; name: string; mailboxId: string; match: "all" | "any"; conditions: MailRuleConditionT[]; actions: MailRuleActionT[];
  enabled: boolean; position: number; runCount: number; lastRunAt: string | null; lastError: string | null; createdAt: string; updatedAt: string;
}
export interface MailRuleRun { id: string; messageId: string | null; from: string | null; subject: string | null; status: "ok" | "partial" | "failed" | "skipped"; steps: { action: RuleActionKind; ok: boolean; detail?: string }[]; createdAt: string }

export interface RuleMessage { from: string; fromName?: string; to: string[]; subject: string; hasAttachments: boolean }

function conditionMatches(c: MailRuleConditionT, m: RuleMessage): boolean {
  const v = (c.value ?? "").trim().toLowerCase();
  const from = m.from.toLowerCase();
  switch (c.field) {
    case "from": return `${from} ${(m.fromName ?? "").toLowerCase()}`.includes(v);
    case "to": return m.to.some((a) => a.toLowerCase().includes(v));
    case "subject": return m.subject.toLowerCase().includes(v);
    case "domain": {
      const d = v.replace(/^@+/, "");
      const host = from.split("@")[1] ?? "";
      return host === d || host.endsWith(`.${d}`);
    }
    case "hasAttachment": return m.hasAttachments;
  }
}

/** True when the message meets the rule's conditions (all of them, or any one). */
export function ruleMatches(rule: { match: "all" | "any"; conditions: MailRuleConditionT[] }, m: RuleMessage): boolean {
  if (!rule.conditions.length) return false;
  return rule.match === "any" ? rule.conditions.some((c) => conditionMatches(c, m)) : rule.conditions.every((c) => conditionMatches(c, m));
}

/** "From contains acme and Subject contains invoice" */
export function describeConditions(rule: { match: "all" | "any"; conditions: MailRuleConditionT[] }): string {
  const parts = rule.conditions.map((c) => (ruleFieldNeedsValue(c.field) ? `${RULE_FIELD_LABEL[c.field].toLowerCase()} "${c.value}"` : RULE_FIELD_LABEL[c.field].toLowerCase()));
  return parts.join(rule.match === "any" ? " or " : " and ");
}
