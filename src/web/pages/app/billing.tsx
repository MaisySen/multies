import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CreditCard, ExternalLink, FileText, PlugZap, Receipt } from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { PLAN_ORDER, PLANS, type Plan, type PlanId, PRICE_LABEL, formatPlanPrice } from "@/shared/plans";
import { Badge, Card, EmptyState, Meter, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/cn";
import { Section } from "./settings";
import { LOCALE } from "@/shared/locale";
import { tz } from "@/web/lib/format";

interface BillingInfo {
  enabled: boolean;
  missing: string[];
  testMode: boolean;
  webhooks: boolean;
  plan: Plan;
  subscription: { status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  hasCustomer: boolean;
  dunning: { pastDueSince: string; graceEndsAt: string | null; sendingPaused: boolean } | null;
  usage: { domains: number; mailboxes: number; aliases: number; seats: number; sendsToday: number };
  limits: Plan["limits"];
}
interface Invoice { id: string; number: string | null; status: string; total: number; currency: string; createdAt: string; hostedUrl: string | null; pdfUrl: string | null }

const money = (cents: number, currency: string) => new Intl.NumberFormat(LOCALE, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  active: { label: "Active", tone: "ok" }, trialing: { label: "Trial", tone: "ok" }, past_due: { label: "Payment overdue", tone: "warn" },
  unpaid: { label: "Unpaid", tone: "bad" }, canceled: { label: "Cancelled", tone: "neutral" }, incomplete: { label: "Incomplete", tone: "warn" },
};

export function BillingSettings() {
  const qc = useQueryClient();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const billing = useQuery({ queryKey: ["billing"], queryFn: () => api.get<BillingInfo>("/billing") });
  const invoices = useQuery({ queryKey: ["billing", "invoices"], queryFn: async () => (await api.get<{ invoices: Invoice[] }>("/billing/invoices")).invoices, enabled: !!billing.data?.enabled });
  const isOwner = me.data?.organization?.role === "owner";
  const isDemo = !!me.data?.organization?.isDemo;

  useEffect(() => {
    const r = params.get("checkout");
    if (!r) return;
    const sessionId = params.get("session_id");
    setParams({}, { replace: true });
    if (r === "success" && sessionId) {
      api.post<{ plan: PlanId; complete: boolean }>("/billing/checkout/confirm", { sessionId })
        .then((res) => res.complete
          ? toast.success("Subscription started", { description: `You're on the ${res.plan[0].toUpperCase()}${res.plan.slice(1)} plan.` })
          : toast("Payment is still processing", { description: "Your plan updates as soon as it confirms." }))
        .catch((e: Error) => showError(e))
        .finally(() => qc.invalidateQueries());
      return;
    }
    if (r === "success") toast.success("Subscription started", { description: "Your plan updates as soon as payment confirms." });
    else toast("Checkout cancelled", { description: "Nothing was charged." });
    qc.invalidateQueries();
  }, [params, setParams, qc]);

  const checkout = useMutation({ mutationFn: (plan: PlanId) => api.post<{ url: string }>("/billing/checkout", { plan }), onSuccess: (r) => window.location.assign(r.url), onError: (e) => showError(e) });
  const portal = useMutation({ mutationFn: () => api.post<{ url: string }>("/billing/portal"), onSuccess: (r) => window.location.assign(r.url), onError: (e) => showError(e) });
  const [changing, setChanging] = useState<PlanId | null>(null);
  const preview = useQuery({
    queryKey: ["billing-preview", changing], enabled: !!changing,
    queryFn: () => api.get<{ upgrade: boolean; dueNow: number; credit: number; currency: string }>(`/billing/change-preview?plan=${changing}`),
  });
  const change = useMutation({
    mutationFn: (plan: PlanId) => api.post("/billing/change", { plan }),
    onSuccess: () => { setChanging(null); qc.invalidateQueries(); toast.success("Plan changed"); },
    onError: (e) => showError(e),
  });
  const switchFree = useMutation({ mutationFn: (plan: PlanId) => api.post("/org/plan", { plan }), onSuccess: () => { qc.invalidateQueries(); toast.success("Plan updated"); }, onError: (e) => showError(e) });

  if (billing.isPending) return <Card className="p-6"><Skeleton className="h-6 w-48" /><Skeleton className="mt-4 h-24" /></Card>;
  if (billing.error) return <Card className="p-6 text-sm text-bad">{billing.error.message}</Card>;
  const b = billing.data;
  const sub = b.subscription;
  const status = sub?.status ? STATUS[sub.status] ?? { label: sub.status, tone: "neutral" as const } : null;
  const paidFlow = b.enabled && !isDemo;

  const meters: { label: string; used: number; max: number }[] = [
    { label: "Domains", used: b.usage.domains, max: b.limits.domains },
    { label: "Mailboxes", used: b.usage.mailboxes, max: b.limits.mailboxes },
    { label: "Aliases", used: b.usage.aliases, max: b.limits.aliases },
    { label: "Seats", used: b.usage.seats, max: b.limits.seats },
    { label: "Sent today", used: b.usage.sendsToday, max: b.limits.dailySends },
  ];

  return (
    <div className="space-y-6">
      {!b.enabled && (
        <div className="flex items-start gap-3 rounded-xl border border-line-strong bg-elevated/60 p-4" role="status">
          <PlugZap className="mt-0.5 h-5 w-5 shrink-0 text-brand-hover" />
          <div className="text-sm">
            <div className="font-medium">Billing isn't connected on this deployment</div>
            <p className="mt-0.5 text-muted">Plans switch instantly and nothing is charged. Payments turn on when the operator adds Stripe keys ({b.missing.join(", ")}).</p>
          </div>
        </div>
      )}
      {isDemo && b.enabled && <p className="text-sm text-muted">Demo workspaces switch plans freely; nothing is charged.</p>}
      {paidFlow && b.testMode && (
        <p className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn" role="status">Stripe test mode. Checkout takes test cards only (4242 4242 4242 4242, any future date, any CVC). Nothing is charged.</p>
      )}

      <Section title="Current plan" description="Limits are enforced on the server and follow your plan the moment it changes.">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold tracking-tight">{b.plan.name}</span>
          <span className="text-sm text-muted">{formatPlanPrice(b.plan.priceMonthly)} {PRICE_LABEL} a month</span>
          {status && <Badge tone={status.tone} dot>{status.label}</Badge>}
        </div>
        {sub?.currentPeriodEnd && (
          <p className="mt-1 text-sm text-muted">{sub.cancelAtPeriodEnd ? "Ends" : "Renews"} on {new Date(sub.currentPeriodEnd).toLocaleDateString(LOCALE, { dateStyle: "long", timeZone: tz() })}.</p>
        )}
        {b.dunning && (
          <p className={cn("mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm", b.dunning.sendingPaused ? "border-bad/25 bg-bad/5 text-bad" : "border-warn/25 bg-warn-soft text-warn")} role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {b.dunning.sendingPaused
              ? "Sending is paused because the last payment didn't go through. Receiving still works. Update your card to resume sending."
              : `Your last payment didn't go through. Everything keeps working until ${new Date(b.dunning.graceEndsAt!).toLocaleDateString(LOCALE, { dateStyle: "long", timeZone: tz() })}; update your card before then.`}
          </p>
        )}
        {sub?.status === "past_due" && !b.dunning && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn"><AlertTriangle className="h-4 w-4" />Your last payment failed. Update your card to keep your plan.</p>
        )}
        <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {meters.map((m) => (
            <div key={m.label}>
              <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted">{m.label}</span><span className="tabular-nums">{m.used.toLocaleString(LOCALE)} / {m.max.toLocaleString(LOCALE)}</span></div>
              <Meter value={m.used} max={m.max} />
            </div>
          ))}
        </div>
        {paidFlow && b.hasCustomer && isOwner && (
          <Button variant="secondary" className="mt-5" loading={portal.isPending} onClick={() => portal.mutate()}><CreditCard className="h-4 w-4" />Manage billing<ExternalLink className="h-3.5 w-3.5 opacity-60" /></Button>
        )}
      </Section>

      <Section title="Plans" description={paidFlow ? "Upgrades go through secure checkout. Change or cancel anytime from the billing portal." : "Switch any time. While billing isn't connected, every plan is free."}>
        <div className="grid lg:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            const isCurrent = id === b.plan.id;
            const higher = PLAN_ORDER.indexOf(id) > PLAN_ORDER.indexOf(b.plan.id);
            const hasLiveSub = !!sub && ["active", "trialing", "past_due"].includes(sub.status ?? "");
            return (
              <div key={id} className={cn("flex flex-col border-line py-4 lg:px-5 lg:first:pl-0 lg:last:pr-0 [&:not(:first-child)]:border-t lg:[&:not(:first-child)]:border-l lg:[&:not(:first-child)]:border-t-0", isCurrent && "text-fg")}>
                <div className="flex items-center justify-between"><span className="font-semibold">{p.name}</span>{isCurrent && <Badge tone="brand">Current</Badge>}</div>
                <div className="mt-1 text-sm"><span className="text-lg font-semibold">{formatPlanPrice(p.priceMonthly)}</span><span className="text-muted"> {PRICE_LABEL}/mo</span></div>
                <ul className="mt-3 flex-1 space-y-1 text-xs text-muted">
                  <li>{p.limits.domains} domain{p.limits.domains === 1 ? "" : "s"} · {p.limits.mailboxes} mailboxes</li>
                  <li>{p.limits.aliases.toLocaleString(LOCALE)} aliases · {p.limits.storagePerMailboxMb / 1024} GB each</li>
                  <li>{p.limits.seats} seats · {p.limits.dailySends.toLocaleString(LOCALE)} sends / day</li>
                </ul>
                {!isCurrent && isOwner && (paidFlow ? (
                  hasLiveSub && id !== "starter"
                    ? <Button size="sm" variant={higher ? "primary" : "secondary"} className="mt-4" onClick={() => setChanging(id)}>{higher ? "Upgrade" : "Downgrade"} to {p.name}</Button>
                    : hasLiveSub || !higher
                    ? <Button size="sm" variant="secondary" className="mt-4" loading={portal.isPending} onClick={() => portal.mutate()}>{higher ? "Upgrade" : "Downgrade"} in portal</Button>
                    : <Button size="sm" className="mt-4" loading={checkout.isPending && checkout.variables === id} onClick={() => checkout.mutate(id)}>Upgrade to {p.name}</Button>
                ) : (
                  <Button size="sm" variant={higher ? "primary" : "secondary"} className="mt-4" loading={switchFree.isPending && switchFree.variables === id} onClick={() => switchFree.mutate(id)}>Switch to {p.name}</Button>
                ))}
              </div>
            );
          })}
        </div>
        {!isOwner && <p className="mt-3 text-xs text-subtle">Only the workspace owner can change the plan.</p>}
      </Section>

      <Section title="Invoices" description="Receipts for every payment, with PDF downloads.">
        {!b.enabled ? (
          <EmptyState className="py-8" icon={<Receipt />} title="No invoices" body="Invoices appear here once billing is connected and you subscribe to a paid plan." />
        ) : invoices.isPending ? <Skeleton className="h-20" /> : !invoices.data?.length ? (
          <EmptyState className="py-8" icon={<Receipt />} title="No invoices yet" body="Your first invoice appears here after checkout." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Invoices">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] text-left text-xs text-subtle"><tr><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Invoice</th><th className="px-3 py-2 font-medium">Amount</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">
                {invoices.data.map((i) => (
                  <tr key={i.id}>
                    <td className="px-3 py-2.5">{new Date(i.createdAt).toLocaleDateString(LOCALE, { timeZone: tz() })}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{i.number ?? i.id}</td>
                    <td className="px-3 py-2.5 tabular-nums">{money(i.total, i.currency)}</td>
                    <td className="px-3 py-2.5"><Badge tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"}>{i.status}</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      {i.pdfUrl && <a className="inline-flex items-center gap-1 text-xs text-brand-hover hover:underline" href={i.pdfUrl} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" />PDF</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Dialog open={!!changing} onClose={() => setChanging(null)} title={changing ? `Move to ${PLANS[changing].name}?` : ""}
        description="Stripe prorates the change to the day, so you only pay for what you use."
        footer={<><Button variant="secondary" onClick={() => setChanging(null)}>Cancel</Button><Button loading={change.isPending} disabled={preview.isPending || !!preview.error} onClick={() => changing && change.mutate(changing)}>Confirm change</Button></>}>
        {preview.isPending ? <Skeleton className="h-5 w-64" /> : preview.error ? <p className="text-sm text-bad">{preview.error.message}</p> : preview.data && (
          <p className="text-sm text-muted">
            {preview.data.upgrade
              ? <>You'll be charged <strong className="text-fg">{money(preview.data.dueNow, preview.data.currency)}</strong> now for the rest of this billing period. New limits apply straight away.</>
              : preview.data.credit > 0
                ? <>You'll get a <strong className="text-fg">{money(preview.data.credit, preview.data.currency)}</strong> credit on your next invoice for the unused time.</>
                : <>The lower price starts on your next invoice.</>}
          </p>
        )}
      </Dialog>
    </div>
  );
}
