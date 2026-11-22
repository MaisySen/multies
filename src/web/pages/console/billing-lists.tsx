/**
 * OPS1: the five lists on /console/billing (Past due, Subscriptions, Stripe events, Free plans, Referrals). Each is the
 * shared DataTable with its filters in the address bar; rows open the workspace's Billing tab.
 */
import { useSearchParams } from "react-router";
import { IconActivity, IconCreditCard, IconShare, IconTag } from "@/web/components/ui/icon";
import { formatCents } from "@/shared/money";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Day, Empty, EMPTY, RelTime, StatusBadge, WorkspaceLink, humanize, planLabel, workspaceHint, type StatusTone } from "./components/format";
import {
  IdCell, PlanCell, STRIPE_EVENT_TYPES, StageBadge, StripeEventBadge, SubscriptionBadge,
  type BillingEventRow, type PastDueRow, type ReferralRow, type SubscriptionRow,
} from "./billing-api";

const billingHref = (orgId: string) => `/console/workspaces/${encodeURIComponent(orgId)}/billing`;

const Workspace = ({ id, name, ownerEmail }: { id: string | null; name: string | null; ownerEmail?: string | null }) => <WorkspaceLink id={id} name={name} hint={workspaceHint(id, ownerEmail)} />;

/** Whether the address narrows the list (a search or any of `keys`), so the empty state can say "match" or "yet". */
function useNarrowed(keys: string[]): boolean {
  const [params] = useSearchParams();
  return ["q", ...keys].some((k) => !!params.get(k));
}

const PLAN_FILTER: FilterDef = {
  key: "plan", label: "Plan", initial: "",
  options: [{ value: "", label: "Any" }, { value: "starter", label: planLabel("starter") }, { value: "pro", label: planLabel("pro") }, { value: "business", label: planLabel("business") }],
};

export function PastDueList() {
  return (
    <DataTable<PastDueRow>
      label="Past due workspaces" path="/billing/past-due" defaultSort="pastDueSince:asc"
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={{ icon: <IconCreditCard />, title: "Nobody is behind on payment", body: "Workspaces with a failed payment show here with how long they have before sending is paused." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <Workspace id={r.orgId} name={r.name} ownerEmail={r.ownerEmail} /> },
        // The stage already says whether sending is paused, so there is no separate Sending column.
        { key: "stage", header: "Stage", cell: (r) => <StageBadge stage={r.stage} /> },
        { key: "days", header: "Days past due", sort: "pastDueSince", align: "right", cell: (r) => <span className="tabular-nums">{r.daysPastDue}</span> },
        { key: "grace", header: "Grace ends", sort: "graceEndsAt", cell: (r) => <RelTime at={r.graceEndsAt} /> },
        { key: "plan", header: "Plan", secondary: true, cell: (r) => <PlanCell plan={r.plan} comp={r.comp} /> },
      ]}
    />
  );
}

export function SubscriptionsList() {
  const narrowed = useNarrowed(["status", "plan", "comp"]);
  return (
    <DataTable<SubscriptionRow>
      label="Subscriptions" path="/billing/subscriptions" defaultSort="createdAt:desc"
      search={{ placeholder: "Search subscriptions" }}
      filters={[
        { key: "status", label: "Status", initial: "", options: [
          { value: "", label: "Any" }, { value: "active", label: "Active" }, { value: "trialing", label: "Trial" },
          { value: "past_due", label: "Past due" }, { value: "canceled", label: "Cancelled" },
        ] },
        PLAN_FILTER,
        { key: "comp", label: "Free plan", initial: "", options: [{ value: "", label: "Any" }, { value: "true", label: "Given free" }, { value: "false", label: "Paying" }] },
      ]}
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={narrowed
        ? { icon: <IconCreditCard />, title: "No subscriptions match", body: "Try another search or clear the filters." }
        : { icon: <IconCreditCard />, title: "No subscriptions yet", body: "Workspaces with a Stripe customer, a subscription or a free plan show here." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <Workspace id={r.orgId} name={r.name} ownerEmail={r.ownerEmail} /> },
        { key: "plan", header: "Plan", cell: (r) => <PlanCell plan={r.plan} comp={r.comp} /> },
        { key: "status", header: "Status", cell: (r) => (
          <span className="flex flex-wrap items-center gap-1.5"><SubscriptionBadge status={r.status} />{r.cancelAtPeriodEnd && <StatusBadge state="ending" label="Ends at period end" tone="warn" dot={false} />}</span>
        ) },
        { key: "period", header: "Period ends", sort: "currentPeriodEnd", cell: (r) => <RelTime at={r.currentPeriodEnd} /> },
        { key: "customer", header: "Stripe customer", secondary: true, cell: (r) => <IdCell id={r.stripeCustomerId} label="Stripe customer id" /> },
      ]}
    />
  );
}

