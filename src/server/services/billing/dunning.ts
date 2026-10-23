/**
 * Dunning and account emails tied to billing: receipts, failed payment notices with a
 * grace period, the end of grace (sending pauses, receiving never does), and usage alerts
 * at 80% and 100% of the daily sending limit. Stripe Smart Retries retries the charge;
 * this module decides what the workspace can do meanwhile and who hears about it.
 */
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { createElement } from "react";
import type { Deps } from "../../context";
import { auditLogs, members, organizations, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { PLANS, PLAN_ORDER } from "@/shared/plans";
import { PaymentFailed, Receipt, UsageAlert } from "../../emails";
import { audit } from "../audit";
import { emailBrand, sendSystemEmail } from "../system-mail";

type Org = typeof organizations.$inferSelect;
const DAY = 86400_000;

/** Owners and admins: the people who can fix billing. */
async function billingContacts(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), inArray(members.role, ["owner", "admin"])));
  return rows.map((r) => r.email);
}

export function money(cents: number | null | undefined, currency = "aud") {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency.toUpperCase() }).format((cents ?? 0) / 100);
}

/** True once the grace period after a failed payment has run out. */
export function sendingPausedForPayment(org: Pick<Org, "pastDueSince" | "graceEndsAt">, now: Date) {
  return !!org.pastDueSince && !!org.graceEndsAt && org.graceEndsAt.getTime() <= now.getTime();
}

export function assertNotPaymentPaused(org: Org, now: Date) {
  if (sendingPausedForPayment(org, now)) {
    throw new HttpError(402, "payment_required", "Sending is paused because the last payment didn't go through. Update the payment method in Settings, Billing, and sending resumes straight away. Receiving mail is not affected.");
  }
}

interface InvoiceLike {
  id?: string; number?: string | null; amount_paid?: number; amount_due?: number; currency?: string; tax?: number | null;
  hosted_invoice_url?: string | null; created?: number;
  lines?: { data?: { description?: string | null; amount?: number }[] };
}

/** First failed payment starts the grace period and emails the billing contacts once. */
export async function onPaymentFailed(deps: Deps, org: Org, inv: InvoiceLike) {
  if (org.pastDueSince) return { started: false };
  const now = deps.now();
  const graceEndsAt = new Date(now.getTime() + deps.config.billingGraceDays * DAY);
  await deps.db.update(organizations).set({ pastDueSince: now, graceEndsAt }).where(eq(organizations.id, org.id));
  const amount = money(inv.amount_due, inv.currency);
  const graceEnds = graceEndsAt.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: org.timezone });
  for (const to of await billingContacts(deps, org.id)) {
    await sendSystemEmail(deps, {
      to, orgId: org.id, template: "payment-failed", subject: `Payment for ${org.name} didn't go through`,
      text: `We couldn't charge ${amount} for ${org.name}. We'll retry automatically. Everything keeps working until ${graceEnds}; after that, sending pauses until the payment goes through. Receiving mail is never paused.`,
      action: { label: "Update payment method", url: `${deps.config.appUrl}/app/settings/billing` },
      element: createElement(PaymentFailed, { brand: emailBrand(deps), workspace: org.name, amount, graceEnds }),
    }).catch(() => undefined);
  }
  return { started: true, graceEndsAt };
}

/** A paid invoice clears any grace period and sends the receipt. */
export async function onInvoicePaid(deps: Deps, org: Org, inv: InvoiceLike) {
  if (org.pastDueSince) {
    await deps.db.update(organizations).set({ pastDueSince: null, graceEndsAt: null }).where(eq(organizations.id, org.id));
    await audit(deps.db, { orgId: org.id, action: "billing.recovered", metadata: { invoice: inv.number ?? inv.id } });
  }
  if (!inv.amount_paid) return;
  const lines = (inv.lines?.data ?? []).map((l) => ({ description: l.description ?? "Subscription", amount: money(l.amount, inv.currency) }));
  const total = money(inv.amount_paid, inv.currency);
  const date = new Date((inv.created ?? Math.floor(deps.now().getTime() / 1000)) * 1000).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: org.timezone });
  const number = inv.number ?? inv.id ?? "";
  for (const to of await billingContacts(deps, org.id)) {
    await sendSystemEmail(deps, {
      to, orgId: org.id, template: "receipt", subject: `Receipt ${number} for ${org.name}: ${total}`,
      text: `Thanks. We received ${total} for ${org.name} on ${date}.${lines.map((l) => `\n${l.description}: ${l.amount}`).join("")}`,
      action: inv.hosted_invoice_url ? { label: "View invoice", url: inv.hosted_invoice_url } : undefined,
      element: createElement(Receipt, {
        brand: emailBrand(deps), workspace: org.name, number, date, lines, total,
        tax: inv.tax ? money(inv.tax, inv.currency) : undefined, url: inv.hosted_invoice_url ?? undefined,
      }),
    }).catch(() => undefined);
  }
}

