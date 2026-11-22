/**
 * OPS1: the Billing section's calls and shared bits (types, plan, subscription, stage and Stripe event badges, an id
 * with a copy button). Lists go through DataTable; this file holds the workspace read and the actions.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { consoleGet } from "@/web/lib/console-api";
import { Card, CopyButton } from "@/web/components/ui/misc";
import { IconInfo } from "@/web/components/ui/icon";
import type { AddonQuantities, PlanId, PlanLimits } from "@/shared/plans";
import { Empty, StatusBadge, compPlanLabel, humanize, planLabel, type StatusTone } from "./components/format";

export interface BillingStatus { enabled: boolean; testMode: boolean; currency: string }

export interface SubscriptionRow {
  orgId: string; name: string; ownerEmail?: string | null; plan: PlanId; effectivePlan: PlanId; comp: boolean; compUntil: string | null; compNote: string | null;
  status: string | null; interval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  pastDue: boolean; stripeCustomerId: string | null; stripeSubscriptionId: string | null; createdAt: string;
}

export type DunningStage = "grace" | "paused" | "exempt";

export interface PastDueRow {
  orgId: string; name: string; ownerEmail?: string | null; plan: PlanId; effectivePlan: PlanId; comp: boolean; status: string | null;
  stage: DunningStage; pastDueSince: string | null; graceEndsAt: string | null; sendingPaused: boolean; daysPastDue: number;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null;
}

export interface BillingEventRow { id: string; type: string; orgId: string | null; orgName: string | null; ownerEmail?: string | null; summary: string | null; createdAt: string }

export interface ReferralRow {
  id: string; code: string; status: string; reason: string | null;
  referrerOrgId: string; referrerName: string | null; referrerOwnerEmail?: string | null;
  referredOrgId: string; referredName: string | null; referredOwnerEmail?: string | null;
  invoiceId: string | null; paidAt: string | null; eligibleAt: string | null; creditedAt: string | null;
  referrerCreditCents: number; referredCreditCents: number; createdAt: string;
}

export interface WorkspaceInvoice { id: string; number: string | null; status: string | null; total: number; currency: string; createdAt: string; periodStart: string; periodEnd: string }

export interface WorkspaceBilling {
  orgId: string; name: string; currency: string;
  billing: { enabled: boolean; testMode: boolean };
  plan: PlanId; effectivePlan: PlanId;
  comp: { on: boolean; until: string | null; note: string | null };
  stripe: { customerId: string | null; subscriptionId: string | null };
  subscription: { status: string | null; interval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean };
  dunning: { stage: DunningStage; pastDueSince: string | null; graceEndsAt: string | null; sendingPaused: boolean; daysPastDue: number } | null;
  addons: AddonQuantities;
  usage: { domains: number; mailboxes: number; agentInboxes: number; aliases: number; seats: number; storageMb: number; agentMessages: number; sendsToday: number };
  limits: PlanLimits;
  invoices: WorkspaceInvoice[]; invoicesError: string | null;
  recentEvents: BillingEventRow[];
  /** The credit the Stripe customer holds now (positive is credit); cents null without Stripe or a customer. */
  creditBalance?: { cents: number | null; currency: string | null; error: string | null };
  /** The last credits added from the console (platform audit rows). */
  recentCredits?: { at: string; actorUserId: string | null; actorEmail: string | null; reason: string | null; amountCents: number | null; note: string | null }[];
  bounds: { creditMinCents: number; creditMaxCents: number; trialDaysMax: number; graceDaysMax: number; compMaxDays: number; noteMax: number };
}

const base = (orgId: string) => `/console/billing/workspaces/${encodeURIComponent(orgId)}`;

export const billingApi = {
  status: () => consoleGet<BillingStatus>("/console/billing/status"),
  workspace: (orgId: string) => consoleGet<WorkspaceBilling>(base(orgId)),
  changePlan: (orgId: string, body: { plan: PlanId; reason: string }) => api.post<{ ok: true; pending: boolean; plan: PlanId }>(`${base(orgId)}/plan`, body),
  setComp: (orgId: string, body: { on: boolean; until?: string | null; note?: string | null; reason: string }) =>
    api.post<{ ok: true; comp: boolean; compUntil: string | null; warnings: string[] }>(`${base(orgId)}/comp`, body),
  addCredit: (orgId: string, body: { amountCents: number; note: string; reason: string; requestKey: string }) =>
    api.post<{ ok: true; transactionId: string; amountCents: number; currency: string; balanceCents: number }>(`${base(orgId)}/credit`, body),
  extendTrial: (orgId: string, body: { days: number; reason: string }) => api.post<{ ok: true; trialEnd: string }>(`${base(orgId)}/trial`, body),
  extendGrace: (orgId: string, body: { days: number; reason: string }) => api.post<{ ok: true; graceEndsAt: string | null }>(`${base(orgId)}/grace`, body),
  resync: (orgId: string, body: { reason: string }) => api.post<{ ok: true; outcome: "synced" | "deleted" | "comp_kept" | "no_subscription" }>(`${base(orgId)}/resync`, body),
  cancelAtPeriodEnd: (orgId: string, body: { on: boolean; reason: string }) => api.post<{ ok: true; cancelAtPeriodEnd: boolean }>(`${base(orgId)}/cancel-at-period-end`, body),
};

