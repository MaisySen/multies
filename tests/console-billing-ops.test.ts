import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, billingEvents, organizations, referrals } from "@/server/db/schema";
import { handleStripeWebhook, syncSubscription, type BillingTarget } from "@/server/services/billing";
import { signStripePayload, stripeClient } from "@/server/services/billing/stripe";
import { OPS1_0174, summarizeStripeEvent } from "@/server/services/billing/ops1-0174";
import { effectivePlanId, getOrg } from "@/server/services/plans";
import {
  CREDIT_MAX_CENTS, SUBSCRIPTION_SORT_FIELDS, expireComps, getWorkspaceBilling, listBillingEvents, listPastDue, listReferrals, listSubscriptions,
  opsAddCredit, opsCancelAtPeriodEnd, opsChangePlan, opsExtendGrace, opsExtendTrial, opsResync, opsSetComp, type PageInput,
} from "@/server/services/console/billing-ops";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz",
};
const DAY = 86_400_000;

type FakeSub = {
  id: string; object: string; customer: string; status: string; cancel_at_period_end: boolean; trial_end?: number | null; metadata: Record<string, string>;
  items: { data: { id?: string; quantity?: number; price: { id: string; lookup_key?: string; recurring?: { interval: string } }; current_period_end?: number }[] };
};

