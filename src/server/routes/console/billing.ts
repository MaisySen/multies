/**
 * OPS1: /api/console/billing, Billing across every workspace and billing actions on one.
 *
 * Reads (billing.read):
 *   GET /status                  { enabled, testMode, currency }: whether Stripe is connected on this deployment
 *   GET /subscriptions           ?q&status&plan&comp=true|false&sort&limit&cursor
 *   GET /past-due                ?sort&limit&cursor (most overdue first)
 *   GET /events                  ?type&orgId&sort&limit&cursor (newest first)
 *   GET /referrals               ?status&orgId&sort&limit&cursor
 *   GET /workspaces/:id          one workspace's billing (ids only, never a Stripe object, no invoice links)
 * Changes (billing.manage; comp and credit also need a recent sign in), each with a reason and audited as billing.*:
 *   POST /workspaces/:id/plan                 { plan, reason }
 *   POST /workspaces/:id/comp                 { on, until?, note?, reason }
 *   POST /workspaces/:id/credit               { amountCents, note, reason, requestKey? }
 *   POST /workspaces/:id/trial                { days, reason }
 *   POST /workspaces/:id/grace                { days, reason }
 *   POST /workspaces/:id/resync               { reason }
 *   POST /workspaces/:id/cancel-at-period-end { on, reason }
 *
 * Lists follow the console convention ({ items, nextCursor }); the billing service pages on (sort field, id) and its
 * cursor is carried as the console's opaque cursor string. There is deliberately no customer portal route here.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { HttpError } from "../../lib/errors";
import { sha256Hex } from "../../lib/crypto";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import { getOrg } from "../../services/plans";
import type { BillingTarget } from "../../services/billing";
import {
  COMP_MAX_DAYS, CREDIT_MAX_CENTS, CREDIT_MIN_CENTS, GRACE_DAYS_MAX, NOTE_MAX, OPS_PLANS, PAGE_LIMIT_MAX, TRIAL_DAYS_MAX,
  getWorkspaceBilling, listBillingEvents, listPastDue, listReferrals, listSubscriptions,
  opsAddCredit, opsCancelAtPeriodEnd, opsChangePlan, opsExtendGrace, opsExtendTrial, opsResync, opsSetComp,
  type Cursor, type PageInput, type Paged,
} from "../../services/console/billing-ops";
import { PRICE_CURRENCY } from "@/shared/plans";

const DEFAULT_LIMIT = 50;
/** The plans an operator can move a workspace to (OPS_PLANS in the service). */
const PLAN_IDS = ["starter", "pro", "business"] as const satisfies readonly (typeof OPS_PLANS)[number][];

/** The service's page from ?limit, ?cursor and ?sort=field:dir. An unknown sort field is a 400 (from the service). */
function pageOf(c: Context<AppEnv>, defaultSort: `${string}:${"asc" | "desc"}`): PageInput {
  const q = c.req.query();
  const raw = Number.parseInt(q.limit ?? "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, PAGE_LIMIT_MAX) : DEFAULT_LIMIT;
  const [defField, defDir] = defaultSort.split(":") as [string, "asc" | "desc"];
  const [f, d] = (q.sort ?? "").split(":");
  const field = f || defField;
  // A direction other than asc or desc goes to the service as given, which refuses it (400 invalid_sort).
  const dir = (f ? d || defDir : defDir) as "asc" | "desc";
  let cursor: Cursor | null = null;
  if (q.cursor) {
    const k = decodeCursor(q.cursor);
    cursor = { v: k.sort instanceof Date ? k.sort.getTime() : k.sort, id: k.id };
  }
  return { limit, cursor, sort: { field, dir } };
}

const listOut = <T>(p: Paged<T>) => ({ items: p.items, nextCursor: p.next ? encodeCursor(p.next.v, p.next.id) : null });

const SubscriptionQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.string().trim().max(40).optional(),
  plan: z.enum(PLAN_IDS).optional().or(z.literal("")),
  comp: z.enum(["true", "false", ""]).optional(),
}).passthrough();
const EventQuery = z.object({ type: z.string().trim().max(80).optional(), orgId: z.string().trim().max(200).optional() }).passthrough();
const ReferralQuery = z.object({ status: z.string().trim().max(40).optional(), orgId: z.string().trim().max(200).optional() }).passthrough();

/** Plain wording for the service's typed errors (shown in a toast). Anything else passes through unchanged. */
const MESSAGES: Record<string, { status: 400 | 409; message: string }> = {
  billing_unavailable: { status: 409, message: "Billing isn't connected on this deployment, so this Stripe action can't run. Comps and grace periods still work." },
  comp_plan_unsupported: { status: 400, message: "Only a free Business plan can be given. Other free plans aren't supported." },
  comp_plan: { status: 409, message: "This workspace has a free Business plan from an operator. Turn that off first." },
  no_subscription: { status: 409, message: "This workspace has no active paid subscription, so there is nothing to change in Stripe." },
  not_past_due: { status: 409, message: "This workspace isn't behind on payment, so it has no grace period to extend." },
  past_due: { status: 409, message: "The subscription is behind on payment. Extend the grace period instead of the trial." },
  no_customer: { status: 409, message: "This workspace has no Stripe customer yet, so there is nowhere to add credit." },
  stripe_object_missing: { status: 409, message: "Stripe no longer has this customer or subscription. Sync with Stripe first." },
  invalid_plan: { status: 400, message: "Choose Free, Pro or Business." },
};

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError && MESSAGES[e.code]) {
      const m = MESSAGES[e.code]!;
      throw new HttpError(m.status, e.code, m.message);
    }
    throw e;
  }
}

