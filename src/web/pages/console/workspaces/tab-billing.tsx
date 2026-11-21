/**
 * OPS1: the Billing tab of a workspace's console page: plan and effective plan, free plan (comp), subscription and
 * payment state, add-ons, usage against limits, recent invoices and Stripe events, and the billing actions.
 * Stripe ids are shown as ids with a copy button; no Stripe object, invoice link or card detail is shown.
 */
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/web/lib/api";
import { formatBytes, num } from "@/web/lib/format";
import { Badge, Card, EmptyState, Meter, Skeleton, tableStyles as T } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconReceipt, IconWarning } from "@/web/components/ui/icon";
import { formatCents } from "@/shared/money";
import { ADDON_ORDER, ADDONS } from "@/shared/plans";
import { KvList } from "../components/kv-list";
import { usePermission } from "../guard";
import { WorkspaceBillingActions } from "../billing-actions";
import { BillingNotConnected, IdCell, STAGE, StatusBadge, When, billingApi, billingKeys, planName, type WorkspaceBilling } from "../billing-api";

const EVENT_LABEL: Record<string, string> = {
  "invoice.paid": "Invoice paid", "invoice.payment_failed": "Payment failed", "customer.subscription.created": "Subscription created",
  "customer.subscription.updated": "Subscription updated", "customer.subscription.deleted": "Subscription ended",
  "checkout.session.completed": "Checkout completed", "charge.refunded": "Refund",
};

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function UsageRow({ label, used, max, format = num }: { label: string; used: number; max: number; format?: (n: number) => string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">{format(used)} <span className="text-subtle">of {format(max)}</span></span>
      </div>
      <Meter value={used} max={max} label={`${label}: ${format(used)} of ${format(max)}`} />
    </div>
  );
}

const mb = (n: number) => formatBytes(n * 1024 * 1024);

function Summary({ b }: { b: WorkspaceBilling }) {
  const s = b.subscription;
  return (
    <KvList items={[
      { label: "Plan", value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{planName(b.effectivePlan)}</span>
          {b.plan !== b.effectivePlan && <span className="text-xs text-subtle">billed as {planName(b.plan)}</span>}
        </span>
      ) },
      { label: "Free Business plan", value: b.comp.on ? (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5"><Badge tone="brand">On</Badge>{b.comp.until ? <span className="text-xs text-muted">until <When at={b.comp.until} /></span> : <span className="text-xs text-muted">no end date</span>}</span>
          {b.comp.note && <span className="text-xs text-muted">{b.comp.note}</span>}
        </span>
      ) : <span className="text-muted">Off</span> },
      { label: "Subscription", value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={s.status} />
          {s.interval && <span className="text-xs text-muted">billed {s.interval === "year" ? "yearly" : "monthly"}</span>}
          {s.cancelAtPeriodEnd && <Badge tone="warn">Ends at period end</Badge>}
        </span>
      ) },
      { label: "Period ends", value: s.currentPeriodEnd ? <When at={s.currentPeriodEnd} /> : null },
      { label: "Payment", value: b.dunning ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STAGE[b.dunning.stage].tone} dot>{STAGE[b.dunning.stage].label}</Badge>
          <span className="text-xs text-muted">{b.dunning.daysPastDue} days past due, grace ends <When at={b.dunning.graceEndsAt} /></span>
        </span>
      ) : <Badge tone="ok" dot>Up to date</Badge> },
      { label: "Stripe customer", value: b.stripe.customerId ? <IdCell id={b.stripe.customerId} label="Stripe customer id" /> : null },
      { label: "Stripe subscription", value: b.stripe.subscriptionId ? <IdCell id={b.stripe.subscriptionId} label="Stripe subscription id" /> : null },
    ]} />
  );
}

function Addons({ b }: { b: WorkspaceBilling }) {
  const owned = ADDON_ORDER.filter((id) => (b.addons[id] ?? 0) > 0);
  if (!owned.length) return <p className="text-sm text-subtle">No add-ons.</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {owned.map((id) => <li key={id}><Badge>{b.addons[id]} x {ADDONS[id].name}</Badge></li>)}
    </ul>
  );
}

