/**
 * OPS1: the operator console's Billing service. Reads across every workspace (subscriptions, past due and dunning,
 * processed Stripe events, referrals, one workspace's billing) and operator actions on any workspace (plan, comp,
 * credit, trial, grace, resync, cancel at period end).
 *
 * These are plain functions: the route layer checks the operator's permission, asks for the reason and writes the
 * platform audit row. Each action returns `{ before, after }` snapshots for that row. Stripe ids are returned as ids
 * only; no secret, card or payment method detail is read or returned. Amounts are integer cents.
 *
 * With billing off or Stripe not configured, reads still answer (no invoices) and actions that need Stripe throw
 * `billing_unavailable` (409). Comp and grace changes are local and work either way.
 *
 * The comp end date and note (organizations.compUntil / compNote) and the event summary (billingEvents.summary) came
 * with migration 0174.
 */
import { and, desc, eq, getTableColumns, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Deps } from "../../context";
import { billingEvents, organizations, platformAuditLogs, referrals } from "../../db/schema";
import { HttpError, badRequest } from "../../lib/errors";
import { containsText } from "../../lib/like-search";
import { PLANS, PRICE_CURRENCY, effectiveLimits, isPlanId, type AddonQuantities, type PlanId } from "@/shared/plans";
import { audit } from "../audit";
import { effectivePlanId, forgetOrgCache, getAddons, getOrg, usage } from "../plans";
import { sentToday } from "../mail/delivery";
import {
  changePlanFor, client, isMissingInStripe, listInvoices, syncSubscription, updateAddonsFor,
  type BillingTarget, type StripeSubscription,
} from "../billing";
import { sendingPausedForPayment } from "../billing/dunning";
import { isStripeError } from "../billing/stripe-lazy";
import { compExpiryFields, readCompExpiry } from "../billing/ops1-0174";
import { ownerEmails, withOwnerEmail } from "./owners";

type Org = typeof organizations.$inferSelect;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// Errors and limits

export const BILLING_UNAVAILABLE = "billing_unavailable";
export const billingUnavailable = () =>
  new HttpError(409, BILLING_UNAVAILABLE, "Billing isn't connected on this deployment, so Stripe actions are unavailable.");

export const CREDIT_MIN_CENTS = 1;
export const CREDIT_MAX_CENTS = 50_000;
export const NOTE_MAX = 300;
export const TRIAL_DAYS_MAX = 90;
export const GRACE_DAYS_MAX = 30;
export const COMP_MAX_DAYS = 3 * 366;
export const OPS_PLANS: readonly PlanId[] = ["starter", "pro", "business"];

function assertBilling(deps: Deps) {
  const b = deps.config.billing;
  if (!b.enabled || !b.stripeSecretKey) throw billingUnavailable();
}

/** What a Stripe step threw, as a typed HttpError (never the raw SDK error). */
function typedStripeError(e: unknown): unknown {
  if (e instanceof HttpError) return e.code === "billing_not_connected" ? billingUnavailable() : e;
  if (isMissingInStripe(e)) return new HttpError(409, "stripe_object_missing", "Stripe no longer has this customer or subscription. Resync the workspace.");
  if (isStripeError(e)) return new HttpError(502, "billing_provider_error", `The payment provider said: ${e.message}`);
  return e;
}

async function stripeStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw typedStripeError(e);
  }
}

function wholeIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}

function cleanNote(v: unknown, required: boolean): string | null {
  if (v == null || (typeof v === "string" && !v.trim())) {
    if (required) throw badRequest("A note is required.");
    return null;
  }
  if (typeof v !== "string") throw badRequest("The note must be text.");
  const t = v.trim();
  if (t.length > NOTE_MAX) throw badRequest(`The note can be up to ${NOTE_MAX} characters.`);
  return t;
}