/** The workspace (404 when unknown) and the operator as the billing actor. */
async function targetOf(c: Context<AppEnv>): Promise<BillingTarget> {
  const id = c.req.param("id") ?? "";
  if (!id || id.length > 200) throw new HttpError(404, "not_found", "Workspace not found.");
  const org = await getOrg(c.var.deps.db, id);
  return { orgId: org.id, actor: { userId: c.var.auth.userId, email: c.var.auth.email } };
}

const days = (max: number) => z.number({ error: "Give the number of days." }).int("Use a whole number of days.").min(1, "Give at least 1 day.").max(max, `Give at most ${max} days.`);
/** A missing reason reads as "Give a reason", not as a type error. */
const reason = z.preprocess((v) => v ?? "", reasonSchema);
const note = z.string().trim().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters.`);

const PlanBody = z.object({ plan: z.enum(PLAN_IDS, { error: "Choose Free, Pro or Business." }), reason });
const CompBody = z.object({
  on: z.boolean({ error: "Say whether to turn the free plan on or off." }),
  until: z.string().trim().max(40).nullish(),
  note: note.nullish(),
  reason,
});
const CreditBody = z.object({
  amountCents: z.number({ error: "Give the credit amount." }).int("Give the credit in whole cents.")
    .min(CREDIT_MIN_CENTS, "The credit must be more than zero.").max(CREDIT_MAX_CENTS, `The credit can be at most ${CREDIT_MAX_CENTS / 100} dollars.`),
  note: note.min(1, "Add a note the customer will see on their balance."),
  reason,
  /** Made by the console once per dialog: a retry of the same request never credits twice. */
  requestKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
const DaysBody = (max: number) => z.object({ days: days(max), reason });
const ReasonBody = z.object({ reason });
const CancelBody = z.object({ on: z.boolean({ error: "Say whether to cancel at period end or keep the subscription." }), reason });

function compUntil(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.000Z` : v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "bad_request", "The end date isn't a valid date. Use a date like 2027-01-31.");
  return d;
}

const ws = { targetType: "workspace", workspaceAudit: true } as const;

