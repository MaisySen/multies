import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { billingEvents, organizations } from "../../db/schema";
import { HttpError, badRequest, forbidden } from "../../lib/errors";
import { PLANS, type PlanId } from "@/shared/plans";
import { audit } from "../audit";
import { getOrg, usage } from "../plans";
import { sentToday } from "../mail/delivery";
import { constructWebhookEvent, stripeClient, type Stripe } from "./stripe";
import { PRICE_CURRENCY } from "@/shared/plans";

/** The subscription fields MyMail mirrors. */
export type StripeSubscription = Pick<Stripe.Subscription, "id" | "status" | "cancel_at_period_end" | "metadata"> & {
  customer: string | { id: string };
  items: { data: { price: { id: string; lookup_key?: string | null }; current_period_end?: number }[] };
  current_period_end?: number;
};

export const notConnected = () => new HttpError(409, "billing_not_connected", "Billing isn't connected on this deployment. Plans switch instantly and nothing is charged.");

function client(deps: Deps) {
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) throw notConnected();
  return stripeClient(b.stripeSecretKey, deps.fetch);
}

const PAID = ["pro", "business"] as const;
type PaidPlan = (typeof PAID)[number];
export const lookupKey = (plan: PaidPlan) => `mymail_${plan}_monthly`;

/** Maps a Stripe price back to a plan, by configured price id or by lookup key. */
export function planForPrice(deps: Deps, price: { id?: string; lookup_key?: string | null } | undefined): PlanId | null {
  if (!price) return null;
  const { prices } = deps.config.billing;
  for (const plan of PAID) {
    if ((price.id && price.id === prices[plan]) || price.lookup_key === lookupKey(plan)) return plan;
  }
  return null;
}

const priceCache = new WeakMap<Deps, Partial<Record<PaidPlan, string>>>();

/**
 * The Stripe price for a plan: STRIPE_PRICE_* when set, otherwise the price with the
 * plan's lookup key. In test mode a missing product and price are created, so a bare
 * test key is enough to try the whole checkout.
 */
export async function resolvePrice(deps: Deps, stripe: Stripe, plan: PaidPlan): Promise<string> {
  const configured = deps.config.billing.prices[plan];
  if (configured) return configured;
  const cache = priceCache.get(deps) ?? {};
  priceCache.set(deps, cache);
  if (cache[plan]) return cache[plan]!;
  const found = await stripe.prices.list({ lookup_keys: [lookupKey(plan)], active: true, limit: 1 });
  let id = found.data[0]?.id;
  if (!id) {
    if (!deps.config.billing.testMode) throw new HttpError(409, "billing_price_missing", `No Stripe price with lookup key ${lookupKey(plan)}. Create one or set STRIPE_PRICE_${plan.toUpperCase()}.`);
    const def = PLANS[plan];
    const product = await stripe.products.create({ name: `${deps.config.appName} ${def.name}`, metadata: { plan } });
    const price = await stripe.prices.create({
      product: product.id, currency: PRICE_CURRENCY, unit_amount: def.priceMonthly * 100, recurring: { interval: "month" }, lookup_key: lookupKey(plan),
    });
    id = price.id;
  }
  cache[plan] = id;
  return id;
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
    testMode: deps.config.billing.testMode,
    webhooks: !!deps.config.billing.stripeWebhookSecret,
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
  const c = await client(deps).customers.create({ email: auth.email, name: org.name, metadata: { orgId: org.id } });
  await deps.db.update(organizations).set({ stripeCustomerId: c.id }).where(eq(organizations.id, org.id));
  return c.id;
}

