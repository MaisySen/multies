import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliver } from "../email-worker/src/index";
import { domains, mailboxes, organizations, users } from "@/server/db/schema";
import { freeLocalPartProblem, suggestFreeLocalPart, ensurePlatformDomain, PLATFORM_ORG } from "@/server/services/free-address";
import { createInboundKey } from "@/server/services/mail/inbound-keys";
import { recheckStaleDomains, retryQueuedProviderDomains } from "@/server/services/domains";
import { isDomainSlotRefusal, QUEUED_PREFIX } from "@/server/services/mail/provider-domains";
import { outboundIdentity } from "@/server/services/mail/sender";

const FREE = { FREE_MAIL_DOMAIN: "free.test", FREE_MAIL_DAILY_SENDS: "3" };

async function verifiedUser(ctx: Awaited<ReturnType<typeof makeTestApp>>, c: Client, name = "Ada Lovelace", org = "Acme") {
  const email = await c.signup(undefined, name, org);
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return email;
}

function raw(to: string, subject = "Hello free address") {
  return [`From: Grace <grace@navy.mil>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Math.random().toString(36).slice(2)}@navy.mil>`,
    "Date: Sun, 25 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Hi there."].join("\r\n");
}

async function viaWorker(ctx: Awaited<ReturnType<typeof makeTestApp>>, key: { id: string; secret: string }, to: string) {
  let rejected: string | null = null;
  const body = raw(to);
  const message = { from: "grace@navy.mil", to, rawSize: body.length, raw: new Response(body).body!, setReject: (r: string) => { rejected = r; }, forward: async () => {} };
  const appFetch = ((url: string, init: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as unknown as typeof fetch;
  // The production Email Worker routes the shared domain to this deployment with the platform key.
  await deliver(message, {
    MYMAIL_WEBHOOK_URL: "http://localhost/nowhere", MYMAIL_KEY_ID: "ink_none", MYMAIL_KEY_SECRET: "x",
    MYMAIL_ROUTES: JSON.stringify({ "free.test": { url: "http://localhost/api/inbound/cloudflare", keyId: key.id, secret: "MYMAIL_KEY_SECRET_PROD" } }),
    MYMAIL_KEY_SECRET_PROD: key.secret,
  }, appFetch);
  return { rejected };
}

describe("free address rules", () => {
  it("suggests first name and team, plain ASCII", () => {
    expect(suggestFreeLocalPart("Ada Lovelace", "Acme")).toBe("ada.acme");
    expect(suggestFreeLocalPart("João Silva", "João's workspace")).toBe("joao");
    expect(suggestFreeLocalPart("", "Fintex", "bidur@example.com")).toBe("bidur.fintex");
    expect(freeLocalPartProblem(suggestFreeLocalPart("A", ""))).toBeNull();
  });
  it("refuses reserved, short and malformed names", () => {
    for (const bad of ["support", "no-reply", "noreply", "postmaster", "security", "relay", "ab", "-ada", "ada..acme", "Ada", "ada_acme", "a".repeat(41)]) {
      expect(freeLocalPartProblem(bad), bad).not.toBeNull();
    }
    for (const ok of ["ada", "ada.acme", "ada-lovelace", "a1b"]) expect(freeLocalPartProblem(ok), ok).toBeNull();
  });
});

describe("free addresses", () => {
  it("is off when the server has no shared domain", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    expect((await c.get("/api/free-address")).body).toEqual({ enabled: false });
    expect((await c.post("/api/free-address", { localPart: "ada.acme" })).status).toBe(404);
  });

  it("a new user with no domain takes an address, sends out and receives", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const info = (await c.get("/api/free-address")).body;
    expect(info).toMatchObject({ enabled: true, domain: "free.test", available: true, suggestion: "ada.acme", addresses: [] });

    const claimed = await c.post("/api/free-address", { localPart: info.suggestion });
    expect(claimed.status).toBe(201);
    const mb = claimed.body.mailbox;
    expect(mb.address).toBe("ada.acme@free.test");
    expect((await c.get("/api/mailboxes")).body.mailboxes.map((m: { address: string }) => m.address)).toEqual(["ada.acme@free.test"]);
    // The shared domain is the platform's, not the workspace's: it doesn't use a domain slot or show in the list.
    expect((await c.get("/api/domains")).body.domains).toHaveLength(0);
    const shared = (await ctx.db.select().from(domains).where(eq(domains.name, "free.test")).get())!;
    expect(shared).toMatchObject({ orgId: PLATFORM_ORG, status: "verified", providerStatus: "verified" });

    // Send to the outside world straight away: from the free address itself.
    const sent = await c.post("/api/mail/send", { mailboxId: mb.id, to: ["grace@navy.mil"], subject: "First mail", text: "Hello from my free address" });
    expect(sent.status).toBe(201);
    const out = ctx.outbound.sent.find((m) => m.subject === "First mail")!;
    expect(out.from.address).toBe("ada.acme@free.test");
    expect(out.replyTo).toBeUndefined();

    // Receive through the Email Worker, signed with the platform workspace's key.
    const key = await createInboundKey(ctx.deps, PLATFORM_ORG);
    expect((await viaWorker(ctx, key, "ada.acme@free.test")).rejected).toBeNull();
    const inbox = (await c.get(`/api/mail/messages?mailboxId=${mb.id}&folder=inbox`)).body;
    expect(JSON.stringify(inbox)).toContain("Hello free address");
    // Unknown addresses on the shared domain bounce.
    expect((await viaWorker(ctx, key, "nobody.here@free.test")).rejected).toMatch(/No mailbox/);
  });

  it("a workspace key can't deliver into the shared domain", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    await c.post("/api/free-address", { localPart: "ada.acme" });
    const own = (await c.post("/api/inbound-keys")).body.key;
    expect((await viaWorker(ctx, own, "ada.acme@free.test")).rejected).toMatch(/not managed by this signing key/);
  });

  it("names are unique across workspaces, and reserved names and unverified people are refused", async () => {
    const ctx = await makeTestApp(FREE);
    const a = new Client(ctx.app);
    await verifiedUser(ctx, a);
    expect((await a.post("/api/free-address", { localPart: "ada.acme" })).status).toBe(201);
    const b = new Client(ctx.app);
    await verifiedUser(ctx, b, "Ada King", "Acme");
    const dup = await b.post("/api/free-address", { localPart: "ada.acme" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/taken/);
    expect((await b.post("/api/free-address", { localPart: "support" })).status).toBe(400);
    const unverified = new Client(ctx.app);
    await unverified.signup(undefined, "Eve", "Evil");
    expect((await unverified.post("/api/free-address", { localPart: "eve.evil" })).status).toBe(403);
  });

  it("a workspace key can take one through the public API", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const key = (await c.post("/api/developer/keys", { name: "ops" })).body;
    const secret = key.secret ?? key.key?.secret;
    const r = await ctx.app.request("/api/v1/free-address", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ localPart: "ops.acme" }) });
    expect(r.status).toBe(201);
    expect((await r.json()).address).toBe("ops.acme@free.test");
  });

  it("sample workspaces can't take one", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const me = (await c.get("/api/account/me")).body;
    await ctx.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, me.organization.id));
    expect((await c.get("/api/free-address")).body.available).toBe(false);
    expect((await c.post("/api/free-address", { localPart: "ada.acme" })).status).toBe(403);
  });

  it("free addresses have their own smaller daily allowance", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const mb = (await c.post("/api/free-address", { localPart: "ada.acme" })).body.mailbox;
    expect((await c.post("/api/mail/send", { mailboxId: mb.id, to: ["a@x.org", "b@x.org", "c@x.org"], subject: "One", text: "Hello there friends" })).status).toBe(201);
    const over = await c.post("/api/mail/send", { mailboxId: mb.id, to: ["d@x.org"], subject: "Two", text: "Hello again friend" });
    expect(over.status).toBe(403);
    expect(over.body.error.message).toMatch(/Free addresses can send to 3 recipients a day/);
  });

  it("agent inboxes for workspaces with no domain use the same shared domain and can send", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const made = await c.post("/api/agents", { name: "Support bot" });
    expect(made.status).toBe(201);
    expect(made.body.agent.address).toMatch(/@free\.test$/);
    const shared = (await ctx.db.select().from(domains).where(eq(domains.name, "free.test")).get())!;
    expect(shared.status).toBe("verified");
  });

  it("the hourly domain check leaves the shared domain alone", async () => {
    const ctx = await makeTestApp(FREE);
    const d = await ensurePlatformDomain(ctx.deps, "free.test");
    await ctx.db.update(domains).set({ lastCheckedAt: new Date(0) }).where(eq(domains.id, d.id));
    const r = await recheckStaleDomains(ctx.deps);
    expect(r.find((x) => x.id === d.id)).toBeUndefined();
    expect((await ctx.db.select().from(domains).where(eq(domains.id, d.id)).get())!.status).toBe("verified");
  });
});

