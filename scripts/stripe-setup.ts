/**
 * Creates MyMail's Stripe products and prices (idempotent, by lookup key):
 *   npm run stripe:setup            (reads STRIPE_SECRET_KEY from the environment)
 *
 * Every add-on gets one product with a monthly price and a yearly price (twelve times
 * the monthly price, used when a workspace's add-ons total under A$5 a month). The
 * legacy Pro and Business prices are left alone. Prices are AUD, tax exclusive.
 * It also lets the Customer Portal change add-on quantities.
 */
import Stripe from "stripe";
import { ADDONS, ADDON_ORDER, PRICE_CURRENCY, addonLookupKey, type BillingInterval } from "../src/shared/plans";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY first.");
  process.exit(1);
}
if (!/^(sk|rk)_test_/.test(key) && !process.argv.includes("--live")) {
  console.error("This is a live key. Pass --live to create live prices on purpose.");
  process.exit(1);
}
const stripe = new Stripe(key, { appInfo: { name: "MyMail setup" } });

async function product(id: string) {
  const a = ADDONS[id as keyof typeof ADDONS];
  const found = await stripe.products.search({ query: `metadata['addon']:'${id}'` }).catch(() => ({ data: [] as Stripe.Product[] }));
  const existing = found.data.find((p) => p.active);
  const fields = { name: `MyMail ${a.name}`, description: a.description, metadata: { addon: id }, unit_label: a.unit.length <= 12 ? a.unit : undefined };
  if (existing) return stripe.products.update(existing.id, fields);
  return stripe.products.create(fields);
}

async function price(productId: string, id: string, interval: BillingInterval) {
  const a = ADDONS[id as keyof typeof ADDONS];
  const lookup = addonLookupKey(id as keyof typeof ADDONS, interval);
  const amount = Math.round((interval === "year" ? a.priceMonthly * 12 : a.priceMonthly) * 100);
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
const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
const portal = configs.data[0];
if (portal) {
  await stripe.billingPortal.configurations.update(portal.id, {
    features: {
      subscription_update: { enabled: true, default_allowed_updates: ["quantity"], products, proration_behavior: "create_prorations" },
    },
  });
  console.log(`portal ${portal.id}: quantity changes enabled for ${products.length} add-ons`);
}
console.log(JSON.stringify(out, null, 2));
