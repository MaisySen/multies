/**
 * R62 pricing: yearly billing (ten months for twelve), the LAUNCH30 code on monthly checkouts only, referrals with
 * their abuse guards, and Business storage (1,000 GB, with 2,500 GB kept by the Business workspaces from before).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { signStripePayload, stripeClient } from "@/server/services/billing/stripe";
import { grantReferral, newReferralCode, normalizeReferralCode, referralCodeFromCookie, selfReferralReason } from "@/server/services/billing/referrals";
import "@/server/services/billing/referral-job";
import { runDueJobs } from "@/server/services/jobs";
import { setAddons } from "@/server/services/plans";
import { organizations, referrals } from "@/server/db/schema";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import {
  ADDONS, BUSINESS_STORAGE_MB, BUSINESS_STORAGE_MB_BEFORE_R62, PLANS, YEARLY_MONTHS_CHARGED, chargeFor, effectiveLimits, intervalFor, yearlyPrice,
} from "@/shared/plans";
import {
  LAUNCH_CODE, LAUNCH_MONTHS, LAUNCH_PERCENT_OFF, MAX_PERCENT_OFF, OFFER_COPY, REFERRAL_CAP_PER_YEAR, REFERRAL_CODE_RE, referralCreditCents,
} from "@/shared/offers";
import { referralCookieFor } from "@/web/lib/referral";

const DAY = 86_400_000;

describe("plans and offers (unit)", () => {
  it("bills yearly at ten months for twelve, yearly only under A$5, monthly unless yearly is chosen", () => {
    expect(YEARLY_MONTHS_CHARGED).toBe(10);
    expect(yearlyPrice(1)).toBe(10);
    expect(yearlyPrice(3)).toBe(30);
    expect(intervalFor({ domain: 1 })).toBe("year");
    expect(intervalFor({ domain: 1 }, 0, "month")).toBe("year");
    expect(intervalFor({ mailboxes: 2 })).toBe("month");
    expect(intervalFor({ mailboxes: 2 }, 0, "year")).toBe("year");
    expect(intervalFor({}, 0, "year")).toBe("month");
    expect(chargeFor({ mailboxes: 2 }, 0, "year")).toEqual({ interval: "year", amount: 60, monthly: 6, yearlySaving: 12 });
    expect(chargeFor({ mailboxes: 2 })).toEqual({ interval: "month", amount: 6, monthly: 6, yearlySaving: 12 });
    expect(chargeFor({})).toMatchObject({ interval: "month", amount: 0 });
  });

  it("lowers Business storage to 1,000 GB, keeps grandfathered storage only on Business, and never touches Free", () => {
    expect(PLANS.business.limits.storageMb).toBe(1000 * 1024);
    expect(BUSINESS_STORAGE_MB).toBe(1000 * 1024);
    expect(PLANS.business.limits.storagePerMailboxMb).toBe(50 * 1024);
    expect(effectiveLimits(PLANS.business, {}, { legacyStorageMb: BUSINESS_STORAGE_MB_BEFORE_R62 }).storageMb).toBe(2500 * 1024);
    // Storage packs still add on top of the kept 2,500 GB.
    expect(effectiveLimits(PLANS.business, { storage: 2 }, { legacyStorageMb: BUSINESS_STORAGE_MB_BEFORE_R62 }).storageMb).toBe(2500 * 1024 + 40 * 1024);
    expect(effectiveLimits(PLANS.business, { storage: 2 }).storageMb).toBe(1000 * 1024 + 40 * 1024);
    // A grandfathered value never applies on another plan.
    expect(effectiveLimits(PLANS.starter, {}, { legacyStorageMb: BUSINESS_STORAGE_MB_BEFORE_R62 }).storageMb).toBe(3 * 1024);
    expect(PLANS.starter.limits.seats).toBe(3);
    expect(PLANS.starter.limits.storageMb).toBe(3 * 1024);
    const m = MIGRATIONS.find((x) => x.name === "0094_r62_pricing_referrals")!;
    expect(m.statements.join("\n")).toContain("SET `legacy_storage_mb` = 2560000 WHERE `plan` = 'business'");
    expect(BUSINESS_STORAGE_MB_BEFORE_R62).toBe(2560000);
  });

  it("keeps every discount within the guardrails and the copy in step with the numbers", () => {
    expect(LAUNCH_CODE).toBe("LAUNCH30");
    expect(LAUNCH_PERCENT_OFF).toBe(30);
    expect(LAUNCH_MONTHS).toBe(3);
    expect(MAX_PERCENT_OFF).toBeLessThanOrEqual(50);
    expect(LAUNCH_PERCENT_OFF).toBeLessThanOrEqual(MAX_PERCENT_OFF);
    // Yearly is 2 months free out of 12, about 17 percent.
    expect(1 - YEARLY_MONTHS_CHARGED / 12).toBeLessThan(MAX_PERCENT_OFF / 100);
    expect(OFFER_COPY.launch).toContain(LAUNCH_CODE);
    expect(OFFER_COPY.referral).toContain(`${REFERRAL_CAP_PER_YEAR}`);
    for (const t of Object.values(OFFER_COPY)) expect(t).not.toMatch(/[\u2013\u2014]/);
    // The home page names the code in words: it must be the real code.
    expect(readFileSync("src/web/pages/landing.tsx", "utf8")).toContain(`the code ${LAUNCH_CODE} for ${LAUNCH_PERCENT_OFF} percent off your first ${LAUNCH_MONTHS} months`);
    expect(ADDONS.storage.priceMonthly).toBe(2);
  });

  it("gives referral credit of one month of add-ons, at least A$1 and at most A$20", () => {
    expect(referralCreditCents(0)).toBe(100);
    expect(referralCreditCents(0.5)).toBe(100);
    expect(referralCreditCents(3)).toBe(300);
    expect(referralCreditCents(19.99)).toBe(1999);
    expect(referralCreditCents(150)).toBe(2000);
  });

  it("makes, reads and validates referral codes", () => {
    for (let i = 0; i < 50; i++) expect(newReferralCode()).toMatch(REFERRAL_CODE_RE);
    expect(newReferralCode(() => new Uint8Array(8))).toBe("AAAAAAAA");
    expect(normalizeReferralCode(" abcd2345 ")).toBe("ABCD2345");
    expect(normalizeReferralCode("ABCD1234")).toBeNull(); // 1 is not in the alphabet
    expect(normalizeReferralCode("short")).toBeNull();
    expect(referralCodeFromCookie("a=1; mm_ref=ABCD2345; b=2")).toBe("ABCD2345");
    expect(referralCodeFromCookie("mm_ref=<script>")).toBeNull();
    expect(referralCodeFromCookie(null)).toBeNull();
    expect(referralCookieFor("?ref=abcd2345&x=1", true)).toBe("mm_ref=ABCD2345; Max-Age=2592000; Path=/; SameSite=Lax; Secure");
    expect(referralCookieFor("?ref=nope", true)).toBeNull();
    expect(referralCookieFor("", false)).toBeNull();
  });

  it("spots self referral by email, company domain, membership and card, but not a shared public mail domain", () => {
    const owner = { emails: ["Owner@Acme.io"], cards: ["fp_a"] };
    expect(selfReferralReason(owner, { emails: ["owner@acme.io"] })).toBe("self_referral_email");
    expect(selfReferralReason(owner, { emails: ["bob@acme.io"] })).toBe("self_referral_domain");
    expect(selfReferralReason(owner, { emails: ["bob@other.io"], cards: ["fp_a"] })).toBe("same_card");
    expect(selfReferralReason(owner, { emails: ["bob@other.io"], isMemberOfReferrer: true })).toBe("member");
    expect(selfReferralReason(owner, { emails: ["bob@other.io"], cards: ["fp_b"] })).toBeNull();
    expect(selfReferralReason({ emails: ["ann@gmail.com"] }, { emails: ["bob@gmail.com"] })).toBeNull();
    expect(selfReferralReason({ emails: ["ann@mail.multies.si"] }, { emails: ["bob@mail.multies.si"] })).toBeNull();
  });
});

/** A small in-memory Stripe for checkout, subscriptions and the referral grant. */
function fakeStripe() {
  const calls: { method: string; path: string; body: string; idem: string | null }[] = [];
  const subs: Record<string, unknown> = {};
  const charges: Record<string, unknown[]> = {};
  const cards: Record<string, string[]> = {};
  const invoices: Record<string, unknown> = {};
  let customers = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, body, idem: headers.get("idempotency-key") });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const list = (data: unknown[]) => json({ object: "list", data, has_more: false, url: url.pathname });
    if (url.pathname === "/v1/customers" && method === "POST") return json({ id: `cus_new${++customers}`, object: "customer" });
    const bt = url.pathname.match(/^\/v1\/customers\/([^/]+)\/balance_transactions$/);
    if (bt) return json({ id: `cbtxn_${calls.length}`, object: "customer_balance_transaction", customer: bt[1], amount: Number(new URLSearchParams(body).get("amount")) });
    if (url.pathname === "/v1/charges") return list(charges[url.searchParams.get("customer") ?? ""] ?? []);
    if (url.pathname === "/v1/payment_methods") return list((cards[url.searchParams.get("customer") ?? ""] ?? []).map((f, i) => ({ id: `pm_${i}`, object: "payment_method", card: { fingerprint: f } })));
    const inv = url.pathname.match(/^\/v1\/invoices\/(in_[^/]+)$/);
    if (inv) return json(invoices[inv[1]] ?? { id: inv[1], object: "invoice", status: "paid", post_payment_credit_notes_amount: 0 });
    if (url.pathname === "/v1/checkout/sessions") return json({ id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_1" });
    if (url.pathname === "/v1/prices" && method === "GET") return list([]);
    if (url.pathname === "/v1/products") return json({ id: "prod_1", object: "product" });
    if (url.pathname === "/v1/prices") { const p = new URLSearchParams(body); return json({ id: `price_auto_${p.get("lookup_key")}`, object: "price", lookup_key: p.get("lookup_key"), unit_amount: Number(p.get("unit_amount")) }); }
    if (url.pathname === "/v1/invoices/create_preview") return json({ object: "invoice", currency: "aud", lines: { data: [{ amount: 5000 }] } });
    if (url.pathname.startsWith("/v1/subscriptions/")) {
      const s = subs[url.pathname.split("/").pop()!];
      return s ? json(s) : json({ error: { message: "No such subscription" } }, 404);
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 400);
  };
  return { calls, subs, charges, cards, invoices, fetch: fetchImpl as typeof fetch };
}

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz" };

