import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { billingEvents, organizations } from "../../db/schema";
import { HttpError, badRequest, forbidden } from "../../lib/errors";
import {
  ADDONS, ADDON_ORDER, PLANS, PLAN_ORDER, PRICE_CURRENCY, addonLookupKey, chargeFor, effectiveLimits, intervalFor, isAddonId,
  type AddonId, type AddonQuantities, type BillingInterval, type PlanId,
} from "@/shared/plans";
import { audit } from "../audit";
import { getAddons, getOrg, overLimits, setAddons, usage } from "../plans";
import { sentToday } from "../mail/delivery";
import { constructWebhookEvent, stripeClient, type Stripe } from "./stripe";
import { onInvoicePaid, onPaymentFailed, sendingPausedForPayment } from "./dunning";

/** The subscription fields MyMail mirrors. */
export type StripePrice = { id: string; lookup_key?: string | null; metadata?: Record<string, string> | null; recurring?: { interval?: string } | null };
export type StripeSubscription = Pick<Stripe.Subscription, "id" | "status" | "cancel_at_period_end" | "metadata"> & {
  customer: string | { id: string };
  items: { data: { id?: string; quantity?: number; price: StripePrice; current_period_end?: number }[] };
  current_period_end?: number;
};

export const notConnected = () => new HttpError(409, "billing_not_connected", "Billing isn't connected on this deployment. Add-ons apply instantly and nothing is charged.");

function client(deps: Deps) {
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) throw notConnected();
  return stripeClient(b.stripeSecretKey, deps.fetch);
}

/** The legacy plans, still billed for the customers on them. */
const PAID = ["pro", "business"] as const;
type PaidPlan = (typeof PAID)[number];
export const lookupKey = (plan: PaidPlan) => `mymail_${plan}_monthly`;

/** Maps a Stripe price back to a legacy plan, by configured price id or by lookup key. */
export function planForPrice(deps: Deps, price: { id?: string; lookup_key?: string | null } | undefined): PlanId | null {
  if (!price) return null;
  const { prices } = deps.config.billing;
  for (const plan of PAID) {
    if ((price.id && price.id === prices[plan]) || price.lookup_key === lookupKey(plan)) return plan;
  }
  return null;
}

/** Maps a Stripe price to an add-on, by lookup key or by the price's metadata. */
export function addonForPrice(price: StripePrice | undefined): AddonId | null {
  if (!price) return null;
  const m = price.lookup_key?.match(/^mymail_addon_([a-z_]+)_(monthly|yearly)$/);
  const id = m?.[1] ?? price.metadata?.addon;
  return isAddonId(id) ? id : null;
}

const priceCache = new WeakMap<Deps, Map<string, string>>();

/**
 * A Stripe price id by lookup key, cached per deployment. Prices are created by
 * `npm run stripe:setup`; in test mode a missing one is created on first use, so a bare
 * test key is enough to try the whole checkout.
 */
async function priceByKey(deps: Deps, stripe: Stripe, key: string, create: () => { name: string; amount: number; interval: BillingInterval; metadata: Record<string, string> }) {
  const cache = priceCache.get(deps) ?? new Map<string, string>();
  priceCache.set(deps, cache);
  const hit = cache.get(key);
  if (hit) return hit;
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  let id = found.data[0]?.id;
  if (!id) {
    if (!deps.config.billing.testMode) throw new HttpError(409, "billing_price_missing", `No Stripe price with lookup key ${key}. Run npm run stripe:setup against this account.`);
    const spec = create();
    const product = await stripe.products.create({ name: spec.name, metadata: spec.metadata });
    const price = await stripe.prices.create({
      product: product.id, currency: PRICE_CURRENCY, unit_amount: Math.round(spec.amount * 100), recurring: { interval: spec.interval },
      lookup_key: key, metadata: spec.metadata, tax_behavior: "exclusive",
    });
    id = price.id;
  }
  cache.set(key, id);
  return id;
}

/** The Stripe price for a legacy plan: STRIPE_PRICE_* when set, otherwise by lookup key. */
export async function resolvePrice(deps: Deps, stripe: Stripe, plan: PaidPlan): Promise<string> {
  const configured = deps.config.billing.prices[plan];
  if (configured) return configured;
  return priceByKey(deps, stripe, lookupKey(plan), () => ({ name: `${deps.config.appName} ${PLANS[plan].name}`, amount: PLANS[plan].priceMonthly, interval: "month", metadata: { plan } }));
}

