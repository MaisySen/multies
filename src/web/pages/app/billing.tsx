import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBuilding, IconCheck, IconCreditCard, IconCrown, IconDatabase, IconDocs, IconExternalLink, IconGlobe, IconInbox, IconMails, IconMinus, IconPlugZap, IconPlus, IconReceipt, IconSend, IconSliders, IconWarning } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { LoadFailure } from "@/web/components/load-error-t1g";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { ADDON_ORDER, ADDONS, PLANS, YEARLY_BELOW_MONTHLY, YEARLY_MONTHS_CHARGED, chargeFor, yearlyOnly, type Addon, type AddonId, type AddonQuantities, type BillingInterval, type Plan, type PlanId, formatPlanPrice } from "@/shared/plans";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { UsageRing } from "@/web/components/premium4-r39"; // R39 premium pass 4
import { ReceiptArt } from "@/web/components/illustrations";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/cn";
import { Section } from "./settings";
import { LOCALE } from "@/shared/locale";
import { EXCL_GST, formatCents } from "@/shared/money";
import { tz } from "@/web/lib/format";

interface BillingInfo {
  enabled: boolean;
  missing: string[];
  testMode: boolean;
  webhooks: boolean;
  plan: Plan;
  addons: AddonQuantities;
  charge: { interval: BillingInterval; amount: number; monthly: number; yearlySaving: number };
  interval: BillingInterval | null;
  /** R62: under A$5 a month add-ons bill yearly only. */
  yearlyOnly: boolean;
  offers: { launchCode: string; launchPercentOff: number; launchMonths: number };
  catalog: Addon[];
  subscription: { status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  hasCustomer: boolean;
  dunning: { pastDueSince: string; graceEndsAt: string | null; sendingPaused: boolean } | null;
  usage: { domains: number; mailboxes: number; agentInboxes: number; aliases: number; seats: number; sendsToday: number; storageMb: number; agentMessages: number };
  limits: Plan["limits"];
}
interface AddonPreview { dueNow: number; credit: number; currency: string; charge: BillingInfo["charge"]; dropsDiscount?: boolean }
interface ReferralInfo { code: string; link: string; signedUp: number; waiting: number; credited: number; creditedThisYear: number; capPerYear: number; holdDays: number; minCreditCents: number; maxCreditCents: number }
interface Invoice { id: string; number: string | null; status: string; total: number; currency: string; createdAt: string; hostedUrl: string | null; pdfUrl: string | null }

/** Stripe amounts (invoices, proration previews) carry their currency: "A$3.50" for AUD (src/shared/money.ts). */
const money = (cents: number, currency: string) => formatCents(cents, currency);
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
  // R62: monthly or yearly (ten months for twelve). Null: keep what the subscription has.
  const [intervalChoice, setIntervalChoice] = useState<BillingInterval | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [comparing, setComparing] = useState(false); // R39: the plan comparison sheet
  const preview = useQuery({
    queryKey: ["billing-preview", draft, dropLegacy, intervalChoice], enabled: reviewing && !!draft,
    queryFn: () => api.post<AddonPreview>("/billing/addons/preview", { addons: draft, dropLegacyPlan: dropLegacy, ...(intervalChoice ? { interval: intervalChoice } : {}) }),
  });
  const save = useMutation({
    mutationFn: () => api.post<{ applied: boolean; url: string | null }>("/billing/addons", { addons: draft, dropLegacyPlan: dropLegacy, ...(intervalChoice ? { interval: intervalChoice } : {}) }),
    onSuccess: (r) => {
      if (r.url) { window.location.assign(r.url); return; }
      setReviewing(false); setDraft(null); setDropLegacy(false); setIntervalChoice(null); qc.invalidateQueries(); toast.success("Add-ons updated", { description: "New limits apply straight away." });
    },
    onError: (e) => showError(e),
  });

