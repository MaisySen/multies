import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { constructWebhookEvent, signStripePayload, stripeClient } from "@/server/services/billing/stripe";
import { enforceGracePeriods, maybeUsageAlert } from "@/server/services/billing/dunning";
import { organizations } from "@/server/db/schema";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz",
};

/** A tiny in-memory Stripe: records calls and answers the endpoints Multies uses. */
function fakeStripe() {
  const calls: { method: string; path: string; body: string }[] = [];
  const subs: Record<string, unknown> = {};
  let lastCheckout: URLSearchParams | undefined;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/customers") return json({ id: "cus_123" });
    if (url.pathname === "/v1/checkout/sessions") {
      lastCheckout = new URLSearchParams(body);
      return json({ id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_1" });
    }
    if (url.pathname === "/v1/checkout/sessions/cs_1") {
      return json({ id: "cs_1", object: "checkout.session", status: "complete", subscription: "sub_1", client_reference_id: lastCheckout?.get("client_reference_id"), metadata: { orgId: lastCheckout?.get("metadata[orgId]") } });
    }
    if (url.pathname === "/v1/prices" && (init?.method ?? "GET") === "GET") return json({ object: "list", data: [], has_more: false, url: "/v1/prices" });
    if (url.pathname === "/v1/products") return json({ id: "prod_1", object: "product" });
    if (url.pathname === "/v1/prices") { const p = new URLSearchParams(body); return json({ id: `price_auto_${p.get("lookup_key")}`, object: "price", lookup_key: p.get("lookup_key"), unit_amount: Number(p.get("unit_amount")) }); }
    if (url.pathname === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session/x" });
    if (url.pathname === "/v1/invoices/create_preview") {
      const p = new URLSearchParams(body);
      const up = p.get("subscription_details[items][0][price]") === "price_biz";
      return json({ object: "invoice", currency: "aud", lines: { data: up ? [{ amount: -600 }, { amount: 2400 }] : [{ amount: 1800 }, { amount: -900 }] } });
    }
    if (url.pathname.startsWith("/v1/subscriptions/") && init?.method === "POST") {
      const p = new URLSearchParams(body);
      const s = subs[url.pathname.split("/").pop()!] as { items: { data: { id?: string; quantity?: number; price: { id: string; lookup_key?: string; recurring?: { interval: string } } }[] } };
      // Apply items[n][id|price|quantity|deleted] the way Stripe does.
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
      return json(s);
    }
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
  const res = await app.request("/api/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": await signStripePayload(stripeClient("sk_test_fake", fetch), raw, secret, when), "content-type": "application/json" } });
  return { status: res.status, body: await res.json() };
}

describe("Stripe webhook signatures (official SDK)", () => {
  it("verifies signatures and rejects stale or forged ones", async () => {
    const stripe = stripeClient("sk_test_fake", fetch);
    const now = new Date();
    const h = await signStripePayload(stripe, "{}", "s", now);
    await expect(constructWebhookEvent(stripe, "{}", h, "s", now)).resolves.toBeTruthy();
    await expect(constructWebhookEvent(stripe, "{ }", h, "s", now)).rejects.toThrow();
    await expect(constructWebhookEvent(stripe, "{}", h, "other", now)).rejects.toThrow();
    await expect(constructWebhookEvent(stripe, "{}", h, "s", new Date(now.getTime() + 10 * 60_000))).rejects.toThrow();
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
    expect((await a.post("/api/billing/checkout", { plan: "pro" })).body.error.code).toBe("plan_retired");
    expect((await a.post("/api/org/plan", { plan: "pro" })).status).toBe(200);
    expect((await a.get("/api/billing/invoices")).body.invoices).toEqual([]);
  });
});

describe("billing with Stripe", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeEach(async () => { stripe = fakeStripe(); ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch }); });

  it("keeps legacy Pro and Business subscriptions syncing from webhooks, and no longer sells them", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    expect((await a.post("/api/org/plan", { plan: "pro" })).body.error.code).toBe("use_billing");
    const co = await a.post("/api/billing/checkout", { plan: "pro" });
    expect(co.status).toBe(410);
    expect(co.body.error.code).toBe("plan_retired");
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

    // Past due keeps the plan; deletion drops to Free.
    await postWebhook(ctx.app, { id: "evt_3", type: "customer.subscription.updated", data: { object: sub("past_due", "price_biz") } });
    expect((await a.get("/api/billing")).body.plan.id).toBe("business");
    await postWebhook(ctx.app, { id: "evt_4", type: "customer.subscription.deleted", data: { object: sub("canceled", "price_biz") } });
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "starter" }, subscription: null });

    const audit = (await a.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toContain("billing.plan_changed");
  });

  it("runs dunning: grace period, paused sending, one final notice, receipt on recovery", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    stripe.subs.sub_1 = sub("active");
    await postWebhook(ctx.app, { id: "evt_1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_123", metadata: { orgId } } } });
    const domainId = (await a.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const box = (await a.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox;

    let now = Date.now();
    ctx.deps.now = () => new Date(now);
    const failed = { id: "in_9", number: "MM-0009", customer: "cus_123", amount_due: 1200, currency: "aud" };
    await postWebhook(ctx.app, { id: "evt_f1", type: "invoice.payment_failed", data: { object: failed } }, "whsec_test", new Date(now));
    await postWebhook(ctx.app, { id: "evt_f2", type: "invoice.payment_failed", data: { object: failed } }, "whsec_test", new Date(now));
    const notices = () => ctx.outbound.sent.filter((m) => /didn't go through|Sending is paused/.test(m.subject));
    expect(notices()).toHaveLength(1); // a retry failing again sends nothing new
    expect(notices()[0]!.html).toContain("Update payment method");
    const org = await ctx.db.query.organizations.findFirst();
    expect(org!.graceEndsAt!.getTime() - org!.pastDueSince!.getTime()).toBe(7 * 86400_000);

    // During grace sending works (it fails later for the unverified domain, not for payment).
    expect((await a.post("/api/mail/send", { mailboxId: box.id, to: ["x@example.com"], subject: "Hi", text: "Hi" })).body.error.code).not.toBe("payment_required");
    now += 8 * 86400_000;
    const paused = await a.post("/api/mail/send", { mailboxId: box.id, to: ["x@example.com"], subject: "Hi", text: "Hi" });
    expect(paused.status).toBe(402);
    expect(paused.body.error.code).toBe("payment_required");
    expect((await enforceGracePeriods(ctx.deps)).notified).toBe(1);
    expect((await enforceGracePeriods(ctx.deps)).notified).toBe(0);
    expect(notices()).toHaveLength(2);

    const paid = { id: "in_9", number: "MM-0009", customer: "cus_123", amount_paid: 1200, tax: 109, currency: "aud", hosted_invoice_url: "https://invoice.stripe.com/i/9", lines: { data: [{ description: "Multies Pro", amount: 1200 }] } };
    await postWebhook(ctx.app, { id: "evt_p1", type: "invoice.paid", data: { object: paid } }, "whsec_test", new Date(now));
    expect((await ctx.db.query.organizations.findFirst())!.pastDueSince).toBeNull();
    const receipt = ctx.outbound.sent.find((m) => m.subject.startsWith("Receipt MM-0009"))!;
    expect(receipt.html).toContain("Payment received: $12.00");
    expect(receipt.html).toContain("Includes GST");
    expect(receipt.html).toContain("Multies Pro");
    expect((await a.post("/api/mail/send", { mailboxId: box.id, to: ["x@example.com"], subject: "Hi", text: "Hi" })).body.error.code).not.toBe("payment_required");
    const audit = (await a.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["billing.payment_failed", "billing.grace_ended", "billing.recovered", "billing.invoice_paid"]));
  });

  it("changes plans in place with Stripe proration, previewed first", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    stripe.subs.sub_1 = sub("active", "price_pro", { items: { data: [{ id: "si_1", price: { id: "price_pro" }, current_period_end: 1762600000 }] } });
    await postWebhook(ctx.app, { id: "evt_1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_123", metadata: { orgId } } } });

    const preview = await a.get("/api/billing/change-preview?plan=business");
    expect(preview.body).toMatchObject({ plan: "business", upgrade: true, dueNow: 1800, credit: 0, currency: "aud" });
    const change = await a.post("/api/billing/change", { plan: "business" });
    expect(change.status).toBe(200);
    const update = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1")!;
    expect(new URLSearchParams(update.body).get("proration_behavior")).toBe("always_invoice");
    expect((await a.get("/api/billing")).body.plan.id).toBe("business");

    const down = await a.get("/api/billing/change-preview?plan=pro");
    expect(down.body).toMatchObject({ upgrade: false, dueNow: 0, credit: 0 });
    expect((await a.post("/api/billing/change", { plan: "business" })).status).toBe(400);
  });

  it("emails usage alerts once per threshold per day", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const org = (await ctx.db.query.organizations.findFirst())!;
    expect(await maybeUsageAlert(ctx.deps, org, 50, 100)).toBeNull();
    expect(await maybeUsageAlert(ctx.deps, org, 80, 100)).toBe(80);
    const fresh = async () => (await ctx.db.select().from(organizations).get())!;
    expect(await maybeUsageAlert(ctx.deps, await fresh(), 90, 100)).toBeNull();
    expect(await maybeUsageAlert(ctx.deps, await fresh(), 100, 100)).toBe(100);
    const alerts = ctx.outbound.sent.filter((m) => /daily sends|daily sending limit/.test(m.subject));
    expect(alerts.map((m) => m.subject)).toEqual(["Acme has used 80% of its daily sends", "Acme reached its daily sending limit"]);
    expect(alerts[1]!.html).toContain("Add a send boost");
    expect(alerts[1]!.text).toContain("A$2 a month");
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

describe("billing with only a test secret key", () => {
  it("creates add-on prices by lookup key, bills small totals yearly and confirms checkout without a webhook", async () => {
    const stripe = fakeStripe();
    const ctx = await makeTestApp({ STRIPE_SECRET_KEY: "sk_test_only" }, { fetch: stripe.fetch });
    const a = new Client(ctx.app);
    await a.signup("solo@acme.io");
    expect((await a.get("/api/billing")).body).toMatchObject({ enabled: true, testMode: true, webhooks: false, plan: { id: "starter", name: "Free" } });
    // A$1 domain + 2 x A$1 agent inboxes = A$3 a month, under A$5, so it bills A$36 a year.
    const co = await a.post("/api/billing/addons", { addons: { domain: 1, agent_inbox: 2 } });
    expect(co.status).toBe(200);
    expect(co.body).toMatchObject({ applied: false, interval: "year" });
    const created = stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/prices").map((c) => new URLSearchParams(c.body));
    expect(created.map((p) => [p.get("lookup_key"), p.get("unit_amount"), p.get("recurring[interval]"), p.get("currency")])).toEqual([
      ["mymail_addon_domain_yearly", "1200", "year", "aud"],
      ["mymail_addon_agent_inbox_yearly", "1200", "year", "aud"],
    ]);
    const checkout = new URLSearchParams(stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!.body);
    expect(checkout.get("line_items[0][price]")).toBe("price_auto_mymail_addon_domain_yearly");
    expect(checkout.get("line_items[1][quantity]")).toBe("2");
    expect(checkout.get("success_url")).toContain("session_id={CHECKOUT_SESSION_ID}");

    const yearly = (key: string, quantity: number) => ({ id: `si_${key}`, quantity, price: { id: `price_auto_${key}`, lookup_key: key, recurring: { interval: "year" } }, current_period_end: 1792600000 });
    stripe.subs.sub_1 = { ...sub("active"), items: { data: [yearly("mymail_addon_domain_yearly", 1), yearly("mymail_addon_agent_inbox_yearly", 2)] } };
    const confirmed = await a.post("/api/billing/checkout/confirm", { sessionId: "cs_1" });
    expect(confirmed.body).toEqual({ plan: "starter", complete: true });
    const b = (await a.get("/api/billing")).body;
    expect(b.addons).toEqual({ domain: 1, agent_inbox: 2 });
    expect(b.interval).toBe("year");
    expect(b.limits).toMatchObject({ domains: 2, agentInboxes: 5, agentMessagesMonthly: 5000, mailboxes: 3 });
    expect(b.charge).toEqual({ interval: "year", amount: 36, monthly: 3 });

    const other = new Client(ctx.app);
    await other.signup("other@else.io");
    expect((await other.post("/api/billing/checkout/confirm", { sessionId: "cs_1" })).status).toBe(403);
  });
});

describe("add-ons on one subscription", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeEach(async () => { stripe = fakeStripe(); ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch }); });

  const monthly = (key: string, quantity: number) => ({ id: `si_${key}`, quantity, price: { id: `price_auto_${key}`, lookup_key: key, recurring: { interval: "month" } }, current_period_end: 1792600000 });

  it("changes quantities in place, switches to monthly at A$5 and refuses removals the workspace still uses", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    stripe.subs.sub_1 = { ...sub("active"), items: { data: [{ ...monthly("mymail_addon_domain_yearly", 1), price: { id: "price_auto_mymail_addon_domain_yearly", lookup_key: "mymail_addon_domain_yearly", recurring: { interval: "year" } } }] } };
    await postWebhook(ctx.app, { id: "evt_a1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_123", metadata: { orgId } } } });
    expect((await a.get("/api/billing")).body).toMatchObject({ addons: { domain: 1 }, interval: "year", limits: { domains: 2 } });

    // Two mailbox packs (A$6) take the total to A$7: every item moves to monthly prices.
    const res = await a.post("/api/billing/addons", { addons: { domain: 1, mailboxes: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, interval: "month" });
    const update = new URLSearchParams(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1").at(-1)!.body);
    expect(update.get("proration_behavior")).toBe("always_invoice");
    expect(update.get("items[0][id]")).toBe("si_mymail_addon_domain_yearly");
    expect(update.get("items[0][price]")).toBe("price_auto_mymail_addon_domain_monthly");
    expect(update.get("items[1][price]")).toBe("price_auto_mymail_addon_mailboxes_monthly");
    expect(update.get("items[1][quantity]")).toBe("2");
    const b = (await a.get("/api/billing")).body;
    expect(b).toMatchObject({ addons: { domain: 1, mailboxes: 2 }, interval: "month", limits: { domains: 2, mailboxes: 13 } });

    // Two domains in use: the extra domain can't be removed until one goes.
    await a.post("/api/domains", { name: "acme.io" });
    await a.post("/api/domains", { name: "acme.com.au" });
    const refused = await a.post("/api/billing/addons", { addons: { mailboxes: 2 } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("domains");

    // A webhook from Stripe (say, the portal) is the source of truth for quantities.
    // An item on the retired AI assistant price (bring your own AI) is ignored, so it grants nothing.
    stripe.subs.sub_1 = { ...sub("active"), items: { data: [monthly("mymail_addon_domain_monthly", 3), monthly("mymail_addon_mailboxes_monthly", 2), monthly("mymail_addon_ai_monthly", 1)] } };
    await postWebhook(ctx.app, { id: "evt_a2", type: "customer.subscription.updated", data: { object: stripe.subs.sub_1 } });
    expect((await a.get("/api/billing")).body.addons).toEqual({ domain: 3, mailboxes: 2 });
    const audit = (await a.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["billing.addons_changed", "billing.addons_synced"]));

    // Cancelling drops every add-on.
    await postWebhook(ctx.app, { id: "evt_a3", type: "customer.subscription.deleted", data: { object: stripe.subs.sub_1 } });
    expect((await a.get("/api/billing")).body).toMatchObject({ addons: {}, limits: { domains: 1 } });
  });

  it("lets a legacy Pro customer add add-ons on the same subscription, or move to Free with add-ons", async () => {
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    stripe.subs.sub_1 = sub("active", "price_pro", { items: { data: [{ id: "si_pro", quantity: 1, price: { id: "price_pro", recurring: { interval: "month" } }, current_period_end: 1792600000 }] } });
    await postWebhook(ctx.app, { id: "evt_l1", type: "checkout.session.completed", data: { object: { subscription: "sub_1", customer: "cus_123", metadata: { orgId } } } });
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "pro", legacy: true }, limits: { domains: 5 } });

    const add = await a.post("/api/billing/addons", { addons: { agent_inbox: 1 } });
    expect(add.body).toMatchObject({ applied: true, interval: "month" });
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "pro" }, addons: { agent_inbox: 1 }, limits: { agentInboxes: 11 } });

    const preview = await a.post("/api/billing/addons/preview", { addons: { domain: 4, mailboxes: 1 }, dropLegacyPlan: true });
    expect(preview.status).toBe(200);
    expect(preview.body.charge).toEqual({ interval: "month", amount: 7, monthly: 7 });
    const moved = await a.post("/api/billing/addons", { addons: { domain: 4, mailboxes: 1 }, dropLegacyPlan: true });
    expect(moved.status).toBe(200);
    const last = new URLSearchParams(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1").at(-1)!.body);
    expect([...last.entries()].filter(([k]) => k.endsWith("[deleted]")).length).toBe(2);
    expect((await a.get("/api/billing")).body).toMatchObject({ plan: { id: "starter" }, addons: { domain: 4, mailboxes: 1 }, limits: { domains: 5, mailboxes: 8, seats: 8 } });
  });

  it("applies add-ons instantly when billing isn't connected", async () => {
    const local = await makeTestApp();
    const a = new Client(local.app);
    await a.signup("owner@acme.io");
    const res = await a.post("/api/billing/addons", { addons: { storage: 2, mailboxes: 1 } });
    expect(res.body).toEqual({ applied: true, url: null });
    expect((await a.get("/api/billing")).body.limits).toMatchObject({ storageMb: 3072 + 40960, mailboxes: 8 });
    expect((await a.post("/api/billing/addons", { addons: { bogus: 1 } })).status).toBe(400);
    // The AI assistant add-on is retired: Multies never sells AI (bring your own AI).
    expect((await a.post("/api/billing/addons", { addons: { ai: 1 } })).status).toBe(400);
  });
});
