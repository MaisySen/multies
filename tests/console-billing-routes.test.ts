/**
 * OPS1: /api/console/billing routes. Lists (paging through nextCursor, filters, bad sort), one workspace's billing (ids
 * only), and each billing action: reason required, billing role allowed, support and read only refused, platform audit
 * row with action, target and reason, step up for comp and credit, typed errors as plain 4xx.
 * Every Stripe call goes to the in-memory fake (tests/console-billing-fake.ts); no real Stripe is reached.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { STRIPE_ENV, fakeStripe, subOf } from "./console-billing-fake";
import { auditLogs, billingEvents, organizations, platformAuditLogs, referrals, sessions } from "@/server/db/schema";
import { syncSubscription } from "@/server/services/billing";

const DAY = 86_400_000;
const REASON = "Customer asked on ticket 4411";

type Harness = {
  ctx: Ctx; stripe: ReturnType<typeof fakeStripe>; keys: string[];
  billing: Client; billingId: string; support: Client; readonly: Client; customer: Client; orgId: string;
};

async function orgOf(c: Client): Promise<string> {
  return (await c.get("/api/account/me")).body.organization.id as string;
}

/** Operators of three tiers, a customer workspace "Acme" on legacy Pro with live subscription sub_1 (customer cus_1). */
async function setup(env: Record<string, string> = STRIPE_ENV): Promise<Harness> {
  const stripe = fakeStripe();
  const keys: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const k = h.get("idempotency-key");
    if (k && String(input).includes("/balance_transactions")) keys.push(k);
    return stripe.fetch(input, init);
  }) as typeof fetch;
  const ctx = await makeTestApp(env, { fetch: fetchImpl });
  const { c: billing, id: billingId } = await signUpAs(ctx, "billing@ops.test", "ops_billing");
  const { c: support } = await signUpAs(ctx, "support@ops.test", "ops_support");
  const { c: readonly } = await signUpAs(ctx, "readonly@ops.test", "ops_readonly");
  const { c: customer } = await signUpAs(ctx, "owner@acme.test", null, "Acme");
  const orgId = await orgOf(customer);
  if (env.STRIPE_SECRET_KEY) {
    stripe.subs.sub_1 = subOf("cus_1", "price_pro", { metadata: { orgId } });
    await syncSubscription(ctx.deps, stripe.subs.sub_1);
  }
  return { ctx, stripe, keys, billing, billingId, support, readonly, customer, orgId };
}

const auditRow = (ctx: Ctx, action: string, targetId: string) =>
  ctx.db.select().from(platformAuditLogs).where(and(eq(platformAuditLogs.action, action), eq(platformAuditLogs.targetId, targetId))).get();