function planIn(v: unknown): PlanId {
  if (!isPlanId(v)) throw new HttpError(400, "invalid_plan", `The plan must be one of ${OPS_PLANS.join(", ")}.`);
  return v;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------------------------------------------
// Paging (fixed contract: keyset on (sortField, id))

export type Cursor = { v: string | number; id: string };
export type PageInput = { limit: number; cursor: Cursor | null; sort: { field: string; dir: "asc" | "desc" } };
export type Paged<T> = { items: T[]; next: Cursor | null };
export const PAGE_LIMIT_MAX = 100;

export const SUBSCRIPTION_SORT_FIELDS = ["createdAt", "name", "currentPeriodEnd"] as const;
export const PAST_DUE_SORT_FIELDS = ["pastDueSince", "graceEndsAt", "name"] as const;
export const BILLING_EVENT_SORT_FIELDS = ["createdAt"] as const;
export const REFERRAL_SORT_FIELDS = ["createdAt", "eligibleAt", "creditedAt"] as const;

type SortExprs = Record<string, { expr: SQL; kind: "number" | "text" }>;

/** The keyset condition, order and fetch size for a page. Refuses a sort field outside `fields`. */
function keyset(page: PageInput, fields: SortExprs, idCol: SQLiteColumn) {
  if (!page || typeof page !== "object") throw badRequest("A page is required.");
  const limit = wholeIn(page.limit, 1, PAGE_LIMIT_MAX, "The page size");
  const field = page.sort?.field;
  const dir = page.sort?.dir;
  if (typeof field !== "string" || !Object.hasOwn(fields, field)) {
    throw new HttpError(400, "invalid_sort", `Sort by one of ${Object.keys(fields).join(", ")}.`);
  }
  if (dir !== "asc" && dir !== "desc") throw new HttpError(400, "invalid_sort", "The sort direction must be asc or desc.");
  const { expr, kind } = fields[field]!;
  let where: SQL | undefined;
  if (page.cursor) {
    const { v, id } = page.cursor;
    const okV = kind === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === "string" && v.length <= 500;
    if (!okV || typeof id !== "string" || !id || id.length > 200) throw new HttpError(400, "bad_cursor", "That page cursor isn't valid."); // OPS1 security: the console's one code
    where = dir === "asc"
      ? sql`(${expr} > ${v} or (${expr} = ${v} and ${idCol} > ${id}))`
      : sql`(${expr} < ${v} or (${expr} = ${v} and ${idCol} < ${id}))`;
  }
  const order = dir === "asc" ? [sql`${expr} asc`, sql`${idCol} asc`] : [sql`${expr} desc`, sql`${idCol} desc`];
  return { limit, where, order, key: expr };
}

function pageOf<R extends { _k: string | number; _id: string }, T>(rows: R[], limit: number, map: (r: R) => T): Paged<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(map), next: rows.length > limit && last ? { v: last._k, id: last._id } : null };
}

const orgSorts = {
  createdAt: { expr: sql`${organizations.createdAt}`, kind: "number" },
  name: { expr: sql`${organizations.name}`, kind: "text" },
  currentPeriodEnd: { expr: sql`coalesce(${organizations.currentPeriodEnd}, 0)`, kind: "number" },
  pastDueSince: { expr: sql`coalesce(${organizations.pastDueSince}, 0)`, kind: "number" },
  graceEndsAt: { expr: sql`coalesce(${organizations.graceEndsAt}, 0)`, kind: "number" },
} satisfies SortExprs;
const pick = <K extends string>(all: Record<string, SortExprs[string]>, keys: readonly K[]): SortExprs =>
  Object.fromEntries(keys.map((k) => [k, all[k]!]));

// ---------------------------------------------------------------------------------------------------------------
// Reads

export type DunningStage = "grace" | "paused" | "exempt";

function dunningOf(org: Org, now: Date) {
  if (!org.pastDueSince) return null;
  const paused = sendingPausedForPayment(org, now);
  const stage: DunningStage = org.compPlan ? "exempt" : paused ? "paused" : "grace";
  return {
    stage, pastDueSince: iso(org.pastDueSince), graceEndsAt: iso(org.graceEndsAt), sendingPaused: paused,
    daysPastDue: Math.max(0, Math.floor((now.getTime() - org.pastDueSince.getTime()) / DAY)),
  };
}

export type SubscriptionItem = {
  orgId: string; name: string; ownerEmail: string | null; plan: PlanId; effectivePlan: PlanId;
  comp: boolean; compUntil: string | null; compNote: string | null;
  status: string | null; interval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  pastDue: boolean; stripeCustomerId: string | null; stripeSubscriptionId: string | null; createdAt: string;
};

