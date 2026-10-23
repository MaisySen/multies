/** Plan prices are in Australian dollars (the Stripe account is Australian). */
export const PRICE_CURRENCY = "aud";

/** "$12" in en-AU; pair it with PRICE_LABEL so the currency is never ambiguous. */
export const formatPlanPrice = (amount: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(amount);
export const PRICE_LABEL = "AUD";

export type PlanId = "starter" | "pro" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthly: number;
  limits: {
    domains: number;
    mailboxes: number;
    aliases: number;
    storagePerMailboxMb: number;
    dailySends: number;
    /** People who can sign in to the workspace (owner included). */
    seats: number;
  };
  features: string[];
  highlighted?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "For a personal domain or side project.",
    priceMonthly: 0,
    limits: { domains: 1, mailboxes: 3, aliases: 10, storagePerMailboxMb: 1024, dailySends: 100, seats: 2 },
    features: ["1 custom domain", "3 mailboxes", "10 aliases & forwards", "1 GB per mailbox", "100 sends / day", "2 team seats", "DNS health checks"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For founders and small teams.",
    priceMonthly: 12,
    limits: { domains: 5, mailboxes: 25, aliases: 200, storagePerMailboxMb: 10240, dailySends: 2000, seats: 10 },
    features: ["5 custom domains", "25 mailboxes", "200 aliases & forwards", "10 GB per mailbox", "2,000 sends / day", "10 team seats", "Delivery logs & audit trail"],
    highlighted: true,
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "For companies running on email.",
    priceMonthly: 49,
    limits: { domains: 50, mailboxes: 250, aliases: 5000, storagePerMailboxMb: 51200, dailySends: 20000, seats: 100 },
    features: ["50 custom domains", "250 mailboxes", "Unlimited-feel aliases", "50 GB per mailbox", "20,000 sends / day", "100 team seats", "Priority support"],
  },
};

export const PLAN_ORDER: PlanId[] = ["starter", "pro", "business"];

export function isPlanId(v: unknown): v is PlanId {
  return v === "starter" || v === "pro" || v === "business";
}