describe("console billing lists", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); }, 60_000);

  it("pages subscriptions through nextCursor, filters by plan, comp and search, and refuses a bad sort or cursor", async () => {
    const { c: b } = await signUpAs(h.ctx, "b@bravo.test", null, "Bravo");
    const { c: c3 } = await signUpAs(h.ctx, "c@charlie.test", null, "Charlie");
    const bravo = await orgOf(b);
    const charlie = await orgOf(c3);
    await h.ctx.db.update(organizations).set({ stripeCustomerId: "cus_b", subscriptionStatus: "past_due", plan: "business" }).where(eq(organizations.id, bravo));
    await h.ctx.db.update(organizations).set({ compPlan: true }).where(eq(organizations.id, charlie));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await h.readonly.get(`/api/console/billing/subscriptions?sort=name:asc&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(1);
      seen.push(r.body.items[0].name);
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["Acme", "Bravo", "Charlie"]);

    const pro = await h.readonly.get("/api/console/billing/subscriptions?plan=pro");
    expect(pro.body.items.map((i: { orgId: string }) => i.orgId)).toEqual([h.orgId]);
    expect(pro.body.items[0]).toMatchObject({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "active" });
    expect((await h.readonly.get("/api/console/billing/subscriptions?comp=true")).body.items.map((i: { orgId: string }) => i.orgId)).toEqual([charlie]);
    expect((await h.readonly.get("/api/console/billing/subscriptions?status=past_due")).body.items.map((i: { orgId: string }) => i.orgId)).toEqual([bravo]);
    expect((await h.readonly.get("/api/console/billing/subscriptions?q=rav")).body.items.map((i: { orgId: string }) => i.orgId)).toEqual([bravo]);

    const badSort = await h.readonly.get("/api/console/billing/subscriptions?sort=stripeCustomerId:asc");
    expect(badSort.status).toBe(400);
    expect(badSort.body.error.code).toBe("invalid_sort");
    expect((await h.readonly.get("/api/console/billing/subscriptions?sort=name:sideways")).status).toBe(400);
    expect((await h.readonly.get("/api/console/billing/subscriptions?cursor=not-a-cursor")).body.error.code).toBe("bad_cursor");
    expect((await h.readonly.get("/api/console/billing/subscriptions?plan=enterprise")).status).toBe(422);
  }, 60_000);

  it("lists past-due workspaces with stage, days and grace end, most overdue first", async () => {
    const now = Date.now();
    const { c: b } = await signUpAs(h.ctx, "b@bravo.test", null, "Bravo");
    const bravo = await orgOf(b);
    await h.ctx.db.update(organizations).set({ pastDueSince: new Date(now - 2 * DAY), graceEndsAt: new Date(now + 5 * DAY) }).where(eq(organizations.id, h.orgId));
    await h.ctx.db.update(organizations).set({ pastDueSince: new Date(now - 10 * DAY), graceEndsAt: new Date(now - 3 * DAY) }).where(eq(organizations.id, bravo));
    const r = await h.support.get("/api/console/billing/past-due");
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { name: string; stage: string; daysPastDue: number; sendingPaused: boolean }) => [i.name, i.stage, i.daysPastDue, i.sendingPaused]))
      .toEqual([["Bravo", "paused", 10, true], ["Acme", "grace", 2, false]]);
    const first = await h.support.get("/api/console/billing/past-due?limit=1");
    expect(first.body.items[0].orgId).toBe(bravo);
    const second = await h.support.get(`/api/console/billing/past-due?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { orgId: string }) => i.orgId)).toEqual([h.orgId]);
    expect(second.body.nextCursor).toBeNull();
    expect((await h.support.get("/api/console/billing/past-due?sort=plan:asc")).status).toBe(400);
  }, 60_000);

  it("lists Stripe events by type and workspace with paging, and referrals by status", async () => {
    await h.ctx.db.insert(billingEvents).values([
      { id: "evt_1", type: "invoice.paid", orgId: h.orgId, summary: "Invoice MM-1 paid: A$12.00", createdAt: new Date(1000) },
      { id: "evt_2", type: "invoice.payment_failed", orgId: h.orgId, createdAt: new Date(2000) },
      { id: "evt_3", type: "customer.subscription.updated", orgId: null, createdAt: new Date(3000) },
    ]);
    const p1 = await h.readonly.get("/api/console/billing/events?limit=2");
    expect(p1.body.items.map((e: { id: string }) => e.id)).toEqual(["evt_3", "evt_2"]);
    const p2 = await h.readonly.get(`/api/console/billing/events?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toMatchObject([{ id: "evt_1", orgName: "Acme", summary: "Invoice MM-1 paid: A$12.00" }]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await h.readonly.get("/api/console/billing/events?type=invoice.paid")).body.items.map((e: { id: string }) => e.id)).toEqual(["evt_1"]);
    expect((await h.readonly.get(`/api/console/billing/events?orgId=${h.orgId}`)).body.items).toHaveLength(2);
    expect((await h.readonly.get("/api/console/billing/events?sort=type:asc")).status).toBe(400);

    await h.ctx.db.insert(referrals).values([
      { id: "ref_1", referrerOrgId: h.orgId, referredOrgId: "org_other", code: "ABCDEFGH", status: "credited", referrerCreditCents: 300, referredCreditCents: 300, createdAt: new Date(1000) },
      { id: "ref_2", referrerOrgId: "org_x", referredOrgId: "org_y", code: "JKLMNPQR", status: "pending", createdAt: new Date(2000) },
    ]);
    const refs = await h.readonly.get("/api/console/billing/referrals");
    expect(refs.body.items.map((r: { id: string }) => r.id)).toEqual(["ref_2", "ref_1"]);
    expect((await h.readonly.get("/api/console/billing/referrals?status=pending")).body.items.map((r: { id: string }) => r.id)).toEqual(["ref_2"]);
    expect((await h.readonly.get("/api/console/billing/referrals?status=nope")).status).toBe(400);
    expect((await h.readonly.get("/api/console/billing/referrals?sort=code:asc")).status).toBe(400);
  }, 60_000);

  it("reads one workspace's billing with ids only, no invoice links, and the action bounds", async () => {
    const r = await h.readonly.get(`/api/console/billing/workspaces/${h.orgId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      orgId: h.orgId, name: "Acme", plan: "pro", effectivePlan: "pro", currency: "aud", billing: { enabled: true },
      stripe: { customerId: "cus_1", subscriptionId: "sub_1" }, subscription: { status: "active", cancelAtPeriodEnd: false },
      bounds: { creditMinCents: 1, creditMaxCents: 50_000, trialDaysMax: 90, graceDaysMax: 30 },
    });
    expect(r.body.invoices[0]).toEqual({
      id: "in_1", number: "MM-0001", status: "paid", total: 1200, currency: "aud",
      createdAt: expect.any(String), periodStart: expect.any(String), periodEnd: expect.any(String),
    });
    const text = JSON.stringify(r.body);
    for (const secret of ["sk_test_fake", "whsec_test", "invoice.stripe.com", "pay.stripe.com", "hostedUrl", "pdfUrl"]) expect(text).not.toContain(secret);
    expect((await h.readonly.get("/api/console/billing/workspaces/org_nope")).status).toBe(404);
    const status = await h.readonly.get("/api/console/billing/status");
    expect(status.body).toEqual({ enabled: true, testMode: true, currency: "aud" });
  }, 60_000);

  it("is closed to customers and anonymous callers, and has no customer portal route", async () => {
    for (const path of ["/subscriptions", "/past-due", "/events", "/referrals", "/status", `/workspaces/${h.orgId}`]) {
      expect((await h.customer.get(`/api/console/billing${path}`)).status).toBe(403);
      expect((await new Client(h.ctx.app).get(`/api/console/billing${path}`)).status).toBe(401);
    }
    expect((await h.billing.post(`/api/console/billing/workspaces/${h.orgId}/portal`, { reason: REASON })).status).toBe(404);
  }, 60_000);
});

