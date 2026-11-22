/**
 * OPS1: the in-memory Stripe for the console billing route tests: a copy of the fake in
 * tests/console-billing-ops.test.ts (that file keeps its own), exported so route tests can share it.
 */

export const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz",
};

export type FakeSub = {
  id: string; object: string; customer: string; status: string; cancel_at_period_end: boolean; trial_end?: number | null; metadata: Record<string, string>;
  items: { data: { id?: string; quantity?: number; price: { id: string; lookup_key?: string; recurring?: { interval: string } }; current_period_end?: number }[] };
};

/** The same in-memory Stripe as tests/billing.test.ts, plus balance transactions, trials, cancel at period end and listing. */
export function fakeStripe() {
  const calls: { method: string; path: string; body: string }[] = [];
  const subs: Record<string, FakeSub> = {};
  const balances: Record<string, number> = {};
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const bal = url.pathname.match(/^\/v1\/customers\/([^/]+)\/balance_transactions$/);
    if (bal && method === "POST") {
      const p = new URLSearchParams(body);
      const amount = Number(p.get("amount"));
      balances[bal[1]!] = (balances[bal[1]!] ?? 0) + amount;
      return json({ id: `cbtxn_${calls.length}`, object: "customer_balance_transaction", amount, currency: p.get("currency"), ending_balance: balances[bal[1]!] });
    }
    if (url.pathname === "/v1/customers") return json({ id: "cus_new" });
    const cus = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
    if (cus && method === "GET") return json({ id: cus[1], object: "customer", balance: balances[cus[1]!] ?? 0, currency: "aud" });
    if (url.pathname === "/v1/prices" && method === "GET") return json({ object: "list", data: [], has_more: false, url: "/v1/prices" });
    if (url.pathname === "/v1/products") return json({ id: "prod_1", object: "product" });
    if (url.pathname === "/v1/prices") { const p = new URLSearchParams(body); return json({ id: `price_auto_${p.get("lookup_key")}`, object: "price", lookup_key: p.get("lookup_key"), unit_amount: Number(p.get("unit_amount")) }); }
    if (url.pathname === "/v1/subscriptions" && method === "GET") {
      const customer = url.searchParams.get("customer");
      return json({ object: "list", data: Object.values(subs).filter((s) => s.customer === customer).slice(0, 1), has_more: false, url: "/v1/subscriptions" });
    }
    if (url.pathname.startsWith("/v1/subscriptions/") && method === "POST") {
      const p = new URLSearchParams(body);
      const s = subs[url.pathname.split("/").pop()!]!;
      for (let n = 0; p.has(`items[${n}][id]`) || p.has(`items[${n}][price]`); n++) {
        const id = p.get(`items[${n}][id]`);
        const price = p.get(`items[${n}][price]`);
        const qty = p.get(`items[${n}][quantity]`);
        const asPrice = (pid: string) => ({ id: pid, lookup_key: pid.replace(/^price_auto_/, ""), recurring: { interval: pid.endsWith("_yearly") ? "year" : "month" } });
        const existing = s.items.data.find((i) => i.id === id);
        if (p.get(`items[${n}][deleted]`) === "true") { s.items.data = s.items.data.filter((i) => i !== existing); continue; }
        if (existing) { if (price) existing.price = price.startsWith("price_auto_") ? asPrice(price) : { id: price }; if (qty) existing.quantity = Number(qty); }
        else if (price) s.items.data.push({ id: `si_${n}_${price}`, quantity: Number(qty ?? 1), price: asPrice(price) });
      }
      if (p.has("trial_end")) { s.trial_end = Number(p.get("trial_end")); s.status = "trialing"; }
      if (p.has("cancel_at_period_end")) s.cancel_at_period_end = p.get("cancel_at_period_end") === "true";
      return json(s);
    }
    if (url.pathname.startsWith("/v1/subscriptions/")) {
      const s = subs[url.pathname.split("/").pop()!];
      return s ? json(s) : json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription" } }, 404);
    }
    if (url.pathname === "/v1/invoices") return json({ data: [{ id: "in_1", number: "MM-0001", status: "paid", total: 1200, currency: "aud", created: 1760000000, hosted_invoice_url: "https://invoice.stripe.com/i/1", invoice_pdf: "https://pay.stripe.com/1.pdf", period_start: 1760000000, period_end: 1762600000 }] });
    return json({ error: { message: "unexpected" } }, 400);
  };
  return { calls, subs, balances, fetch: fetchImpl as typeof fetch };
}

export const subOf = (customer: string, price = "price_pro", extra: Partial<FakeSub> = {}): FakeSub => ({
  id: "sub_1", object: "subscription", customer, status: "active", cancel_at_period_end: false, metadata: {},
  items: { data: [{ id: "si_plan", price: { id: price, recurring: { interval: "month" } }, current_period_end: 1792600000 }] }, ...extra,
});
