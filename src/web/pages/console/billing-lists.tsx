/**
 * OPS1: the five lists on /console/billing (Past due, Subscriptions, Stripe events, Comps, Referrals). Each is the
 * shared DataTable with its filters in the address bar; rows open the workspace's Billing tab.
 */
import { Link } from "react-router";
import { Badge } from "@/web/components/ui/misc";
import { IconActivity, IconCreditCard, IconShare, IconTag } from "@/web/components/ui/icon";
import { formatCents } from "@/shared/money";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import {
  IdCell, STAGE, StatusBadge, When, planName,
  type BillingEventRow, type PastDueRow, type ReferralRow, type SubscriptionRow,
} from "./billing-api";

const billingHref = (orgId: string) => `/console/workspaces/${encodeURIComponent(orgId)}/billing`;

function WorkspaceLink({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-subtle">No workspace</span>;
  return <Link to={`/console/workspaces/${encodeURIComponent(id)}`} className="font-medium text-fg hover:underline">{name ?? id}</Link>;
}

function PlanCell({ plan, effectivePlan, comp }: { plan: string; effectivePlan: string; comp: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span>{planName(effectivePlan)}</span>
      {comp && <Badge tone="brand">Free</Badge>}
      {plan !== effectivePlan && <span className="text-xs text-subtle">billed as {planName(plan)}</span>}
    </span>
  );
}

const PLAN_FILTER: FilterDef = {
  key: "plan", label: "Plan", initial: "",
  options: [{ value: "", label: "Any" }, { value: "starter", label: "Free" }, { value: "pro", label: "Pro" }, { value: "business", label: "Business" }],
};

export function PastDueList() {
  return (
    <DataTable<PastDueRow>
      label="Past due workspaces" path="/billing/past-due" defaultSort="pastDueSince:asc"
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={{ icon: <IconCreditCard />, title: "Nobody is behind on payment", body: "Workspaces with a failed payment show here with how long they have before sending is paused." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <WorkspaceLink id={r.orgId} name={r.name} /> },
        { key: "stage", header: "Stage", cell: (r) => <Badge tone={STAGE[r.stage].tone} dot className="whitespace-nowrap">{STAGE[r.stage].label}</Badge> },
        { key: "days", header: "Days past due", sort: "pastDueSince", align: "right", cell: (r) => <span className="tabular-nums">{r.daysPastDue}</span> },
        { key: "grace", header: "Grace ends", sort: "graceEndsAt", cell: (r) => <When at={r.graceEndsAt} /> },
        { key: "sending", header: "Sending", cell: (r) => (r.sendingPaused ? <Badge tone="bad" dot className="whitespace-nowrap">Paused</Badge> : <Badge tone="ok" dot className="whitespace-nowrap">On</Badge>) },
        { key: "plan", header: "Plan", cell: (r) => <PlanCell plan={r.plan} effectivePlan={r.effectivePlan} comp={r.comp} /> },
      ]}
    />
  );
}

export function SubscriptionsList() {
  return (
    <DataTable<SubscriptionRow>
      label="Subscriptions" path="/billing/subscriptions" defaultSort="createdAt:desc"
      search={{ placeholder: "Search by name, workspace id or Stripe id" }}
      filters={[
        { key: "status", label: "Status", initial: "", options: [
          { value: "", label: "Any" }, { value: "active", label: "Active" }, { value: "trialing", label: "Trial" },
          { value: "past_due", label: "Past due" }, { value: "canceled", label: "Cancelled" },
        ] },
        PLAN_FILTER,
        { key: "comp", label: "Free plan", initial: "", options: [{ value: "", label: "Any" }, { value: "true", label: "Given free" }, { value: "false", label: "Paying" }] },
      ]}
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={{ icon: <IconCreditCard />, title: "No subscriptions match", body: "Workspaces with a Stripe customer, a subscription or a free plan show here." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <WorkspaceLink id={r.orgId} name={r.name} /> },
        { key: "plan", header: "Plan", cell: (r) => <PlanCell plan={r.plan} effectivePlan={r.effectivePlan} comp={r.comp} /> },
        { key: "status", header: "Status", cell: (r) => (
          <span className="flex flex-wrap items-center gap-1.5"><StatusBadge status={r.status} />{r.cancelAtPeriodEnd && <Badge tone="warn" className="whitespace-nowrap">Ends at period end</Badge>}</span>
        ) },
        { key: "period", header: "Period ends", sort: "currentPeriodEnd", cell: (r) => <When at={r.currentPeriodEnd} empty="None" /> },
        { key: "customer", header: "Stripe customer", cell: (r) => <IdCell id={r.stripeCustomerId} label="Stripe customer id" /> },
      ]}
    />
  );
}

