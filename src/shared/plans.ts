/**
 * Plans and add-ons. Prices are in Australian dollars, excluding GST (the Stripe
 * account is Australian).
 *
 * Pricing model (round 5): every business starts on Free, forever, and adds small
 * add-ons priced per business, never per person. The old Pro and Business plans are
 * kept for the customers already on them ("legacy"), with their limits unchanged, and
 * are no longer sold.
 *
 * Multies never pays for AI model calls ("bring your own AI"): the assistant runs on the
 * workspace's own API key, and people connect Claude, ChatGPT or any agent through MCP.
 */
export const PRICE_CURRENCY = "aud";

/** "A$12" or "A$1.50": the A$ prefix keeps the currency clear to visitors outside Australia. */
export const formatPlanPrice = (amount: number) =>
  `A$${new Intl.NumberFormat("en-AU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount)}`;
export const PRICE_LABEL = "AUD";

export type PlanId = "starter" | "pro" | "business";

export interface PlanLimits {
  domains: number;
  mailboxes: number;
  aliases: number;
  /** The most one mailbox can hold. */
  storagePerMailboxMb: number;
  /** Storage shared by every mailbox in the workspace. */
  storageMb: number;
  dailySends: number;
  /** People who can sign in to the workspace (owner included). */
  seats: number;
  /** Inboxes that AI agents use through the API and MCP. */
  agentInboxes: number;
  /** Messages agents can send per calendar month, across all agent inboxes. */
  agentMessagesMonthly: number;
  /** Messages one agent inbox can send per day. */
  agentDailySends: number;
  /** Automation runs a calendar month (email rules, status rules, due date reminders). */
  automationRunsMonthly: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthly: number;
  limits: PlanLimits;
  features: string[];
  /** No longer sold. Existing subscriptions keep working with these limits. */
  legacy?: boolean;
  highlighted?: boolean;
}

const GB = 1024;

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Free",
    tagline: "For startups and small businesses. Free forever.",
    priceMonthly: 0,
    limits: {
      domains: 1, mailboxes: 3, aliases: 10, storagePerMailboxMb: 3 * GB, storageMb: 3 * GB, dailySends: 100, seats: 3,
      agentInboxes: 3, agentMessagesMonthly: 3000, agentDailySends: 100, automationRunsMonthly: 1000,
    },
    features: [
      "1 custom domain",
      "3 mailboxes and 3 people",
      "Tasks, boards, docs and contacts, with 1,000 automation runs a month",
      "Team chat, goals, templates and repeating tasks",
      "3 GB shared storage",
      "Outlook, Apple Mail and phone access (IMAP and SMTP)",
      "Bring your own AI: connect Claude, ChatGPT or any agent through MCP, free.",
      "3 agent inboxes with API and MCP access",
      "Free import from Gmail or Outlook",
    ],
    highlighted: true,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Legacy plan. Still supported for existing customers.",
    priceMonthly: 12,
    legacy: true,
    limits: {
      domains: 5, mailboxes: 25, aliases: 200, storagePerMailboxMb: 10 * GB, storageMb: 250 * GB, dailySends: 2000, seats: 10,
      agentInboxes: 10, agentMessagesMonthly: 10_000, agentDailySends: 500, automationRunsMonthly: 10_000,
    },
    features: ["5 custom domains", "25 mailboxes", "10 GB per mailbox", "2,000 sends a day", "10 people", "Tasks, boards, docs and contacts", "Bring your own AI"],
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "Legacy plan. Still supported for existing customers.",
    priceMonthly: 49,
    legacy: true,
    limits: {
      domains: 50, mailboxes: 250, aliases: 5000, storagePerMailboxMb: 50 * GB, storageMb: 2500 * GB, dailySends: 20_000, seats: 100,
      agentInboxes: 50, agentMessagesMonthly: 50_000, agentDailySends: 2000, automationRunsMonthly: 50_000,
    },
    features: ["50 custom domains", "250 mailboxes", "50 GB per mailbox", "20,000 sends a day", "100 people", "Tasks, boards, docs and contacts", "Bring your own AI"],
  },
};

export const PLAN_ORDER: PlanId[] = ["starter", "pro", "business"];
/** Plans a new customer can choose. */
export const PUBLIC_PLANS: PlanId[] = ["starter"];

