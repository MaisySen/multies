import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { formEncode, signStripePayload, verifyStripeSignature } from "@/server/services/billing/stripe";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz",
};

/** A tiny in-memory Stripe: records calls and answers the endpoints MyMail uses. */
function fakeStripe() {
  const calls: { method: string; path: string; body: string }[] = [];
  const subs: Record<string, unknown> = {};
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/customers") return json({ id: "cus_123" });
    if (url.pathname === "/v1/checkout/sessions") return json({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    if (url.pathname === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session/x" });
    if (url.pathname.startsWith("/v1/subscriptions/")) return json(subs[url.pathname.split("/").pop()!] ?? { error: { message: "No such subscription" } }, subs[url.pathname.split("/").pop()!] ? 200 : 404);
    if (url.pathname === "/v1/invoices") return json({ data: [{ id: "in_1", number: "MM-0001", status: "paid", total: 1200, currency: "usd", created: 1760000000, hosted_invoice_url: "https://invoice.stripe.com/i/1", invoice_pdf: "https://pay.stripe.com/1.pdf", period_start: 1760000000, period_end: 1762600000 }] });
    return json({ error: { message: "unexpected" } }, 400);
  };
  return { calls, subs, fetch: fetchImpl as typeof fetch };
}

const sub = (status: string, price = "price_pro", extra: Record<string, unknown> = {}) => ({
  id: "sub_1", object: "subscription", customer: "cus_123", status, cancel_at_period_end: false,
  items: { data: [{ price: { id: price }, current_period_end: 1762600000 }] }, metadata: {}, ...extra,
});

async function postWebhook(app: Awaited<ReturnType<typeof makeTestApp>>["app"], event: unknown, secret = "whsec_test", when = new Date()) {
  const raw = JSON.stringify(event);
  const res = await app.request("/api/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": await signStripePayload(raw, secret, when), "content-type": "application/json" } });
  return { status: res.status, body: await res.json() };
}

describe("Stripe primitives", () => {
  it("form-encodes nested params the way Stripe expects", () => {
    expect(formEncode({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], metadata: { orgId: "o" } }))
      .toBe("mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BorgId%5D=o");
  });
  it("verifies signatures and rejects stale or forged ones", async () => {
    const now = new Date();
    const h = await signStripePayload("{}", "s", now);
    expect(await verifyStripeSignature("{}", h, "s", now)).toBe(true);
    expect(await verifyStripeSignature("{ }", h, "s", now)).toBe(false);
    expect(await verifyStripeSignature("{}", h, "other", now)).toBe(false);
    expect(await verifyStripeSignature("{}", h, "s", new Date(now.getTime() + 10 * 60_000))).toBe(false);
  });
});

describe("billing when not connected", () => {
  it("reports what's missing and keeps free plan switching", async () => {
    const ctx = await makeTestApp();
    const a = new Client(ctx.app);
    await a.signup();
    const b = await a.get("/api/billing");
    expect(b.body.enabled).toBe(false);
    expect(b.body.missing).toContain("STRIPE_SECRET_KEY");
    expect((await a.post("/api/billing/checkout", { plan: "pro" })).body.error.code).toBe("billing_not_connected");
    expect((await a.post("/api/org/plan", { plan: "pro" })).status).toBe(200);
    expect((await a.get("/api/billing/invoices")).body.invoices).toEqual([]);
  });
});

describe("billing with Stripe", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeEach(async () => { stripe = fakeStripe(); ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch }); });

  it("starts checkout for the owner and syncs the plan from webhooks", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    expect((await a.post("/api/org/plan", { plan: "pro" })).body.error.code).toBe("use_billing");
    const co = await a.post("/api/billing/checkout", { plan: "pro" });
    expect(co.body.url).toContain("checkout.stripe.com");
    const checkoutCall = stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(checkoutCall.body).toContain("line_items%5B0%5D%5Bprice%5D=price_pro");
    const orgId = (await a.get("/api/account/me")).body.organization.id;

    stripe.subs.sub_1 = sub("active");
    const done = await postWebhook(ctx.app, { id: "evt_1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_123", metadata: { orgId } } } });
    expect(done.status).toBe(200);
    const billing = (await a.get("/api/billing")).body;
    expect(billing.plan.id).toBe("pro");
    expect(billing.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: false });

    // Upgrade, then a replayed event is ignored.
    const up = await postWebhook(ctx.app, { id: "evt_2", type: "customer.subscription.updated", data: { object: sub("active", "price_biz", { cancel_at_period_end: true }) } });
    expect(up.body.duplicate).toBe(false);
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "business" }, subscription: { cancelAtPeriodEnd: true } });
    expect((await postWebhook(ctx.app, { id: "evt_2", type: "customer.subscription.updated", data: { object: sub("active", "price_pro") } })).body.duplicate).toBe(true);
    expect((await a.get("/api/billing")).body.plan.id).toBe("business");

    // Past due keeps the plan; deletion drops to Starter.
    await postWebhook(ctx.app, { id: "evt_3", type: "customer.subscription.updated", data: { object: sub("past_due", "price_biz") } });
    expect((await a.get("/api/billing")).body.plan.id).toBe("business");
    await postWebhook(ctx.app, { id: "evt_4", type: "customer.subscription.deleted", data: { object: sub("canceled", "price_biz") } });
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "starter" }, subscription: null });

    const audit = (await a.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toContain("billing.plan_changed");
  });

  it("refuses unsigned webhooks and non-owners", async () => {
    const res = await ctx.app.request("/api/webhooks/stripe", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } });
    expect(res.status).toBe(400);
    expect((await postWebhook(ctx.app, { id: "evt_x", type: "invoice.paid", data: { object: {} } }, "wrong-secret")).status).toBe(400);

    const owner = new Client(ctx.app);
    await owner.signup("o@acme.io");
    await owner.post("/api/org/plan", { plan: "pro" }).catch(() => {});
    // Give the workspace a second seat by subscribing, then invite an admin.
    const orgId = (await owner.get("/api/account/me")).body.organization.id;
    await owner.post("/api/billing/checkout", { plan: "pro" });
    stripe.subs.sub_1 = sub("active");
    await postWebhook(ctx.app, { id: "evt_5", type: "checkout.session.completed", data: { object: { subscription: "sub_1", metadata: { orgId } } } });
    const inv = await owner.post("/api/team/invites", { email: "adm@acme.io", role: "admin" });
    const adm = new Client(ctx.app);
    await adm.signup("adm@acme.io");
    await adm.post(`/api/invites/${inv.body.link.split("/").pop()}/accept`);
    expect((await adm.post("/api/billing/portal")).status).toBe(403);
    expect((await owner.post("/api/billing/portal")).body.url).toContain("billing.stripe.com");
    const invoices = (await owner.get("/api/billing/invoices")).body.invoices;
    expect(invoices[0]).toMatchObject({ number: "MM-0001", total: 1200, currency: "usd", status: "paid" });
  });
});
