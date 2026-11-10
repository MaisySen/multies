import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { privacyWorld, verifiedDomain } from "./priv1a-world";
import { domains, mailboxes, organizations, users } from "@/server/db/schema";
import { isHosted } from "@/server/services/mail/delivery";
import { createDomain } from "@/server/services/domains";
import { ensurePlatformDomain } from "@/server/services/free-address";
import { CONNECTED_DOMAIN } from "@/server/services/connect";
import { CONNECTED_DOMAIN_NAME, assertDomainAllowed } from "@/server/services/suite/operator-inbox";
import { newId } from "@/server/lib/crypto";

/**
 * PRIV1b, batch domain-routing: P36 (unverified domains routed inside the platform, public and platform names claimable),
 * P40 (demo adds domains and sends as them with pass results), P50 (platform domains adopted from a squatter),
 * P70 (v1 domain create skips name rules). Each case checks the attack fails and the legitimate path still works.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const inbox = async (c: Client, mailboxId: string) => {
  const r = await c.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox`);
  return (r.body.messages ?? r.body.items ?? []) as { id: string; subject: string }[];
};
const sentTo = (ctx: Ctx, addr: string) => ctx.outbound.sent.filter((m) => [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].includes(addr));

describe("P36: only verified domains route inside the platform", () => {
  it("a pending squat on partner.io catches nothing; the mail leaves through the provider; once verified it routes", async () => {
    const w = await privacyWorld();
    const B = w.outsider;
    const d = await B.post("/api/domains", { name: "partner.io" });
    expect(d.status).toBe(201);
    expect(d.body.domain.status).not.toBe("verified");
    const domId = d.body.domain.id as string;
    const bob = (await B.post("/api/mailboxes", { domainId: domId, localPart: "bob", displayName: "Bob" })).body.mailbox.id as string;
    expect((await B.call("PATCH", `/api/domains/${domId}`, { catchAllMailboxId: bob })).status).toBe(200);
    expect(await isHosted(w.ctx.db, "bob@partner.io")).toBe(false);
    expect(await isHosted(w.ctx.db, "ceo@partner.io")).toBe(false);

    const s = await w.owner.post("/api/mail/send", { mailboxId: w.boxes.team, to: ["bob@partner.io", "ceo@partner.io"], subject: "Q3 contract", text: "Confidential pricing" });
    expect(s.status).toBe(201);
    expect(s.body.internal).toEqual([]);
    expect(sentTo(w.ctx, "bob@partner.io").length).toBe(1);
    expect(sentTo(w.ctx, "ceo@partner.io").length).toBe(1);
    expect((await inbox(B, bob)).some((m) => m.subject === "Q3 contract")).toBe(false);

    // Legitimate: once the domain is proved (the DNS check passes), it routes inside the platform as before.
    await w.ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, domId));
    expect(await isHosted(w.ctx.db, "bob@partner.io")).toBe(true);
    const s2 = await w.owner.post("/api/mail/send", { mailboxId: w.boxes.team, to: ["bob@partner.io"], subject: "After verify", text: "hi" });
    expect(s2.body.internal).toEqual(["bob@partner.io"]);
    expect((await inbox(B, bob)).some((m) => m.subject === "After verify")).toBe(true);
  });

  it("a demoted (failed) domain stops routing too, unless it was once proved in DNS", async () => {
    const w = await privacyWorld();
    expect(await isHosted(w.ctx.db, `pat${w.n}@acme.io`)).toBe(false); // no mailbox there
    expect(await isHosted(w.ctx.db, "team@acme.io")).toBe(true);
    // PRIV1b (integration M1): a failed re-check of a proved domain (verifiedAt kept) keeps routing; never proved does not.
    await w.ctx.db.update(domains).set({ status: "failed" }).where(eq(domains.id, w.domainId));
    expect(await isHosted(w.ctx.db, "team@acme.io")).toBe(true);
    await w.ctx.db.update(domains).set({ status: "failed", verifiedAt: null }).where(eq(domains.id, w.domainId));
    expect(await isHosted(w.ctx.db, "team@acme.io")).toBe(false);
  });

  it("a password reset for a login on a squatted domain goes out through the provider, not into the squatter's mailbox", async () => {
    const w = await privacyWorld();
    const victim = `out${w.n}@other.io`;
    const d = await w.owner.post("/api/domains", { name: "other.io" });
    expect(d.status).toBe(201);
    const box = (await w.owner.post("/api/mailboxes", { domainId: d.body.domain.id, localPart: `out${w.n}`, displayName: "Otto" })).body.mailbox.id as string;
    const before = sentTo(w.ctx, victim).length;
    const anon = new Client(w.ctx.app);
    const r = await anon.call("POST", "/api/auth/request-password-reset", { email: victim, redirectTo: "/reset-password" }, { "cf-connecting-ip": "192.0.2.77" });
    expect(r.status).toBe(200);
    expect(await inbox(w.owner, box)).toEqual([]);
    expect(sentTo(w.ctx, victim).length).toBe(before + 1);
    expect(JSON.stringify(sentTo(w.ctx, victim).at(-1))).toMatch(/reset-password/);
  });

  it("public mail services and their subdomains can't be added; an ordinary domain still can", async () => {
    const w = await privacyWorld();
    for (const name of ["gmail.com", "outlook.com", "icloud.com", "proton.me", "mail.gmail.com", "GMAIL.com"]) {
      const r = await w.owner.post("/api/domains", { name });
      expect(r.status, name).toBe(409);
      expect(r.body.error.message).toMatch(/public mail service/);
    }
    expect((await w.owner.post("/api/domains", { name: "acme-two.io" })).status).toBe(201);
  });

  it("free addresses, the demo sample domain and the connected row still route (all stored verified)", async () => {
    const ctx = await makeTestApp({ FREE_MAIL_DOMAIN: "free.example", APP_URL: "https://app.multies.test", DEMO_MODE: "true" });
    const A = new Client(ctx.app); await A.signup("olive@acme.io", "Olive", "Acme");
    const domA = await verifiedDomain(ctx, A, "acme.io");
    const boxA = (await A.post("/api/mailboxes", { domainId: domA, localPart: "olive", displayName: "Olive" })).body.mailbox.id as string;
    const C = new Client(ctx.app); await C.signup("carol@victim.io", "Carol", "Carol Co");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "carol@victim.io"));
    const cl = await C.post("/api/free-address", { localPart: "carol.k" });
    expect(cl.status).toBe(201);
    const s = await A.post("/api/mail/send", { mailboxId: boxA, to: ["carol.k@free.example"], subject: "To a free address", text: "hi" });
    expect(s.body.internal).toEqual(["carol.k@free.example"]);
    expect((await inbox(C, cl.body.mailbox.id)).some((m) => m.subject === "To a free address")).toBe(true);
    // Free address sends back inside the platform.
    const back = await C.post("/api/mail/send", { mailboxId: cl.body.mailbox.id, to: ["olive@acme.io"], subject: "Back", text: "hi" });
    expect(back.body.internal).toEqual(["olive@acme.io"]);

    // Demo: the sample mailboxes still mail each other inside the platform.
    const D = new Client(ctx.app);
    expect((await D.post("/api/account/demo", {})).status).toBeLessThan(300);
    const boxes = (await D.get("/api/mailboxes")).body.mailboxes as { id: string; address: string; localPart: string }[];
    const founders = boxes.find((b) => b.localPart === "founders")!;
    const support = boxes.find((b) => b.localPart === "support")!;
    const ds = await D.post("/api/mail/send", { mailboxId: founders.id, to: [support.address], subject: "Demo internal", text: "hi" });
    expect(ds.status).toBe(201);
    expect(ds.body.internal).toEqual([support.address]);

    // The connected row the connect flow uses is the platform's and verified.
    expect(CONNECTED_DOMAIN_NAME).toBe(CONNECTED_DOMAIN);
    const conn = await ensurePlatformDomain(ctx.deps, CONNECTED_DOMAIN);
    expect([conn.orgId, conn.status]).toEqual(["org_platform", "verified"]);
  });
});

describe("P50: platform shared domains are reserved and never adopted", () => {
  it("no workspace can add the free-mail, agent, connected or company names; the operator keeps the company domain", async () => {
    const ctx = await makeTestApp({ FREE_MAIL_DOMAIN: "free.example", AGENT_MAIL_DOMAIN: "agents.example", APP_URL: "https://app.multies.test" });
    const B = new Client(ctx.app); await B.signup("boss@evil.io", "Eve", "Evil");
    for (const name of ["free.example", "agents.example", "x.free.example", "connected.multies.invalid", "multies.si", "mail.multies.si"]) {
      const r = await B.post("/api/domains", { name });
      expect(r.status, name).toBe(409);
      expect(r.body.error.message).toMatch(/reserved/);
    }
    expect(await ctx.db.select().from(domains).where(eq(domains.name, "free.example")).get()).toBeUndefined();
    const cfg = { operatorInbox: { orgId: "org_hq", domain: "multies.si", addresses: [] }, freeMail: { domain: "mail.multies.si" } };
    expect(() => assertDomainAllowed(cfg, "org_hq", "multies.si")).not.toThrow();
    expect(() => assertDomainAllowed(cfg, "org_hq", "status.multies.si")).not.toThrow();
    expect(() => assertDomainAllowed(cfg, "org_hq", "mail.multies.si")).toThrow(/reserved/);
    expect(() => assertDomainAllowed(cfg, "org_x", "status.multies.si")).toThrow(/reserved/);
    expect(() => assertDomainAllowed(cfg, "org_x", "acme.io")).not.toThrow();
  });

  it("a row a workspace added before the fix is not adopted: the claim is refused and the squatter's data stays", async () => {
    const ctx = await makeTestApp({ FREE_MAIL_DOMAIN: "free.example", APP_URL: "https://app.multies.test" });
    const B = new Client(ctx.app); await B.signup("boss@evil.io", "Eve", "Evil");
    const bOrg = (await B.get("/api/account/me")).body.organization.id as string;
    const domId = newId("dom");
    await ctx.db.insert(domains).values({ id: domId, orgId: bOrg, name: "free.example", verificationToken: "t", dkimSelector: "s", dkimPublicKey: "k", dkimPrivateKeyEnc: "e" });
    const C = new Client(ctx.app); await C.signup("carol@victim.io", "Carol", "Carol Co");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "carol@victim.io"));
    const cl = await C.post("/api/free-address", { localPart: "carol.k" });
    expect(cl.status).toBe(409);
    expect(cl.body.error.code).toBe("platform_domain_taken");
    expect(await ctx.db.select().from(mailboxes).where(eq(mailboxes.domainId, domId)).all()).toEqual([]);
    expect((await ctx.db.select().from(domains).where(eq(domains.id, domId)).get())?.orgId).toBe(bOrg);
  });

  it("legitimate: with no squatter the platform row is created and owned by the platform", async () => {
    const ctx = await makeTestApp({ FREE_MAIL_DOMAIN: "free.example", APP_URL: "https://app.multies.test" });
    const C = new Client(ctx.app); await C.signup("carol@victim.io", "Carol", "Carol Co");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "carol@victim.io"));
    expect((await C.post("/api/free-address", { localPart: "carol.k" })).status).toBe(201);
    const row = await ctx.db.select().from(domains).where(eq(domains.name, "free.example")).get();
    expect([row?.orgId, row?.status]).toEqual(["org_platform", "verified"]);
  });
});

describe("P40: a demo workspace can't add or remove domains or send as an unproved one", () => {
  it("demo add and delete are refused; the sample domain stays and sends with pass results", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const A = new Client(ctx.app); await A.signup("olive@acme.io", "Olive", "Acme");
    const domA = await verifiedDomain(ctx, A, "acme.io");
    const boxA = (await A.post("/api/mailboxes", { domainId: domA, localPart: "olive", displayName: "Olive" })).body.mailbox.id as string;
    const D = new Client(ctx.app);
    expect((await D.post("/api/account/demo", {})).status).toBeLessThan(300);
    const sample = (await D.get("/api/domains")).body.domains[0];
    const del = await D.call("DELETE", `/api/domains/${sample.id}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("demo_domains_off");
    const add = await D.post("/api/domains", { name: "partner.io" });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe("demo_domains_off");
    expect(await ctx.db.select().from(domains).where(eq(domains.name, "partner.io")).get()).toBeUndefined();

    const founders = ((await D.get("/api/mailboxes")).body.mailboxes as { id: string; localPart: string }[]).find((b) => b.localPart === "founders")!;
    const s = await D.post("/api/mail/send", { mailboxId: founders.id, to: ["olive@acme.io"], subject: "Hello from the demo", text: "hi" });
    expect(s.status).toBe(201);
    const m = (await inbox(A, boxA)).find((x) => x.subject === "Hello from the demo")!;
    expect(JSON.stringify((await A.get(`/api/mail/messages/${m.id}`)).body)).toMatch(/"dmarc":"pass"/);

    // An unproved sender domain in a demo is refused like everywhere else (the demo exemption is gone).
    await ctx.db.update(domains).set({ status: "pending" }).where(eq(domains.id, sample.id));
    const s2 = await D.post("/api/mail/send", { mailboxId: founders.id, to: ["olive@acme.io"], subject: "Spoof", text: "new bank details" });
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe("domain_unverified");
    expect((await inbox(A, boxA)).some((x) => x.subject === "Spoof")).toBe(false);
  });

  it("Check DNS on the demo sample domain keeps it verified; the sample mailboxes still mail each other with pass", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const D = new Client(ctx.app);
    expect((await D.post("/api/account/demo", {})).status).toBeLessThan(300);
    const sample = (await D.get("/api/domains")).body.domains[0];
    const v = await D.post(`/api/domains/${sample.id}/verify`, {});
    expect(v.status).toBe(200);
    expect((await ctx.db.select().from(domains).where(eq(domains.id, sample.id)).get())!.status).toBe("verified");
    const boxes = (await D.get("/api/mailboxes")).body.mailboxes as { id: string; address: string; localPart: string }[];
    const founders = boxes.find((b) => b.localPart === "founders")!;
    const support = boxes.find((b) => b.localPart === "support")!;
    const s = await D.post("/api/mail/send", { mailboxId: founders.id, to: [support.address], subject: "After check", text: "hi" });
    expect(s.status).toBe(201);
    expect(s.body.internal).toEqual([support.address]);
    const m = (await inbox(D, support.id)).find((x) => x.subject === "After check")!;
    expect(JSON.stringify((await D.get(`/api/mail/messages/${m.id}`)).body)).toMatch(/"dmarc":"pass"/);
  });

  it("only the demo seeder's sample flag passes the demo guard, not a reused DKIM key", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const D = new Client(ctx.app);
    expect((await D.post("/api/account/demo", {})).status).toBeLessThan(300);
    const sample = (await D.get("/api/domains")).body.domains[0];
    const orgId = (await ctx.db.select().from(domains).where(eq(domains.id, sample.id)).get())!.orgId;
    const dkimKey = { publicKeyB64: "AAAA", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" };
    await expect(createDomain(ctx.deps, orgId, "partner.io", { dkimKey })).rejects.toMatchObject({ status: 403, code: "demo_domains_off" });
    expect(await ctx.db.select().from(domains).where(eq(domains.name, "partner.io")).get()).toBeUndefined();
  });

  it("a non-demo workspace still adds and removes its own domains", async () => {
    const ctx = await makeTestApp({});
    const A = new Client(ctx.app); await A.signup("olive@acme.io", "Olive", "Acme");
    const add = await A.post("/api/domains", { name: "acme.io" });
    expect(add.status).toBe(201);
    expect((await A.call("DELETE", `/api/domains/${add.body.domain.id}`)).status).toBe(200);
  });
});

describe("P70: v1 POST /domains uses the app's name rules", () => {
  async function keyFor(c: Client) {
    const made = await c.post("/api/developer/keys", { name: "CI" });
    return made.body.secret as string;
  }
  async function bearer(ctx: Ctx, key: string, body: unknown) {
    const res = await ctx.app.request("/api/v1/domains", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("a trailing dot can't sit beside another workspace's name; bad names are refused; a good name still works", async () => {
    const ctx = await makeTestApp({});
    const A = new Client(ctx.app); await A.signup("olive@acme.io", "Olive", "Acme");
    expect((await A.post("/api/domains", { name: "partner.io" })).status).toBe(201);
    const B = new Client(ctx.app); await B.signup("boss@evil.io", "Eve", "Evil");
    const bOrg = (await B.get("/api/account/me")).body.organization.id as string;
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, bOrg));
    const key = await keyFor(B);
    const dot = await bearer(ctx, key, { name: "partner.io." });
    expect(dot.status).toBe(409);
    expect(await ctx.db.select().from(domains).where(eq(domains.name, "partner.io.")).get()).toBeUndefined();
    for (const name of ["not a domain", "localhost", "1.2.3.4", "-bad.io"]) expect((await bearer(ctx, key, { name })).status, name).toBe(422);
    expect((await bearer(ctx, key, { name: "gmail.com" })).status).toBe(409);
    const ok = await bearer(ctx, key, { name: "https://Evil-Two.io/" });
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe("evil-two.io");
  });
});
