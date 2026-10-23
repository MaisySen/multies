import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { billingOverview, changePlan, confirmCheckout, previewPlanChange, handleStripeWebhook, listInvoices, openPortal, startCheckout } from "../services/billing";
import { Stripe } from "../services/billing/stripe";
import { HttpError } from "../lib/errors";

const wrapStripe = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof Stripe.errors.StripeError) throw new HttpError(502, "billing_provider_error", `The payment provider said: ${e.message}`);
    throw e;
  }
};

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
    .post("/checkout/confirm", async (c) => {
      const { sessionId } = await parseBody(c, z.object({ sessionId: z.string().min(1).max(255) }));
      return c.json(await wrapStripe(() => confirmCheckout(c.var.deps, c.var.auth, sessionId)));
    })
    .get("/change-preview", async (c) => {
      const { plan } = parseQuery(c, z.object({ plan: z.enum(["pro", "business"]) }));
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
