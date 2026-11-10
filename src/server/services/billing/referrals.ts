/**
 * R62: referrals. Every workspace has a referral link (made the first time an owner or admin opens it in Billing).
 * A workspace created by someone who arrived through that link is recorded here. When the new workspace makes its
 * first paid payment, a job waits out the refund window (14 days); if the payment still stands and it is not a self
 * referral, both workspaces get a Stripe customer balance credit worth one month of the new workspace's add-ons (at
 * least A$1, at most A$20), which Stripe takes off their next invoices. A referrer earns at most 12 credits a year.
 *
 * Self referral is blocked on the same owner or admin email, the same company email domain (public mail domains
 * such as gmail.com never count as a match), membership of the referring workspace, or the same card.
 *
 * D1 cost: nothing on any hot route. Sign up through a link: one indexed read and one write. A paid invoice: one
 * read by primary key of the new workspace's row in referrals. The grant job: a handful of reads, once per referral.
 */
import { and, count, eq, gte, gt, isNull } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { members, organizations, referrals } from "../../db/schema";
import { HttpError, forbidden } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { ADDONS, ADDON_ORDER, PLANS, PRICE_CURRENCY } from "@/shared/plans";
import {
  REFERRAL_CAP_PER_YEAR, REFERRAL_CODE_RE, REFERRAL_COOKIE, REFERRAL_HOLD_DAYS, REFERRAL_MAX_CENTS, REFERRAL_MIN_CENTS, REFERRAL_PARAM, referralCreditCents,
} from "@/shared/offers";
import { audit } from "../audit";
import { effectivePlanId, getAddons, getOrg } from "../plans";
import { enqueue, PermanentJobError } from "../jobs";
import { billingContacts } from "./dunning";
import type { Stripe } from "./stripe";
import { loadStripe } from "./stripe-lazy";

const DAY = 86_400_000;
type Org = typeof organizations.$inferSelect;

/** Letters and digits without look alikes (no I, O, 0, 1). */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newReferralCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function normalizeReferralCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const code = v.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/** The referral code in a request's cookie header, if any. */
export function referralCodeFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === REFERRAL_COOKIE) return normalizeReferralCode(decodeURIComponent(v.join("=")));
  }
  return null;
}

/** Mail domains anyone can sign up for: sharing one says nothing about who owns a workspace. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.com.au", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "zoho.com", "yandex.com",
  "fastmail.com", "hey.com", "tutanota.com", "mail.com", "bigpond.com", "bigpond.net.au", "optusnet.com.au", "outlook.com.au", "hotmail.com.au",
  "mail.multies.si", "multies.si",
]);

const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";
export const isPublicMailDomain = (domain: string) => PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase());

/**
 * Why a referral is a self referral, or null when it isn't. `referrer` and `referred` are the owner and admin emails
 * of each side; card fingerprints come from Stripe.
 */
export function selfReferralReason(
  referrer: { emails: string[]; cards?: string[] },
  referred: { emails: string[]; cards?: string[]; isMemberOfReferrer?: boolean },
): string | null {
  if (referred.isMemberOfReferrer) return "member";
  const a = new Set(referrer.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (referred.emails.some((e) => a.has(e.trim().toLowerCase()))) return "self_referral_email";
  const domains = new Set([...a].map(domainOf).filter((d) => d && !isPublicMailDomain(d)));
  if (referred.emails.some((e) => domains.has(domainOf(e)))) return "self_referral_domain";
  const cards = new Set((referrer.cards ?? []).filter(Boolean));
  if ((referred.cards ?? []).some((c) => c && cards.has(c))) return "same_card";
  return null;
}

async function client(deps: Deps): Promise<Stripe> {
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) throw new HttpError(409, "billing_not_connected", "Billing isn't connected on this deployment.");
  const { stripeClient } = await loadStripe();
  return stripeClient(b.stripeSecretKey, deps.fetch);
}

