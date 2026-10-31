import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations } from "@/server/db/schema";
import { isMissingInStripe } from "@/server/services/billing";

/**
 * The switch to live Stripe keys: Multies' own Customer Portal settings (STRIPE_PORTAL_CONFIG, so the shared
 * account default is left alone) and recovery from customer ids made in test mode.
 */
const ENV = { STRIPE_SECRET_KEY: "rk_live_fake", STRIPE_WEBHOOK_SECRET: "whsec_live", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz" };

function fakeStripe(known = new Set<string>()) {
  const calls: { method: string; path: string; body: URLSearchParams }[] = [];
  let n = 0;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const missing = (id: string) => json({ error: { type: "invalid_request_error", code: "resource_missing", message: `No such customer: '${id}'`, param: "customer" } }, 400);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/v1/customers" && method === "POST") { const id = `cus_live${++n}`; known.add(id); return json({ id, object: "customer" }); }
    if (url.pathname === "/v1/billing_portal/sessions") {
      const c = body.get("customer")!;
      return known.has(c) ? json({ object: "billing_portal.session", url: "https://billing.stripe.com/p/session/live" }) : missing(c);
    }
    if (url.pathname === "/v1/invoices") {
      const c = url.searchParams.get("customer")!;
      return known.has(c) ? json({ object: "list", data: [], has_more: false, url: "/v1/invoices" }) : missing(c);
    }
    return json({ error: { message: "unexpected" } }, 400);
  };
  return { calls, fetch: fetchImpl as typeof fetch };
}

async function owner(env: Record<string, string>, stripe: ReturnType<typeof fakeStripe>) {
  const ctx = await makeTestApp(env, { fetch: stripe.fetch });
  const a = new Client(ctx.app);
  await a.signup("owner@acme.io");
  const orgId = (await a.get("/api/billing")).body.orgId ?? (await ctx.db.select().from(organizations).get())!.id;
  return { ctx, a, orgId: orgId as string };
}

describe("Stripe live switch", () => {
  it("opens the portal with STRIPE_PORTAL_CONFIG when it is set", async () => {
    const stripe = fakeStripe();
    const { a } = await owner({ ...ENV, STRIPE_PORTAL_CONFIG: "bpc_multies" }, stripe);
    const res = await a.post("/api/billing/portal", {});
    expect(res.body.url).toBe("https://billing.stripe.com/p/session/live");
    const portal = stripe.calls.find((c) => c.path === "/v1/billing_portal/sessions")!;
    expect(portal.body.get("configuration")).toBe("bpc_multies");
  });

  it("leaves the configuration out when STRIPE_PORTAL_CONFIG is unset (the account default, as before)", async () => {
    const stripe = fakeStripe();
    const { a } = await owner(ENV, stripe);
    expect((await a.post("/api/billing/portal", {})).body.url).toBeTruthy();
    expect(stripe.calls.find((c) => c.path === "/v1/billing_portal/sessions")!.body.has("configuration")).toBe(false);
  });

  it("replaces a test mode customer Stripe no longer knows, once, and keeps the new one", async () => {
    const stripe = fakeStripe();
    const { ctx, a, orgId } = await owner({ ...ENV, STRIPE_PORTAL_CONFIG: "bpc_multies" }, stripe);
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_testmode" }).where(eq(organizations.id, orgId));
    const res = await a.post("/api/billing/portal", {});
    expect(res.status).toBe(200);
    const sessions = stripe.calls.filter((c) => c.path === "/v1/billing_portal/sessions").map((c) => c.body.get("customer"));
    expect(sessions).toEqual(["cus_testmode", "cus_live1"]);
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get())!.stripeCustomerId).toBe("cus_live1");
    await a.post("/api/billing/portal", {});
    expect(stripe.calls.filter((c) => c.path === "/v1/customers").length).toBe(1);
  });

  it("shows no invoices for a customer from the other Stripe mode instead of failing", async () => {
    const stripe = fakeStripe();
    const { ctx, a, orgId } = await owner(ENV, stripe);
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_testmode" }).where(eq(organizations.id, orgId));
    const res = await a.get("/api/billing/invoices");
    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([]);
  });

  it("only treats Stripe's resource_missing as missing", () => {
    expect(isMissingInStripe({ code: "resource_missing" })).toBe(true);
    expect(isMissingInStripe({ raw: { code: "resource_missing" } })).toBe(true);
    expect(isMissingInStripe({ code: "card_declined" })).toBe(false);
    expect(isMissingInStripe(null)).toBe(false);
  });
});