export function EventsList() {
  const narrowed = useNarrowed(["type"]);
  return (
    <DataTable<BillingEventRow>
      label="Stripe events" path="/billing/events" defaultSort="createdAt:desc"
      filters={[{ key: "type", label: "Type", initial: "", options: [{ value: "", label: "Any" }, ...STRIPE_EVENT_TYPES.map(([value, label]) => ({ value, label }))] }]}
      rowKey={(r) => r.id}
      empty={narrowed
        ? { icon: <IconActivity />, title: "No Stripe events of this type", body: "Pick Any to see every event." }
        : { icon: <IconActivity />, title: "No Stripe events yet", body: "Each payment, subscription change or refund Stripe tells us about shows here." }}
      columns={[
        { key: "when", header: "When", sort: "createdAt", cell: (r) => <RelTime at={r.createdAt} /> },
        { key: "type", header: "Type", cell: (r) => <StripeEventBadge type={r.type} /> },
        { key: "summary", header: "Summary", cell: (r) => (r.summary ? <span className="line-clamp-2 max-w-sm">{r.summary}</span> : <Empty />) },
        { key: "ws", header: "Workspace", cell: (r) => <Workspace id={r.orgId} name={r.orgName} ownerEmail={r.ownerEmail} /> },
        { key: "details", header: "", secondary: true, cell: (r) => (
          <details className="text-xs" data-testid="console-billing-event-details">
            <summary className="cursor-pointer select-none text-muted hover:text-fg">Details</summary>
            <span className="mt-1 block"><IdCell id={r.id} label="Stripe event id" /></span>
          </details>
        ) },
      ]}
    />
  );
}

export function CompsList() {
  return (
    <DataTable<SubscriptionRow>
      label="Free plans" path="/billing/subscriptions" params={{ comp: "true" }} defaultSort="createdAt:desc"
      search={{ placeholder: "Search free plans" }}
      rowKey={(r) => r.orgId} rowHref={(r) => billingHref(r.orgId)}
      empty={{ icon: <IconTag />, title: "No free plans given", body: "Workspaces an operator gave a free Business plan show here with the end date and note." }}
      columns={[
        { key: "name", header: "Workspace", sort: "name", cell: (r) => <Workspace id={r.orgId} name={r.name} ownerEmail={r.ownerEmail} /> },
        { key: "until", header: "Free until", cell: (r) => (r.compUntil ? <Day at={r.compUntil} /> : <Empty>No end date</Empty>) },
        { key: "note", header: "Note", secondary: true, cell: (r) => (r.compNote ? <span className="line-clamp-2 max-w-sm">{r.compNote}</span> : <Empty />) },
        { key: "billing", header: "Still billed", cell: (r) => (
          r.status && ["active", "trialing", "past_due"].includes(r.status)
            ? <StatusBadge state="billed" label={`Yes, ${planLabel(r.plan)}`} tone="warn" />
            : <StatusBadge state="not_billed" label="No" tone="ok" />
        ) },
      ]}
    />
  );
}

const REFERRAL_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  signed_up: { label: "Signed up", tone: "neutral" },
  pending: { label: "Waiting", tone: "warn" },
  credited: { label: "Credited", tone: "ok" },
  blocked: { label: "Blocked", tone: "bad" },
  void: { label: "Void", tone: "neutral" },
};

export function ReferralsList() {
  const narrowed = useNarrowed(["status"]);
  return (
    <DataTable<ReferralRow>
      label="Referrals" path="/billing/referrals" defaultSort="createdAt:desc"
      filters={[{ key: "status", label: "Status", initial: "", options: [{ value: "", label: "Any" }, ...Object.entries(REFERRAL_STATUS).map(([value, s]) => ({ value, label: s.label }))] }]}
      rowKey={(r) => r.id}
      empty={narrowed
        ? { icon: <IconShare />, title: "No referrals in this state", body: "Pick Any to see every referral." }
        : { icon: <IconShare />, title: "No referrals yet", body: "When a workspace signs up with another's referral link it shows here." }}
      columns={[
        { key: "created", header: "Created", sort: "createdAt", cell: (r) => <RelTime at={r.createdAt} /> },
        { key: "referrer", header: "Referred by", cell: (r) => <Workspace id={r.referrerOrgId} name={r.referrerName} ownerEmail={r.referrerOwnerEmail} /> },
        { key: "referred", header: "New workspace", cell: (r) => <Workspace id={r.referredOrgId} name={r.referredName} ownerEmail={r.referredOwnerEmail} /> },
        { key: "status", header: "Status", cell: (r) => {
          const s = REFERRAL_STATUS[r.status] ?? { label: humanize(r.status), tone: "neutral" as const };
          return <span title={r.reason ?? undefined}><StatusBadge state={r.status} label={s.label} tone={s.tone} /></span>;
        } },
        { key: "credit", header: "Credit each", align: "right", cell: (r) => (
          <span className="tabular-nums">{r.referrerCreditCents || r.referredCreditCents ? formatCents(Math.max(r.referrerCreditCents, r.referredCreditCents)) : EMPTY}</span>
        ) },
        { key: "credited", header: "Credited", sort: "creditedAt", secondary: true, cell: (r) => <RelTime at={r.creditedAt} empty="Not yet" /> },
        { key: "invoice", header: "Invoice", secondary: true, cell: (r) => <IdCell id={r.invoiceId} label="invoice id" /> },
      ]}
    />
  );
}
