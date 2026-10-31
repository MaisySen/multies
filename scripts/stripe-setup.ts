/**
 * Creates Multies' Stripe products and prices (idempotent, by lookup key):
 *   npm run stripe:setup            (reads STRIPE_SECRET_KEY from the environment)
 *
 * Every add-on gets one product with a monthly price and a yearly price (R62: ten times
 * the monthly price, two months free; chosen at checkout, and the only interval when a
 * workspace's add-ons total under A$5 a month). A yearly price with the old amount is
 * replaced and its lookup key moved, so existing yearly subscriptions keep their price
 * until they change. The legacy Pro and Business prices are left alone. Prices are AUD,
 * tax exclusive. It also lets the Customer Portal change add-on quantities.
 *
 * R62: also makes the launch coupon (30 percent off, 3 months, repeating) and its
 * promotion code LAUNCH30, and adds charge.refunded to the webhook endpoints that point
 * at Multies (referral credits wait out refunds). Checks every coupon stays at or under
 * 50 percent off.
 */
import Stripe from "stripe";
import { ADDONS, ADDON_ORDER, PRICE_CURRENCY, addonLookupKey, yearlyPrice, type BillingInterval } from "../src/shared/plans";
import { LAUNCH_CODE, LAUNCH_COUPON_ID, LAUNCH_MONTHS, LAUNCH_PERCENT_OFF, MAX_PERCENT_OFF } from "../src/shared/offers";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY first.");
  process.exit(1);
}
if (!/^(sk|rk)_test_/.test(key) && !process.argv.includes("--live")) {
  console.error("This is a live key. Pass --live to create live prices on purpose.");
  process.exit(1);
}
const stripe = new Stripe(key, { appInfo: { name: "Multies setup" } });

async function product(id: string) {
  const a = ADDONS[id as keyof typeof ADDONS];
  const found = await stripe.products.search({ query: `metadata['addon']:'${id}'` }).catch(() => ({ data: [] as Stripe.Product[] }));
  const existing = found.data.find((p) => p.active);
  const fields = { name: `Multies ${a.name}`, description: a.description, metadata: { addon: id }, unit_label: a.unit.length <= 12 ? a.unit : undefined };
  if (existing) return stripe.products.update(existing.id, fields);
  return stripe.products.create(fields);
}

async function price(productId: string, id: string, interval: BillingInterval) {
  const a = ADDONS[id as keyof typeof ADDONS];
  const lookup = addonLookupKey(id as keyof typeof ADDONS, interval);
  const amount = Math.round((interval === "year" ? yearlyPrice(a.priceMonthly) : a.priceMonthly) * 100);
  const found = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  const current = found.data[0];
  if (current && current.unit_amount === amount && current.currency === PRICE_CURRENCY && current.recurring?.interval === interval && current.active) return current;
  // A price's amount can't change: make a new one and move the lookup key to it.
  return stripe.prices.create({
    product: productId, currency: PRICE_CURRENCY, unit_amount: amount, recurring: { interval }, lookup_key: lookup, transfer_lookup_key: true,
    tax_behavior: "exclusive", nickname: `${a.name} (${interval === "year" ? "yearly" : "monthly"})`, metadata: { addon: id },
  });
}

const out: Record<string, string> = {};
const products: { product: string; prices: string[] }[] = [];
for (const id of ADDON_ORDER) {
  const p = await product(id);
  const m = await price(p.id, id, "month");
  const y = await price(p.id, id, "year");
  out[m.lookup_key!] = m.id;
  out[y.lookup_key!] = y.id;
  products.push({ product: p.id, prices: [m.id, y.id] });
  console.log(`${id.padEnd(12)} ${p.id}  monthly ${m.id} (${(m.unit_amount ?? 0) / 100} ${m.currency})  yearly ${y.id} (${(y.unit_amount ?? 0) / 100} ${y.currency})`);
}