async function postWebhook(app: Awaited<ReturnType<typeof makeTestApp>>["app"], event: unknown) {
  const raw = JSON.stringify(event);
  const res = await app.request("/api/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": await signStripePayload(stripeClient("sk_test_fake", fetch), raw, "whsec_test", new Date()), "content-type": "application/json" } });
  return { status: res.status, body: await res.json() };
}

async function setup(referrerEmail = "owner@acme.io", referredEmail = "bob@newco.io") {
  const stripe = fakeStripe();
  const ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch });
  const a = new Client(ctx.app);
  await a.signup(referrerEmail);
  const ref = await a.get("/api/billing/referral");
  const b = new Client(ctx.app);
  b.jar.set("mm_ref", ref.body.code);
  await b.signup(referredEmail);
  const referredOrg = (await b.get("/api/account/me")).body.organization.id as string;
  const referrerOrg = (await a.get("/api/account/me")).body.organization.id as string;
  return { stripe, ctx, a, b, ref: ref.body, referredOrg, referrerOrg };
}

/** The referred workspace buys one mailbox pack (A$3 a month) and pays its first invoice. */
async function firstPayment(s: Awaited<ReturnType<typeof setup>>, amount = 330, id = "evt_paid_1") {
  await s.ctx.db.update(organizations).set({ stripeCustomerId: "cus_B" }).where(eq(organizations.id, s.referredOrg));
  await setAddons(s.ctx.db, s.referredOrg, { mailboxes: 1 });
  s.stripe.charges.cus_B = [{ id: "ch_1", refunded: false, amount_refunded: 0, disputed: false, payment_method_details: { card: { fingerprint: "fp_b" } } }];
  return postWebhook(s.ctx.app, { id, type: "invoice.paid", data: { object: { id: "in_ref1", customer: "cus_B", amount_paid: amount, currency: "aud", number: "MM-1", lines: { data: [] } } } });
}