export const referralLink = (appUrl: string, code: string) => `${appUrl.replace(/\/$/, "")}/?${REFERRAL_PARAM}=${code}`;

/** The workspace's referral link and how it has done. Makes the code on first use. Owners and admins only. */
export async function referralInfo(deps: Deps, auth: AuthContext) {
  if (auth.role !== "owner" && auth.role !== "admin") throw forbidden("Only workspace owners and admins can see the referral link.");
  const org = await getOrg(deps.db, auth.orgId);
  let code = org.referralCode;
  for (let attempt = 0; !code && attempt < 3; attempt++) {
    const next = newReferralCode();
    try {
      // The where clause keeps a code made at the same moment by another request.
      await deps.db.update(organizations).set({ referralCode: next }).where(and(eq(organizations.id, org.id), isNull(organizations.referralCode)));
      code = (await getOrg(deps.db, auth.orgId)).referralCode;
    } catch { /* a clash with another workspace's code: try another */ }
  }
  if (!code) throw new HttpError(503, "referral_code_unavailable", "Couldn't make a referral link just now. Try again.");
  const since = new Date(deps.now().getTime() - 365 * DAY);
  const rows = await deps.db.select({ status: referrals.status, n: count() }).from(referrals)
    .where(eq(referrals.referrerOrgId, org.id)).groupBy(referrals.status);
  const creditedThisYear = (await deps.db.select({ n: count() }).from(referrals)
    .where(and(eq(referrals.referrerOrgId, org.id), eq(referrals.status, "credited"), gte(referrals.creditedAt, since), gt(referrals.referrerCreditCents, 0))).get())?.n ?? 0;
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return {
    code, link: referralLink(deps.config.appUrl, code),
    signedUp: rows.reduce((s, r) => s + Number(r.n), 0), waiting: (by.signed_up ?? 0) + (by.pending ?? 0), credited: by.credited ?? 0,
    creditedThisYear: Number(creditedThisYear), capPerYear: REFERRAL_CAP_PER_YEAR, holdDays: REFERRAL_HOLD_DAYS,
    minCreditCents: REFERRAL_MIN_CENTS, maxCreditCents: REFERRAL_MAX_CENTS,
  };
}

/**
 * Records that a new workspace was created by someone who came through a referral link. Called once, on the first
 * sign in path that creates the workspace. Never throws: a bad or unknown code just records nothing.
 */
export async function recordReferralSignup(deps: Deps, input: { orgId: string; userId: string; email: string; code: string | null }) {
  try {
    const code = normalizeReferralCode(input.code);
    if (!code) return null;
    const referrer = await deps.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.referralCode, code)).get();
    if (!referrer || referrer.id === input.orgId) return null;
    const [contacts, member] = await Promise.all([
      billingContacts(deps, referrer.id),
      deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, referrer.id), eq(members.userId, input.userId))).get(),
    ]);
    const reason = selfReferralReason({ emails: contacts }, { emails: [input.email], isMemberOfReferrer: !!member });
    const id = newId("ref");
    await deps.db.insert(referrals).values({
      id, referrerOrgId: referrer.id, referredOrgId: input.orgId, code, status: reason ? "blocked" : "signed_up", reason, createdAt: deps.now(),
    }).onConflictDoNothing();
    await audit(deps.db, { orgId: input.orgId, actorUserId: input.userId, actorEmail: input.email, action: "billing.referral_signed_up", metadata: { referrer: referrer.id, blocked: reason } });
    return { id, status: reason ? "blocked" : "signed_up", reason };
  } catch (err) {
    deps.log?.warn?.("referral.signup_failed", { error: String(err).slice(0, 200) });
    return null;
  }
}

interface PaidInvoice { id?: string; amount_paid?: number; customer?: unknown }

/**
 * A paid invoice: if it is the first paid payment of a referred workspace, the referral starts waiting out the
 * refund window and a grant job is queued for the end of it. One read for every paid invoice.
 */
