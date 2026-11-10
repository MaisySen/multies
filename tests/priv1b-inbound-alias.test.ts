import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliver } from "../email-worker/src/index";
import { deliveries, domains, messages, organizations, users } from "@/server/db/schema";
import { createInboundKey } from "@/server/services/mail/inbound-keys";
import { PLATFORM_ORG } from "@/server/services/free-address";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const FREE = { FREE_MAIL_DOMAIN: "free.test", FREE_MAIL_DAILY_SENDS: "3" };

function raw(to: string, o: { from?: string; subject?: string; body?: string; auth?: string } = {}) {
  return [`From: Sender <${o.from ?? "security@bank.com"}>`, `To: ${to}`, `Subject: ${o.subject ?? "Reset your password"}`, `Message-ID: <${Math.random().toString(36).slice(2)}@bank.com>`,
    o.auth === undefined ? "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass" : o.auth ? `Authentication-Results: mx.cloudflare.net; ${o.auth}` : "",
    "Date: Sun, 25 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", o.body ?? "Please read this note about your account."].filter(Boolean).join("\r\n");
}

/** Runs the real Email Worker against the app, signed with `key`. */
async function post(ctx: Ctx, key: { id: string; secret: string }, to: string, o: Parameters<typeof raw>[1] = {}) {
  let rejected: string | null = null;
  const body = raw(to, o);
  const message = { from: o.from ?? "security@bank.com", to, rawSize: body.length, raw: new Response(body).body!, setReject: (r: string) => { rejected = r; }, forward: async () => {} };
  const appFetch = ((url: string, init: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as unknown as typeof fetch;
  await deliver(message, { MYMAIL_WEBHOOK_URL: "http://localhost/api/inbound/cloudflare", MYMAIL_KEY_ID: key.id, MYMAIL_KEY_SECRET: key.secret }, appFetch);
  return { rejected };
}

/** A workspace with a verified domain (stands in for the DNS check), an inbound key and its org id. */
async function workspace(ctx: Ctx, name: string, domain: string) {
  const c = new Client(ctx.app);
  await c.signup(undefined, `${name} Owner`, name);
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const dom = (await c.post("/api/domains", { name: domain })).body.domain;
  await ctx.db.update(domains).set({ status: "verified" }).where(eq(domains.id, dom.id));
  const key = (await c.post("/api/inbound-keys")).body.key as { id: string; secret: string };
  return { c, orgId, domainId: dom.id as string, key };
}

const inboxOf = (ctx: Ctx, mailboxId: string) => ctx.db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
const authOf = (row: unknown) => JSON.parse(String((row as { authResults: string }).authResults));

describe("PRIV1b (P38): an alias can't put mail into another workspace", () => {
  it("another workspace's personal mailbox gets nothing through the alias; the address is forwarded like any outside one", async () => {
    const ctx = await makeTestApp(FREE);
    const v = new Client(ctx.app);
    const vEmail = await v.signup(undefined, "Vic Tim", "VictimCo");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, vEmail));
    const victim = (await v.post("/api/free-address", { localPart: "vic.victimco" })).body.mailbox;

    const a = await workspace(ctx, "EvilCo", "evil.io");
    expect((await a.c.post("/api/aliases", { domainId: a.domainId, localPart: "x", destinations: [victim.address] })).status).toBe(201);
    expect((await post(ctx, a.key, victim.address)).rejected).toMatch(/not managed by this signing key/);
    const sentBefore = ctx.outbound.sent.length;
    await post(ctx, a.key, "x@evil.io");
    expect(await inboxOf(ctx, victim.id)).toHaveLength(0);
    // It left as an ordinary forward from the alias, metered and filtered like any send.
    const out = ctx.outbound.sent.slice(sentBefore);
    expect(out).toHaveLength(1);
    expect(out[0]!.from.address).toBe("x@evil.io");
    expect(out[0]!.to).toEqual([victim.address]);
  });

  it("an alias still delivers into a mailbox of its own workspace", async () => {
    const ctx = await makeTestApp();
    const w = await workspace(ctx, "Acme", "acme.io");
    const mb = (await w.c.post("/api/mailboxes", { domainId: w.domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    expect((await w.c.post("/api/aliases", { domainId: w.domainId, localPart: "team", destinations: [mb.address] })).status).toBe(201);
    const sentBefore = ctx.outbound.sent.length;
    expect((await post(ctx, w.key, "team@acme.io")).rejected).toBeNull();
    expect(await inboxOf(ctx, mb.id)).toHaveLength(1);
    expect(ctx.outbound.sent.length).toBe(sentBefore);
  });

  it("a workspace key's Authentication-Results can't say pass; a failing verdict still files as spam", async () => {
    const ctx = await makeTestApp();
    const w = await workspace(ctx, "Acme", "acme.io");
    const mb = (await w.c.post("/api/mailboxes", { domainId: w.domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    expect((await post(ctx, w.key, "hello@acme.io")).rejected).toBeNull();
    const [row] = await inboxOf(ctx, mb.id);
    expect(row!.folder).toBe("inbox");
    expect(authOf(row)).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    expect((await post(ctx, w.key, "hello@acme.io", { auth: "spf=fail; dkim=fail; dmarc=fail" })).rejected).toBeNull();
    const spam = (await inboxOf(ctx, mb.id)).find((m) => m.folder === "spam");
    expect(authOf(spam)).toEqual({ spf: "fail", dkim: "fail", dmarc: "fail" });
  });

  it("the platform's own worker key keeps the verdicts Cloudflare added", async () => {
    const ctx = await makeTestApp(FREE);
    const v = new Client(ctx.app);
    const vEmail = await v.signup(undefined, "Ada Lovelace", "Acme");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, vEmail));
    const mb = (await v.post("/api/free-address", { localPart: "ada.acme" })).body.mailbox;
    const key = await createInboundKey(ctx.deps, PLATFORM_ORG);
    expect((await post(ctx, key, mb.address)).rejected).toBeNull();
    const [row] = await inboxOf(ctx, mb.id);
    expect(authOf(row)).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });
});

describe("PRIV1b (P39): alias forwards pass the sending gates", () => {
  const forwarded = (ctx: Ctx, orgId: string) => ctx.db.select().from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.status, "forwarded")));
  const refused = (ctx: Ctx, orgId: string) => ctx.db.select().from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.direction, "outbound"), eq(deliveries.status, "rejected")));

  it("a suspended workspace forwards nothing and the sender gets a bounce", async () => {
    const ctx = await makeTestApp();
    const w = await workspace(ctx, "EvilCo", "evil.io");
    const dests = Array.from({ length: 20 }, (_, i) => `victim${i}@gmail.com`);
    expect((await w.c.post("/api/aliases", { domainId: w.domainId, localPart: "blast", destinations: dests })).status).toBe(201);
    await ctx.db.update(organizations).set({ suspendedAt: new Date() }).where(eq(organizations.id, w.orgId));
    const sentBefore = ctx.outbound.sent.length;
    expect((await post(ctx, w.key, "blast@evil.io")).rejected).toBeTruthy();
    expect(ctx.outbound.sent.length).toBe(sentBefore);
    expect(await forwarded(ctx, w.orgId)).toHaveLength(0);
    const r = await refused(ctx, w.orgId);
    expect(r).toHaveLength(20);
    expect(r[0]!.detail).toMatch(/suspended/);
  });

  it("forwards count against the daily cap: the first fits, the next is refused", async () => {
    const ctx = await makeTestApp();
    const w = await workspace(ctx, "Acme", "acme.io");
    expect((await w.c.post("/api/aliases", { domainId: w.domainId, localPart: "fwd", destinations: ["a@gmail.com", "b@gmail.com"] })).status).toBe(201);
    await ctx.db.update(organizations).set({ sendCapDaily: 3 }).where(eq(organizations.id, w.orgId));
    const sentBefore = ctx.outbound.sent.length;
    expect((await post(ctx, w.key, "fwd@acme.io", { auth: "" })).rejected).toBeNull();
    expect(ctx.outbound.sent.length).toBe(sentBefore + 1);
    expect(await forwarded(ctx, w.orgId)).toHaveLength(2);
    expect((await post(ctx, w.key, "fwd@acme.io", { auth: "" })).rejected).toBeTruthy();
    expect(ctx.outbound.sent.length).toBe(sentBefore + 1);
    expect((await refused(ctx, w.orgId))[0]!.detail).toMatch(/Daily sending limit/);
    // The workspace's own sends see the forwards too.
    const mb = (await w.c.post("/api/mailboxes", { domainId: w.domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    const send = await w.c.post("/api/mail/send", { mailboxId: mb.id, to: ["c@gmail.com", "d@gmail.com"], subject: "Hi", text: "Hello there" });
    expect(send.body.queued ?? send.body.error).toBeTruthy();
  });

  it("a spam forward is held and not sent", async () => {
    const ctx = await makeTestApp();
    const w = await workspace(ctx, "Acme", "acme.io");
    expect((await w.c.post("/api/aliases", { domainId: w.domainId, localPart: "fwd", destinations: ["a@gmail.com"] })).status).toBe(201);
    const sentBefore = ctx.outbound.sent.length;
    expect((await post(ctx, w.key, "fwd@acme.io", { subject: "YOU HAVE WON THE LOTTERY", body: "act now, click here https://bit.ly/x" })).rejected).toBeTruthy();
    expect(ctx.outbound.sent.length).toBe(sentBefore);
    expect((await refused(ctx, w.orgId))[0]!.detail).toMatch(/spam/);
  });
});