const row = async (s: Awaited<ReturnType<typeof setup>>) => (await s.ctx.db.select().from(referrals).where(eq(referrals.referredOrgId, s.referredOrg)).get())!;
const later = (s: Awaited<ReturnType<typeof setup>>, days: number) => { const t = Date.now() + days * DAY; s.ctx.deps.now = () => new Date(t); };
const credits = (s: Awaited<ReturnType<typeof setup>>) => s.stripe.calls.filter((c) => c.path.endsWith("/balance_transactions"));

describe("referrals", () => {
  it("gives the referral link once, records a sign up through it, and credits both sides 14 days after the first payment", async () => {
    const s = await setup();
    expect(s.ref.code).toMatch(REFERRAL_CODE_RE);
    expect(s.ref.link).toContain(`/?ref=${s.ref.code}`);
    expect((await s.a.get("/api/billing/referral")).body.code).toBe(s.ref.code); // stable
    expect((await row(s))).toMatchObject({ status: "signed_up", referrerOrgId: s.referrerOrg });

    // A zero invoice is not a payment.
    await postWebhook(s.ctx.app, { id: "evt_zero", type: "invoice.paid", data: { object: { id: "in_0", customer: "cus_B", amount_paid: 0 } } });
    await s.ctx.db.update(organizations).set({ stripeCustomerId: "cus_B" }).where(eq(organizations.id, s.referredOrg));
    await postWebhook(s.ctx.app, { id: "evt_zero2", type: "invoice.paid", data: { object: { id: "in_0", customer: "cus_B", amount_paid: 0 } } });
    expect((await row(s)).status).toBe("signed_up");

    expect((await firstPayment(s)).status).toBe(200);
    const pending = await row(s);
    expect(pending).toMatchObject({ status: "pending", invoiceId: "in_ref1" });
    expect(pending.eligibleAt!.getTime() - pending.paidAt!.getTime()).toBe(14 * DAY);
    // A second paid invoice (or a redelivered event) queues nothing more.
    await firstPayment(s, 330, "evt_paid_2");

    // Not yet: the job waits for the refund window.
    expect((await runDueJobs(s.ctx.deps)).ran).toBe(0);
    later(s, 15);
    expect((await runDueJobs(s.ctx.deps)).ran).toBe(1);
    const done = await row(s);
    expect(done).toMatchObject({ status: "credited", referredCreditCents: 300, referrerCreditCents: 300, reason: null });
    const tx = credits(s);
    expect(tx.map((c) => [c.path, new URLSearchParams(c.body).get("amount"), new URLSearchParams(c.body).get("currency"), c.idem])).toEqual([
      ["/v1/customers/cus_B/balance_transactions", "-300", "aud", `multies-referral-${done.id}-referred`],
      ["/v1/customers/cus_new1/balance_transactions", "-300", "aud", `multies-referral-${done.id}-referrer`],
    ]);
    // The referrer had no Stripe customer yet: one was made and kept.
    expect((await s.ctx.db.select().from(organizations).where(eq(organizations.id, s.referrerOrg)).get())!.stripeCustomerId).toBe("cus_new1");
    // Running the grant again credits nothing more.
    expect(await grantReferral(s.ctx.deps, done.id)).toMatchObject({ skipped: true });
    expect(credits(s).length).toBe(2);
    const info = (await s.a.get("/api/billing/referral")).body;
    expect(info).toMatchObject({ signedUp: 1, credited: 1, creditedThisYear: 1, capPerYear: 12 });
  });

  it("blocks a sign up from the same company domain at once, but not two people on a public mail domain", async () => {
    const same = await setup("owner@acme.io", "bob@acme.io");
    expect(await row(same)).toMatchObject({ status: "blocked", reason: "self_referral_domain" });
    await firstPayment(same);
    expect((await row(same)).status).toBe("blocked");

    const pub = await setup("ann@gmail.com", "bob@gmail.com");
    expect((await row(pub)).status).toBe("signed_up");
  });

  it("voids a referral refunded inside the window, and checks the charges again before crediting", async () => {
    const s = await setup();
    await firstPayment(s);
    await postWebhook(s.ctx.app, { id: "evt_refund", type: "charge.refunded", data: { object: { id: "ch_1", customer: "cus_B", amount_refunded: 330 } } });
    expect(await row(s)).toMatchObject({ status: "void", reason: "refunded" });

    const t = await setup("ann@one.io", "bob@two.io");
    await firstPayment(t);
    t.stripe.charges.cus_B = [{ id: "ch_1", refunded: false, amount_refunded: 100, payment_method_details: { card: { fingerprint: "fp_b" } } }];
    later(t, 15);
    await runDueJobs(t.ctx.deps);
    expect(await row(t)).toMatchObject({ status: "void", reason: "refunded" });
    expect(credits(t)).toEqual([]);
  });

  it("blocks the same card at grant time", async () => {
    const s = await setup();
    await s.ctx.db.update(organizations).set({ stripeCustomerId: "cus_A" }).where(eq(organizations.id, s.referrerOrg));
    s.stripe.cards.cus_A = ["fp_b"];
    await firstPayment(s);
    later(s, 15);
    await runDueJobs(s.ctx.deps);
    expect(await row(s)).toMatchObject({ status: "blocked", reason: "same_card" });
    expect(credits(s)).toEqual([]);
  });

  it("caps the referrer at 12 credits a year while the new workspace still gets its credit", async () => {
    const s = await setup();
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      await s.ctx.db.insert(referrals).values({
        id: `ref_old${i}`, referrerOrgId: s.referrerOrg, referredOrgId: `org_old${i}`, code: s.ref.code, status: "credited",
        creditedAt: new Date(now.getTime() - (i + 1) * DAY), referrerCreditCents: 100, referredCreditCents: 100, createdAt: now,
      });
    }
    await firstPayment(s);
    later(s, 15);
    await runDueJobs(s.ctx.deps);
    expect(await row(s)).toMatchObject({ status: "credited", referredCreditCents: 300, referrerCreditCents: 0, reason: "cap" });
    expect(credits(s).map((c) => c.path)).toEqual(["/v1/customers/cus_B/balance_transactions"]);
  });

  it("ignores a referral cookie with an unknown code", async () => {
    const stripe = fakeStripe();
    const ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch });
    const b = new Client(ctx.app);
    b.jar.set("mm_ref", "ZZZZZZZZ");
    await b.signup("new@person.io");
    expect(await ctx.db.select().from(referrals).all()).toEqual([]);
  });
});