export function isPlanId(v: unknown): v is PlanId {
  return v === "starter" || v === "pro" || v === "business";
}

// ---------------------------------------------------------------- add-ons

export type AddonId = "domain" | "storage" | "mailboxes" | "send_boost" | "agent_inbox";

export interface Addon {
  id: AddonId;
  name: string;
  /** AUD a month for one unit. */
  priceMonthly: number;
  /** What one unit is, for "A$1 a month per domain". */
  unit: string;
  description: string;
  /** What one unit adds to the plan's limits. */
  grants: Partial<PlanLimits>;
  maxQuantity: number;
}

export const ADDONS: Record<AddonId, Addon> = {
  domain: {
    id: "domain", name: "Extra domain", priceMonthly: 1, unit: "domain",
    description: "One more custom domain with its own DKIM key.",
    grants: { domains: 1 }, maxQuantity: 50,
  },
  storage: {
    id: "storage", name: "Storage pack", priceMonthly: 2, unit: "20 GB",
    description: "20 GB more storage, shared by every mailbox.",
    grants: { storageMb: 20 * GB, storagePerMailboxMb: 20 * GB }, maxQuantity: 50,
  },
  mailboxes: {
    id: "mailboxes", name: "Mailbox pack", priceMonthly: 3, unit: "5 mailboxes",
    description: "5 more mailboxes and 5 more people.",
    grants: { mailboxes: 5, seats: 5, aliases: 50 }, maxQuantity: 40,
  },
  send_boost: {
    id: "send_boost", name: "Send boost", priceMonthly: 2, unit: "1,000 sends a day",
    description: "1,000 more recipients a day to addresses outside Multies.",
    grants: { dailySends: 1000 }, maxQuantity: 20,
  },
  agent_inbox: {
    id: "agent_inbox", name: "Agent inbox", priceMonthly: 1, unit: "inbox",
    description: "One more inbox for an AI agent, with 1,000 more agent messages a month.",
    grants: { agentInboxes: 1, agentMessagesMonthly: 1000 }, maxQuantity: 100,
  },
};

export const ADDON_ORDER: AddonId[] = ["domain", "mailboxes", "storage", "send_boost", "agent_inbox"];

export function isAddonId(v: unknown): v is AddonId {
  return typeof v === "string" && v in ADDONS;
}

export type AddonQuantities = Partial<Record<AddonId, number>>;

/** A plan's limits with add-ons on top. */
export function effectiveLimits(plan: Plan, addons: AddonQuantities = {}): PlanLimits {
  const out = { ...plan.limits };
  for (const id of ADDON_ORDER) {
    const qty = addons[id] ?? 0;
    if (!qty) continue;
    for (const [k, v] of Object.entries(ADDONS[id].grants) as [keyof PlanLimits, number][]) out[k] += v * qty;
  }
  return out;
}

/**
 * Card fees make tiny monthly charges poor value (1.7 percent plus A$0.30 a charge in
 * Australia), so a subscription whose add-ons total less than this a month is billed
 * once a year at twelve times the monthly price.
 */
export const YEARLY_BELOW_MONTHLY = 5;

export type BillingInterval = "month" | "year";

/** Total a month for a set of add-ons, in AUD. */
export function addonsMonthlyTotal(addons: AddonQuantities): number {
  return ADDON_ORDER.reduce((sum, id) => sum + ADDONS[id].priceMonthly * (addons[id] ?? 0), 0);
}

/** How a set of add-ons is billed: yearly under A$5 a month (with no legacy plan), else monthly. */
export function intervalFor(addons: AddonQuantities, basePlanMonthly = 0): BillingInterval {
  const total = basePlanMonthly + addonsMonthlyTotal(addons);
  return total > 0 && total < YEARLY_BELOW_MONTHLY ? "year" : "month";
}

/** What the customer pays per interval, in AUD. */
export function chargeFor(addons: AddonQuantities, basePlanMonthly = 0) {
  const monthly = basePlanMonthly + addonsMonthlyTotal(addons);
  const interval = intervalFor(addons, basePlanMonthly);
  return { interval, amount: interval === "year" ? monthly * 12 : monthly, monthly };
}

export const addonLookupKey = (id: AddonId, interval: BillingInterval) => `mymail_addon_${id}_${interval === "year" ? "yearly" : "monthly"}`;