/** Maintenance step: tells billing contacts once when a grace period ends. */
export async function enforceGracePeriods(deps: Deps) {
  const now = deps.now();
  const due = await deps.db.select().from(organizations)
    .where(and(isNotNull(organizations.pastDueSince), isNotNull(organizations.graceEndsAt), lte(organizations.graceEndsAt, now)));
  let notified = 0;
  for (const org of due) {
    const already = await deps.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, "billing.grace_ended"), gte(auditLogs.createdAt, org.pastDueSince!))).get();
    if (already) continue;
    await audit(deps.db, { orgId: org.id, action: "billing.grace_ended", metadata: { pastDueSince: org.pastDueSince!.toISOString() } });
    for (const to of await billingContacts(deps, org.id)) {
      await sendSystemEmail(deps, {
        to, orgId: org.id, template: "payment-failed", subject: `Sending is paused for ${org.name}`,
        text: `The grace period after a failed payment has ended, so sending from ${org.name} is paused. Receiving mail and access to existing mail continue. Updating the payment method restores sending straight away.`,
        action: { label: "Update payment method", url: `${deps.config.appUrl}/app/settings/billing` },
        element: createElement(PaymentFailed, { brand: emailBrand(deps), workspace: org.name, amount: "", graceEnds: "", final: true }),
      }).catch(() => undefined);
    }
    notified++;
  }
  return { notified };
}

export const USAGE_THRESHOLDS = [80, 100] as const;

/**
 * After a send: emails the billing contacts the first time in a UTC day that the
 * workspace crosses 80% and 100% of its daily sending limit.
 */
export async function maybeUsageAlert(deps: Deps, org: Org, used: number, limit: number) {
  const pct = (used / Math.max(1, limit)) * 100;
  const crossed = USAGE_THRESHOLDS.filter((t) => pct >= t).at(-1);
  if (!crossed) return null;
  const day = deps.now().toISOString().slice(0, 10);
  const key = `${day}:sends:${crossed}`;
  const sent = (org.usageAlerts ?? "").split(",").filter((k) => k.startsWith(day));
  if (sent.includes(key)) return null;
  await deps.db.update(organizations).set({ usageAlerts: [...sent, key].join(",") }).where(eq(organizations.id, org.id));
  const plan = PLANS[org.plan];
  const next = PLAN_ORDER[PLAN_ORDER.indexOf(org.plan) + 1];
  for (const to of await billingContacts(deps, org.id)) {
    await sendSystemEmail(deps, {
      to, orgId: org.id, template: "usage-alert",
      subject: crossed >= 100 ? `${org.name} reached its daily sending limit` : `${org.name} has used ${crossed}% of its daily sends`,
      text: `${org.name} has sent to ${used} of ${limit} recipients today on the ${plan.name} plan. The limit resets at midnight UTC.${next ? ` The ${PLANS[next].name} plan allows ${PLANS[next].limits.dailySends.toLocaleString("en-AU")} a day.` : ""}`,
      action: next ? { label: `Upgrade to ${PLANS[next].name}`, url: `${deps.config.appUrl}/app/settings/billing` } : undefined,
      element: createElement(UsageAlert, { brand: emailBrand(deps), workspace: org.name, metric: "daily sends", used, limit, plan: plan.name, nextPlan: next ? PLANS[next].name : undefined }),
    }).catch(() => undefined);
  }
  return crossed;
}