describe("checkout, yearly and the launch code", () => {
  it("allows promotion codes on monthly checkouts only, and charges a chosen year at ten months", async () => {
    const stripe = fakeStripe();
    const ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch });
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const checkouts = () => stripe.calls.filter((c) => c.path === "/v1/checkout/sessions").map((c) => new URLSearchParams(c.body));

    expect((await a.post("/api/billing/addons", { addons: { mailboxes: 2 } })).body).toMatchObject({ interval: "month" });
    expect(checkouts().at(-1)!.get("allow_promotion_codes")).toBe("true");

    expect((await a.post("/api/billing/addons", { addons: { mailboxes: 2 }, interval: "year" })).body).toMatchObject({ interval: "year" });
    expect(checkouts().at(-1)!.get("allow_promotion_codes")).toBe("false");
    const yearly = stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/prices").map((c) => new URLSearchParams(c.body)).find((p) => p.get("lookup_key") === "mymail_addon_mailboxes_yearly")!;
    expect(yearly.get("unit_amount")).toBe("3000");

    // Under A$5 a month: yearly only, so no code either.
    expect((await a.post("/api/billing/addons", { addons: { domain: 1 }, interval: "month" })).body).toMatchObject({ interval: "year" });
    expect(checkouts().at(-1)!.get("allow_promotion_codes")).toBe("false");
    expect((await a.post("/api/billing/addons", { addons: { domain: 1 }, interval: "weekly" })).status).toBe(422);

    const b = (await a.get("/api/billing")).body;
    expect(b).toMatchObject({ yearlyOnly: false, offers: { launchCode: "LAUNCH30", launchPercentOff: 30, launchMonths: 3 } });
  });

  it("drops the launch discount when a monthly subscription moves to yearly, and keeps yearly when quantities change", async () => {
    const stripe = fakeStripe();
    const ctx = await makeTestApp(STRIPE_ENV, { fetch: stripe.fetch });
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    const item = (key: string, interval: string, quantity: number) => ({ id: `si_${key}`, quantity, price: { id: `price_auto_${key}`, lookup_key: key, recurring: { interval } }, current_period_end: 1792600000 });
    stripe.subs.sub_1 = { id: "sub_1", object: "subscription", customer: "cus_123", status: "active", cancel_at_period_end: false, metadata: { orgId }, discounts: ["di_launch"], items: { data: [item("mymail_addon_mailboxes_monthly", "month", 2)] } };
    await postWebhook(ctx.app, { id: "evt_s1", type: "customer.subscription.created", data: { object: stripe.subs.sub_1 } });

    const preview = await a.post("/api/billing/addons/preview", { addons: { mailboxes: 2 }, interval: "year" });
    expect(preview.body).toMatchObject({ interval: "year", dropsDiscount: true, charge: { interval: "year", amount: 60 } });
    const previewCall = new URLSearchParams(stripe.calls.filter((c) => c.path === "/v1/invoices/create_preview").at(-1)!.body);
    expect(previewCall.has("discounts")).toBe(true);
    expect(previewCall.get("discounts")).toBe("");

    const moved = await a.post("/api/billing/addons", { addons: { mailboxes: 2 }, interval: "year" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const update = new URLSearchParams(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1").at(-1)!.body);
    expect(update.get("discounts")).toBe("");
    expect(update.get("items[0][price]")).toBe("price_auto_mymail_addon_mailboxes_yearly");

    // Now yearly (as Stripe reads it after the change): adding a pack stays yearly without asking, and sends no discount change.
    stripe.subs.sub_1 = { ...(stripe.subs.sub_1 as object), discounts: [], items: { data: [item("mymail_addon_mailboxes_yearly", "year", 2)] } };
    await a.post("/api/billing/addons", { addons: { mailboxes: 3 } });
    const again = new URLSearchParams(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1").at(-1)!.body);
    expect(again.get("items[0][price]")).toBe("price_auto_mymail_addon_mailboxes_yearly");
    expect(again.has("discounts")).toBe(false);
  });

  it("keeps 2,500 GB for a grandfathered Business workspace and gives a new one 1,000 GB", async () => {
    const ctx = await makeTestApp();
    const a = new Client(ctx.app);
    await a.signup("owner@acme.io");
    const orgId = (await a.get("/api/account/me")).body.organization.id;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    expect((await a.get("/api/billing")).body.limits.storageMb).toBe(1000 * 1024);
    await ctx.db.update(organizations).set({ legacyStorageMb: 2560000 }).where(eq(organizations.id, orgId));
    expect((await a.get("/api/billing")).body.limits.storageMb).toBe(2500 * 1024);
    await ctx.db.update(organizations).set({ plan: "starter" }).where(eq(organizations.id, orgId));
    expect((await a.get("/api/billing")).body.limits).toMatchObject({ storageMb: 3 * 1024, seats: 3 });
  });
});
