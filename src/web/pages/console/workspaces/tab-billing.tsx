/**
 * OPS1: the Billing tab of a workspace's console page: plan, free plan (comp), subscription and payment state,
 * add-ons, recent invoices and Stripe events, and the billing actions. Usage against limits lives on the Usage tab
 * (one link here). Stripe ids are shown as ids with a copy button; no Stripe object, invoice link or card detail.
 * Without Stripe one notice says so, and the invoices and the actions that need Stripe are hidden.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Badge, Skeleton, tableStyles as T } from "@/web/components/ui/misc";
import { formatCents } from "@/shared/money";
import { ADDON_ORDER, ADDONS } from "@/shared/plans";
import { cn } from "@/web/lib/cn";
import { KvList } from "../components/kv-list";
import { consoleTable } from "../components/data-table";
import { Day, EmptyRow, LoadError, RelTime, StatusBadge, compPlanLabel, humanize, planLabel } from "../components/format";
import { usePermission } from "../guard";
import { WorkspaceBillingActions } from "../billing-actions";
import { BillingNotConnected, IdCell, StageBadge, StripeEventBadge, SubscriptionBadge, billingApi, billingKeys, type WorkspaceBilling } from "../billing-api";

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Summary({ b }: { b: WorkspaceBilling }) {
  const s = b.subscription;
  return (
    <KvList items={[
      { label: "Plan", value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{b.comp.on ? compPlanLabel("business") : planLabel(b.effectivePlan)}</span>
          {b.comp.on && b.plan !== "starter" && <span className="text-xs text-subtle">still pays for {planLabel(b.plan)}</span>}
        </span>
      ) },
      { label: "Free Business plan", value: b.comp.on ? (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge state="on" label="On" tone="brand" />
            <span className="text-xs text-muted">{b.comp.until ? <>until <Day at={b.comp.until} /></> : "no end date"}</span>
          </span>
          {b.comp.note && <span className="text-xs text-muted">{b.comp.note}</span>}
        </span>
      ) : <span className="text-muted">Off</span> },
      { label: "Subscription", value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <SubscriptionBadge status={s.status} />
          {s.interval && <span className="text-xs text-muted">billed {s.interval === "year" ? "yearly" : "monthly"}</span>}
          {s.cancelAtPeriodEnd && <StatusBadge state="ending" label="Ends at period end" tone="warn" dot={false} />}
        </span>
      ) },
      { label: "Period ends", value: s.currentPeriodEnd ? <Day at={s.currentPeriodEnd} /> : null },
      { label: "Payment", value: b.dunning ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <StageBadge stage={b.dunning.stage} />
          <span className="text-xs text-muted">{b.dunning.daysPastDue} days past due, grace ends <RelTime at={b.dunning.graceEndsAt} /></span>
        </span>
      ) : <StatusBadge state="ok" label="Up to date" /> },
      { label: "Stripe customer", value: b.stripe.customerId ? <IdCell id={b.stripe.customerId} label="Stripe customer id" /> : null },
      { label: "Stripe subscription", value: b.stripe.subscriptionId ? <IdCell id={b.stripe.subscriptionId} label="Stripe subscription id" /> : null },
    ]} />
  );
}

function Addons({ b }: { b: WorkspaceBilling }) {
  const owned = ADDON_ORDER.filter((id) => (b.addons[id] ?? 0) > 0);
  if (!owned.length) return <EmptyRow>No add-ons.</EmptyRow>;
  return (
    <ul className="flex flex-wrap gap-2">
      {owned.map((id) => <li key={id}><Badge>{b.addons[id]} x {ADDONS[id].name}</Badge></li>)}
    </ul>
  );
}


function Invoices({ b }: { b: WorkspaceBilling }) {
  if (b.invoicesError) return <EmptyRow className="text-warn">Couldn't read invoices from Stripe right now. Try again later.</EmptyRow>;
  if (!b.invoices.length) return <EmptyRow>Stripe has no invoices for this workspace.</EmptyRow>;
  return (
    <div className={consoleTable.wrap} tabIndex={0} role="region" aria-label="Recent invoices">
      <table className={consoleTable.table}>
        <thead className={T.head}>
          <tr>
            <th className={T.th}>Invoice</th><th className={T.th}>Date</th><th className={T.th}>Status</th>
            <th className={cn(T.th, "text-right")}>Total</th><th className={cn(T.th, consoleTable.secondary)}>Id</th>
          </tr>
        </thead>
        <tbody className={T.body}>
          {b.invoices.map((i) => (
            <tr key={i.id} className={T.row}>
              <td className={cn(T.td, "whitespace-nowrap")}>{i.number ?? "Draft"}</td>
              <td className={T.td}><Day at={i.createdAt} /></td>
              <td className={T.td}><StatusBadge state={i.status ?? "unknown"} label={i.status ? humanize(i.status) : "Unknown"} /></td>
              <td className={cn(T.td, "text-right tabular-nums")}>{formatCents(i.total, i.currency)}</td>
              <td className={cn(T.td, consoleTable.secondary)}><IdCell id={i.id} label="invoice id" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Events({ b }: { b: WorkspaceBilling }) {
  if (!b.recentEvents.length) return <EmptyRow>No Stripe events for this workspace yet.</EmptyRow>;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {b.recentEvents.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="flex min-w-0 flex-col items-start gap-1">
            <StripeEventBadge type={e.type} />
            {e.summary && <span className="text-xs text-muted">{e.summary}</span>}
          </span>
          <span className="shrink-0 text-xs text-subtle"><RelTime at={e.createdAt} /></span>
        </li>
      ))}
    </ul>
  );
}

export function WorkspaceBillingTab({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: billingKeys.workspace(orgId), queryFn: () => billingApi.workspace(orgId) });
  if (q.isPending) {
    return (
      <div role="status" className="space-y-4" aria-busy="true" aria-label="Loading billing">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  if (q.error) return <LoadError error={q.error} what="billing" retry={() => void q.refetch()} />;
  return <Loaded b={q.data} />;
}

function Loaded({ b }: { b: WorkspaceBilling }) {
  const canManage = usePermission("billing.manage");
  const stripeOn = b.billing.enabled;
  return (
    <div className="space-y-6" data-testid="console-billing-workspace">
      {!stripeOn && <BillingNotConnected workspace />}
      <Section title="Billing"><Summary b={b} /></Section>
      {canManage && <WorkspaceBillingActions b={b} />}
      <Section title="Add-ons"><Addons b={b} /></Section>
      <p className="text-sm text-muted" data-testid="console-billing-usage-link">
        Usage against the plan's limits is on the{" "}
        <Link to={`/console/workspaces/${encodeURIComponent(b.orgId)}/usage`} className="font-medium text-fg underline-offset-2 hover:underline">Usage tab</Link>.
      </p>
      {stripeOn && <Section title="Recent invoices" testId="console-billing-invoices"><Invoices b={b} /></Section>}
      <Section title="Recent Stripe events"><Events b={b} /></Section>
    </div>
  );
}