function subscriptionItem(org: Org): Omit<SubscriptionItem, "ownerEmail"> {
  return {
    orgId: org.id, name: org.name, plan: org.plan, effectivePlan: effectivePlanId(org),
    comp: org.compPlan, compUntil: iso(org.compUntil), compNote: org.compNote,
    status: org.subscriptionStatus, interval: org.billingInterval ?? null, currentPeriodEnd: iso(org.currentPeriodEnd), cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    pastDue: !!org.pastDueSince, stripeCustomerId: org.stripeCustomerId, stripeSubscriptionId: org.stripeSubscriptionId, createdAt: org.createdAt.toISOString(),
  };
}

export type SubscriptionFilters = { status?: string; plan?: PlanId; comp?: boolean };

/**
 * Workspaces with billing: a Stripe customer, a subscription status, or a comp. `q` matches the workspace id or a
 * Stripe customer or subscription id exactly, or the name anywhere.
 */
export async function listSubscriptions(deps: Deps, input: { filters?: SubscriptionFilters; q?: string | null; page: PageInput }): Promise<Paged<SubscriptionItem>> {
  const ks = keyset(input.page, pick(orgSorts, SUBSCRIPTION_SORT_FIELDS), organizations.id);
  const f = input.filters ?? {};
  const conds: (SQL | undefined)[] = [
    or(isNotNull(organizations.stripeCustomerId), isNotNull(organizations.subscriptionStatus), eq(organizations.compPlan, true)),
    ks.where,
  ];
  if (f.status !== undefined) {
    if (typeof f.status !== "string" || !/^[a-z_]{1,40}$/.test(f.status)) throw badRequest("Unknown subscription status.");
    conds.push(eq(organizations.subscriptionStatus, f.status));
  }
  if (f.plan !== undefined) conds.push(eq(organizations.plan, planIn(f.plan)));
  if (f.comp !== undefined) conds.push(eq(organizations.compPlan, !!f.comp));
  const q = (input.q ?? "").trim().slice(0, 200);
  if (q) {
    conds.push(or(
      eq(organizations.id, q), eq(organizations.stripeCustomerId, q), eq(organizations.stripeSubscriptionId, q), containsText(organizations.name, q),
    ));
  }
  const rows = await deps.db.select({ ...getTableColumns(organizations), _k: sql<string | number>`${ks.key}`, _id: organizations.id })
    .from(organizations).where(and(...conds)).orderBy(...ks.order).limit(ks.limit + 1);
  const page = pageOf(rows, ks.limit, (r) => subscriptionItem(r));
  return { ...page, items: await withOwnerEmail(deps, page.items) };
}

export type PastDueItem = {
  orgId: string; name: string; ownerEmail: string | null; plan: PlanId; effectivePlan: PlanId; comp: boolean; status: string | null;
  stage: DunningStage; pastDueSince: string | null; graceEndsAt: string | null; sendingPaused: boolean; daysPastDue: number;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null;
};

/** Workspaces in dunning (a failed payment not yet recovered), with the stage and when grace ends. */
export async function listPastDue(deps: Deps, page: PageInput): Promise<Paged<PastDueItem>> {
  const ks = keyset(page, pick(orgSorts, PAST_DUE_SORT_FIELDS), organizations.id);
  const rows = await deps.db.select({ ...getTableColumns(organizations), _k: sql<string | number>`${ks.key}`, _id: organizations.id })
    .from(organizations).where(and(isNotNull(organizations.pastDueSince), ks.where)).orderBy(...ks.order).limit(ks.limit + 1);
  const now = deps.now();
  const paged = pageOf(rows, ks.limit, (org) => {
    const d = dunningOf(org, now)!;
    return {
      orgId: org.id, name: org.name, plan: org.plan, effectivePlan: effectivePlanId(org), comp: org.compPlan, status: org.subscriptionStatus,
      stage: d.stage, pastDueSince: d.pastDueSince, graceEndsAt: d.graceEndsAt, sendingPaused: d.sendingPaused, daysPastDue: d.daysPastDue,
      stripeCustomerId: org.stripeCustomerId, stripeSubscriptionId: org.stripeSubscriptionId,
    };
  });
  return { ...paged, items: await withOwnerEmail(deps, paged.items) };
}

export type BillingEventItem = { id: string; type: string; orgId: string | null; orgName: string | null; ownerEmail: string | null; summary: string | null; createdAt: string };