  if (billing.isPending) return <Card className="p-6"><Skeleton className="h-6 w-48" /><Skeleton className="mt-4 h-24" /></Card>;
  // POL2 (HQ MB-325): the plain words with a Retry button, as the other pages show a failed read.
  if (billing.error) return <Card className="p-0" data-testid="billing-error"><LoadFailure error={billing.error} onRetry={() => billing.refetch()} block /></Card>;
  const b = billing.data;
  const sub = b.subscription;
  const status = sub?.status ? STATUS[sub.status] ?? { label: sub.status, tone: "neutral" as const } : null;
  const paidFlow = b.enabled && !isDemo;
  const hasLiveSub = !!sub && ["active", "trialing", "past_due"].includes(sub.status ?? "");
  const legacy = !!b.plan.legacy;
  const chosen = draft ?? b.addons;
  const base = legacy && !dropLegacy ? b.plan.priceMonthly : 0;
  const next = chargeFor(chosen, base, intervalChoice ?? b.interval);
  const intervalChanged = hasLiveSub && !!b.interval && next.amount > 0 && next.interval !== b.interval;
  const dirty = (!!draft && (JSON.stringify(clean(draft)) !== JSON.stringify(clean(b.addons)) || dropLegacy)) || (!!intervalChoice && intervalChanged);
  const canChooseInterval = next.monthly > 0 && !yearlyOnly(next.monthly);
  const pickInterval = (i: BillingInterval) => { setIntervalChoice(i); setDraft(chosen); };
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
        {/* R39 premium pass 4: the plan as a hero card on the accent, with the price, status and a compare sheet. */}
        <div className="relative overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-br from-brand-soft via-surface to-surface p-5 shadow-card sm:p-6" data-testid="plan-hero">
          <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-brand/10 blur-2xl" aria-hidden />
          <div className="relative">
            <div className="flex min-w-0 items-center gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand text-white shadow-[0_6px_16px_-6px_rgb(0_113_227/0.6)] [&_svg]:h-6 [&_svg]:w-6" aria-hidden><IconCrown /></span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[26px] font-semibold leading-tight tracking-tight">{legacy ? `${b.plan.name} (legacy plan)` : "Free"}</span>
                  {status && <Badge tone={status.tone} dot>{status.label}</Badge>}
                </div>
                <span className="block whitespace-nowrap text-sm text-muted">
                  {b.charge.amount === 0 ? "A$0, nothing to pay" : `${formatPlanPrice(b.charge.amount)} a ${b.charge.interval === "year" ? "year" : "month"}`}
                </span>
              </div>
            </div>
          </div>
          <ul className="relative mt-4 flex flex-wrap gap-2 text-[12.5px] text-muted" aria-label="What every plan includes">
            {["Per business, never per person", "No card needed", "Add-ons from A$1 a month"].map((x) => (
              <li key={x} className="inline-flex items-center gap-1.5 rounded-full bg-surface/80 px-2.5 py-1 ring-1 ring-line"><IconCheck className="h-3 w-3 text-ok" />{x}</li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" className="relative mt-4" onClick={() => setComparing(true)}><IconSliders className="h-4 w-4" />Compare limits</Button>
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
        <h3 className="mb-3 mt-6 text-[13px] font-semibold text-muted">Usage and limits</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3" data-testid="usage-rings">
          {meters.map((m) => (
            <Card key={m.label} className="p-3.5">
              <UsageRing used={m.used} max={m.max} label={m.label} show={m.show ?? ((n) => n.toLocaleString(LOCALE))} />
            </Card>
          ))}
        </div>
        {paidFlow && b.hasCustomer && isOwner && (
          <Button variant="secondary" className="mt-5" loading={portal.isPending} onClick={() => portal.mutate()}><IconCreditCard className="h-4 w-4" />Manage billing<IconExternalLink className="h-3.5 w-3.5 opacity-60" /></Button>
        )}
      </Section>

      <Section title="Add-ons" description={`Add only what you need, from A$1 a month. Everything sits on one subscription and one invoice. Pay yearly and get two months free. When your add-ons come to less than ${formatPlanPrice(YEARLY_BELOW_MONTHLY)} a month, they bill once a year, so card fees don't eat a A$1 charge. Prices are ${EXCL_GST}.`}>
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {ADDON_ORDER.map((id) => {
            const a = ADDONS[id];
            const qty = chosen[id] ?? 0;
            const single = a.maxQuantity === 1;
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-hover/40 motion-reduce:transition-none">
                <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]", qty ? "bg-brand text-white" : "bg-brand-soft text-brand-hover")} aria-hidden>{ADDON_ICON[id]}</span>
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
            <strong className="tabular-nums">{next.amount === 0 ? "A$0" : `${formatPlanPrice(next.amount)} a ${next.interval === "year" ? "year" : "month"}`}</strong>
            {next.interval === "year" && next.amount > 0 && <span className="text-subtle"> ({YEARLY_MONTHS_CHARGED} months for 12, you save {formatPlanPrice(next.yearlySaving)})</span>}
            {/* R62: monthly or yearly with two months free. Under A$5 a month it is yearly only. */}
            {isOwner && paidFlow && canChooseInterval && (
              <div className="mt-2 inline-flex rounded-lg bg-fill p-0.5 text-[13px]" role="group" aria-label="Billing interval" data-testid="billing-interval">
                {(["month", "year"] as const).map((i) => (
                  <button key={i} type="button" aria-pressed={next.interval === i} onClick={() => pickInterval(i)}
                    className={cn("rounded-md px-3 py-1 transition-colors motion-reduce:transition-none", next.interval === i ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>
                    {i === "month" ? "Monthly" : "Yearly, 2 months free"}
                  </button>
                ))}
              </div>
            )}
            {isOwner && paidFlow && !hasLiveSub && next.interval === "month" && next.amount > 0 && (
              <p className="mt-2 text-xs text-subtle" data-testid="launch-code-hint">New here? Enter {b.offers.launchCode} at checkout for {b.offers.launchPercentOff}% off your first {b.offers.launchMonths} months.</p>
            )}
          </div>
          {isOwner && (
            <div className="flex flex-wrap items-center gap-3">
              {legacy && hasLiveSub && (
                <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={dropLegacy} onChange={(e) => { setDropLegacy(e.target.checked); setDraft(chosen); }} />Move to Free, keep these add-ons</label>
              )}
              {draft && <Button variant="secondary" size="sm" onClick={() => { setDraft(null); setDropLegacy(false); setIntervalChoice(null); }}>Reset</Button>}
              <Button disabled={!dirty} loading={save.isPending && !reviewing} onClick={onSave}>
                {!paidFlow ? "Apply add-ons" : hasLiveSub ? "Review change" : "Continue to checkout"}
              </Button>
            </div>
          )}
        </div>
        {!isOwner && <p className="mt-3 text-xs text-subtle">Only the workspace owner can change add-ons.</p>}
      </Section>

      {paidFlow && (isOwner || me.data?.organization?.role === "admin") && <ReferralSection />}

      <Section title="Invoices" description="Receipts for every payment, with PDF downloads.">
        {!b.enabled ? (
          <EmptyState className="py-8" icon={<IconReceipt />} art={<ReceiptArt />} title="No invoices" body="Invoices appear here once billing is connected and you add something paid." />
        ) : invoices.isPending ? <Card className="p-0"><SkeletonRows rows={3} label="Loading invoices" avatar /></Card> : !invoices.data?.length ? (
          <EmptyState className="py-8" icon={<IconReceipt />} art={<ReceiptArt />} title="No invoices yet" body="Your first invoice appears here after checkout." />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" aria-label="Invoices">
            {invoices.data.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-fill text-muted [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden><IconReceipt /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium tabular-nums">{money(i.total, i.currency)}</span><Badge tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"}>{i.status}</Badge></div>
                  <div className="truncate text-xs text-subtle">{new Date(i.createdAt).toLocaleDateString(LOCALE, { timeZone: tz(), dateStyle: "medium" })} · <span className="font-mono">{i.number ?? i.id}</span></div>
                </div>
                {i.pdfUrl && <a className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-brand-hover hover:bg-brand-soft max-sm:min-h-11" href={i.pdfUrl} target="_blank" rel="noreferrer"><IconDocs className="h-3.5 w-3.5" />PDF</a>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ComparePlans open={comparing} onClose={() => setComparing(false)} limits={b.limits} />
      <Dialog open={reviewing} onClose={() => setReviewing(false)} title="Confirm your add-ons"
        description="Stripe prorates the change to the day, so you only pay for what you use."
        footer={<><Button variant="secondary" onClick={() => setReviewing(false)}>Cancel</Button><Button loading={save.isPending} disabled={preview.isPending || !!preview.error} onClick={() => save.mutate()}>Confirm change</Button></>}>
        {preview.isPending ? <Skeleton className="h-5 w-64" /> : preview.error ? <p className="text-sm text-bad">{preview.error.message}</p> : preview.data && (
          <div className="space-y-2 text-sm text-muted">
            <p>From now on: <strong className="text-fg">{formatPlanPrice(preview.data.charge.amount)} a {preview.data.charge.interval === "year" ? "year" : "month"}</strong>.</p>
            {preview.data.dropsDiscount && <p>Moving to yearly billing ends your launch discount, which applies to monthly billing only.</p>}
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

/** R62: the workspace's referral link. Both sides get a month of the new workspace's add-ons once its first payment stands. */
function ReferralSection() {
  const ref = useQuery({ queryKey: ["billing", "referral"], queryFn: () => api.get<ReferralInfo>("/billing/referral"), staleTime: 60_000 });
  const copy = async (link: string) => {
    try { await navigator.clipboard.writeText(link); toast.success("Referral link copied"); } catch { toast("Copy the link from the box"); }
  };
  const r = ref.data;
  return (
    <Section title="Refer a business" description="When a business signs up with your link and its first payment goes through, you both get a credit worth one month of its add-ons, from A$1 to A$20. Credits come off your next invoices.">
      {ref.isPending ? <Skeleton className="h-10 w-full" /> : ref.error ? <p className="text-sm text-bad">{ref.error.message}</p> : r && (
        <div className="space-y-3" data-testid="referral">
          <div className="flex flex-wrap items-center gap-2">
            <input readOnly value={r.link} aria-label="Your referral link" onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px]" />
            <Button variant="secondary" onClick={() => copy(r.link)}>Copy link</Button>
          </div>
          <p className="text-sm text-muted">
            {r.signedUp === 0 ? "No sign ups through your link yet." : `${r.signedUp} signed up, ${r.waiting} waiting for a first payment or the ${r.holdDays} day refund window, ${r.credited} credited.`}
            {" "}You can earn up to {r.capPerYear} credits a year ({r.creditedThisYear} so far). Referring your own business doesn't count.
          </p>
        </div>
      )}
    </Section>
  );
}

function clean(a: AddonQuantities) {
  return Object.fromEntries(ADDON_ORDER.filter((id) => (a[id] ?? 0) > 0).map((id) => [id, a[id]]));
}

/** R39: one icon per add-on, drawn in a tinted tile (solid accent once added). */
const ADDON_ICON: Record<AddonId, React.ReactNode> = { domain: <IconGlobe />, mailboxes: <IconMails />, storage: <IconDatabase />, send_boost: <IconSend />, agent_inbox: <IconInbox /> };

/** R39: the plan comparison as a native sheet: what Free includes beside what this workspace has now. */
function ComparePlans({ open, onClose, limits }: { open: boolean; onClose: () => void; limits: BillingInfo["limits"] }) {
  const free = PLANS.starter.limits;
  const gb = (mb: number) => `${(mb / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB`;
  const n = (x: number) => x.toLocaleString(LOCALE);
  const rows: [string, number, number, (x: number) => string][] = [
    ["Custom domains", free.domains, limits.domains, n], ["Mailboxes", free.mailboxes, limits.mailboxes, n], ["People", free.seats, limits.seats, n],
    ["Storage", free.storageMb, limits.storageMb, gb], ["Sends a day", free.dailySends, limits.dailySends, n], ["Aliases", free.aliases, limits.aliases, n],
    ["Agent inboxes", free.agentInboxes, limits.agentInboxes, n], ["Agent messages a month", free.agentMessagesMonthly, limits.agentMessagesMonthly, n],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Compare limits" description="Free is the same for every business. Add-ons raise a limit the moment you add them.">
      <div className="overflow-hidden rounded-xl border border-line" data-testid="compare-plans">
        <div className="grid grid-cols-[minmax(0,1fr)_72px_72px] bg-fill/60 px-3 py-2 text-[12px] font-medium text-muted"><span>Limit</span><span className="text-right">Free</span><span className="text-right">You</span></div>
        <ul className="divide-y divide-line">
          {rows.map(([label, f, you, fmt]) => (
            <li key={label} className="grid grid-cols-[minmax(0,1fr)_72px_72px] items-center px-3 py-2.5 text-[13.5px]">
              <span className="flex items-center gap-2"><IconBuilding className="h-3.5 w-3.5 text-subtle" aria-hidden />{label}</span>
              <span className="text-right tabular-nums text-muted">{fmt(f)}</span>
              <span className={cn("text-right tabular-nums", you > f ? "font-semibold text-brand-hover" : "")}>{fmt(you)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