export async function startCheckout(deps: Deps, auth: AuthContext, plan: PlanId) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can change billing.");
  const stripe = client(deps);
  if (!PAID.includes(plan as PaidPlan)) throw badRequest("That plan isn't sold through checkout.");
  const price = await resolvePrice(deps, stripe, plan as PaidPlan);
  const org = await getOrg(deps.db, auth.orgId);
  if (org.stripeSubscriptionId && LIVE.has(org.subscriptionStatus ?? "")) {
    throw new HttpError(409, "has_subscription", "You already have a subscription. Change plans from the billing portal.");
  }
  const customer = await ensureCustomer(deps, auth);
  const base = `${deps.config.appUrl}/app/settings/billing`;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription", customer, client_reference_id: auth.orgId,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { orgId: auth.orgId } },
    metadata: { orgId: auth.orgId },
    allow_promotion_codes: true,
    success_url: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}?checkout=cancelled`,
  });
  return { id: session.id, url: session.url };
}

export async function openPortal(deps: Deps, auth: AuthContext) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can change billing.");
  const stripe = client(deps);
  const customer = await ensureCustomer(deps, auth);
  const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${deps.config.appUrl}/app/settings/billing` });
  return { url: portal.url };
}

export async function listInvoices(deps: Deps, orgId: string) {
  if (!deps.config.billing.enabled) return [];
  const org = await getOrg(deps.db, orgId);
  if (!org.stripeCustomerId) return [];
  const res = await client(deps).invoices.list({ customer: org.stripeCustomerId, limit: 24 });
  return res.data.map((i) => ({
    id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency,
    createdAt: new Date(i.created * 1000), periodStart: new Date(i.period_start * 1000), periodEnd: new Date(i.period_end * 1000),
    hostedUrl: i.hosted_invoice_url, pdfUrl: i.invoice_pdf,
  }));
}

/**
 * Called when the customer returns from Checkout: reads the session from Stripe and
 * mirrors the subscription right away, so the plan changes without waiting for a webhook.
 */
export async function confirmCheckout(deps: Deps, auth: AuthContext, sessionId: string) {
  const stripe = client(deps);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const sessionOrg = session.metadata?.orgId ?? session.client_reference_id;
  if (sessionOrg !== auth.orgId) throw forbidden("That checkout belongs to another workspace.");
  if (session.status !== "complete" || !session.subscription) return { plan: (await getOrg(deps.db, auth.orgId)).plan, complete: false };
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as StripeSubscription;
  sub.metadata = { ...(sub.metadata ?? {}), orgId: auth.orgId };
  const res = await syncSubscription(deps, sub);
  return { plan: res?.plan ?? "starter", complete: true };
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
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const org = await findOrg(deps, customer, sub.metadata?.orgId);
  if (!org) return null;
  const item = sub.items?.data?.[0];
  const mapped = planForPrice(deps, item?.price);
  const live = !deleted && LIVE.has(sub.status);
  const plan: PlanId = live && mapped ? mapped : "starter";
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  await deps.db.update(organizations).set({
    plan,
    stripeCustomerId: customer,
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

/** Handles one verified webhook. Returns what happened, for logs and tests. */
export async function handleStripeWebhook(deps: Deps, rawBody: string, signature: string | undefined) {
  const secret = deps.config.billing.stripeWebhookSecret;
  if (!deps.config.billing.enabled || !secret) throw notConnected();
  if (!signature) throw new HttpError(400, "bad_signature", "Invalid Stripe signature.");
  const stripe = client(deps);
  let event: Stripe.Event;
  try {
    event = await constructWebhookEvent(stripe, rawBody, signature, secret, deps.now());
  } catch {
    throw new HttpError(400, "bad_signature", "Invalid Stripe signature.");
  }
  const seen = await deps.db.select().from(billingEvents).where(eq(billingEvents.id, event.id)).get();
  if (seen) return { duplicate: true, type: event.type };
  const obj = event.data.object as unknown as Record<string, unknown>;
  let orgId: string | null = null;
  switch (event.type) {
    case "checkout.session.completed": {
      const subId = obj.subscription as string | undefined;
      const metaOrg = (obj.metadata as Record<string, string> | undefined)?.orgId ?? (obj.client_reference_id as string | undefined);
      if (subId) {
        const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as StripeSubscription;
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