export async function onReferralPayment(deps: Deps, org: Org, inv: PaidInvoice) {
  if (!inv.amount_paid || inv.amount_paid <= 0) return null;
  const row = await deps.db.select().from(referrals).where(eq(referrals.referredOrgId, org.id)).get();
  if (!row || row.status !== "signed_up") return null;
  const now = deps.now();
  const eligibleAt = new Date(now.getTime() + REFERRAL_HOLD_DAYS * DAY);
  // Conditional update: a webhook delivered twice queues one job.
  const moved = await deps.db.update(referrals).set({ status: "pending", invoiceId: inv.id ?? null, paidAt: now, eligibleAt })
    .where(and(eq(referrals.id, row.id), eq(referrals.status, "signed_up"))).returning({ id: referrals.id });
  if (!moved.length) return null;
  await enqueue(deps, "billing.referral_grant", { referralId: row.id }, { orgId: org.id, delayMs: REFERRAL_HOLD_DAYS * DAY });
  await audit(deps.db, { orgId: org.id, action: "billing.referral_paid", metadata: { referral: row.id, eligibleAt: eligibleAt.toISOString() } });
  return { referralId: row.id, eligibleAt };
}

/** A refunded charge voids a referral still inside its refund window. */
export async function onReferralRefund(deps: Deps, org: Org) {
  const row = await deps.db.select({ id: referrals.id, status: referrals.status }).from(referrals).where(eq(referrals.referredOrgId, org.id)).get();
  if (!row || row.status !== "pending") return null;
  await deps.db.update(referrals).set({ status: "void", reason: "refunded" }).where(and(eq(referrals.id, row.id), eq(referrals.status, "pending")));
  await audit(deps.db, { orgId: org.id, action: "billing.referral_void", metadata: { referral: row.id, reason: "refunded" } });
  return { referralId: row.id, status: "void" as const };
}

type ChargeLike = { refunded?: boolean; amount_refunded?: number; disputed?: boolean; status?: string; payment_method_details?: { card?: { fingerprint?: string | null } | null } | null };

const cardsOf = (charges: ChargeLike[]) => charges.map((c) => c.payment_method_details?.card?.fingerprint ?? "").filter(Boolean);

async function ensureReferrerCustomer(deps: Deps, stripe: Stripe, org: Org, email: string | undefined) {
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const c = await stripe.customers.create({
    email, name: org.name, metadata: { orgId: org.id }, address: { country: org.country }, preferred_locales: ["en-AU"],
  }, { idempotencyKey: `multies-customer-${org.id}` });
  await deps.db.update(organizations).set({ stripeCustomerId: c.id }).where(eq(organizations.id, org.id));
  return c.id;
}

/** A month of the workspace's add-ons (and a legacy plan's price), in A$. */
export async function monthlyTotal(deps: Deps, org: Org) {
  const addons = await getAddons(deps.db, org.id);
  const plan = PLANS[effectivePlanId(org)]; // PRIV1b (CB1): a comp workspace is on the plan it was granted
  const base = plan.legacy ? plan.priceMonthly : 0;
  return base + ADDON_ORDER.reduce((s, id) => s + ADDONS[id].priceMonthly * (addons[id] ?? 0), 0);
}

/**
 * The grant job, run at the end of the refund window. Checks the payment still stands, checks for self referral
 * again (now with card fingerprints), applies the yearly cap, then credits both sides through Stripe customer
 * balance transactions with idempotency keys, so a retried job never credits twice.
 */