/** Processed Stripe webhook events, newest first by default, for one workspace or all, optionally of one type. */
export async function listBillingEvents(deps: Deps, input: { orgId?: string | null; type?: string | null; page: PageInput }): Promise<Paged<BillingEventItem>> {
  const ks = keyset(input.page, { createdAt: { expr: sql`${billingEvents.createdAt}`, kind: "number" } }, billingEvents.id);
  const conds: (SQL | undefined)[] = [ks.where];
  if (input.orgId) conds.push(eq(billingEvents.orgId, String(input.orgId).slice(0, 200)));
  if (input.type) {
    if (!/^[a-z0-9_.]{1,80}$/.test(input.type)) throw badRequest("Unknown event type.");
    conds.push(eq(billingEvents.type, input.type));
  }
  const rows = await deps.db.select({
    id: billingEvents.id, type: billingEvents.type, orgId: billingEvents.orgId, createdAt: billingEvents.createdAt, orgName: organizations.name,
    summary: billingEvents.summary,
    _k: sql<string | number>`${ks.key}`, _id: billingEvents.id,
  }).from(billingEvents).leftJoin(organizations, eq(organizations.id, billingEvents.orgId))
    .where(and(...conds)).orderBy(...ks.order).limit(ks.limit + 1);
  const page = pageOf(rows, ks.limit, (r) => ({ id: r.id, type: r.type, orgId: r.orgId, orgName: r.orgName ?? null, summary: r.summary ?? null, createdAt: r.createdAt.toISOString() }));
  return { ...page, items: await withOwnerEmail(deps, page.items) };
}

export type ReferralItem = {
  id: string; code: string; status: string; reason: string | null;
  referrerOrgId: string; referrerName: string | null; referrerOwnerEmail: string | null;
  referredOrgId: string; referredName: string | null; referredOwnerEmail: string | null;
  invoiceId: string | null; paidAt: string | null; eligibleAt: string | null; creditedAt: string | null;
  referrerCreditCents: number; referredCreditCents: number; createdAt: string;
};
const REFERRAL_STATUSES = ["signed_up", "pending", "credited", "blocked", "void"] as const;

/** Referrals across workspaces; `orgId` matches either side. */
export async function listReferrals(deps: Deps, input: { filters?: { status?: string; orgId?: string }; page: PageInput }): Promise<Paged<ReferralItem>> {
  const ks = keyset(input.page, {
    createdAt: { expr: sql`${referrals.createdAt}`, kind: "number" },
    eligibleAt: { expr: sql`coalesce(${referrals.eligibleAt}, 0)`, kind: "number" },
    creditedAt: { expr: sql`coalesce(${referrals.creditedAt}, 0)`, kind: "number" },
  }, referrals.id);
  const f = input.filters ?? {};
  const conds: (SQL | undefined)[] = [ks.where];
  if (f.status !== undefined) {
    const status = REFERRAL_STATUSES.find((s) => s === f.status);
    if (!status) throw badRequest(`The referral status must be one of ${REFERRAL_STATUSES.join(", ")}.`);
    conds.push(eq(referrals.status, status));
  }
  if (f.orgId) conds.push(or(eq(referrals.referrerOrgId, f.orgId), eq(referrals.referredOrgId, f.orgId)));
  const referrer = alias(organizations, "referrer_org");
  const referred = alias(organizations, "referred_org");
  const rows = await deps.db.select({
    ...getTableColumns(referrals), referrerName: referrer.name, referredName: referred.name,
    _k: sql<string | number>`${ks.key}`, _id: referrals.id,
  }).from(referrals)
    .leftJoin(referrer, eq(referrer.id, referrals.referrerOrgId))
    .leftJoin(referred, eq(referred.id, referrals.referredOrgId))
    .where(and(...conds)).orderBy(...ks.order).limit(ks.limit + 1);
  const owners = await ownerEmails(deps, rows.slice(0, ks.limit).flatMap((r) => [r.referrerOrgId, r.referredOrgId]));
  return pageOf(rows, ks.limit, (r) => ({
    id: r.id, code: r.code, status: r.status, reason: r.reason,
    referrerOrgId: r.referrerOrgId, referrerName: r.referrerName ?? null, referrerOwnerEmail: owners.get(r.referrerOrgId) ?? null,
    referredOrgId: r.referredOrgId, referredName: r.referredName ?? null, referredOwnerEmail: owners.get(r.referredOrgId) ?? null,
    invoiceId: r.invoiceId, paidAt: iso(r.paidAt), eligibleAt: iso(r.eligibleAt), creditedAt: iso(r.creditedAt),
    referrerCreditCents: r.referrerCreditCents, referredCreditCents: r.referredCreditCents, createdAt: r.createdAt.toISOString(),
  }));
}