/** The Stripe price for one unit of an add-on, monthly or yearly (twelve times the monthly price). */
export async function resolveAddonPrice(deps: Deps, stripe: Stripe, id: AddonId, interval: BillingInterval): Promise<string> {
  const a = ADDONS[id];
  return priceByKey(deps, stripe, addonLookupKey(id, interval), () => ({
    name: `${deps.config.appName} ${a.name}`, amount: interval === "year" ? a.priceMonthly * 12 : a.priceMonthly, interval, metadata: { addon: id },
  }));
}

/** Statuses where the customer keeps what they pay for. */
const LIVE = new Set(["active", "trialing", "past_due"]);

function cleanAddons(input: Record<string, number>): AddonQuantities {
  const out: AddonQuantities = {};
  for (const [k, v] of Object.entries(input)) {
    if (!isAddonId(k)) throw badRequest(`Unknown add-on: ${k}.`);
    if (!Number.isInteger(v) || v < 0) throw badRequest("Add-on quantities must be whole numbers.");
    if (v > ADDONS[k].maxQuantity) throw badRequest(`${ADDONS[k].name}: up to ${ADDONS[k].maxQuantity}.`);
    if (v > 0) out[k] = v;
  }
  return out;
}

export async function billingOverview(deps: Deps, orgId: string) {
  const org = await getOrg(deps.db, orgId);
  const [used, sends, addons] = await Promise.all([usage(deps.db, orgId, deps.now()), sentToday(deps.db, orgId, deps.now()), getAddons(deps.db, orgId)]);
  const plan = PLANS[org.plan];
  const base = plan.legacy ? plan.priceMonthly : 0;
  return {
    enabled: deps.config.billing.enabled,
    missing: deps.config.billing.enabled ? [] : deps.config.billing.missing,
    testMode: deps.config.billing.testMode,
    webhooks: !!deps.config.billing.stripeWebhookSecret,
    plan,
    addons,
    charge: chargeFor(addons, base),
    interval: org.billingInterval ?? null,
    catalog: ADDON_ORDER.map((id) => ADDONS[id]),
    subscription: org.stripeSubscriptionId ? {
      status: org.subscriptionStatus, currentPeriodEnd: org.currentPeriodEnd, cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    } : null,
    hasCustomer: !!org.stripeCustomerId,
    dunning: org.pastDueSince ? { pastDueSince: org.pastDueSince, graceEndsAt: org.graceEndsAt, sendingPaused: sendingPausedForPayment(org, deps.now()) } : null,
    usage: { ...used, sendsToday: sends },
    limits: effectiveLimits(plan, addons),
  };
}

async function ensureCustomer(deps: Deps, auth: AuthContext) {
  const org = await getOrg(deps.db, auth.orgId);
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const c = await client(deps).customers.create({
    email: auth.email, name: org.name, metadata: { orgId: org.id },
    // The workspace country pre-fills checkout; en-AU receipts and invoices.
    address: { country: org.country }, preferred_locales: ["en-AU"],
  });
  await deps.db.update(organizations).set({ stripeCustomerId: c.id }).where(eq(organizations.id, org.id));
  return c.id;
}

function assertOwner(auth: AuthContext) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can change billing.");
}

/** Refuses a change that would leave the workspace over its limits. */
async function assertFits(deps: Deps, orgId: string, plan: PlanId, addons: AddonQuantities) {
  const over = overLimits(await usage(deps.db, orgId, deps.now()), effectiveLimits(PLANS[plan], addons));
  if (over.length) throw badRequest(`Remove some ${over.join(" and ")} first: the workspace would be over its limits without these add-ons.`);
}

/** The old plans are no longer sold. Existing subscriptions keep working. */
export async function startCheckout(_deps: Deps, auth: AuthContext, _plan: PlanId): Promise<{ id: string; url: string | null }> {
  assertOwner(auth);
  throw new HttpError(410, "plan_retired", "Pro and Business are no longer sold. Every workspace starts on Free; add only what you need from the add-ons.");
}

