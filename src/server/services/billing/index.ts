import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { billingEvents, organizations } from "../../db/schema";
import { HttpError, badRequest, forbidden } from "../../lib/errors";
import { PLANS, type PlanId } from "@/shared/plans";
import { audit } from "../audit";
import { getOrg, usage } from "../plans";
import { sentToday } from "../mail/delivery";
import { StripeClient, verifyStripeSignature, type StripeSubscription } from "./stripe";

export const notConnected = () => new HttpError(409, "billing_not_connected", "Billing isn't connected on this deployment. Plans switch instantly and nothing is charged.");

function client(deps: Deps) {
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) throw notConnected();
  return new StripeClient(b.stripeSecretKey, deps.fetch);
}

export function planForPrice(deps: Deps, priceId: string | undefined): PlanId | null {
  const { prices } = deps.config.billing;
  if (priceId && priceId === prices.pro) return "pro";
  if (priceId && priceId === prices.business) return "business";
  return null;
}

/** Statuses where the customer keeps their paid plan. */
const LIVE = new Set(["active", "trialing", "past_due"]);

export async function billingOverview(deps: Deps, orgId: string) {
  const org = await getOrg(deps.db, orgId);
  const [used, sends] = await Promise.all([usage(deps.db, orgId), sentToday(deps.db, orgId, deps.now())]);
  const plan = PLANS[org.plan];
  return {
    enabled: deps.config.billing.enabled,
    missing: deps.config.billing.enabled ? [] : deps.config.billing.missing,
    plan,
    subscription: org.stripeSubscriptionId ? {
      status: org.subscriptionStatus, currentPeriodEnd: org.currentPeriodEnd, cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    } : null,
    hasCustomer: !!org.stripeCustomerId,
    usage: { ...used, sendsToday: sends },
    limits: plan.limits,
  };
}

async function ensureCustomer(deps: Deps, auth: AuthContext) {
  const org = await getOrg(deps.db, auth.orgId);
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const c = await client(deps).createCustomer({ email: auth.email, name: org.name, orgId: org.id });
  await deps.db.update(organizations).set({ stripeCustomerId: c.id }).where(eq(organizations.id, org.id));
  return c.id;
}

export async function startCheckout(deps: Deps, auth: AuthContext, plan: PlanId) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can change billing.");
  const stripe = client(deps);
  const price = deps.config.billing.prices[plan as "pro" | "business"];
  if (!price) throw badRequest("That plan isn't sold through checkout.");
  const org = await getOrg(deps.db, auth.orgId);
  if (org.stripeSubscriptionId && LIVE.has(org.subscriptionStatus ?? "")) {
    throw new HttpError(409, "has_subscription", "You already have a subscription. Change plans from the billing portal.");
  }
  const customer = await ensureCustomer(deps, auth);
  const base = `${deps.config.appUrl}/app/settings/billing`;
  return stripe.createCheckoutSession({ customer, price, orgId: auth.orgId, successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancelled` });
}

export async function openPortal(deps: Deps, auth: AuthContext) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can change billing.");
  const stripe = client(deps);
  const customer = await ensureCustomer(deps, auth);
  return stripe.createPortalSession({ customer, returnUrl: `${deps.config.appUrl}/app/settings/billing` });
}

export async function listInvoices(deps: Deps, orgId: string) {
  if (!deps.config.billing.enabled) return [];
  const org = await getOrg(deps.db, orgId);
  if (!org.stripeCustomerId) return [];
  const res = await client(deps).listInvoices(org.stripeCustomerId);
  return res.data.map((i) => ({
    id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency,
    createdAt: new Date(i.created * 1000), periodStart: new Date(i.period_start * 1000), periodEnd: new Date(i.period_end * 1000),
    hostedUrl: i.hosted_invoice_url, pdfUrl: i.invoice_pdf,
  }));
}

async function findOrg(deps: Deps, customerId?: string, orgId?: string) {
  if (orgId) {
    const o = await deps.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (o) return o;
  }
  if (customerId) return (await deps.db.select().from(organizations).where(eq(organizations.stripeCustomerId, customerId)).get()) ?? null;
  return null;
}

/** Mirrors a subscription onto the workspace: plan, status, renewal date. */
export async function syncSubscription(deps: Deps, sub: StripeSubscription, deleted = false) {
  const org = await findOrg(deps, sub.customer, sub.metadata?.orgId);
  if (!org) return null;
  const item = sub.items?.data?.[0];
  const mapped = planForPrice(deps, item?.price?.id);
  const live = !deleted && LIVE.has(sub.status);
  const plan: PlanId = live && mapped ? mapped : "starter";
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  await deps.db.update(organizations).set({
    plan,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: deleted ? null : sub.id,
    subscriptionStatus: deleted ? "canceled" : sub.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: !deleted && !!sub.cancel_at_period_end,
  }).where(eq(organizations.id, org.id));
  if (plan !== org.plan) {
    await audit(deps.db, { orgId: org.id, action: "billing.plan_changed", metadata: { from: org.plan, to: plan, status: sub.status } });
  }
  return { orgId: org.id, plan };
}

interface StripeEvent { id: string; type: string; data: { object: Record<string, unknown> } }

/** Handles one verified webhook. Returns what happened, for logs and tests. */
export async function handleStripeWebhook(deps: Deps, rawBody: string, signature: string | undefined) {
  const secret = deps.config.billing.stripeWebhookSecret;
  if (!deps.config.billing.enabled || !secret) throw notConnected();
  if (!(await verifyStripeSignature(rawBody, signature, secret, deps.now()))) throw new HttpError(400, "bad_signature", "Invalid Stripe signature.");
  const event = JSON.parse(rawBody) as StripeEvent;
  const seen = await deps.db.select().from(billingEvents).where(eq(billingEvents.id, event.id)).get();
  if (seen) return { duplicate: true, type: event.type };
  const obj = event.data.object;
  let orgId: string | null = null;
  switch (event.type) {
    case "checkout.session.completed": {
      const subId = obj.subscription as string | undefined;
      const metaOrg = (obj.metadata as Record<string, string> | undefined)?.orgId ?? (obj.client_reference_id as string | undefined);
      if (subId) {
        const sub = await client(deps).retrieveSubscription(subId);
        sub.metadata = { ...(sub.metadata ?? {}), ...(metaOrg ? { orgId: metaOrg } : {}) };
        orgId = (await syncSubscription(deps, sub))?.orgId ?? null;
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
      orgId = (await syncSubscription(deps, obj as unknown as StripeSubscription))?.orgId ?? null;
      break;
    case "customer.subscription.deleted":
      orgId = (await syncSubscription(deps, obj as unknown as StripeSubscription, true))?.orgId ?? null;
      break;
    case "invoice.payment_failed":
    case "invoice.paid": {
      const org = await findOrg(deps, obj.customer as string);
      orgId = org?.id ?? null;
      if (org) {
        await audit(deps.db, {
          orgId: org.id, action: event.type === "invoice.paid" ? "billing.invoice_paid" : "billing.payment_failed",
          metadata: { amount: obj.amount_paid ?? obj.amount_due, currency: obj.currency, number: obj.number },
        });
      }
      break;
    }
    default:
      break;
  }
  await deps.db.insert(billingEvents).values({ id: event.id, type: event.type, orgId }).onConflictDoNothing();
  return { duplicate: false, type: event.type, orgId };
}
