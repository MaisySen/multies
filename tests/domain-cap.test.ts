import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { domains, organizations } from "@/server/db/schema";
import { retryQueuedProviderDomains, queuedDomainCount } from "@/server/services/domains";
import { isDomainSlotRefusal, QUEUED_PREFIX } from "@/server/services/mail/provider-domains";

/** Round 17: the sending provider's per-account domain cap never breaks sign up or adding a domain. */
describe("the provider's domain cap", () => {
  const CAP_MESSAGE = "You have reached your domain limit. Upgrade your plan to add more domains.";
  function providerFetch(state: { full: boolean }) {
    return (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/domains" && init?.method === "POST") {
        if (state.full) return new Response(JSON.stringify({ name: "validation_error", message: CAP_MESSAGE }), { status: 403 });
        return new Response(JSON.stringify({ id: "rsd_1", status: "pending", records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc" }] }), { status: 200 });
      }
      if (u.pathname === "/domains") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.pathname.startsWith("/domains/")) return new Response(JSON.stringify({ id: "rsd_1", status: "pending", records: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("recognises the cap refusal and nothing else", () => {
    expect(isDomainSlotRefusal(403, CAP_MESSAGE)).toBe(true);
    expect(isDomainSlotRefusal(422, "The domain name is invalid")).toBe(false);
    expect(isDomainSlotRefusal(500, CAP_MESSAGE)).toBe(false);
  });

  it("queues the domain with a clear status, and registers it when a slot frees", async () => {
    const state = { full: true };
    const ctx = await makeTestApp({ RESEND_API_KEY: "re_test_key" }, { fetch: providerFetch(state) });
    const c = new Client(ctx.app);
    await c.signup();
    const made = await c.post("/api/domains", { name: "acme.io" });
    expect(made.status).toBe(201);
    expect(made.body.domain.sending.status).toBe("queued");
    expect(made.body.domain.sending.detail).toMatch(/Waiting for a sending slot/);
    // No other domain's name is offered for sending.
    expect(made.body.domain.sending.detail).not.toMatch(/multies\.si|via/i);
    const row = (await ctx.db.select().from(domains).where(eq(domains.name, "acme.io")).get())!;
    expect(row.providerStatus?.startsWith(QUEUED_PREFIX)).toBe(true);
    expect(await queuedDomainCount(ctx.db)).toBe(1);

    // Still full: nothing is written.
    expect(await retryQueuedProviderDomains(ctx.deps)).toEqual({ waiting: 1, registered: 0 });
    // A slot frees up: the queued domain is registered on the next pass.
    state.full = false;
    expect(await retryQueuedProviderDomains(ctx.deps)).toEqual({ waiting: 1, registered: 1 });
    const after = (await ctx.db.select().from(domains).where(eq(domains.name, "acme.io")).get())!;
    expect(after.providerDomainId).toBe("rsd_1");
    expect(after.providerStatus).toBe("pending");
    expect(await retryQueuedProviderDomains(ctx.deps)).toEqual({ waiting: 0, registered: 0 });
  });

  it("deleting a registered domain hands its slot to the oldest queued one", async () => {
    const state = { full: false };
    const ctx = await makeTestApp({ RESEND_API_KEY: "re_test_key" }, { fetch: providerFetch(state) });
    const c = new Client(ctx.app);
    await c.signup();
    // The Free plan has one domain; a bigger plan makes room for a second.
    const me = (await c.get("/api/account/me")).body;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, me.organization.id));
    const first = (await c.post("/api/domains", { name: "first.io" })).body.domain;
    expect(first.sending.status).toBe("pending");
    state.full = true;
    const second = await c.post("/api/domains", { name: "second.io" });
    expect(second.status).toBe(201);
    expect(second.body.domain.sending.status).toBe("queued");
    state.full = false;
    expect((await c.del(`/api/domains/${first.id}`)).status).toBe(200);
    const after = (await ctx.db.select().from(domains).where(eq(domains.name, "second.io")).get())!;
    expect(after.providerStatus).toBe("pending");
  });
});