/** Line items for a set of add-ons at one interval. */
async function addonItems(deps: Deps, stripe: Stripe, addons: AddonQuantities, interval: BillingInterval) {
  const ids = ADDON_ORDER.filter((id) => (addons[id] ?? 0) > 0);
  return Promise.all(ids.map(async (id) => ({ id, price: await resolveAddonPrice(deps, stripe, id, interval), quantity: addons[id]! })));
}

/**
 * Buying add-ons. Without a subscription this starts a Stripe Checkout with every add-on
 * on one subscription; with one, the subscription's items change in place (see
 * `updateAddons`). When billing isn't connected (local, demo) they apply instantly.
 */
export async function startAddonCheckout(deps: Deps, auth: AuthContext, input: Record<string, number>) {
  assertOwner(auth);
  const addons = cleanAddons(input);
  if (!Object.keys(addons).length) throw badRequest("Choose at least one add-on.");
  const org = await getOrg(deps.db, auth.orgId);
  if (!deps.config.billing.enabled) {
    await assertFits(deps, auth.orgId, org.plan, addons);
    await setAddons(deps.db, auth.orgId, addons);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "billing.addons_changed", metadata: { addons, charged: false } });
    return { applied: true as const, url: null };
  }
  if (org.stripeSubscriptionId && LIVE.has(org.subscriptionStatus ?? "")) {
    throw new HttpError(409, "has_subscription", "You already have a subscription. Change add-ons in place instead.");
  }
  const stripe = client(deps);
  const interval = intervalFor(addons);
  const items = await addonItems(deps, stripe, addons, interval);
  const customer = await ensureCustomer(deps, auth);
  const base = `${deps.config.appUrl}/app/settings/billing`;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription", customer, client_reference_id: auth.orgId,
    line_items: items.map((i) => ({ price: i.price, quantity: i.quantity })),
    subscription_data: { metadata: { orgId: auth.orgId } },
    metadata: { orgId: auth.orgId },
    allow_promotion_codes: true,
    // Charge exactly the AUD price everywhere instead of converting to the visitor's currency.
    adaptive_pricing: { enabled: false },
    success_url: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}?checkout=cancelled`,
  });
  return { applied: false as const, url: session.url, id: session.id, interval };
}

/** Builds the item changes that turn a live subscription into `addons` (and optionally drops a legacy plan). */
async function plannedItems(deps: Deps, auth: AuthContext, input: Record<string, number>, opts: { dropLegacyPlan?: boolean } = {}) {
  assertOwner(auth);
  const addons = cleanAddons(input);
  const org = await getOrg(deps.db, auth.orgId);
  if (!org.stripeSubscriptionId || !LIVE.has(org.subscriptionStatus ?? "")) throw new HttpError(409, "no_subscription", "There's no active subscription to change. Start one with checkout.");
  const stripe = client(deps);
  const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId) as unknown as StripeSubscription;
  const planItem = sub.items.data.find((i) => planForPrice(deps, i.price));
  const keepPlan = planItem && !opts.dropLegacyPlan;
  const nextPlan: PlanId = keepPlan ? planForPrice(deps, planItem.price)! : "starter";
  await assertFits(deps, auth.orgId, nextPlan, addons);
  const interval = intervalFor(addons, keepPlan ? PLANS[nextPlan].priceMonthly : 0);
  const wanted = await addonItems(deps, stripe, addons, interval);
  const changes: { id?: string; price?: string; quantity?: number; deleted?: boolean }[] = [];
  const used = new Set<string>();
  for (const w of wanted) {
    const existing = sub.items.data.find((i) => i.id && !used.has(i.id) && addonForPrice(i.price) === w.id);
    if (existing?.id) { used.add(existing.id); changes.push({ id: existing.id, price: w.price, quantity: w.quantity }); }
    else changes.push({ price: w.price, quantity: w.quantity });
  }
  for (const i of sub.items.data) {
    if (!i.id || used.has(i.id)) continue;
    if (i === planItem && keepPlan) continue;
    changes.push({ id: i.id, deleted: true });
  }
  if (!changes.some((c) => !c.deleted) && !keepPlan) {
    throw badRequest("That would remove everything you pay for. Cancel the subscription from the billing portal instead.");
  }
  const before = await getAddons(deps.db, auth.orgId);
  const baseBefore = PLANS[org.plan].legacy ? PLANS[org.plan].priceMonthly : 0;
  const more = chargeFor(addons, keepPlan ? PLANS[nextPlan].priceMonthly : 0).monthly >= chargeFor(before, baseBefore).monthly;
  // Additions are charged now for the rest of the period; reductions credit the next invoice.
  const proration = more ? ("always_invoice" as const) : ("create_prorations" as const);
  return { stripe, org, sub, changes, addons, interval, proration, more, nextPlan };
}

/** What an add-on change costs today, from Stripe's own proration maths. */
export async function previewAddons(deps: Deps, auth: AuthContext, input: Record<string, number>, opts: { dropLegacyPlan?: boolean } = {}) {
  const { stripe, org, sub, changes, interval, proration, more, addons, nextPlan } = await plannedItems(deps, auth, input, opts);
  const preview = await stripe.invoices.createPreview({
    customer: org.stripeCustomerId!, subscription: sub.id,
    subscription_details: { items: changes, proration_behavior: proration, proration_date: Math.floor(deps.now().getTime() / 1000) },
  });
  const net = preview.lines.data.reduce((sum, l) => sum + l.amount, 0);
  return { addons, interval, currency: preview.currency, dueNow: more ? Math.max(0, net) : 0, credit: more ? 0 : Math.max(0, -net), charge: chargeFor(addons, PLANS[nextPlan].legacy ? PLANS[nextPlan].priceMonthly : 0) };
}

/** Changes add-ons on the one subscription in place, with proration. The webhook syncs too. */
export async function updateAddons(deps: Deps, auth: AuthContext, input: Record<string, number>, opts: { dropLegacyPlan?: boolean } = {}) {
  if (!deps.config.billing.enabled) return startAddonCheckout(deps, auth, input);
  const { stripe, org, sub, changes, addons, interval, proration } = await plannedItems(deps, auth, input, opts);
  const updated = await stripe.subscriptions.update(sub.id, {
    items: changes, proration_behavior: proration, payment_behavior: "pending_if_incomplete",
    metadata: { ...(sub.metadata ?? {}), orgId: org.id },
  });
  await syncSubscription(deps, updated as unknown as StripeSubscription);
  await audit(deps.db, { orgId: org.id, actorUserId: auth.userId, actorEmail: auth.email, action: "billing.addons_changed", metadata: { addons, interval, proration, dropLegacyPlan: !!opts.dropLegacyPlan } });
  return { applied: true as const, url: null, interval, pending: !!(updated as unknown as { pending_update?: unknown }).pending_update };
}

/** The live subscription and its legacy plan item, for moving between Pro and Business. */
async function liveItem(deps: Deps, auth: AuthContext, plan: PlanId) {
  assertOwner(auth);
  if (!PAID.includes(plan as PaidPlan)) throw badRequest("To move to Free, keep the add-ons you want and drop the legacy plan from Billing.");
  const org = await getOrg(deps.db, auth.orgId);
  if (!org.stripeSubscriptionId || !LIVE.has(org.subscriptionStatus ?? "")) throw new HttpError(409, "no_subscription", "There's no active subscription to change.");
  if (!PLANS[org.plan].legacy) throw new HttpError(410, "plan_retired", "Pro and Business are no longer sold. Add only what you need from the add-ons.");
  if (org.plan === plan) throw badRequest("You're already on that plan.");
  const stripe = client(deps);
  const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
  const item = sub.items.data.find((i) => planForPrice(deps, i.price as StripePrice)) ?? sub.items.data[0];
  if (!item) throw new HttpError(409, "no_subscription", "The subscription has no plan item.");
  const price = await resolvePrice(deps, stripe, plan as PaidPlan);
  const upgrade = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(org.plan);
  if (!upgrade) {
    const over = overLimits(await usage(deps.db, auth.orgId, deps.now()), effectiveLimits(PLANS[plan], await getAddons(deps.db, auth.orgId)));
    if (over.length) throw badRequest(`Remove some ${over.join(" and ")} before moving to ${PLANS[plan].name}.`);
  }
  const proration = upgrade ? ("always_invoice" as const) : ("create_prorations" as const);
  return { stripe, org, sub, item, price, upgrade, proration };
}

/** What a legacy plan change costs today. */
export async function previewPlanChange(deps: Deps, auth: AuthContext, plan: PlanId) {
  const { stripe, org, sub, item, price, upgrade, proration } = await liveItem(deps, auth, plan);
  const preview = await stripe.invoices.createPreview({
    customer: org.stripeCustomerId!, subscription: sub.id,
    subscription_details: { items: [{ id: item.id, price }], proration_behavior: proration, proration_date: Math.floor(deps.now().getTime() / 1000) },
  });
  const net = preview.lines.data.reduce((sum, l) => sum + l.amount, 0);
  return { plan, upgrade, currency: preview.currency, dueNow: upgrade ? Math.max(0, net) : 0, credit: upgrade ? 0 : Math.max(0, -net) };
}

/** Moves a legacy subscriber between Pro and Business in place, with proration. */
export async function changePlan(deps: Deps, auth: AuthContext, plan: PlanId) {
  const { stripe, org, sub, item, price, upgrade, proration } = await liveItem(deps, auth, plan);
  const updated = await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price }], proration_behavior: proration, payment_behavior: "pending_if_incomplete",
    metadata: { ...(sub.metadata ?? {}), orgId: org.id },
  });
  await syncSubscription(deps, updated as unknown as StripeSubscription);
  await audit(deps.db, { orgId: org.id, actorUserId: auth.userId, actorEmail: auth.email, action: `plan.${upgrade ? "upgraded" : "downgraded"}`, metadata: { from: org.plan, to: plan, proration } });
  return { plan: PLANS[plan], pending: !!updated.pending_update };
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

/**
 * Cancels a workspace's subscription immediately when the workspace is deleted, with a
 * prorated credit for the unused time. Never blocks the deletion: a failure is reported.
 */
export async function cancelForDeletion(deps: Deps, org: typeof organizations.$inferSelect) {
  if (!org.stripeSubscriptionId || org.subscriptionStatus === "canceled") return false;
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) return false;
  try {
    await stripeClient(b.stripeSecretKey, deps.fetch).subscriptions.cancel(org.stripeSubscriptionId, { prorate: true, invoice_now: true });
    return true;
  } catch (err) {
    deps.reportError?.(err, { where: "cancelForDeletion", org: org.id });
    return false;
  }
}

/**
 * Mirrors a subscription onto the workspace: the legacy plan (if any), every add-on and
 * its quantity, the interval, the status and the renewal date.
 */
export async function syncSubscription(deps: Deps, sub: StripeSubscription, deleted = false) {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const org = await findOrg(deps, customer, sub.metadata?.orgId);
  if (!org) return null;
  const live = !deleted && LIVE.has(sub.status);
  const items = sub.items?.data ?? [];
  let mapped: PlanId | null = null;
  const addons: AddonQuantities = {};
  for (const item of items) {
    mapped = mapped ?? planForPrice(deps, item.price);
    const a = addonForPrice(item.price);
    if (a) addons[a] = (addons[a] ?? 0) + (item.quantity ?? 1);
  }
  const plan: PlanId = live && mapped ? mapped : "starter";
  const interval = items[0]?.price?.recurring?.interval;
  const periodEnd = sub.current_period_end ?? items[0]?.current_period_end;
  const before = await getAddons(deps.db, org.id);
  await deps.db.update(organizations).set({
    plan,
    stripeCustomerId: customer,
    stripeSubscriptionId: deleted ? null : sub.id,
    subscriptionStatus: deleted ? "canceled" : sub.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: !deleted && !!sub.cancel_at_period_end,
    billingInterval: !deleted && (interval === "month" || interval === "year") ? interval : null,
  }).where(eq(organizations.id, org.id));
  const nextAddons = live ? addons : {};
  await setAddons(deps.db, org.id, nextAddons);
  if (plan !== org.plan) {
    await audit(deps.db, { orgId: org.id, action: "billing.plan_changed", metadata: { from: org.plan, to: plan, status: sub.status } });
  }
  if (JSON.stringify(before) !== JSON.stringify(nextAddons)) {
    await audit(deps.db, { orgId: org.id, action: "billing.addons_synced", metadata: { from: before, to: nextAddons, status: sub.status } });
  }
  return { orgId: org.id, plan, addons: nextAddons };
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
        if (event.type === "invoice.paid") await onInvoicePaid(deps, org, obj);
        else await onPaymentFailed(deps, org, obj);
      }
      break;
    }
    default:
      break;
  }
  await deps.db.insert(billingEvents).values({ id: event.id, type: event.type, orgId }).onConflictDoNothing();
  return { duplicate: false, type: event.type, orgId };
}