export function billingRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); })
    .get("/status", requireOperator("billing.read"), (c) => {
      const b = c.var.deps.config.billing;
      return c.json({ enabled: b.enabled && !!b.stripeSecretKey, testMode: b.testMode, currency: PRICE_CURRENCY });
    })
    .get("/subscriptions", requireOperator("billing.read"), async (c) => {
      const f = parseQuery(c, SubscriptionQuery);
      const page = pageOf(c, "createdAt:desc");
      return c.json(listOut(await listSubscriptions(c.var.deps, {
        q: f.q || null, page,
        filters: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.plan ? { plan: f.plan } : {}),
          ...(f.comp === "true" ? { comp: true } : f.comp === "false" ? { comp: false } : {}),
        },
      })));
    })
    .get("/past-due", requireOperator("billing.read"), async (c) => c.json(listOut(await listPastDue(c.var.deps, pageOf(c, "pastDueSince:asc")))))
    .get("/events", requireOperator("billing.read"), async (c) => {
      const f = parseQuery(c, EventQuery);
      return c.json(listOut(await listBillingEvents(c.var.deps, { type: f.type || null, orgId: f.orgId || null, page: pageOf(c, "createdAt:desc") })));
    })
    .get("/referrals", requireOperator("billing.read"), async (c) => {
      const f = parseQuery(c, ReferralQuery);
      return c.json(listOut(await listReferrals(c.var.deps, {
        filters: { ...(f.status ? { status: f.status } : {}), ...(f.orgId ? { orgId: f.orgId } : {}) }, page: pageOf(c, "createdAt:desc"),
      })));
    })
    .get("/workspaces/:id", requireOperator("billing.read"), async (c) => {
      const { orgId } = await targetOf(c);
      const b = await getWorkspaceBilling(c.var.deps, orgId);
      const currency = b.invoices[0]?.currency ?? PRICE_CURRENCY;
      return c.json({
        ...b,
        currency,
        // Ids, amounts and dates only: no hosted invoice or PDF links (they open the invoice for anyone holding them).
        invoices: b.invoices.map((i) => ({
          id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency,
          createdAt: i.createdAt.toISOString(), periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(),
        })),
        bounds: {
          creditMinCents: CREDIT_MIN_CENTS, creditMaxCents: CREDIT_MAX_CENTS, trialDaysMax: TRIAL_DAYS_MAX,
          graceDaysMax: GRACE_DAYS_MAX, compMaxDays: COMP_MAX_DAYS, noteMax: NOTE_MAX,
        },
      });
    })
    .post("/workspaces/:id/plan", requireOperator("billing.manage"), async (c) => {
      const body = await parseBody(c, PlanBody);
      const target = await targetOf(c);
      type R = Awaited<ReturnType<typeof opsChangePlan>>;
      // changePlanFor writes the workspace's own audit row naming the operator, so only the platform row is added here.
      const r = await operatorAction(c, {
        action: "billing.plan_changed", targetType: "workspace", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { plan: body.plan },
      }, () => mapped(() => opsChangePlan(c.var.deps, target, body.plan)));
      return c.json({ ok: true, pending: r.pending, plan: r.after.plan, effectivePlan: r.after.effectivePlan });
    })
    .post("/workspaces/:id/comp", requireOperator("billing.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, CompBody);
      const target = await targetOf(c);
      const until = body.on ? compUntil(body.until) : null;
      type R = Awaited<ReturnType<typeof opsSetComp>>;
      const r = await operatorAction(c, {
        ...ws, action: body.on ? "billing.comp_set" : "billing.comp_removed", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { until: until?.toISOString() ?? null },
      }, () => mapped(() => opsSetComp(c.var.deps, target, body.on ? "business" : null, until, body.on ? body.note ?? null : null)));
      return c.json({ ok: true, comp: r.after.comp, compUntil: r.after.compUntil, warnings: r.warnings });
    })
    .post("/workspaces/:id/credit", requireOperator("billing.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, CreditBody);
      const target = await targetOf(c);
      // The same request (same operator, workspace, amount, note, reason and console request key) maps to the same
      // Stripe idempotency key, so a retried or doubled submit returns the first balance transaction.
      const scope = body.requestKey ?? c.var.deps.now().toISOString().slice(0, 10);
      const idempotencyKey = `ops-credit-${(await sha256Hex(JSON.stringify([target.orgId, target.actor.userId, body.amountCents, body.note, body.reason, scope]))).slice(0, 48)}`;
      type R = Awaited<ReturnType<typeof opsAddCredit>>;
      const r = await operatorAction(c, {
        ...ws, action: "billing.credit_added", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after,
        metadata: { amountCents: body.amountCents, note: body.note },
      }, () => mapped(() => opsAddCredit(c.var.deps, target, body.amountCents, body.note, { idempotencyKey })));
      return c.json({ ok: true, transactionId: r.transactionId, amountCents: r.amountCents, currency: r.currency, balanceCents: r.after.balanceCents });
    })
    .post("/workspaces/:id/trial", requireOperator("billing.manage"), async (c) => {
      const body = await parseBody(c, DaysBody(TRIAL_DAYS_MAX));
      const target = await targetOf(c);
      type R = Awaited<ReturnType<typeof opsExtendTrial>>;
      const r = await operatorAction(c, {
        ...ws, action: "billing.trial_extended", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => ({ ...x.after, trialEnd: x.trialEnd }), metadata: { days: body.days },
      }, () => mapped(() => opsExtendTrial(c.var.deps, target, body.days)));
      return c.json({ ok: true, trialEnd: r.trialEnd });
    })
    .post("/workspaces/:id/grace", requireOperator("billing.manage"), async (c) => {
      const body = await parseBody(c, DaysBody(GRACE_DAYS_MAX));
      const target = await targetOf(c);
      type R = Awaited<ReturnType<typeof opsExtendGrace>>;
      const r = await operatorAction(c, {
        ...ws, action: "billing.grace_extended", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { days: body.days },
      }, () => mapped(() => opsExtendGrace(c.var.deps, target, body.days)));
      return c.json({ ok: true, graceEndsAt: r.after.graceEndsAt });
    })
    .post("/workspaces/:id/resync", requireOperator("billing.manage"), async (c) => {
      const body = await parseBody(c, ReasonBody);
      const target = await targetOf(c);
      type R = Awaited<ReturnType<typeof opsResync>>;
      const r = await operatorAction(c, {
        ...ws, action: "billing.resynced", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: {},
      }, () => mapped(() => opsResync(c.var.deps, target)));
      return c.json({ ok: true, outcome: r.outcome });
    })
    .post("/workspaces/:id/cancel-at-period-end", requireOperator("billing.manage"), async (c) => {
      const body = await parseBody(c, CancelBody);
      const target = await targetOf(c);
      type R = Awaited<ReturnType<typeof opsCancelAtPeriodEnd>>;
      const r = await operatorAction(c, {
        ...ws, action: body.on ? "billing.cancel_scheduled" : "billing.cancel_unscheduled", targetId: target.orgId, orgId: target.orgId, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => x.after,
      }, () => mapped(() => opsCancelAtPeriodEnd(c.var.deps, target, body.on)));
      return c.json({ ok: true, cancelAtPeriodEnd: r.after.cancelAtPeriodEnd });
    });
}
