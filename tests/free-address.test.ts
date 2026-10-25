import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliver } from "../email-worker/src/index";
import { domains, mailboxes, organizations, users } from "@/server/db/schema";
import { freeLocalPartProblem, suggestFreeLocalPart, ensurePlatformDomain, PLATFORM_ORG } from "@/server/services/free-address";
import { createInboundKey } from "@/server/services/mail/inbound-keys";
import { recheckStaleDomains } from "@/server/services/domains";
import { freeMailDomain } from "@/server/config";

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
    expect(suggestFreeLocalPart("", "Harbour", "bidur@example.com")).toBe("bidur.harbour");
    expect(freeLocalPartProblem(suggestFreeLocalPart("A", ""))).toBeNull();
  });
  it("refuses reserved, short and malformed names", () => {
    for (const bad of ["support", "no-reply", "noreply", "no.reply", "postmaster", "security", "relay", "admin", "hello", "legal", "privacy", "accounts", "review", "abuse", "billing", "ops",
      "support.team", "security-team", "admin1", "multies", "multies.support", "team.multies", "ab", "-ada", "ada..acme", "Ada", "ada_acme", "a".repeat(41)]) {
      expect(freeLocalPartProblem(bad), bad).not.toBeNull();
    }
    for (const ok of ["ada", "ada.acme", "ada-lovelace", "a1b"]) expect(freeLocalPartProblem(ok), ok).toBeNull();
  });
});

describe("the shared domain is never the company's own", () => {
  it("refuses the app's domain and its www/app hosts, takes a subdomain", () => {
    expect(freeMailDomain("multies.si", "https://multies.si")).toBeUndefined();
    expect(freeMailDomain("app.multies.si", "https://app.multies.si")).toBeUndefined();
    expect(freeMailDomain("MULTIES.SI", "https://www.multies.si")).toBeUndefined();
    expect(freeMailDomain("mail.multies.si", "https://multies.si")).toBe("mail.multies.si");
    expect(freeMailDomain(undefined, "https://multies.si")).toBeUndefined();
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

  it("a deleted free address is never given to someone else", async () => {
    const ctx = await makeTestApp(FREE);
    const a = new Client(ctx.app);
    await verifiedUser(ctx, a);
    expect((await a.post("/api/free-address", { localPart: "gone.acme" })).status).toBe(201);
    await ctx.db.delete(mailboxes).where(eq(mailboxes.address, "gone.acme@free.test"));
    const b = new Client(ctx.app);
    await verifiedUser(ctx, b, "Gone Again", "Other");
    const again = await b.post("/api/free-address", { localPart: "gone.acme" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/taken/);
    expect((await b.post("/api/free-address", { localPart: "gone.other" })).status).toBe(201);
  });

  it("a workspace key can take one through the public API", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const key = (await c.post("/api/developer/keys", { name: "ops" })).body;
    const secret = key.secret ?? key.key?.secret;
    const r = await ctx.app.request("/api/v1/free-address", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ localPart: "desk.acme" }) });
    expect(r.status).toBe(201);
    expect((await r.json()).address).toBe("desk.acme@free.test");
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

describe("free address abuse limits", () => {
  it("one per person, even after deleting it", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const mb = (await c.post("/api/free-address", { localPart: "ada.acme" })).body.mailbox;
    expect((await c.del(`/api/mailboxes/${mb.id}`)).status).toBe(200);
    const again = await c.post("/api/free-address", { localPart: "ada.again" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/Each person gets one/);
  });

  it("a few per network and per device a day, and a ceiling for the whole server", async () => {
    const ctx = await makeTestApp({ ...FREE, TRUST_PROXY: "true", FREE_MAIL_DAILY_CLAIMS: "5" });
    const claim = async (i: number, headers: Record<string, string>) => {
      const c = new Client(ctx.app);
      // Each person signs up from their own network (sign up has its own per network limit).
      const email = `person${i}@example.com`;
      const up = await c.call("POST", "/api/auth/sign-up/email", { name: `Person ${i}`, email, password: "a-strong-password" }, { "x-forwarded-for": `192.0.2.${i}` });
      expect(up.status).toBe(200);
      await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
      return c.call("POST", "/api/free-address", { localPart: `person${i}.x` }, headers);
    };
    for (let i = 1; i <= 3; i++) expect((await claim(i, { "x-forwarded-for": "203.0.113.9" })).status).toBe(201);
    const blockedIp = await claim(4, { "x-forwarded-for": "203.0.113.9" });
    expect(blockedIp.status).toBe(429);
    expect(blockedIp.body.error.message).toMatch(/network or device/);
    // Another network, but the same device as before.
    expect((await claim(5, { "x-forwarded-for": "198.51.100.1", "x-device-id": "dev-1" })).status).toBe(201);
    expect((await claim(6, { "x-forwarded-for": "198.51.100.2", "x-device-id": "dev-1" })).status).toBe(201);
    // The server's ceiling (5 a day here) is reached.
    const full = await claim(7, { "x-forwarded-for": "198.51.100.3" });
    expect(full.status).toBe(429);
    expect(full.body.error.message).toMatch(/today's free addresses/);
  });

  it("new accounts get a smaller allowance, and one message can't go to many people", async () => {
    const ctx = await makeTestApp({ FREE_MAIL_DOMAIN: "free.test", FREE_MAIL_DAILY_SENDS: "50", FREE_MAIL_NEW_DAILY_SENDS: "2" });
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const mb = (await c.post("/api/free-address", { localPart: "ada.acme" })).body.mailbox;
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@x.org`);
    const big = await c.post("/api/mail/send", { mailboxId: mb.id, to: many, subject: "Hi all", text: "Hello everyone here" });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toMatch(/up to 10 people/);
    expect((await c.post("/api/mail/send", { mailboxId: mb.id, to: ["a@x.org", "b@x.org"], subject: "One", text: "Hello there friends" })).status).toBe(201);
    const over = await c.post("/api/mail/send", { mailboxId: mb.id, to: ["c@x.org"], subject: "Two", text: "Hello again friend" });
    expect(over.status).toBe(403);
    expect(over.body.error.message).toMatch(/2 recipients a day in their first week/);
  });

  it("spam looking mail from a free address is held at the lower score", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await verifiedUser(ctx, c);
    const mb = (await c.post("/api/free-address", { localPart: "ada.acme" })).body.mailbox;
    const spam = await c.post("/api/mail/send", { mailboxId: mb.id, to: ["a@x.org"], subject: "FREE MONEY!!! CLAIM YOUR PRIZE NOW", text: "Click here to claim your free prize money now!!! Limited time offer, act now, winner! bit.ly/x bit.ly/y" });
    expect(spam.status).toBe(422);
  });
});