const EVENT_TYPES = [
  ["invoice.paid", "Invoice paid"],
  ["invoice.payment_failed", "Payment failed"],
  ["customer.subscription.created", "Subscription created"],
  ["customer.subscription.updated", "Subscription updated"],
  ["customer.subscription.deleted", "Subscription ended"],
  ["checkout.session.completed", "Checkout completed"],
  ["charge.refunded", "Refund"],
] as const;
const EVENT_LABEL: Record<string, string> = Object.fromEntries(EVENT_TYPES);

export function EventsList() {
  return (
    <DataTable<BillingEventRow>
      label="Stripe events" path="/billing/events" defaultSort="createdAt:desc"
      filters={[{ key: "type", label: "Type", initial: "", options: [{ value: "", label: "Any" }, ...EVENT_TYPES.map(([value, label]) => ({ value, label }))] }]}
      rowKey={(r) => r.id}
      empty={{ icon: <IconActivity />, title: "No Stripe events yet", body: "Each payment, subscription change or refund Stripe tells us about shows here." }}
      columns={[
        { key: "when", header: "When", sort: "createdAt", cell: (r) => <When at={r.createdAt} /> },
        { key: "type", header: "Type", cell: (r) => (
          <span className={r.type === "invoice.payment_failed" ? "font-medium text-bad" : "font-medium"}>{EVENT_LABEL[r.type] ?? r.type}</span>
        ) },
        { key: "summary", header: "Summary", cell: (r) => (r.summary ? <span className="line-clamp-2 max-w-sm">{r.summary}</span> : <span className="text-subtle">No summary</span>) },
        { key: "ws", header: "Workspace", cell: (r) => <WorkspaceLink id={r.orgId} name={r.orgName} /> },
        { key: "id", header: "Event id", cell: (r) => <IdCell id={r.id} label="event id" /> },
      ]}
    />
  );
}

export function CompsList() {
  return (
    <DataTable<SubscriptionRow>
      label="Free plans" path="/billing/subscriptions" params={{ comp: "true" }} defaultSort="createdAt:desc"
      search={{ placeholder: "Search by name or workspace id" }}
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={{ icon: <IconTag />, title: "No free plans given", body: "Workspaces an operator gave a free Business plan show here with the end date and note." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <WorkspaceLink id={r.orgId} name={r.name} /> },
        { key: "until", header: "Free until", cell: (r) => (r.compUntil ? <When at={r.compUntil} /> : <Badge>No end date</Badge>) },
        { key: "note", header: "Note", cell: (r) => (r.compNote ? <span className="line-clamp-2 max-w-sm">{r.compNote}</span> : <span className="text-subtle">No note</span>) },
        { key: "billing", header: "Still billed", cell: (r) => (
          r.status && ["active", "trialing", "past_due"].includes(r.status) ? <Badge tone="warn" dot>Yes, {planName(r.plan)}</Badge> : <Badge tone="ok" dot>No</Badge>
        ) },
      ]}
    />
  );
}

const REFERRAL_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  signed_up: { label: "Signed up", tone: "neutral" },
  pending: { label: "Waiting", tone: "warn" },
  credited: { label: "Credited", tone: "ok" },
  blocked: { label: "Blocked", tone: "bad" },
  void: { label: "Void", tone: "neutral" },
};

export function ReferralsList() {
  return (
    <DataTable<ReferralRow>
      label="Referrals" path="/billing/referrals" defaultSort="createdAt:desc"
      filters={[{ key: "status", label: "Status", initial: "", options: [{ value: "", label: "Any" }, ...Object.entries(REFERRAL_STATUS).map(([value, s]) => ({ value, label: s.label }))] }]}
      rowKey={(r) => r.id}
      empty={{ icon: <IconShare />, title: "No referrals yet", body: "When a workspace signs up with another's referral link it shows here." }}
      columns={[
        { key: "created", header: "Created", sort: "createdAt", cell: (r) => <When at={r.createdAt} /> },
        { key: "referrer", header: "Referred by", cell: (r) => <WorkspaceLink id={r.referrerOrgId} name={r.referrerName} /> },
        { key: "referred", header: "New workspace", cell: (r) => <WorkspaceLink id={r.referredOrgId} name={r.referredName} /> },
        { key: "status", header: "Status", cell: (r) => {
          const s = REFERRAL_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
          return <span title={r.reason ?? undefined}><Badge tone={s.tone} dot>{s.label}</Badge></span>;
        } },
        { key: "credit", header: "Credit each", align: "right", cell: (r) => (
          <span className="tabular-nums">{r.referrerCreditCents || r.referredCreditCents ? formatCents(Math.max(r.referrerCreditCents, r.referredCreditCents)) : "None"}</span>
        ) },
        { key: "credited", header: "Credited", sort: "creditedAt", cell: (r) => <When at={r.creditedAt} empty="Not yet" /> },
        { key: "invoice", header: "Invoice", cell: (r) => <IdCell id={r.invoiceId} label="invoice id" /> },
      ]}
    />
  );
}