function Usage({ b }: { b: WorkspaceBilling }) {
  const u = b.usage;
  const l = b.limits;
  return (
    <Card className="grid gap-4 p-4 sm:grid-cols-2">
      <UsageRow label="Seats" used={u.seats} max={l.seats} />
      <UsageRow label="Mailboxes" used={u.mailboxes} max={l.mailboxes} />
      <UsageRow label="Domains" used={u.domains} max={l.domains} />
      <UsageRow label="Aliases" used={u.aliases} max={l.aliases} />
      <UsageRow label="Storage" used={u.storageMb} max={l.storageMb} format={mb} />
      <UsageRow label="Sends today" used={u.sendsToday} max={l.dailySends} />
      <UsageRow label="Agent inboxes" used={u.agentInboxes} max={l.agentInboxes} />
      <UsageRow label="Agent messages this month" used={u.agentMessages} max={l.agentMessagesMonthly} />
    </Card>
  );
}

function Invoices({ b }: { b: WorkspaceBilling }) {
  if (b.invoicesError) return <p className="text-sm text-warn">Couldn't read invoices from Stripe right now. Try again later.</p>;
  if (!b.invoices.length) return <Card className="p-0"><EmptyState icon={<IconReceipt />} title="No invoices" body={b.billing.enabled ? "Stripe has no invoices for this workspace." : "Billing isn't connected on this deployment."} /></Card>;
  return (
    <div className={T.wrap} tabIndex={0} role="region" aria-label="Recent invoices">
      <table className={T.table}>
        <thead className={T.head}><tr><th className={T.th}>Invoice</th><th className={T.th}>Date</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Total</th><th className={T.th}>Id</th></tr></thead>
        <tbody className={T.body}>
          {b.invoices.map((i) => (
            <tr key={i.id} className={T.row}>
              <td className={`${T.td} whitespace-nowrap`}>{i.number ?? "Draft"}</td>
              <td className={`${T.td} whitespace-nowrap`}><When at={i.createdAt} /></td>
              <td className={T.td}><Badge tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : i.status === "uncollectible" ? "bad" : "neutral"} dot>{i.status ?? "Unknown"}</Badge></td>
              <td className={`${T.td} text-right tabular-nums`}>{formatCents(i.total, i.currency)}</td>
              <td className={T.td}><IdCell id={i.id} label="invoice id" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Events({ b }: { b: WorkspaceBilling }) {
  if (!b.recentEvents.length) return <p className="text-sm text-subtle">No Stripe events for this workspace yet.</p>;
  return (
    <Card className="divide-y divide-line p-0">
      {b.recentEvents.map((e) => (
        <div key={e.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="min-w-0">
            <span className={e.type === "invoice.payment_failed" ? "font-medium text-bad" : "font-medium"}>{EVENT_LABEL[e.type] ?? e.type}</span>
            {e.summary && <span className="block text-xs text-muted">{e.summary}</span>}
          </span>
          <span className="shrink-0 text-xs text-subtle"><When at={e.createdAt} /></span>
        </div>
      ))}
    </Card>
  );
}

export function WorkspaceBillingTab({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: billingKeys.workspace(orgId), queryFn: () => billingApi.workspace(orgId) });
  if (q.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading billing">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  if (q.error) {
    return (
      <Card className="p-0">
        <EmptyState icon={<IconWarning />} title="Couldn't load billing" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} />
      </Card>
    );
  }
  const b = q.data;
  return <Loaded b={b} />;
}

function Loaded({ b }: { b: WorkspaceBilling }) {
  const canManage = usePermission("billing.manage");
  return (
    <div className="space-y-6" data-testid="console-billing-workspace">
      <BillingNotConnected />
      <Section title="Billing"><Summary b={b} /></Section>
      {canManage && <WorkspaceBillingActions b={b} />}
      <Section title="Add-ons"><Addons b={b} /></Section>
      <Section title="Usage against limits"><Usage b={b} /></Section>
      <Section title="Recent invoices" testId="console-billing-invoices"><Invoices b={b} /></Section>
      <Section title="Recent Stripe events"><Events b={b} /></Section>
    </div>
  );
}
