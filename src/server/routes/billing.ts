import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { billingOverview, changePlan, confirmCheckout, previewAddons, previewPlanChange, handleStripeWebhook, listInvoices, openPortal, startAddonCheckout, startCheckout, updateAddons } from "../services/billing";
import { getOrg } from "../services/plans";
import { Stripe } from "../services/billing/stripe";
import { HttpError } from "../lib/errors";

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const Q_BILLING_1 = z.object({ plan: z.enum(["pro", "business"]) });

const wrapStripe = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof Stripe.errors.StripeError) throw new HttpError(502, "billing_provider_error", `The payment provider said: ${e.message}`);
    throw e;
  }
};

const AddonsBody = z.object({
  addons: z.record(z.string(), z.number().int().min(0).max(100)),
  dropLegacyPlan: z.boolean().optional(),
});

export function billingRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await billingOverview(c.var.deps, c.var.auth.orgId)))
    .post("/checkout", async (c) => {
      const { plan } = await parseBody(c, z.object({ plan: z.enum(["pro", "business"]) }));
      const session = await wrapStripe(() => startCheckout(c.var.deps, c.var.auth, plan));
      const { auth, deps } = c.var;
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "billing.checkout_started", metadata: { plan }, ip: c.var.ip });
      return c.json({ url: session.url });
    })
    /**
     * Sets the workspace's add-ons to exactly these quantities. With no subscription yet
     * this returns a Stripe Checkout URL; with one, the subscription changes in place.
     */
    .post("/addons", async (c) => {
      const { addons, dropLegacyPlan } = await parseBody(c, AddonsBody);
      const { auth, deps } = c.var;
      const org = await getOrg(deps.db, auth.orgId);
      const live = !!org.stripeSubscriptionId && ["active", "trialing", "past_due"].includes(org.subscriptionStatus ?? "");
      const res = await wrapStripe(() => (live ? updateAddons(deps, auth, addons, { dropLegacyPlan }) : startAddonCheckout(deps, auth, addons)));
      if (res.url) await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "billing.checkout_started", metadata: { addons }, ip: c.var.ip });
      return c.json(res);
    })
    .post("/addons/preview", async (c) => {
      const { addons, dropLegacyPlan } = await parseBody(c, AddonsBody);
      return c.json(await wrapStripe(() => previewAddons(c.var.deps, c.var.auth, addons, { dropLegacyPlan })));
    })
    .post("/checkout/confirm", async (c) => {
      const { sessionId } = await parseBody(c, z.object({ sessionId: z.string().min(1).max(255) }));
      return c.json(await wrapStripe(() => confirmCheckout(c.var.deps, c.var.auth, sessionId)));
    })
    .get("/change-preview", async (c) => {
      const { plan } = parseQuery(c, Q_BILLING_1);
      return c.json(await wrapStripe(() => previewPlanChange(c.var.deps, c.var.auth, plan)));
    })
    .post("/change", async (c) => {
      const { plan } = await parseBody(c, z.object({ plan: z.enum(["pro", "business"]) }));
      return c.json(await wrapStripe(() => changePlan(c.var.deps, c.var.auth, plan)));
    })
    .post("/portal", async (c) => c.json({ url: (await wrapStripe(() => openPortal(c.var.deps, c.var.auth))).url }))
    .get("/invoices", async (c) => c.json({ invoices: await wrapStripe(() => listInvoices(c.var.deps, c.var.auth.orgId)) }));
}

/** Provider webhooks. Signed, so no cookie auth or CSRF check applies. */
export function providerWebhookRoutes() {
  return new Hono<AppEnv>()
    .post("/stripe", async (c) => {
      const raw = await c.req.text();
      const res = await wrapStripe(() => handleStripeWebhook(c.var.deps, raw, c.req.header("stripe-signature")));
      return c.json({ received: true, ...res });
    });
}