export const billingKeys = {
  status: ["console", "billing", "status"] as const,
  workspace: (orgId: string) => ["console", "billing", "workspace", orgId] as const,
};

/** A subscription status in plain words, in the console's shared colours (past due amber, ended grey). */
const SUBSCRIPTION_LABEL: Record<string, string> = {
  active: "Active", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid", incomplete: "Incomplete",
  incomplete_expired: "Expired", paused: "Paused", canceled: "Cancelled",
};

export function SubscriptionBadge({ status }: { status: string | null }) {
  if (!status) return <StatusBadge state="none" label="No subscription" tone="neutral" dot={false} />;
  const ended = status === "canceled" || status === "incomplete_expired";
  return <StatusBadge state={status} label={SUBSCRIPTION_LABEL[status] ?? humanize(status)} tone={ended ? "neutral" : undefined} />;
}

export const STAGE: Record<DunningStage, { label: string; tone: StatusTone }> = {
  grace: { label: "In grace period", tone: "warn" },
  paused: { label: "Sending paused", tone: "bad" },
  exempt: { label: "Free plan, not paused", tone: "neutral" },
};

/** Where a late payer is: in grace (sending on), sending paused, or exempt (a free plan is never paused). */
export function StageBadge({ stage }: { stage: DunningStage }) {
  return <StatusBadge state={stage} label={STAGE[stage].label} tone={STAGE[stage].tone} />;
}

/** Stripe's event types in plain words; the raw type stays in the badge's title. */
export const STRIPE_EVENT_TYPES = [
  ["invoice.paid", "Invoice paid"],
  ["invoice.payment_failed", "Payment failed"],
  ["customer.subscription.created", "Subscription created"],
  ["customer.subscription.updated", "Subscription updated"],
  ["customer.subscription.deleted", "Subscription ended"],
  ["checkout.session.completed", "Checkout completed"],
  ["charge.refunded", "Refund"],
] as const;
const STRIPE_EVENT_LABEL: Record<string, string> = Object.fromEntries(STRIPE_EVENT_TYPES);
const STRIPE_EVENT_TONE: Record<string, StatusTone> = {
  "invoice.paid": "ok", "invoice.payment_failed": "bad", "customer.subscription.deleted": "warn", "charge.refunded": "warn",
};

/** A Stripe event as a badge: a failed payment red, a paid invoice green, an ending or refund amber, the rest grey. */
export function StripeEventBadge({ type }: { type: string }) {
  return <StatusBadge state={type} label={STRIPE_EVENT_LABEL[type] ?? humanize(type)} tone={STRIPE_EVENT_TONE[type] ?? "neutral"} />;
}

/** The plan a workspace is on: "Pro", or "Free Business plan" (and what they still pay for) when it was given free. */
export function PlanCell({ plan, comp }: { plan: string; comp: boolean }) {
  if (!comp) return <span className="whitespace-nowrap">{planLabel(plan)}</span>;
  return (
    <span className="flex flex-col">
      <span className="whitespace-nowrap">{compPlanLabel("business")}</span>
      {plan !== "starter" && <span className="whitespace-nowrap text-xs text-subtle">still pays for {planLabel(plan)}</span>}
    </span>
  );
}

/** A Stripe or Multies id in mono with a short Copy button (`label` names it for the hover title). Never a whole object. */
export function IdCell({ id, label }: { id: string | null | undefined; label: string }) {
  if (!id) return <Empty />;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="truncate font-mono text-xs" title={`${label}: ${id}`}>{id}</span>
      <CopyButton value={id} label="Copy" />
    </span>
  );
}

/** "1250" cents typed as dollars ("12.50") back to whole cents, or null when it isn't a money amount. */
export function dollarsToCents(v: string): number | null {
  const t = v.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** A one-off key per dialog, so a retried credit is never applied twice. */
export function newRequestKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `ck_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether Stripe is connected here (undefined while loading). */
export function useBillingEnabled(): boolean | undefined {
  const status = useQuery({ queryKey: billingKeys.status, queryFn: billingApi.status, staleTime: 5 * 60_000 });
  return status.data?.enabled;
}

/**
 * The one notice that Stripe isn't connected here. On the Billing page it says lists still read; on a workspace
 * (`workspace`) it names what is left, since actions that need Stripe are hidden rather than shown disabled.
 */
export function BillingNotConnected({ workspace }: { workspace?: boolean }) {
  const enabled = useBillingEnabled();
  if (enabled !== false) return null;
  return (
    <Card className="flex items-start gap-3 border-warn/30 bg-warn-soft p-4 text-sm" role="status" data-testid="console-billing-not-connected">
      <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
      <p>
        <span className="font-medium">Billing isn't connected on this deployment.</span>{" "}
        {workspace
          ? "Invoices, plan changes, credits, trials, syncs and cancellations need Stripe, so they are hidden here. You can still give a free Business plan and extend a grace period."
          : "Lists show what is stored here. On each workspace, changes that need Stripe are hidden; free plans and grace periods still work."}
      </p>
    </Card>
  );
}