export type WorkspaceBilling = Awaited<ReturnType<typeof getWorkspaceBilling>>;

/** One workspace's billing for the console: plan, comp, Stripe ids, status, dunning, add-ons, usage against limits, invoices. */
export async function getWorkspaceBilling(deps: Deps, orgId: string) {
  const org = await getOrg(deps.db, orgId);
  const now = deps.now();
  const [used, sends, addons, events] = await Promise.all([
    usage(deps.db, orgId, now), sentToday(deps.db, orgId, now), getAddons(deps.db, orgId),
    listBillingEvents(deps, { orgId, page: { limit: 10, cursor: null, sort: { field: "createdAt", dir: "desc" } } }),
  ]);
  let invoices: Awaited<ReturnType<typeof listInvoices>> = [];
  let invoicesError: string | null = null;
  try {
    invoices = await stripeStep(() => listInvoices(deps, orgId));
  } catch (e) {
    invoicesError = e instanceof HttpError ? e.code : "billing_provider_error";
  }
  const effective = effectivePlanId(org);
  const comp = readCompExpiry(org);
  const [credit, recentCredits] = await Promise.all([creditBalance(deps, org.stripeCustomerId), recentCreditsOf(deps, org.id)]);
  return {
    orgId: org.id, name: org.name,
    billing: { enabled: deps.config.billing.enabled && !!deps.config.billing.stripeSecretKey, testMode: deps.config.billing.testMode },
    plan: org.plan, effectivePlan: effective,
    comp: { on: org.compPlan, until: iso(comp.compUntil), note: comp.compNote, expirySupported: true },
    stripe: { customerId: org.stripeCustomerId, subscriptionId: org.stripeSubscriptionId },
    subscription: { status: org.subscriptionStatus, interval: org.billingInterval ?? null, currentPeriodEnd: iso(org.currentPeriodEnd), cancelAtPeriodEnd: org.cancelAtPeriodEnd },
    dunning: dunningOf(org, now),
    addons,
    usage: { ...used, sendsToday: sends },
    limits: effectiveLimits(PLANS[effective], addons, org),
    referralCode: org.referralCode,
    invoices, invoicesError,
    recentEvents: events.items,
    creditBalance: credit,
    recentCredits,
  };
}

/**
 * OPS1: the credit the Stripe customer holds now (Stripe's balance, negative is credit; shown here as a positive
 * credit), which Stripe takes off the next invoices. Includes referral credits and anything changed in Stripe itself.
 * null cents without Stripe or a customer; an error code when Stripe could not be read.
 */
async function creditBalance(deps: Deps, customerId: string | null): Promise<{ cents: number | null; currency: string | null; error: string | null }> {
  if (!customerId || !deps.config.billing.enabled || !deps.config.billing.stripeSecretKey) return { cents: null, currency: null, error: null };
  try {
    const c = await stripeStep(async () => (await client(deps)).customers.retrieve(customerId));
    if ("deleted" in c && c.deleted) return { cents: null, currency: null, error: "customer_deleted" };
    const live = c as { balance?: number | null; currency?: string | null };
    return { cents: -(live.balance ?? 0), currency: live.currency ?? PRICE_CURRENCY, error: null };
  } catch (e) {
    return { cents: null, currency: null, error: e instanceof HttpError ? e.code : "billing_provider_error" };
  }
}

