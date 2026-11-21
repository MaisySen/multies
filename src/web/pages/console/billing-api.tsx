/**
 * OPS1: the Billing section's calls and shared bits (types, plan and status labels, a relative date, an id with a
 * copy button). Lists go through DataTable; this file holds the workspace read and the actions.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Badge, Card, CopyButton } from "@/web/components/ui/misc";
import { IconInfo } from "@/web/components/ui/icon";
import { PLANS, isPlanId, type AddonQuantities, type PlanId, type PlanLimits } from "@/shared/plans";

export interface BillingStatus { enabled: boolean; testMode: boolean; currency: string }

export interface SubscriptionRow {
  orgId: string; name: string; plan: PlanId; effectivePlan: PlanId; comp: boolean; compUntil: string | null; compNote: string | null;
  status: string | null; interval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  pastDue: boolean; stripeCustomerId: string | null; stripeSubscriptionId: string | null; createdAt: string;
}

export type DunningStage = "grace" | "paused" | "exempt";

export interface PastDueRow {
  orgId: string; name: string; plan: PlanId; effectivePlan: PlanId; comp: boolean; status: string | null;
  stage: DunningStage; pastDueSince: string | null; graceEndsAt: string | null; sendingPaused: boolean; daysPastDue: number;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null;
}

export interface BillingEventRow { id: string; type: string; orgId: string | null; orgName: string | null; summary: string | null; createdAt: string }

export interface ReferralRow {
  id: string; code: string; status: string; reason: string | null;
  referrerOrgId: string; referrerName: string | null; referredOrgId: string; referredName: string | null;
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
  bounds: { creditMinCents: number; creditMaxCents: number; trialDaysMax: number; graceDaysMax: number; compMaxDays: number; noteMax: number };
}

const base = (orgId: string) => `/console/billing/workspaces/${encodeURIComponent(orgId)}`;

export const billingApi = {
  status: () => api.get<BillingStatus>("/console/billing/status"),
  workspace: (orgId: string) => api.get<WorkspaceBilling>(base(orgId)),
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

export const planName = (p: string | null | undefined) => (isPlanId(p) ? PLANS[p].name : p ?? "None");

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  active: { label: "Active", tone: "ok" },
  trialing: { label: "Trial", tone: "ok" },
  past_due: { label: "Past due", tone: "bad" },
  unpaid: { label: "Unpaid", tone: "bad" },
  incomplete: { label: "Incomplete", tone: "warn" },
  incomplete_expired: { label: "Expired", tone: "neutral" },
  paused: { label: "Paused", tone: "warn" },
  canceled: { label: "Cancelled", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge>No subscription</Badge>;
  const s = STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as const };
  return <Badge tone={s.tone} dot className="whitespace-nowrap">{s.label}</Badge>;
}

export const STAGE: Record<DunningStage, { label: string; tone: "warn" | "bad" | "neutral" }> = {
  grace: { label: "In grace period", tone: "warn" },
  paused: { label: "Sending paused", tone: "bad" },
  exempt: { label: "Free plan, not paused", tone: "neutral" },
};

/** A relative date with the exact time on hover ("Not set" when empty). */
export function When({ at, empty = "Not set" }: { at: string | null | undefined; empty?: string }) {
  if (!at) return <span className="text-subtle">{empty}</span>;
  return <span className="whitespace-nowrap" title={fullDate(at)}>{timeAgo(at)}</span>;
}

/** A Stripe or Multies id in mono with a short Copy button (`label` names it for the hover title). Never a whole object. */
export function IdCell({ id, label }: { id: string | null | undefined; label: string }) {
  if (!id) return <span className="text-subtle">None</span>;
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

/** Says when Stripe isn't connected here: lists still read, Stripe actions are refused. Nothing while loading. */
export function BillingNotConnected() {
  const status = useQuery({ queryKey: billingKeys.status, queryFn: billingApi.status, staleTime: 5 * 60_000 });
  if (!status.data || status.data.enabled) return null;
  return (
    <Card className="flex items-start gap-3 border-warn/30 bg-warn-soft p-4 text-sm" role="status" data-testid="console-billing-not-connected">
      <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
      <p>
        <span className="font-medium">Billing isn't connected on this deployment.</span>{" "}
        Lists still show what is stored here, but plan changes, credits, trials, syncs and cancellations need Stripe and won't run. Free plans and grace periods still work.
      </p>
    </Card>
  );
}