export async function grantReferral(deps: Deps, referralId: string) {
  const row = await deps.db.select().from(referrals).where(eq(referrals.id, referralId)).get();
  if (!row) throw new PermanentJobError("referral not found");
  if (row.status !== "pending") return { status: row.status, skipped: true };
  if (row.eligibleAt && row.eligibleAt.getTime() > deps.now().getTime()) throw new PermanentJobError("referral not yet eligible");
  const finish = async (status: "credited" | "blocked" | "void", fields: Partial<typeof referrals.$inferInsert> = {}) => {
    await deps.db.update(referrals).set({ status, ...fields }).where(and(eq(referrals.id, row.id), eq(referrals.status, "pending")));
    await audit(deps.db, { orgId: row.referredOrgId, action: `billing.referral_${status}`, metadata: { referral: row.id, reason: fields.reason ?? null, referrerOrg: row.referrerOrgId } });
    return { status, ...fields };
  };
  const [referred, referrer] = await Promise.all([
    deps.db.select().from(organizations).where(eq(organizations.id, row.referredOrgId)).get(),
    deps.db.select().from(organizations).where(eq(organizations.id, row.referrerOrgId)).get(),
  ]);
  if (!referred?.stripeCustomerId) return finish("void", { reason: "workspace_gone" });
  if (!referrer) return finish("void", { reason: "referrer_gone" });
  const stripe = await client(deps);
  // The payment must still stand: invoice paid, no credit note after payment, no refund or dispute on the charges.
  if (row.invoiceId) {
    const inv = await stripe.invoices.retrieve(row.invoiceId) as unknown as { status?: string; post_payment_credit_notes_amount?: number };
    if (inv.status !== "paid" || (inv.post_payment_credit_notes_amount ?? 0) > 0) return finish("void", { reason: "refunded" });
  }
  const referredCharges = (await stripe.charges.list({ customer: referred.stripeCustomerId, limit: 20 })).data as unknown as ChargeLike[];
  if (referredCharges.some((c) => c.refunded || (c.amount_refunded ?? 0) > 0 || c.disputed)) return finish("void", { reason: "refunded" });
  // Self referral, now with cards.
  const referrerCards: string[] = [];
  if (referrer.stripeCustomerId) {
    const [pms, charges] = await Promise.all([
      stripe.paymentMethods.list({ customer: referrer.stripeCustomerId, type: "card", limit: 20 }),
      stripe.charges.list({ customer: referrer.stripeCustomerId, limit: 20 }),
    ]);
    for (const pm of pms.data) if (pm.card?.fingerprint) referrerCards.push(pm.card.fingerprint);
    referrerCards.push(...cardsOf(charges.data as unknown as ChargeLike[]));
  }
  const [referrerEmails, referredEmails] = await Promise.all([billingContacts(deps, referrer.id), billingContacts(deps, referred.id)]);
  const reason = selfReferralReason({ emails: referrerEmails, cards: referrerCards }, { emails: referredEmails, cards: cardsOf(referredCharges) });
  if (reason) return finish("blocked", { reason });
  const cents = referralCreditCents(await monthlyTotal(deps, referred));
  const since = new Date(deps.now().getTime() - 365 * DAY);
  const earned = (await deps.db.select({ n: count() }).from(referrals)
    .where(and(eq(referrals.referrerOrgId, referrer.id), eq(referrals.status, "credited"), gte(referrals.creditedAt, since), gt(referrals.referrerCreditCents, 0))).get())?.n ?? 0;
  const referrerGets = Number(earned) < REFERRAL_CAP_PER_YEAR;
  const credit = (customer: string, side: "referred" | "referrer") => stripe.customers.createBalanceTransaction(customer, {
    amount: -cents, currency: PRICE_CURRENCY, description: "Referral credit: one month of add-ons free", metadata: { referralId: row.id, side },
  }, { idempotencyKey: `multies-referral-${row.id}-${side}` });
  await credit(referred.stripeCustomerId, "referred");
  if (referrerGets) await credit(await ensureReferrerCustomer(deps, stripe, referrer, referrerEmails[0]), "referrer");
  await audit(deps.db, { orgId: referrer.id, action: "billing.referral_credited", metadata: { referral: row.id, cents: referrerGets ? cents : 0, capped: !referrerGets } });
  return finish("credited", {
    creditedAt: deps.now(), referredCreditCents: cents, referrerCreditCents: referrerGets ? cents : 0, reason: referrerGets ? null : "cap",
  });
}