/** The last five credits added from the console (platform audit rows billing.credit_added): amount, note, who, why. */
async function recentCreditsOf(deps: Deps, orgId: string) {
  const rows = await deps.db.select({
    at: platformAuditLogs.createdAt, actorUserId: platformAuditLogs.actorUserId, actorEmail: platformAuditLogs.actorEmail,
    reason: platformAuditLogs.reason, metadata: platformAuditLogs.metadata,
  }).from(platformAuditLogs)
    .where(and(eq(platformAuditLogs.orgId, orgId), eq(platformAuditLogs.action, "billing.credit_added")))
    .orderBy(desc(platformAuditLogs.createdAt)).limit(5);
  return rows.map((r) => {
    let m: { amountCents?: unknown; note?: unknown } = {};
    try { m = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* an unreadable row shows without its amount */ }
    return {
      at: r.at.toISOString(), actorUserId: r.actorUserId, actorEmail: r.actorEmail, reason: r.reason,
      amountCents: typeof m.amountCents === "number" ? m.amountCents : null, note: typeof m.note === "string" ? m.note : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots for the audit row

export type BillingSnapshot = {
  plan: PlanId; effectivePlan: PlanId; comp: boolean; compUntil: string | null; compNote: string | null;
  subscriptionStatus: string | null; interval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  pastDueSince: string | null; graceEndsAt: string | null; addons: AddonQuantities;
};
export type OpsResult<Extra extends object = object> = { before: BillingSnapshot; after: BillingSnapshot } & Extra;

async function snapshot(deps: Deps, orgId: string): Promise<BillingSnapshot> {
  const [org, addons] = await Promise.all([getOrg(deps.db, orgId), getAddons(deps.db, orgId)]);
  return snapshotOf(org, addons);
}

function snapshotOf(org: Org, addons: AddonQuantities): BillingSnapshot {
  const comp = readCompExpiry(org);
  return {
    plan: org.plan, effectivePlan: effectivePlanId(org), comp: org.compPlan, compUntil: iso(comp.compUntil), compNote: comp.compNote,
    subscriptionStatus: org.subscriptionStatus, interval: org.billingInterval ?? null, currentPeriodEnd: iso(org.currentPeriodEnd), cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    pastDueSince: iso(org.pastDueSince), graceEndsAt: iso(org.graceEndsAt), addons,
  };
}

const LIVE = new Set(["active", "trialing", "past_due"]);

function assertLiveSubscription(org: Org) {
  if (org.compPlan) throw new HttpError(409, "comp_plan", "This workspace is on an internal comp plan. Turn the comp off first.");
  if (!org.stripeSubscriptionId || !LIVE.has(org.subscriptionStatus ?? "")) throw new HttpError(409, "no_subscription", "This workspace has no active subscription.");
  return org.stripeSubscriptionId;
}

// ---------------------------------------------------------------------------------------------------------------
// Actions

/**
 * Moves a workspace between the legacy plans in place with proration (`changePlanFor`), or to Free (`starter`) by
 * dropping the legacy plan item and keeping its add-ons (`updateAddonsFor`). Both write the workspace's own audit row
 * naming the operator. Product rules still apply: comp workspaces, retired plans and over-limit downgrades are refused.
 */
export async function opsChangePlan(deps: Deps, target: BillingTarget, plan: PlanId): Promise<OpsResult<{ pending: boolean }>> {
  const next = planIn(plan);
  assertBilling(deps);
  const before = await snapshot(deps, target.orgId);
  let pending: boolean;
  if (next === "starter") {
    if (before.plan === "starter") throw badRequest("The workspace is already on Free.");
    pending = (await stripeStep(() => updateAddonsFor(deps, target, before.addons, { dropLegacyPlan: true }))).pending;
  } else {
    pending = (await stripeStep(() => changePlanFor(deps, target, next))).pending;
  }
  forgetOrgCache(target.orgId);
  return { before, after: await snapshot(deps, target.orgId), pending };
}

/**
 * Turns an internal comp on (`plan` "business": a comp workspace is treated as Business everywhere, see
 * `effectivePlanId`) or off (`plan` null). `until` (an end date) and `note` are kept with the comp.
 * Comp on does not cancel a live Stripe subscription: `warnings` says so, and the operator cancels it separately.
 */
export async function opsSetComp(
  deps: Deps, target: BillingTarget, plan: PlanId | null, until?: Date | null, note?: string | null,
): Promise<OpsResult<{ warnings: string[] }>> {
  const on = plan !== null;
  if (on && planIn(plan) !== "business") {
    throw new HttpError(400, "comp_plan_unsupported", "A comp workspace is treated as Business. Other comp plans aren't supported.");
  }
  let end: Date | null = null;
  if (on && until != null) {
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) throw badRequest("The comp end date isn't a valid date.");
    const now = deps.now().getTime();
    if (until.getTime() <= now) throw badRequest("The comp end date must be in the future.");
    if (until.getTime() > now + COMP_MAX_DAYS * DAY) throw badRequest(`The comp can end at most ${COMP_MAX_DAYS} days from now.`);
    end = until;
  }
  const cleanNoteValue = on ? cleanNote(note, false) : null;
  const before = await snapshot(deps, target.orgId);
  await deps.db.update(organizations)
    .set({ compPlan: on, ...compExpiryFields(end, cleanNoteValue) })
    .where(eq(organizations.id, target.orgId));
  forgetOrgCache(target.orgId);
  const after = await snapshot(deps, target.orgId);
  const warnings: string[] = [];
  if (on && after.subscriptionStatus && LIVE.has(after.subscriptionStatus)) warnings.push("subscription_still_billing");
  return { before, after, warnings };
}

/**
 * Credits the workspace's Stripe customer balance (Stripe takes it off the next invoices). `amountCents` is the credit
 * as a positive whole number of cents. `balanceCents` follows Stripe: negative is credit the customer holds.
 */
export async function opsAddCredit(
  deps: Deps, target: BillingTarget, amountCents: number, note: string, opts: { idempotencyKey?: string } = {},
): Promise<{ before: { balanceCents: number }; after: { balanceCents: number }; transactionId: string; amountCents: number; currency: string }> {
  const amount = wholeIn(amountCents, CREDIT_MIN_CENTS, CREDIT_MAX_CENTS, "The credit in cents");
  const description = cleanNote(note, true)!;
  assertBilling(deps);
  const org = await getOrg(deps.db, target.orgId);
  if (!org.stripeCustomerId) throw new HttpError(409, "no_customer", "This workspace has no Stripe customer to credit.");
  const customer = org.stripeCustomerId;
  const tx = await stripeStep(async () => (await client(deps)).customers.createBalanceTransaction(customer, {
    amount: -amount, currency: PRICE_CURRENCY, description,
    metadata: { orgId: org.id, source: "operator_console", ...(target.actor.userId ? { operator: target.actor.userId } : {}) },
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined));
  const ending = tx.ending_balance;
  return { before: { balanceCents: ending + amount }, after: { balanceCents: ending }, transactionId: tx.id, amountCents: amount, currency: tx.currency };
}

/** Pushes the subscription's trial end out by `days` from the later of now and the current trial end (no proration). */
export async function opsExtendTrial(deps: Deps, target: BillingTarget, days: number): Promise<OpsResult<{ trialEnd: string }>> {
  const n = wholeIn(days, 1, TRIAL_DAYS_MAX, "Days");
  assertBilling(deps);
  const org = await getOrg(deps.db, target.orgId);
  const subId = assertLiveSubscription(org);
  if (org.subscriptionStatus === "past_due") throw new HttpError(409, "past_due", "The subscription is past due. Extend the grace period instead.");
  const before = snapshotOf(org, await getAddons(deps.db, org.id));
  const stripe = await stripeStep(() => client(deps));
  const sub = await stripeStep(() => stripe.subscriptions.retrieve(subId));
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const trialEnd = Math.max(sub.trial_end ?? 0, nowSec) + n * 86_400;
  const updated = await stripeStep(() => stripe.subscriptions.update(subId, { trial_end: trialEnd, proration_behavior: "none" }));
  await syncSubscription(deps, updated as unknown as StripeSubscription);
  forgetOrgCache(org.id);
  return { before, after: await snapshot(deps, org.id), trialEnd: new Date(trialEnd * 1000).toISOString() };
}

/** Moves a past-due workspace's grace end out by `days` from the later of now and the current grace end. Local only. */
export async function opsExtendGrace(deps: Deps, target: BillingTarget, days: number): Promise<OpsResult> {
  const n = wholeIn(days, 1, GRACE_DAYS_MAX, "Days");
  const org = await getOrg(deps.db, target.orgId);
  if (!org.pastDueSince) throw new HttpError(409, "not_past_due", "This workspace isn't past due, so it has no grace period.");
  const before = snapshotOf(org, await getAddons(deps.db, org.id));
  const from = Math.max(org.graceEndsAt?.getTime() ?? 0, deps.now().getTime());
  await deps.db.update(organizations).set({ graceEndsAt: new Date(from + n * DAY) }).where(eq(organizations.id, org.id));
  forgetOrgCache(org.id);
  return { before, after: await snapshot(deps, org.id) };
}

/**
 * Reads the workspace's subscription from Stripe and mirrors it (`syncSubscription`). Without a stored subscription id
 * the customer's latest subscription is used; a subscription Stripe no longer has is mirrored as deleted.
 * A comp workspace is left as it is (syncSubscription keeps comps), and `outcome` says so.
 */
export async function opsResync(deps: Deps, target: BillingTarget): Promise<OpsResult<{ outcome: "synced" | "deleted" | "comp_kept" | "no_subscription" }>> {
  assertBilling(deps);
  const org = await getOrg(deps.db, target.orgId);
  const before = snapshotOf(org, await getAddons(deps.db, org.id));
  const stripe = await stripeStep(() => client(deps));
  let sub: StripeSubscription | null = null;
  let deleted = false;
  if (org.stripeSubscriptionId) {
    const id = org.stripeSubscriptionId;
    try {
      sub = (await stripe.subscriptions.retrieve(id)) as unknown as StripeSubscription;
    } catch (e) {
      if (!isMissingInStripe(e)) throw typedStripeError(e);
      deleted = true;
      sub = { id, customer: org.stripeCustomerId ?? "", status: "canceled", cancel_at_period_end: false, metadata: { orgId: org.id }, items: { data: [] } };
    }
  } else if (org.stripeCustomerId) {
    const customer = org.stripeCustomerId;
    const list = await stripeStep(() => stripe.subscriptions.list({ customer, status: "all", limit: 1 }));
    sub = (list.data[0] as unknown as StripeSubscription | undefined) ?? null;
  }
  if (!sub) return { before, after: before, outcome: "no_subscription" };
  sub.metadata = { ...(sub.metadata ?? {}), orgId: org.id };
  const status = sub.status;
  await syncSubscription(deps, sub, deleted || status === "canceled");
  forgetOrgCache(org.id);
  const outcome = org.compPlan ? "comp_kept" : deleted || status === "canceled" ? "deleted" : "synced";
  return { before, after: await snapshot(deps, org.id), outcome };
}

/** Sets or clears cancel at period end on the live subscription, then mirrors it. Idempotent. */
export async function opsCancelAtPeriodEnd(deps: Deps, target: BillingTarget, on: boolean): Promise<OpsResult> {
  if (typeof on !== "boolean") throw badRequest("Say whether to cancel at period end.");
  assertBilling(deps);
  const org = await getOrg(deps.db, target.orgId);
  const subId = assertLiveSubscription(org);
  const before = snapshotOf(org, await getAddons(deps.db, org.id));
  const updated = await stripeStep(async () => (await client(deps)).subscriptions.update(subId, { cancel_at_period_end: on }));
  await syncSubscription(deps, updated as unknown as StripeSubscription);
  forgetOrgCache(org.id);
  return { before, after: await snapshot(deps, org.id) };
}

// ---------------------------------------------------------------------------------------------------------------
// Maintenance (written, not wired: see the integrator notes)

export const EXPIRE_COMPS_BATCH = 100;

/**
 * Ends comps whose end date has passed: comp off, end date and note cleared, one workspace audit row each
 * (`billing.comp_expired`). Up to EXPIRE_COMPS_BATCH workspaces a run. `available` is always true (kept for callers
 * written before 0174).
 */
export async function expireComps(deps: Deps, now: Date = deps.now()): Promise<{ available: boolean; expired: string[] }> {
  const due = await deps.db.select({ ...getTableColumns(organizations) }).from(organizations)
    .where(and(eq(organizations.compPlan, true), isNotNull(organizations.compUntil), lte(organizations.compUntil, now)))
    .limit(EXPIRE_COMPS_BATCH);
  const expired: string[] = [];
  for (const org of due) {
    const res = await deps.db.update(organizations).set({ compPlan: false, ...compExpiryFields(null, null) })
      .where(and(eq(organizations.id, org.id), eq(organizations.compPlan, true))).returning({ id: organizations.id });
    if (!res.length) continue;
    const { compUntil, compNote } = readCompExpiry(org);
    await audit(deps.db, { orgId: org.id, action: "billing.comp_expired", metadata: { until: iso(compUntil), note: compNote } });
    forgetOrgCache(org.id);
    expired.push(org.id);
  }
  return { available: true, expired };
}
