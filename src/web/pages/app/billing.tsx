import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCreditCard, IconDocs, IconExternalLink, IconMinus, IconPlugZap, IconPlus, IconReceipt, IconWarning } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { ADDON_ORDER, ADDONS, PLANS, YEARLY_BELOW_MONTHLY, chargeFor, type Addon, type AddonId, type AddonQuantities, type BillingInterval, type Plan, type PlanId, formatPlanPrice } from "@/shared/plans";
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
  addons: AddonQuantities;
  charge: { interval: BillingInterval; amount: number; monthly: number };
  interval: BillingInterval | null;
  catalog: Addon[];
  subscription: { status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  hasCustomer: boolean;
  dunning: { pastDueSince: string; graceEndsAt: string | null; sendingPaused: boolean } | null;
  usage: { domains: number; mailboxes: number; agentInboxes: number; aliases: number; seats: number; sendsToday: number; storageMb: number; agentMessages: number };
  limits: Plan["limits"];
}
interface AddonPreview { dueNow: number; credit: number; currency: string; charge: BillingInfo["charge"] }
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
  const platformAdmin = !!me.data?.user.platformAdmin;

  useEffect(() => {
    const r = params.get("checkout");
    if (!r) return;
    const sessionId = params.get("session_id");
    setParams({}, { replace: true });
    if (r === "success" && sessionId) {
      api.post<{ plan: PlanId; complete: boolean }>("/billing/checkout/confirm", { sessionId })
        .then((res) => res.complete
          ? toast.success("Add-ons added", { description: res.plan === "starter" ? "New limits apply straight away." : `Your ${PLANS[res.plan].name} plan is active.` })
          : toast("Payment is still processing", { description: "Your plan updates as soon as it confirms." }))
        .catch((e: Error) => showError(e))
        .finally(() => qc.invalidateQueries());
      return;
    }
    if (r === "success") toast.success("Subscription started", { description: "Your add-ons apply as soon as payment confirms." });
    else toast("Checkout cancelled", { description: "Nothing was charged." });
    qc.invalidateQueries();
  }, [params, setParams, qc]);

  const portal = useMutation({ mutationFn: () => api.post<{ url: string }>("/billing/portal"), onSuccess: (r) => window.location.assign(r.url), onError: (e) => showError(e) });
  const [draft, setDraft] = useState<AddonQuantities | null>(null);
  const [dropLegacy, setDropLegacy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const preview = useQuery({
    queryKey: ["billing-preview", draft, dropLegacy], enabled: reviewing && !!draft,
    queryFn: () => api.post<AddonPreview>("/billing/addons/preview", { addons: draft, dropLegacyPlan: dropLegacy }),
  });
  const save = useMutation({
    mutationFn: () => api.post<{ applied: boolean; url: string | null }>("/billing/addons", { addons: draft, dropLegacyPlan: dropLegacy }),
    onSuccess: (r) => {
      if (r.url) { window.location.assign(r.url); return; }
      setReviewing(false); setDraft(null); setDropLegacy(false); qc.invalidateQueries(); toast.success("Add-ons updated", { description: "New limits apply straight away." });
    },
    onError: (e) => showError(e),
  });

  if (billing.isPending) return <Card className="p-6"><Skeleton className="h-6 w-48" /><Skeleton className="mt-4 h-24" /></Card>;
  if (billing.error) return <Card className="p-6 text-sm text-bad">{billing.error.message}</Card>;
  const b = billing.data;
  const sub = b.subscription;
  const status = sub?.status ? STATUS[sub.status] ?? { label: sub.status, tone: "neutral" as const } : null;
  const paidFlow = b.enabled && !isDemo;
  const hasLiveSub = !!sub && ["active", "trialing", "past_due"].includes(sub.status ?? "");
  const legacy = !!b.plan.legacy;
  const chosen = draft ?? b.addons;
  const dirty = !!draft && (JSON.stringify(clean(draft)) !== JSON.stringify(clean(b.addons)) || dropLegacy);
  const base = legacy && !dropLegacy ? b.plan.priceMonthly : 0;
  const next = chargeFor(chosen, base);
  const setQty = (id: AddonId, qty: number) => setDraft({ ...chosen, [id]: Math.max(0, Math.min(ADDONS[id].maxQuantity, qty)) });
  const onSave = () => (hasLiveSub ? setReviewing(true) : save.mutate());

  const gb = (mb: number) => `${(mb / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB`;
  const meters: { label: string; used: number; max: number; show?: (n: number) => string }[] = [
    { label: "Domains", used: b.usage.domains, max: b.limits.domains },
    { label: "Mailboxes", used: b.usage.mailboxes, max: b.limits.mailboxes },
    { label: "People", used: b.usage.seats, max: b.limits.seats },
    { label: "Storage", used: b.usage.storageMb, max: b.limits.storageMb, show: gb },
    { label: "Sent today", used: b.usage.sendsToday, max: b.limits.dailySends },
    { label: "Agent inboxes", used: b.usage.agentInboxes, max: b.limits.agentInboxes },
    { label: "Agent messages this month", used: b.usage.agentMessages, max: b.limits.agentMessagesMonthly },
    { label: "Aliases", used: b.usage.aliases, max: b.limits.aliases },
  ];

  return (
    <div className="space-y-6">
      {!b.enabled && (
        <div className="flex items-start gap-3 rounded-xl border border-line-strong bg-elevated/60 p-4" role="status">
          <IconPlugZap className="mt-0.5 h-5 w-5 shrink-0 text-brand-hover" />
          <div className="text-sm">
            <div className="font-medium">Paid add-ons aren't on sale yet</div>
            <p className="mt-0.5 text-muted">Add-ons apply instantly and nothing is charged for now.{platformAdmin && b.missing.length ? ` Operator: set ${b.missing.join(", ")} to take payments.` : ""}</p>
          </div>
        </div>
      )}
      {isDemo && b.enabled && <p className="text-sm text-muted">Demo workspaces add and remove add-ons freely; nothing is charged.</p>}
      {/* Test mode is the operator's business: only platform admins see it. */}
      {paidFlow && b.testMode && platformAdmin && (
        <p className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn" role="status">Stripe test mode. Checkout takes test cards only (4242 4242 4242 4242, any future date, any CVC). Nothing is charged.</p>
      )}

      <Section title="Your plan" description="Free forever, priced per business, never per person. Limits change the moment your add-ons do.">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold tracking-tight">{legacy ? `${b.plan.name} (legacy plan)` : "Free"}</span>
          <span className="text-sm text-muted">
            {b.charge.amount === 0 ? "A$0, nothing to pay" : `${formatPlanPrice(b.charge.amount)} AUD a ${b.charge.interval === "year" ? "year" : "month"}`}
          </span>
          {status && <Badge tone={status.tone} dot>{status.label}</Badge>}
        </div>
        {legacy && <p className="mt-1 text-sm text-muted">Pro and Business are no longer sold, and your plan keeps working with its limits. You can add add-ons to it, or move to Free and keep only the add-ons you need.</p>}
        {sub?.currentPeriodEnd && (
          <p className="mt-1 text-sm text-muted">{sub.cancelAtPeriodEnd ? "Ends" : "Renews"} on {new Date(sub.currentPeriodEnd).toLocaleDateString(LOCALE, { dateStyle: "long", timeZone: tz() })}.</p>
        )}
        {b.dunning && (
          <p className={cn("mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm", b.dunning.sendingPaused ? "border-bad/25 bg-bad/5 text-bad" : "border-warn/25 bg-warn-soft text-warn")} role="alert">
            <IconWarning className="h-4 w-4 shrink-0" />
            {b.dunning.sendingPaused
              ? "Sending is paused because the last payment didn't go through. Receiving still works. Update your card to resume sending."
              : `Your last payment didn't go through. Everything keeps working until ${new Date(b.dunning.graceEndsAt!).toLocaleDateString(LOCALE, { dateStyle: "long", timeZone: tz() })}; update your card before then.`}
          </p>
        )}
        {sub?.status === "past_due" && !b.dunning && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn"><IconWarning className="h-4 w-4" />Your last payment failed. Update your card to keep your plan.</p>
        )}
        <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {meters.map((m) => (
            <div key={m.label}>
              <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted">{m.label}</span><span className="tabular-nums">{m.show ? m.show(m.used) : m.used.toLocaleString(LOCALE)} / {m.show ? m.show(m.max) : m.max.toLocaleString(LOCALE)}</span></div>
              <Meter value={m.used} max={m.max} />
            </div>
          ))}
        </div>
        {paidFlow && b.hasCustomer && isOwner && (
          <Button variant="secondary" className="mt-5" loading={portal.isPending} onClick={() => portal.mutate()}><IconCreditCard className="h-4 w-4" />Manage billing<IconExternalLink className="h-3.5 w-3.5 opacity-60" /></Button>
        )}
      </Section>

      <Section title="Add-ons" description={`Add only what you need, from A$1 a month. Everything sits on one subscription and one invoice. When your add-ons come to less than A$${YEARLY_BELOW_MONTHLY} a month, they bill once a year instead, so card fees don't eat a A$1 charge.`}>
        <ul className="divide-y divide-line border-y border-line">
          {ADDON_ORDER.map((id) => {
            const a = ADDONS[id];
            const qty = chosen[id] ?? 0;
            const single = a.maxQuantity === 1;
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2"><span className="font-medium">{a.name}</span><span className="text-sm text-muted">{formatPlanPrice(a.priceMonthly)} a month{single ? " for the whole team" : ` per ${a.unit}`}</span></div>
                  <p className="text-xs text-subtle">{a.description}</p>
                </div>
                {isOwner ? (single ? (
                  <Button size="sm" variant={qty ? "secondary" : "primary"} aria-pressed={!!qty} onClick={() => setQty(id, qty ? 0 : 1)}>{qty ? "Remove" : "Add"}</Button>
                ) : (
                  <div className="flex items-center gap-1" role="group" aria-label={`${a.name} quantity`}>
                    <Button size="sm" variant="secondary" aria-label={`One less ${a.name.toLowerCase()}`} disabled={!qty} onClick={() => setQty(id, qty - 1)}><IconMinus className="h-3.5 w-3.5" /></Button>
                    <output className="w-8 text-center tabular-nums" aria-live="polite">{qty}</output>
                    <Button size="sm" variant="secondary" aria-label={`One more ${a.name.toLowerCase()}`} disabled={qty >= a.maxQuantity} onClick={() => setQty(id, qty + 1)}><IconPlus className="h-3.5 w-3.5" /></Button>
                  </div>
                )) : <span className="text-sm tabular-nums text-muted">{qty ? `x ${qty}` : "Not added"}</span>}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-muted">{dirty ? "New total: " : "Total: "}</span>
            <strong className="tabular-nums">{next.amount === 0 ? "A$0" : `${formatPlanPrice(next.amount)} AUD a ${next.interval === "year" ? "year" : "month"}`}</strong>
            {next.interval === "year" && next.amount > 0 && <span className="text-subtle"> ({formatPlanPrice(next.monthly)} a month, billed yearly)</span>}
          </div>
          {isOwner && (
            <div className="flex flex-wrap items-center gap-3">
              {legacy && hasLiveSub && (
                <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={dropLegacy} onChange={(e) => { setDropLegacy(e.target.checked); setDraft(chosen); }} />Move to Free, keep these add-ons</label>
              )}
              {draft && <Button variant="secondary" size="sm" onClick={() => { setDraft(null); setDropLegacy(false); }}>Reset</Button>}
              <Button disabled={!dirty} loading={save.isPending && !reviewing} onClick={onSave}>
                {!paidFlow ? "Apply add-ons" : hasLiveSub ? "Review change" : "Continue to checkout"}
              </Button>
            </div>
          )}
        </div>
        {!isOwner && <p className="mt-3 text-xs text-subtle">Only the workspace owner can change add-ons.</p>}
      </Section>

      <Section title="Invoices" description="Receipts for every payment, with PDF downloads.">
        {!b.enabled ? (
          <EmptyState className="py-8" icon={<IconReceipt />} title="No invoices" body="Invoices appear here once billing is connected and you add something paid." />
        ) : invoices.isPending ? <Skeleton className="h-20" /> : !invoices.data?.length ? (
          <EmptyState className="py-8" icon={<IconReceipt />} title="No invoices yet" body="Your first invoice appears here after checkout." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Invoices">
            <table className="w-full text-sm">
              <thead className="bg-fill/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Invoice</th><th className="px-3 py-2 font-medium">Amount</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">
                {invoices.data.map((i) => (
                  <tr key={i.id}>
                    <td className="px-3 py-2.5">{new Date(i.createdAt).toLocaleDateString(LOCALE, { timeZone: tz() })}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{i.number ?? i.id}</td>
                    <td className="px-3 py-2.5 tabular-nums">{money(i.total, i.currency)}</td>
                    <td className="px-3 py-2.5"><Badge tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"}>{i.status}</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      {i.pdfUrl && <a className="inline-flex items-center gap-1 text-xs text-brand-hover hover:underline" href={i.pdfUrl} target="_blank" rel="noreferrer"><IconDocs className="h-3.5 w-3.5" />PDF</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Dialog open={reviewing} onClose={() => setReviewing(false)} title="Confirm your add-ons"
        description="Stripe prorates the change to the day, so you only pay for what you use."
        footer={<><Button variant="secondary" onClick={() => setReviewing(false)}>Cancel</Button><Button loading={save.isPending} disabled={preview.isPending || !!preview.error} onClick={() => save.mutate()}>Confirm change</Button></>}>
        {preview.isPending ? <Skeleton className="h-5 w-64" /> : preview.error ? <p className="text-sm text-bad">{preview.error.message}</p> : preview.data && (
          <div className="space-y-2 text-sm text-muted">
            <p>From now on: <strong className="text-fg">{formatPlanPrice(preview.data.charge.amount)} AUD a {preview.data.charge.interval === "year" ? "year" : "month"}</strong>.</p>
            <p>
              {preview.data.dueNow > 0
                ? <>You'll be charged <strong className="text-fg">{money(preview.data.dueNow, preview.data.currency)}</strong> now for the rest of this billing period.</>
                : preview.data.credit > 0
                  ? <>You'll get a <strong className="text-fg">{money(preview.data.credit, preview.data.currency)}</strong> credit on your next invoice for the unused time.</>
                  : <>Nothing is due today.</>}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function clean(a: AddonQuantities) {
  return Object.fromEntries(ADDON_ORDER.filter((id) => (a[id] ?? 0) > 0).map((id) => [id, a[id]]));
}