describe("console billing actions", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); }, 60_000);

  it("each action needs a reason, is refused to support and read only, runs for billing, and is audited", async () => {
    const base = `/api/console/billing/workspaces/${h.orgId}`;
    const cases: { path: string; body: Record<string, unknown>; action: string; before?: () => Promise<unknown>; check?: (body: Record<string, unknown>) => void }[] = [
      { path: "/plan", body: { plan: "business" }, action: "billing.plan_changed", check: (b) => expect(b).toMatchObject({ plan: "business", pending: false }) },
      { path: "/credit", body: { amountCents: 500, note: "Sorry about the outage", requestKey: "dialog_key_0001" }, action: "billing.credit_added", check: (b) => expect(b).toMatchObject({ amountCents: 500, currency: "aud", balanceCents: -500 }) },
      { path: "/trial", body: { days: 7 }, action: "billing.trial_extended", check: (b) => expect(typeof b.trialEnd).toBe("string") },
      { path: "/cancel-at-period-end", body: { on: true }, action: "billing.cancel_scheduled", check: (b) => expect(b.cancelAtPeriodEnd).toBe(true) },
      { path: "/resync", body: {}, action: "billing.resynced", check: (b) => expect(b.outcome).toBe("synced") },
      {
        path: "/grace", body: { days: 5 }, action: "billing.grace_extended",
        before: () => h.ctx.db.update(organizations).set({ pastDueSince: new Date(Date.now() - 9 * DAY), graceEndsAt: new Date(Date.now() - DAY) }).where(eq(organizations.id, h.orgId)),
        check: (b) => expect(new Date(b.graceEndsAt as string).getTime()).toBeGreaterThan(Date.now() + 4 * DAY),
      },
      { path: "/comp", body: { on: true, note: "Partner workspace" }, action: "billing.comp_set", check: (b) => expect(b).toMatchObject({ comp: true, warnings: ["subscription_still_billing"] }) },
    ];
    for (const k of cases) {
      const noReason = await h.billing.post(`${base}${k.path}`, k.body);
      expect(noReason.status, `${k.path} without a reason`).toBe(422);
      expect(noReason.body.error.message).toMatch(/reason/i);
      for (const who of [h.support, h.readonly]) {
        const r = await who.post(`${base}${k.path}`, { ...k.body, reason: REASON });
        expect(r.status, `${k.path} by a lower tier`).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
      expect((await h.customer.post(`${base}${k.path}`, { ...k.body, reason: REASON })).status).toBe(403);
      expect((await new Client(h.ctx.app).post(`${base}${k.path}`, { ...k.body, reason: REASON })).status).toBe(401);
      await k.before?.();
      const ok = await h.billing.post(`${base}${k.path}`, { ...k.body, reason: REASON });
      expect(ok.status, `${k.path}: ${JSON.stringify(ok.body)}`).toBe(200);
      k.check?.(ok.body);
      const row = await auditRow(h.ctx, k.action, h.orgId);
      expect(row, k.action).toMatchObject({ targetType: "workspace", targetId: h.orgId, orgId: h.orgId, reason: REASON, actorEmail: "billing@ops.test", actorRole: "ops_billing" });
      expect(row!.before).not.toBeNull();
      expect(row!.after).not.toBeNull();
    }
    // The workspace's own Activity shows the operator's comp with the reason.
    const ws = await h.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, h.orgId), eq(auditLogs.action, "billing.comp_set"))).get();
    expect(JSON.parse(ws!.metadata!)).toMatchObject({ by: "operator", reason: REASON });
    // Nothing was audited for the refused attempts: one row per action.
    expect(await h.ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.orgId, h.orgId))).toHaveLength(cases.length);
  }, 120_000);

  it("derives the Stripe idempotency key from the request, so a retry cannot credit twice", async () => {
    const path = `/api/console/billing/workspaces/${h.orgId}/credit`;
    const body = { amountCents: 1250, note: "Outage credit", reason: REASON, requestKey: "dialog_key_aaaa" };
    expect((await h.billing.post(path, body)).status).toBe(200);
    expect((await h.billing.post(path, body)).status).toBe(200);
    expect((await h.billing.post(path, { ...body, requestKey: "dialog_key_bbbb" })).status).toBe(200);
    expect((await h.billing.post(path, { ...body, amountCents: 1300 })).status).toBe(200);
    expect(h.keys).toHaveLength(4);
    expect(h.keys[0]).toBe(h.keys[1]);
    expect(new Set(h.keys).size).toBe(3);
    const call = h.stripe.calls.find((c) => c.path === "/v1/customers/cus_1/balance_transactions")!;
    expect(new URLSearchParams(call.body).get("amount")).toBe("-1250");

    for (const bad of [0, -1, 12.5, 50_001]) {
      const r = await h.billing.post(path, { ...body, amountCents: bad });
      expect(r.status, String(bad)).toBe(422);
    }
    expect((await h.billing.post(path, { ...body, note: "" })).status).toBe(422);
  }, 60_000);

  it("asks for a recent sign in for comp and credit only", async () => {
    await h.ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(sessions.userId, h.billingId));
    const base = `/api/console/billing/workspaces/${h.orgId}`;
    for (const [path, body] of [["/comp", { on: true }], ["/credit", { amountCents: 100, note: "x credit" }]] as const) {
      const r = await h.billing.post(`${base}${path}`, { ...body, reason: REASON });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("step_up_required");
    }
    expect((await h.billing.post(`${base}/resync`, { reason: REASON })).status).toBe(200);
  }, 60_000);

  it("maps the service's typed errors to plain 4xx messages and 404s an unknown workspace", async () => {
    const base = `/api/console/billing/workspaces/${h.orgId}`;
    const grace = await h.billing.post(`${base}/grace`, { days: 3, reason: REASON });
    expect(grace.status).toBe(409);
    expect(grace.body.error).toMatchObject({ code: "not_past_due" });
    expect(grace.body.error.message).toMatch(/isn't behind on payment/);
    expect((await h.billing.post(`${base}/grace`, { days: 31, reason: REASON })).status).toBe(422);
    expect((await h.billing.post(`${base}/trial`, { days: 91, reason: REASON })).status).toBe(422);
    expect((await h.billing.post(`${base}/plan`, { plan: "enterprise", reason: REASON })).status).toBe(422);
    const comp = await h.billing.post(`${base}/comp`, { on: true, until: "2020-01-01", reason: REASON });
    expect(comp.status).toBe(400);
    expect((await h.billing.post(`${base}/comp`, { on: true, until: "not a date", reason: REASON })).status).toBe(400);

    // On a comp workspace plan changes are refused with a plain message.
    expect((await h.billing.post(`${base}/comp`, { on: true, reason: REASON })).status).toBe(200);
    const plan = await h.billing.post(`${base}/plan`, { plan: "business", reason: REASON });
    expect(plan.status).toBe(409);
    expect(plan.body.error.code).toBe("comp_plan");

    const { c: other } = await signUpAs(h.ctx, "free@free.test", null, "Freebie");
    const freeId = await orgOf(other);
    const trial = await h.billing.post(`/api/console/billing/workspaces/${freeId}/trial`, { days: 3, reason: REASON });
    expect(trial.status).toBe(409);
    expect(trial.body.error.code).toBe("no_subscription");
    const credit = await h.billing.post(`/api/console/billing/workspaces/${freeId}/credit`, { amountCents: 100, note: "x credit", reason: REASON });
    expect(credit.body.error.code).toBe("no_customer");

    expect((await h.billing.post("/api/console/billing/workspaces/org_nope/resync", { reason: REASON })).status).toBe(404);
  }, 60_000);

  it("gives a comp with an end date and note, and turns it off", async () => {
    const base = `/api/console/billing/workspaces/${h.orgId}`;
    const until = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    const on = await h.billing.post(`${base}/comp`, { on: true, until, note: "Launch partner", reason: REASON });
    expect(on.status).toBe(200);
    expect(on.body.compUntil).toBe(`${until}T23:59:59.000Z`);
    const w = await h.readonly.get(base);
    expect(w.body).toMatchObject({ effectivePlan: "business", comp: { on: true, until: `${until}T23:59:59.000Z`, note: "Launch partner" } });
    const off = await h.billing.post(`${base}/comp`, { on: false, reason: REASON });
    expect(off.body).toMatchObject({ comp: false, compUntil: null, warnings: [] });
    expect(await auditRow(h.ctx, "billing.comp_removed", h.orgId)).toBeTruthy();
  }, 60_000);
});