// The portal can change add-on quantities and cancel; it never offers the retired plans.
// STRIPE_PORTAL_CONFIG names Multies' own portal settings. The live account is shared with other businesses,
// so its default portal settings are never edited there: without STRIPE_PORTAL_CONFIG the step only runs in test mode.
const portalConfigId = process.env.STRIPE_PORTAL_CONFIG;
const isLive = !/^(sk|rk)_test_/.test(key);
const portal = portalConfigId
  ? await stripe.billingPortal.configurations.retrieve(portalConfigId)
  : isLive ? undefined : (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data[0];
if (!portal && isLive) console.log("portal: skipped (set STRIPE_PORTAL_CONFIG to Multies' own portal configuration; the account default is shared)");
if (portal) {
  await stripe.billingPortal.configurations.update(portal.id, {
    features: {
      subscription_update: { enabled: true, default_allowed_updates: ["quantity"], products, proration_behavior: "create_prorations" },
    },
  });
  console.log(`portal ${portal.id}: quantity changes enabled for ${products.length} add-ons`);
}
// R62: the launch coupon and its promotion code. Coupons can't be edited, so a wrong one stops the script.
if (LAUNCH_PERCENT_OFF > MAX_PERCENT_OFF) throw new Error(`The launch discount is over ${MAX_PERCENT_OFF} percent.`);
let coupon = await stripe.coupons.retrieve(LAUNCH_COUPON_ID).catch(() => null);
if (coupon && (coupon.percent_off !== LAUNCH_PERCENT_OFF || coupon.duration !== "repeating" || coupon.duration_in_months !== LAUNCH_MONTHS)) {
  throw new Error(`Coupon ${LAUNCH_COUPON_ID} exists with other terms. Delete it in Stripe, then run this again.`);
}
coupon ??= await stripe.coupons.create({
  id: LAUNCH_COUPON_ID, name: `Launch: ${LAUNCH_PERCENT_OFF}% off ${LAUNCH_MONTHS} months`, percent_off: LAUNCH_PERCENT_OFF,
  duration: "repeating", duration_in_months: LAUNCH_MONTHS, metadata: { offer: "launch" },
});
const codes = await stripe.promotionCodes.list({ code: LAUNCH_CODE, limit: 10 });
let promo = codes.data.find((p) => p.active);
// One per customer: a workspace redeems it once, on its first subscription.
promo ??= await stripe.promotionCodes.create({
  promotion: { type: "coupon", coupon: coupon.id }, code: LAUNCH_CODE, restrictions: { first_time_transaction: true }, metadata: { offer: "launch" },
});
console.log(`coupon ${coupon.id} (${coupon.percent_off}% off, ${coupon.duration_in_months} months)  promotion code ${LAUNCH_CODE} ${promo.id}`);
out.launch_coupon = coupon.id;
out.launch_promotion_code = promo.id;

// Every coupon in the account stays within the guardrail.
for await (const c of stripe.coupons.list({ limit: 100 })) {
  if ((c.percent_off ?? 0) > MAX_PERCENT_OFF) console.warn(`WARNING: coupon ${c.id} is ${c.percent_off}% off, over the ${MAX_PERCENT_OFF}% guardrail.`);
}

// R62: referral credits need refunds. Adds charge.refunded to endpoints already sending Multies' billing events.
// Only Multies' own hosts: other businesses on the same Stripe account use the same path.
const isMultiesHost = (url: string) => {
  const host = new URL(url).hostname;
  return host === "multies.si" || host.endsWith(".multies.si") || (host.startsWith("mymail") && host.endsWith(".workers.dev"));
};
for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
  if (!ep.url.endsWith("/api/webhooks/stripe") || !isMultiesHost(ep.url) || ep.enabled_events.includes("*") || ep.enabled_events.includes("charge.refunded")) continue;
  await stripe.webhookEndpoints.update(ep.id, { enabled_events: [...ep.enabled_events, "charge.refunded"] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[] });
  console.log(`webhook ${ep.id} ${ep.url}: added charge.refunded`);
}
console.log(JSON.stringify(out, null, 2));