/** The same in-memory Stripe as tests/billing.test.ts, plus balance transactions, trials, cancel at period end and listing. */
function fakeStripe() {
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

const subOf = (customer: string, price = "price_pro", extra: Partial<FakeSub> = {}): FakeSub => ({
  id: "sub_1", object: "subscription", customer, status: "active", cancel_at_period_end: false, metadata: {},
  items: { data: [{ id: "si_plan", price: { id: price, recurring: { interval: "month" } }, current_period_end: 1792600000 }] }, ...extra,
});

const page = (field: string, dir: "asc" | "desc" = "desc", limit = 20, cursor: PageInput["cursor"] = null): PageInput => ({ limit, cursor, sort: { field, dir } });
const operator = { userId: "usr_operator", email: "ops@multies.example" };

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;

async function newWorkspace(ctx: Ctx, email: string, name: string) {
  const c = new Client(ctx.app);
  await c.signup(email, "Owner", name);
  return (await c.get("/api/account/me")).body.organization.id as string;
}

/** A workspace on legacy Pro with a live subscription sub_1 on customer cus_1, mirrored the way a webhook would. */
async function subscribed(ctx: Ctx, stripe: ReturnType<typeof fakeStripe>, extra: Partial<FakeSub> = {}) {
  const orgId = await newWorkspace(ctx, "owner@acme.io", "Acme");
  stripe.subs.sub_1 = subOf("cus_1", "price_pro", { metadata: { orgId }, ...extra });
  await syncSubscription(ctx.deps, stripe.subs.sub_1);
  return { orgId, target: { orgId, actor: operator } satisfies BillingTarget };
}

describe("console billing reads", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  let ctx: Ctx;
  beforeEach(async () => { stripe = fakeStripe(); ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch }); });

  it("lists subscriptions with filters, search and keyset paging, and refuses an unknown sort field", async () => {
    const a = await newWorkspace(ctx, "a@a.io", "Alpha");
    const b = await newWorkspace(ctx, "b@b.io", "Bravo");
    const c = await newWorkspace(ctx, "c@c.io", "Charlie");
    await newWorkspace(ctx, "d@d.io", "Delta"); // no billing: never listed
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a", subscriptionStatus: "active", plan: "pro", currentPeriodEnd: new Date(3 * DAY) }).where(eq(organizations.id, a));
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_b", subscriptionStatus: "past_due", plan: "business", currentPeriodEnd: new Date(1 * DAY) }).where(eq(organizations.id, b));
    await ctx.db.update(organizations).set({ compPlan: true }).where(eq(organizations.id, c));

    const all = await listSubscriptions(ctx.deps, { page: page("name", "asc") });
    expect(all.items.map((i) => i.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(all.next).toBeNull();
    expect(all.items[2]).toMatchObject({ comp: true, plan: "starter", effectivePlan: "business", stripeCustomerId: null });
    expect(all.items[0]).toMatchObject({ stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a", status: "active", currentPeriodEnd: new Date(3 * DAY).toISOString() });

    // Keyset paging, one at a time, by period end descending (no period end sorts as 0).
    const seen: string[] = [];
    let cursor: PageInput["cursor"] = null;
    for (let i = 0; i < 5; i++) {
      const p = await listSubscriptions(ctx.deps, { page: page("currentPeriodEnd", "desc", 1, cursor) });
      seen.push(...p.items.map((x) => x.name));
      if (!p.next) break;
      cursor = p.next;
    }
    expect(seen).toEqual(["Alpha", "Bravo", "Charlie"]);

    expect((await listSubscriptions(ctx.deps, { filters: { status: "past_due" }, page: page("createdAt") })).items.map((i) => i.orgId)).toEqual([b]);
    expect((await listSubscriptions(ctx.deps, { filters: { plan: "pro" }, page: page("createdAt") })).items.map((i) => i.orgId)).toEqual([a]);
    expect((await listSubscriptions(ctx.deps, { filters: { comp: true }, page: page("createdAt") })).items.map((i) => i.orgId)).toEqual([c]);
    expect((await listSubscriptions(ctx.deps, { q: "cus_b", page: page("createdAt") })).items.map((i) => i.orgId)).toEqual([b]);
    expect((await listSubscriptions(ctx.deps, { q: "rav", page: page("createdAt") })).items.map((i) => i.orgId)).toEqual([b]);

    expect(SUBSCRIPTION_SORT_FIELDS).not.toContain("stripeCustomerId");
    await expect(listSubscriptions(ctx.deps, { page: page("stripeCustomerId") })).rejects.toMatchObject({ code: "invalid_sort" });
    await expect(listSubscriptions(ctx.deps, { page: page("name", "asc", 101) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(listSubscriptions(ctx.deps, { page: page("name", "asc", 1, { v: 5, id: "x" }) })).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(listSubscriptions(ctx.deps, { filters: { plan: "enterprise" as never }, page: page("name") })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("lists past-due workspaces with the dunning stage and grace end", async () => {
    const now = Date.now();
    const a = await newWorkspace(ctx, "a@a.io", "In grace");
    const b = await newWorkspace(ctx, "b@b.io", "Paused");
    await newWorkspace(ctx, "c@c.io", "Fine");
    await ctx.db.update(organizations).set({ pastDueSince: new Date(now - 2 * DAY), graceEndsAt: new Date(now + 5 * DAY) }).where(eq(organizations.id, a));
    await ctx.db.update(organizations).set({ pastDueSince: new Date(now - 10 * DAY), graceEndsAt: new Date(now - 3 * DAY) }).where(eq(organizations.id, b));
    const res = await listPastDue(ctx.deps, page("pastDueSince", "asc"));
    expect(res.items.map((i) => [i.name, i.stage, i.sendingPaused, i.daysPastDue])).toEqual([["Paused", "paused", true, 10], ["In grace", "grace", false, 2]]);
    expect(res.items[1]!.graceEndsAt).toBe(new Date(now + 5 * DAY).toISOString());
    const first = await listPastDue(ctx.deps, page("graceEndsAt", "desc", 1));
    expect(first.items.map((i) => i.orgId)).toEqual([a]);
    expect((await listPastDue(ctx.deps, page("graceEndsAt", "desc", 1, first.next))).items.map((i) => i.orgId)).toEqual([b]);
  });

  it("lists processed Stripe events by workspace and type, with paging", async () => {
    const a = await newWorkspace(ctx, "a@a.io", "Alpha");
    await ctx.db.insert(billingEvents).values([
      { id: "evt_1", type: "invoice.paid", orgId: a, createdAt: new Date(1000) },
      { id: "evt_2", type: "invoice.payment_failed", orgId: a, createdAt: new Date(2000) },
      { id: "evt_3", type: "customer.subscription.updated", orgId: null, createdAt: new Date(3000) },
    ]);
    const all = await listBillingEvents(ctx.deps, { page: page("createdAt") });
    expect(all.items.map((e) => e.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
    expect(all.items[1]).toMatchObject({ orgId: a, orgName: "Alpha", type: "invoice.payment_failed", summary: null });
    expect((await listBillingEvents(ctx.deps, { orgId: a, page: page("createdAt") })).items.map((e) => e.id)).toEqual(["evt_2", "evt_1"]);
    expect((await listBillingEvents(ctx.deps, { type: "invoice.paid", page: page("createdAt") })).items.map((e) => e.id)).toEqual(["evt_1"]);
    const p1 = await listBillingEvents(ctx.deps, { page: page("createdAt", "asc", 2) });
    expect(p1.items.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
    expect(p1.next).toEqual({ v: 2000, id: "evt_2" });
    expect((await listBillingEvents(ctx.deps, { page: page("createdAt", "asc", 2, p1.next) })).items.map((e) => e.id)).toEqual(["evt_3"]);
    await expect(listBillingEvents(ctx.deps, { type: "x'; drop", page: page("createdAt") })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("stores a plain summary with each processed webhook once 0174 is in", async () => {
    const orgId = await newWorkspace(ctx, "a@a.io", "Alpha");
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_a" }).where(eq(organizations.id, orgId));
    const raw = JSON.stringify({ id: "evt_sum", type: "invoice.payment_failed", data: { object: { customer: "cus_a", amount_due: 1200, currency: "aud", number: "MM-9" } } });
    const signature = await signStripePayload(stripeClient("sk_test_fake", fetch), raw, "whsec_test", new Date());
    expect(await handleStripeWebhook(ctx.deps, raw, signature)).toMatchObject({ duplicate: false, orgId });
    const [e] = (await listBillingEvents(ctx.deps, { orgId, page: page("createdAt") })).items;
    expect(e).toMatchObject({ id: "evt_sum", type: "invoice.payment_failed", summary: OPS1_0174.eventSummary ? "Invoice MM-9 payment failed: A$12.00" : null });
  });

  it("lists referrals with both workspace names, by status or either side", async () => {
    const a = await newWorkspace(ctx, "a@a.io", "Referrer");
    const b = await newWorkspace(ctx, "b@b.io", "Referred");
    const c = await newWorkspace(ctx, "c@c.io", "Other");
    await ctx.db.insert(referrals).values([
      { id: "ref_1", referrerOrgId: a, referredOrgId: b, code: "ABCDEFGH", status: "credited", creditedAt: new Date(5000), referrerCreditCents: 300, referredCreditCents: 300, createdAt: new Date(1000) },
      { id: "ref_2", referrerOrgId: c, referredOrgId: "org_gone", code: "JKLMNPQR", status: "pending", createdAt: new Date(2000) },
    ]);
    const all = await listReferrals(ctx.deps, { page: page("createdAt") });
    expect(all.items.map((r) => r.id)).toEqual(["ref_2", "ref_1"]);
    expect(all.items[1]).toMatchObject({ referrerName: "Referrer", referredName: "Referred", referrerCreditCents: 300, creditedAt: new Date(5000).toISOString() });
    expect(all.items[0]).toMatchObject({ referredName: null });
    expect((await listReferrals(ctx.deps, { filters: { status: "pending" }, page: page("createdAt") })).items.map((r) => r.id)).toEqual(["ref_2"]);
    expect((await listReferrals(ctx.deps, { filters: { orgId: b }, page: page("creditedAt") })).items.map((r) => r.id)).toEqual(["ref_1"]);
    await expect(listReferrals(ctx.deps, { filters: { status: "nope" }, page: page("createdAt") })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("reads one workspace's billing: plan, Stripe ids only, add-ons, usage against limits, invoices and events", async () => {
    const { orgId } = await subscribed(ctx, stripe);
    await ctx.db.insert(billingEvents).values({ id: "evt_w", type: "invoice.paid", orgId });
    const w = await getWorkspaceBilling(ctx.deps, orgId);
    expect(w).toMatchObject({
      orgId, name: "Acme", plan: "pro", effectivePlan: "pro", billing: { enabled: true, testMode: true },
      comp: { on: false, until: null, note: null, expirySupported: OPS1_0174.comp },
      stripe: { customerId: "cus_1", subscriptionId: "sub_1" },
      subscription: { status: "active", interval: "month", cancelAtPeriodEnd: false },
      dunning: null, invoicesError: null,
    });
    expect(w.invoices[0]).toMatchObject({ number: "MM-0001", total: 1200, currency: "aud" });
    expect(w.usage).toMatchObject({ seats: 1, sendsToday: 0 });
    expect(w.limits.seats).toBeGreaterThan(0);
    expect(w.recentEvents.map((e) => e.id)).toEqual(["evt_w"]);
    const text = JSON.stringify(w);
    expect(text).not.toContain("sk_test");
    expect(text).not.toContain("whsec");
  });
});

describe("console billing actions", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  let ctx: Ctx;
  beforeEach(async () => { stripe = fakeStripe(); ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch }); });

  it("changes the plan of a workspace the operator does not own, and audits the operator on the workspace", async () => {
    const { orgId, target } = await subscribed(ctx, stripe);
    const res = await opsChangePlan(ctx.deps, target, "business");
    expect(res.before).toMatchObject({ plan: "pro", effectivePlan: "pro" });
    expect(res.after).toMatchObject({ plan: "business", effectivePlan: "business" });
    expect(res.pending).toBe(false);
    const update = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1")!;
    expect(new URLSearchParams(update.body).get("items[0][price]")).toBe("price_biz");
    const row = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "plan.upgraded")).get();
    expect(row).toMatchObject({ orgId, actorUserId: operator.userId, actorEmail: operator.email });

    await expect(opsChangePlan(ctx.deps, target, "business")).rejects.toMatchObject({ code: "bad_request" });
    await expect(opsChangePlan(ctx.deps, target, "enterprise" as never)).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("moves a legacy subscriber to Free keeping their add-ons", async () => {
    const domain = { id: "si_dom", quantity: 1, price: { id: "price_auto_mymail_addon_domain_monthly", lookup_key: "mymail_addon_domain_monthly", recurring: { interval: "month" } } };
    const { target } = await subscribed(ctx, stripe);
    stripe.subs.sub_1!.items.data.push(domain);
    await syncSubscription(ctx.deps, stripe.subs.sub_1!);
    const res = await opsChangePlan(ctx.deps, target, "starter");
    expect(res.before).toMatchObject({ plan: "pro", addons: { domain: 1 } });
    expect(res.after).toMatchObject({ plan: "starter", addons: { domain: 1 } });
    // Without the plan the add-ons total A$1 a month, under A$5, so the product rule (R62) bills them yearly.
    expect(stripe.subs.sub_1!.items.data.map((i) => i.price.id)).toEqual(["price_auto_mymail_addon_domain_yearly"]);
  });

  it("turns a comp on and off, and effectivePlanId follows it", async () => {
    const { orgId, target } = await subscribed(ctx, stripe);
    const on = await opsSetComp(ctx.deps, target, "business", null, "Partner workspace");
    expect(on.before).toMatchObject({ comp: false, effectivePlan: "pro" });
    expect(on.after).toMatchObject({ comp: true, plan: "pro", effectivePlan: "business", compNote: OPS1_0174.comp ? "Partner workspace" : null });
    expect(on.warnings).toEqual(["subscription_still_billing"]);
    expect(effectivePlanId(await getOrg(ctx.db, orgId))).toBe("business");
    // A comp workspace's plan doesn't change from billing actions.
    await expect(opsChangePlan(ctx.deps, target, "business")).rejects.toMatchObject({ code: "comp_plan" });

    const off = await opsSetComp(ctx.deps, target, null);
    expect(off.after).toMatchObject({ comp: false, effectivePlan: "pro", compNote: null, compUntil: null });
    expect(effectivePlanId(await getOrg(ctx.db, orgId))).toBe("pro");

    await expect(opsSetComp(ctx.deps, target, "pro")).rejects.toMatchObject({ code: "comp_plan_unsupported" });
    await expect(opsSetComp(ctx.deps, target, "business", new Date(Date.now() - DAY))).rejects.toMatchObject({ code: "bad_request" });
    await expect(opsSetComp(ctx.deps, target, "business", new Date(Date.now() + 5000 * DAY))).rejects.toMatchObject({ code: "bad_request" });
    await expect(opsSetComp(ctx.deps, target, "business", null, "x".repeat(301))).rejects.toMatchObject({ code: "bad_request" });
  });

  it("comps with an end date only once 0174 is in, and expireComps ends them", async () => {
    const { orgId, target } = await subscribed(ctx, stripe);
    const until = new Date(Date.now() + 10 * DAY);
    if (!OPS1_0174.comp) {
      // OPS1-0174: before the migration a dated comp is refused (it would never end) and the expiry job does nothing.
      await expect(opsSetComp(ctx.deps, target, "business", until)).rejects.toMatchObject({ code: "comp_expiry_unavailable" });
      expect(await expireComps(ctx.deps, new Date(Date.now() + 20 * DAY))).toEqual({ available: false, expired: [] });
      return;
    }
    const on = await opsSetComp(ctx.deps, target, "business", until, "Trial partner");
    expect(on.after).toMatchObject({ comp: true, compUntil: until.toISOString(), compNote: "Trial partner" });
    expect(await expireComps(ctx.deps, new Date(Date.now() + 5 * DAY))).toEqual({ available: true, expired: [] });
    expect(await expireComps(ctx.deps, new Date(Date.now() + 11 * DAY))).toEqual({ available: true, expired: [orgId] });
    const org = await getOrg(ctx.db, orgId);
    expect(org.compPlan).toBe(false);
    expect(effectivePlanId(org)).toBe("pro");
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "billing.comp_expired")).get()).toMatchObject({ orgId });
    expect((await expireComps(ctx.deps, new Date(Date.now() + 12 * DAY))).expired).toEqual([]);
  });

  it("credits the Stripe customer balance in cents, within bounds", async () => {
    const { target } = await subscribed(ctx, stripe);
    const res = await opsAddCredit(ctx.deps, target, 500, "Sorry about the outage", { idempotencyKey: "ops-credit-1" });
    expect(res).toMatchObject({ before: { balanceCents: 0 }, after: { balanceCents: -500 }, amountCents: 500, currency: "aud" });
    const call = stripe.calls.find((c) => c.path === "/v1/customers/cus_1/balance_transactions")!;
    const body = new URLSearchParams(call.body);
    expect([body.get("amount"), body.get("currency"), body.get("description"), body.get("metadata[source]")]).toEqual(["-500", "aud", "Sorry about the outage", "operator_console"]);
    const again = await opsAddCredit(ctx.deps, target, 250, "Second");
    expect(again).toMatchObject({ before: { balanceCents: -500 }, after: { balanceCents: -750 } });

    for (const bad of [0, -5, 1.5, CREDIT_MAX_CENTS + 1, Number.NaN]) {
      await expect(opsAddCredit(ctx.deps, target, bad, "x")).rejects.toMatchObject({ code: "bad_request" });
    }
    await expect(opsAddCredit(ctx.deps, target, 100, "  ")).rejects.toMatchObject({ code: "bad_request" });
    const other = await newWorkspace(ctx, "b@b.io", "No customer");
    await expect(opsAddCredit(ctx.deps, { orgId: other, actor: operator }, 100, "x")).rejects.toMatchObject({ code: "no_customer" });
  });

  it("extends a trial on Stripe from the later of now and the current trial end", async () => {
    const trialEnd = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const { target } = await subscribed(ctx, stripe, { status: "trialing", trial_end: trialEnd });
    const res = await opsExtendTrial(ctx.deps, target, 7);
    expect(res.trialEnd).toBe(new Date((trialEnd + 7 * 86_400) * 1000).toISOString());
    const call = stripe.calls.findLast((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1")!;
    const body = new URLSearchParams(call.body);
    expect([body.get("trial_end"), body.get("proration_behavior")]).toEqual([String(trialEnd + 7 * 86_400), "none"]);
    expect(res.after).toMatchObject({ subscriptionStatus: "trialing" });
    for (const bad of [0, 91, 2.5]) await expect(opsExtendTrial(ctx.deps, target, bad)).rejects.toMatchObject({ code: "bad_request" });
    const none = await newWorkspace(ctx, "b@b.io", "No sub");
    await expect(opsExtendTrial(ctx.deps, { orgId: none, actor: operator }, 7)).rejects.toMatchObject({ code: "no_subscription" });
  });

  it("extends the grace period of a past-due workspace", async () => {
    const { orgId, target } = await subscribed(ctx, stripe);
    await expect(opsExtendGrace(ctx.deps, target, 3)).rejects.toMatchObject({ code: "not_past_due" });
    const now = Date.now();
    await ctx.db.update(organizations).set({ pastDueSince: new Date(now - 9 * DAY), graceEndsAt: new Date(now - 2 * DAY) }).where(eq(organizations.id, orgId));
    expect((await listPastDue(ctx.deps, page("pastDueSince"))).items[0]!.stage).toBe("paused");
    const res = await opsExtendGrace(ctx.deps, target, 5);
    expect(res.before.graceEndsAt).toBe(new Date(now - 2 * DAY).toISOString());
    const after = new Date(res.after.graceEndsAt!).getTime();
    expect(after).toBeGreaterThanOrEqual(now + 5 * DAY);
    expect(after).toBeLessThan(now + 5 * DAY + 60_000);
    expect((await listPastDue(ctx.deps, page("pastDueSince"))).items[0]!.stage).toBe("grace");
    // A second extension counts from the current grace end.
    const again = await opsExtendGrace(ctx.deps, target, 2);
    expect(new Date(again.after.graceEndsAt!).getTime()).toBe(after + 2 * DAY);
    await expect(opsExtendGrace(ctx.deps, target, 31)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("resyncs from Stripe: a changed subscription, a customer without a stored id, and one Stripe no longer has", async () => {
    const { orgId, target } = await subscribed(ctx, stripe);
    stripe.subs.sub_1!.items.data[0]!.price = { id: "price_biz", recurring: { interval: "month" } };
    const res = await opsResync(ctx.deps, target);
    expect(res).toMatchObject({ outcome: "synced", before: { plan: "pro" }, after: { plan: "business" } });

    await ctx.db.update(organizations).set({ stripeSubscriptionId: null }).where(eq(organizations.id, orgId));
    expect((await opsResync(ctx.deps, target)).after).toMatchObject({ plan: "business" });
    expect((await getOrg(ctx.db, orgId)).stripeSubscriptionId).toBe("sub_1");

    delete stripe.subs.sub_1;
    const gone = await opsResync(ctx.deps, target);
    expect(gone).toMatchObject({ outcome: "deleted", after: { plan: "starter", subscriptionStatus: "canceled" } });
    expect((await getOrg(ctx.db, orgId)).stripeSubscriptionId).toBeNull();
    expect((await opsResync(ctx.deps, target)).outcome).toBe("no_subscription");
  });

  it("sets and clears cancel at period end", async () => {
    const { target } = await subscribed(ctx, stripe);
    const on = await opsCancelAtPeriodEnd(ctx.deps, target, true);
    expect([on.before.cancelAtPeriodEnd, on.after.cancelAtPeriodEnd]).toEqual([false, true]);
    expect(new URLSearchParams(stripe.calls.findLast((c) => c.method === "POST")!.body).get("cancel_at_period_end")).toBe("true");
    const off = await opsCancelAtPeriodEnd(ctx.deps, target, false);
    expect(off.after.cancelAtPeriodEnd).toBe(false);
  });

  it("turns Stripe's own errors into typed ones", async () => {
    const { target } = await subscribed(ctx, stripe);
    delete stripe.subs.sub_1;
    await expect(opsExtendTrial(ctx.deps, target, 3)).rejects.toMatchObject({ code: "stripe_object_missing", status: 409 });
  });
});

describe("console billing when billing is not connected", () => {
  it("answers reads, keeps local actions and refuses Stripe actions with billing_unavailable", async () => {
    const ctx = await makeTestApp();
    const orgId = await newWorkspace(ctx, "o@o.io", "Offline");
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x", subscriptionStatus: "active", plan: "pro", pastDueSince: new Date(), graceEndsAt: new Date() }).where(eq(organizations.id, orgId));
    const target = { orgId, actor: operator };
    const w = await getWorkspaceBilling(ctx.deps, orgId);
    expect(w).toMatchObject({ billing: { enabled: false }, invoices: [], invoicesError: null });
    expect((await listSubscriptions(ctx.deps, { page: page("createdAt") })).items).toHaveLength(1);

    for (const p of [
      opsChangePlan(ctx.deps, target, "business"), opsAddCredit(ctx.deps, target, 100, "x"), opsExtendTrial(ctx.deps, target, 3),
      opsResync(ctx.deps, target), opsCancelAtPeriodEnd(ctx.deps, target, true),
    ]) {
      await expect(p).rejects.toMatchObject({ code: "billing_unavailable", status: 409 });
    }
    expect((await opsSetComp(ctx.deps, target, "business")).after.effectivePlan).toBe("business");
    expect((await opsExtendGrace(ctx.deps, target, 2)).after.graceEndsAt).not.toBeNull();
  });
});

describe("Stripe event summaries", () => {
  it("names the event, amount and status and nothing else", () => {
    expect(summarizeStripeEvent("invoice.paid", { number: "MM-1", amount_paid: 1250, currency: "aud", customer_email: "a@b.c" })).toBe("Invoice MM-1 paid: A$12.50");
    expect(summarizeStripeEvent("invoice.payment_failed", { amount_due: 300, currency: "aud" })).toBe("Invoice payment failed: A$3.00");
    expect(summarizeStripeEvent("customer.subscription.updated", { status: "active", cancel_at_period_end: true })).toBe("Subscription updated, status active, cancels at period end");
    expect(summarizeStripeEvent("charge.refunded", { amount_refunded: 100, currency: "usd", payment_method_details: { card: { last4: "4242" } } })).toBe("Charge refunded: USD 1.00");
    expect(summarizeStripeEvent("payment_method.attached", { card: { last4: "4242" } })).toBeNull();
  });
});
