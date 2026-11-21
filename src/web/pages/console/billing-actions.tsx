/**
 * OPS1: the billing actions on a workspace's Billing tab. Each is a plain button that opens the shared reason dialog,
 * which says what happens and what the customer is charged or credited. Hidden for roles without billing.manage.
 * Comp (free Business plan) and credit need a recent sign in; the dialog offers it when the server asks.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { DateInput, Field, Input, Select } from "@/web/components/ui/input";
import { formatCents } from "@/shared/money";
import { PLAN_ORDER, PLANS, type PlanId } from "@/shared/plans";
import { shortDate } from "@/web/lib/format";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { billingApi, dollarsToCents, newRequestKey, planName, type WorkspaceBilling } from "./billing-api";

type Res<K extends keyof typeof billingApi> = Awaited<ReturnType<(typeof billingApi)[K]>>;

const LIVE = ["active", "trialing", "past_due"];

function ActionRow({ label, hint, onClick, disabled, disabledWhy, testId, tone = "secondary" }: {
  label: string; hint: string; onClick: () => void; disabled?: boolean; disabledWhy?: string; testId: string; tone?: "secondary" | "danger";
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-subtle">{disabled && disabledWhy ? disabledWhy : hint}</p>
      </div>
      <Button size="sm" variant={tone} onClick={onClick} disabled={disabled} data-testid={testId} className="shrink-0 self-start sm:self-auto">{label}</Button>
    </div>
  );
}

function wholeDays(v: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

export function WorkspaceBillingActions({ b }: { b: WorkspaceBilling }) {
  const orgId = b.orgId;
  const money = (cents: number) => formatCents(cents, b.currency);
  const live = !!b.subscription.status && LIVE.includes(b.subscription.status) && !!b.stripe.subscriptionId;
  const stripeOff = !b.billing.enabled;
  const offWhy = "Billing isn't connected on this deployment.";

  const [plan, setPlan] = useState<PlanId>(b.plan === "business" ? "pro" : "business");
  const changePlan = useOperatorAction<void, Res<"changePlan">>({
    title: `Change ${b.name}'s plan`,
    description: `They are billed for ${planName(b.plan)} now. The change goes to Stripe straight away. An upgrade is prorated: Stripe charges the difference for the rest of this period on their next invoice. A downgrade gives them prorated credit. Moving to Free removes the plan from the subscription and keeps their add-ons.`,
    confirmLabel: "Change plan",
    canSubmit: plan !== b.plan,
    fields: (
      <Field label="New plan" hint={plan === b.plan ? "Pick a plan other than the current one." : `${PLANS[plan].name} limits apply once Stripe confirms.`}>
        {(p) => (
          <Select {...p} value={plan} onChange={(e) => setPlan(e.target.value as PlanId)} data-testid="console-billing-plan-select">
            {PLAN_ORDER.map((id) => <option key={id} value={id}>{PLANS[id].name}{id === b.plan ? " (current)" : ""}</option>)}
          </Select>
        )}
      </Field>
    ),
    run: (_v, reason) => billingApi.changePlan(orgId, { plan, reason }),
    success: "Plan changed",
    onDone: (r) => { if (r.pending) toast.message("Stripe is waiting for the payment to go through. The plan changes when it does."); },
  });

  const [until, setUntil] = useState("");
  const [compNote, setCompNote] = useState("");
  const giveComp = useOperatorAction<void, Res<"setComp">>({
    title: `Give ${b.name} a free Business plan`,
    description: `Only Business can be given free. The workspace gets Business limits at no charge until the end date (or until you end it). Nothing is charged or refunded, and their Stripe subscription is not touched${live ? `: they still pay for ${planName(b.plan)} unless you also cancel it at period end` : ""}.`,
    confirmLabel: "Give free Business plan",
    fields: (
      <div className="space-y-4">
        {live && (
          <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="console-billing-comp-still-billing">
            This workspace has a paid subscription that keeps billing after the free plan starts.
          </p>
        )}
        <Field label="Free until (optional)" hint={`Leave empty for no end date. At most ${b.bounds.compMaxDays} days ahead.`}>
          {(p) => <DateInput {...p} value={until} onChange={(e) => setUntil(e.target.value)} data-testid="console-billing-comp-until" />}
        </Field>
        <Field label="Note (optional)" hint="Why they get it, kept with the free plan.">
          {(p) => <Input {...p} value={compNote} maxLength={b.bounds.noteMax} onChange={(e) => setCompNote(e.target.value)} placeholder="Launch partner" data-testid="console-billing-comp-note" />}
        </Field>
      </div>
    ),
    run: (_v, reason) => billingApi.setComp(orgId, { on: true, until: until || null, note: compNote.trim() || null, reason }),
    success: "Free Business plan given",
    onDone: (r) => {
      if (r.warnings.includes("subscription_still_billing")) toast.warning("Their paid subscription is still billing. Cancel it at period end if they shouldn't pay.");
      setUntil(""); setCompNote("");
    },
  });
  const endComp = useOperatorAction<void>({
    title: `End ${b.name}'s free Business plan?`,
    description: `They go back to the limits of the plan they pay for (${planName(b.plan)}) straight away. Nothing is charged by this change.`,
    confirmLabel: "End free plan", tone: "danger",
    run: (_v, reason) => billingApi.setComp(orgId, { on: false, reason }),
    success: "Free plan ended",
  });

  const [amount, setAmount] = useState("");
  const [creditNote, setCreditNote] = useState("");
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const cents = dollarsToCents(amount);
  const amountOk = cents !== null && cents >= b.bounds.creditMinCents && cents <= b.bounds.creditMaxCents;
  const credit = useOperatorAction<void>({
    title: `Add credit to ${b.name}`,
    description: `The credit goes on their Stripe balance. Nothing is charged now: Stripe takes it off their next invoices until it is used up. It can't be paid out.`,
    confirmLabel: amountOk ? `Add ${money(cents!)} credit` : "Add credit",
    canSubmit: amountOk && !!creditNote.trim(),
    fields: (
      <div className="space-y-4">
        <Field label={`Amount in ${b.currency.toUpperCase()}`} error={amount && !amountOk ? `Enter an amount from ${money(b.bounds.creditMinCents)} to ${money(b.bounds.creditMaxCents)}.` : undefined}
          hint={`From ${money(b.bounds.creditMinCents)} to ${money(b.bounds.creditMaxCents)}.`}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" data-testid="console-billing-credit-amount" />}
        </Field>
        <Field label="Note for the customer" hint="Shown on their balance in Stripe, for example the reason for the credit.">
          {(p) => <Input {...p} value={creditNote} maxLength={b.bounds.noteMax} onChange={(e) => setCreditNote(e.target.value)} placeholder="Credit for the outage on 3 Nov" data-testid="console-billing-credit-note" />}
        </Field>
      </div>
    ),
    run: (_v, reason) => billingApi.addCredit(orgId, { amountCents: cents!, note: creditNote.trim(), reason, requestKey }),
    success: "Credit added",
    onDone: () => { setAmount(""); setCreditNote(""); setRequestKey(newRequestKey()); },
  });

  const [trialDays, setTrialDays] = useState("7");
  const trialN = wholeDays(trialDays, b.bounds.trialDaysMax);
  const trial = useOperatorAction<void>({
    title: `Extend ${b.name}'s trial`,
    description: "Moves the trial end later in Stripe, counted from today or the current trial end, whichever is later. They are not charged until the new trial end, and nothing is prorated.",
    confirmLabel: "Extend trial",
    canSubmit: trialN !== null,
    fields: (
      <Field label="Days to add" hint={`1 to ${b.bounds.trialDaysMax} days.`} error={trialDays && trialN === null ? `Enter 1 to ${b.bounds.trialDaysMax}.` : undefined}>
        {(p) => <Input {...p} inputMode="numeric" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} data-testid="console-billing-trial-days" />}
      </Field>
    ),
    run: (_v, reason) => billingApi.extendTrial(orgId, { days: trialN!, reason }),
    success: "Trial extended",
  });

  const [graceDays, setGraceDays] = useState("7");
  const graceN = wholeDays(graceDays, b.bounds.graceDaysMax);
  const grace = useOperatorAction<void>({
    title: `Extend ${b.name}'s grace period`,
    description: `Gives them more days before sending is paused for the missed payment${b.dunning?.graceEndsAt ? ` (now ${shortDate(b.dunning.graceEndsAt)})` : ""}. This only changes Multies: Stripe keeps retrying the card as usual, and nothing is charged or credited.`,
    confirmLabel: "Extend grace period",
    canSubmit: graceN !== null,
    fields: (
      <Field label="Days to add" hint={`1 to ${b.bounds.graceDaysMax} days, from today or the current grace end, whichever is later.`} error={graceDays && graceN === null ? `Enter 1 to ${b.bounds.graceDaysMax}.` : undefined}>
        {(p) => <Input {...p} inputMode="numeric" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} data-testid="console-billing-grace-days" />}
      </Field>
    ),
    run: (_v, reason) => billingApi.extendGrace(orgId, { days: graceN!, reason }),
    success: "Grace period extended",
  });

  const resync = useOperatorAction<void, Res<"resync">>({
    title: `Sync ${b.name} with Stripe`,
    description: "Reads their subscription from Stripe and updates this workspace to match (plan, add-ons, status, period end). Nothing changes in Stripe and nothing is charged.",
    confirmLabel: "Sync with Stripe",
    run: (_v, reason) => billingApi.resync(orgId, { reason }),
    onDone: (r) => {
      const msg = { synced: "Synced with Stripe", deleted: "Stripe has no live subscription, so it is now marked ended", comp_kept: "Synced. The free Business plan stays on", no_subscription: "Stripe has no subscription for this workspace" }[r.outcome];
      toast.success(msg);
    },
  });

  const ending = b.subscription.cancelAtPeriodEnd;
  const periodEnd = b.subscription.currentPeriodEnd ? shortDate(b.subscription.currentPeriodEnd) : "the end of the period";
  const cancel = useOperatorAction<void>({
    title: ending ? `Keep ${b.name}'s subscription?` : `Cancel ${b.name}'s subscription at period end?`,
    description: ending
      ? `The subscription renews on ${periodEnd} as usual and they are charged then.`
      : `The subscription ends on ${periodEnd}. They keep their plan until then and are not charged again. Nothing is refunded for the current period.`,
    confirmLabel: ending ? "Keep subscription" : "Cancel at period end", tone: ending ? "primary" : "danger",
    run: (_v, reason) => billingApi.cancelAtPeriodEnd(orgId, { on: !ending, reason }),
    success: ending ? "The subscription will renew" : "The subscription ends at period end",
  });

  return (
    <PermissionGate permission="billing.manage">
      <Card className="px-4 py-1" data-testid="console-billing-actions">
        <h2 className="pt-3 text-sm font-semibold">Actions</h2>
        <div className="divide-y divide-line">
          <ActionRow label="Change plan" hint="Move the paid subscription to another plan in Stripe." onClick={() => changePlan.open()} testId="console-billing-action-plan"
            disabled={stripeOff || b.comp.on} disabledWhy={stripeOff ? offWhy : "End the free Business plan first."} />
          {b.comp.on ? (
            <ActionRow label="End free Business plan" hint="Go back to the plan they pay for." onClick={() => endComp.open()} testId="console-billing-action-comp-end" tone="danger" />
          ) : (
            <ActionRow label="Give free Business plan" hint="Business limits at no charge, with an optional end date and note." onClick={() => giveComp.open()} testId="console-billing-action-comp" />
          )}
          <ActionRow label="Add credit" hint="Credit on their Stripe balance, taken off their next invoices." onClick={() => { setRequestKey(newRequestKey()); credit.open(); }} testId="console-billing-action-credit"
            disabled={stripeOff || !b.stripe.customerId} disabledWhy={stripeOff ? offWhy : "They have no Stripe customer yet."} />
          <ActionRow label="Extend trial" hint="Push the trial end later in Stripe." onClick={() => trial.open()} testId="console-billing-action-trial"
            disabled={stripeOff || !live || b.subscription.status === "past_due" || b.comp.on} disabledWhy={stripeOff ? offWhy : b.subscription.status === "past_due" ? "They are behind on payment. Extend the grace period instead." : "They have no live subscription."} />
          <ActionRow label="Extend grace period" hint="More days before sending is paused for a missed payment." onClick={() => grace.open()} testId="console-billing-action-grace"
            disabled={!b.dunning} disabledWhy="They aren't behind on payment." />
          <ActionRow label="Sync with Stripe" hint="Update this workspace from what Stripe has." onClick={() => resync.open()} testId="console-billing-action-resync"
            disabled={stripeOff} disabledWhy={offWhy} />
          <ActionRow label={ending ? "Keep subscription" : "Cancel at period end"} hint={ending ? `It ends on ${periodEnd}. Undo that.` : "End the subscription when the current period ends."}
            onClick={() => cancel.open()} testId="console-billing-action-cancel" tone={ending ? "secondary" : "danger"}
            disabled={stripeOff || !live || b.comp.on} disabledWhy={stripeOff ? offWhy : b.comp.on ? "End the free Business plan first." : "They have no live subscription."} />
        </div>
      </Card>
      {changePlan.dialog}{giveComp.dialog}{endComp.dialog}{credit.dialog}{trial.dialog}{grace.dialog}{resync.dialog}{cancel.dialog}
    </PermissionGate>
  );
}