describe("the provider's domain cap never breaks sign up or a new domain", () => {
  const CAP_MESSAGE = "You have reached your domain limit. Upgrade your plan to add more domains.";
  function providerFetch(state: { full: boolean; calls: string[] }) {
    return (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      state.calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/domains" && init?.method === "POST") {
        if (state.full) return new Response(JSON.stringify({ name: "validation_error", message: CAP_MESSAGE }), { status: 403 });
        return new Response(JSON.stringify({ id: "rsd_1", status: "pending", records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc" }] }), { status: 200 });
      }
      if (u.pathname === "/domains") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.pathname.startsWith("/domains/")) return new Response(JSON.stringify({ id: "rsd_1", status: "pending", records: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("recognises the cap refusal", () => {
    expect(isDomainSlotRefusal(403, CAP_MESSAGE)).toBe(true);
    expect(isDomainSlotRefusal(422, "The domain name is invalid")).toBe(false);
  });

  it("queues the domain with a clear status, relays its mail through the shared domain, and registers it when a slot frees", async () => {
    const state = { full: true, calls: [] as string[] };
    const ctx = await makeTestApp({ ...FREE, OUTBOUND_DRIVER: "resend", RESEND_API_KEY: "re_test_key" }, { fetch: providerFetch(state) });
    // The Resend driver would call the network: keep the log driver for the outbound side of this test.
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const made = await c.post("/api/domains", { name: "acme.io" });
    expect(made.status).toBe(201);
    expect(made.body.domain.sending.status).toBe("queued");
    expect(made.body.domain.sending.detail).toMatch(/Waiting for a sending slot/);
    expect(made.body.domain.sending.detail).toMatch(/free\.test/);
    const row = (await ctx.db.select().from(domains).where(eq(domains.name, "acme.io")).get())!;
    expect(row.providerStatus?.startsWith(QUEUED_PREFIX)).toBe(true);

    // The domain is usable: once its own DNS checks pass, mail goes out "via Multies" with Reply-To.
    const id = outboundIdentity(ctx.deps, { address: "ada@acme.io", displayName: "Ada" }, row);
    expect(id).toEqual({ from: { address: "relay@free.test", name: "Ada via Multies" }, replyTo: "ada@acme.io", relayed: true });
    expect(outboundIdentity(ctx.deps, { address: "ada@acme.io", displayName: "Ada" }, { providerStatus: "verified" }).relayed).toBe(false);

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

  it("a queued domain's mail really leaves from the shared domain", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const d = (await c.post("/api/domains", { name: "acme.io" })).body.domain;
    await ctx.db.update(domains).set({ status: "verified", providerStatus: `${QUEUED_PREFIX} domain limit` }).where(eq(domains.id, d.id));
    const mb = (await c.post("/api/mailboxes", { domainId: d.id, localPart: "ada", displayName: "Ada" })).body.mailbox;
    expect((await c.post("/api/mail/send", { mailboxId: mb.id, to: ["grace@navy.mil"], subject: "Relayed", text: "Hello through the relay" })).status).toBe(201);
    const out = ctx.outbound.sent.find((m) => m.subject === "Relayed")!;
    expect(out.from).toEqual({ address: "relay@free.test", name: "Ada via Multies" });
    expect(out.replyTo).toBe("ada@acme.io");
    // The Sent folder keeps the person's own address.
    const stored = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mb.id)).get();
    expect(stored?.address).toBe("ada@acme.io");
  });
});