describe("console billing when billing is not connected", () => {
  it("says so on status, keeps local actions, and refuses Stripe actions with a plain 409", async () => {
    const h = await setup({});
    expect((await h.readonly.get("/api/console/billing/status")).body.enabled).toBe(false);
    await h.ctx.db.update(organizations).set({ stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x", subscriptionStatus: "active", plan: "pro", pastDueSince: new Date(), graceEndsAt: new Date() }).where(eq(organizations.id, h.orgId));
    const base = `/api/console/billing/workspaces/${h.orgId}`;
    for (const [path, body] of [["/plan", { plan: "business" }], ["/credit", { amountCents: 100, note: "x credit" }], ["/trial", { days: 3 }], ["/resync", {}], ["/cancel-at-period-end", { on: true }]] as const) {
      const r = await h.billing.post(`${base}${path}`, { ...body, reason: REASON });
      expect(r.status, path).toBe(409);
      expect(r.body.error.code).toBe("billing_unavailable");
      expect(r.body.error.message).toMatch(/isn't connected/);
    }
    expect((await h.billing.post(`${base}/grace`, { days: 2, reason: REASON })).status).toBe(200);
    expect((await h.billing.post(`${base}/comp`, { on: true, reason: REASON })).status).toBe(200);
    expect((await h.readonly.get(base)).body).toMatchObject({ billing: { enabled: false }, invoices: [], effectivePlan: "business" });
  }, 60_000);
});
