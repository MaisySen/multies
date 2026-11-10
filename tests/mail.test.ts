import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliver } from "../email-worker/src/index";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
let inbox: { id: string; address: string };

function rawEmail(o: { from?: string; to?: string; subject?: string; body?: string; messageId?: string; inReplyTo?: string; auth?: string; attachment?: boolean } = {}) {
  const boundary = "b1";
  const head = [
    `From: Grace Hopper <${o.from ?? "grace@navy.mil"}>`,
    `To: ${o.to ?? "hello@acme.io"}`,
    `Subject: ${o.subject ?? "Hello there"}`,
    `Message-ID: ${o.messageId ?? `<${Math.random().toString(36).slice(2)}@navy.mil>`}`,
    o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}` : "",
    o.auth ? `Authentication-Results: mx.cloudflare.net; ${o.auth}` : "",
    "Date: Thu, 22 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  if (!o.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", o.body ?? "Testing the new mail system."].join("\r\n");
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain", "", o.body ?? "See attached.", `--${boundary}`,
    'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', "Content-Transfer-Encoding: base64", "", btoa("attachment body"), `--${boundary}--`, ""].join("\r\n");
}

/** Runs the real Email Worker against the app, exactly as Cloudflare would. */
async function viaWorker(raw: string, env: { id: string; secret: string }, to = "hello@acme.io", from = "grace@navy.mil") {
  let rejected: string | null = null;
  const message = {
    from, to, rawSize: raw.length,
    raw: new Response(raw).body!,
    setReject: (r: string) => { rejected = r; },
    forward: async () => {},
  };
  const appFetch = ((url: string, init: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as unknown as typeof fetch;
  await deliver(message, { MYMAIL_WEBHOOK_URL: "http://localhost/api/inbound/cloudflare", MYMAIL_KEY_ID: env.id, MYMAIL_KEY_SECRET: env.secret }, appFetch);
  return { rejected };
}

async function verifyDomain() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup();
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  inbox = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme Hello" })).body.mailbox;
});

describe("inbound via Cloudflare Email Worker", () => {
  it("stores a signed message, with attachments, in the inbox", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    const r = await viaWorker(rawEmail({ attachment: true, auth: "spf=pass; dkim=pass; dmarc=pass" }), key);
    expect(r.rejected).toBeNull();
    const list = await c.get(`/api/mail/messages?mailboxId=${inbox.id}&folder=inbox`);
    expect(list.body.messages).toHaveLength(1);
    expect(list.body.messages[0]).toMatchObject({ subject: "Hello there", isRead: false, hasAttachments: true, from: { address: "grace@navy.mil", name: "Grace Hopper" } });
    const full = await c.get(`/api/mail/messages/${list.body.messages[0].id}`);
    expect(full.body.message.authResults).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    const att = full.body.message.attachments[0];
    expect(att.filename).toBe("notes.txt");
    const dl = await ctx.app.request(`/api/mail/attachments/${att.id}`, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(await dl.text()).toBe("attachment body");
    const deliveries = await c.get("/api/deliveries?direction=inbound");
    expect(deliveries.body.deliveries[0]).toMatchObject({ status: "delivered", provider: "cloudflare" });
  });

  it("bounces unknown recipients and files DMARC failures as spam", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    expect((await viaWorker(rawEmail({ to: "nobody@acme.io" }), key, "nobody@acme.io")).rejected).toMatch(/No mailbox/);
    await viaWorker(rawEmail({ auth: "spf=fail; dkim=fail; dmarc=fail" }), key);
    expect((await c.get(`/api/mail/messages?folder=spam`)).body.messages).toHaveLength(1);
  });

  it("refuses bad signatures and other tenants' domains", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    const forged = await viaWorker(rawEmail(), { id: key.id, secret: "whsec_wrong" });
    expect(forged.rejected).toMatch(/Temporary failure/);
    const other = new Client(ctx.app);
    await other.signup();
    const otherKey = (await other.post("/api/inbound-keys")).body.key;
    const cross = await viaWorker(rawEmail(), otherKey);
    expect(cross.rejected).toMatch(/not managed/);
    expect((await c.get("/api/mail/messages")).body.messages).toHaveLength(0);
  });

  it("routes plus-addresses, aliases and the catch-all", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    await c.post("/api/aliases", { domainId, localPart: "sales", destinations: ["hello@acme.io", "founder@gmail.com"] });
    await viaWorker(rawEmail({ to: "hello+news@acme.io" }), key, "hello+news@acme.io");
    await viaWorker(rawEmail({ to: "sales@acme.io", subject: "Pricing?" }), key, "sales@acme.io");
    expect(ctx.outbound.sent.at(-1)).toMatchObject({ to: ["founder@gmail.com"], from: { address: "sales@acme.io" }, replyTo: "grace@navy.mil" });
    await c.patch(`/api/domains/${domainId}`, { catchAllMailboxId: inbox.id });
    await viaWorker(rawEmail({ to: "random@acme.io" }), key, "random@acme.io");
    expect((await c.get(`/api/mail/messages?mailboxId=${inbox.id}`)).body.messages).toHaveLength(3);
  });
});

describe("sending", () => {
  it("refuses to send from an unverified domain", async () => {
    const r = await c.post("/api/mail/send", { mailboxId: inbox.id, to: ["x@example.com"], subject: "Hi", text: "Hi" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("domain_unverified");
  });

  it("delivers internally, hands external mail to the provider, and threads replies", async () => {
    await verifyDomain();
    const team = (await c.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox;
    const sent = await c.post("/api/mail/send", { mailboxId: inbox.id, to: ["team@acme.io", "Partner@Example.com"], subject: "Kickoff", text: "Let's go" });
    expect(sent.status).toBe(201);
    expect(sent.body.internal).toEqual(["team@acme.io"]);
    expect(sent.body.external).toEqual([{ address: "partner@example.com", status: "queued", detail: expect.stringContaining("No outbound provider") }]);
    expect(ctx.outbound.sent.find((m) => m.subject === "Kickoff")!.to).toEqual(["partner@example.com"]);

    const received = (await c.get(`/api/mail/messages?mailboxId=${team.id}&folder=inbox`)).body.messages[0];
    expect(received.subject).toBe("Kickoff");
    await c.post("/api/mail/send", { mailboxId: team.id, to: ["hello@acme.io"], subject: "Re: Kickoff", text: "On it", inReplyToId: received.id });
    const helloInbox = (await c.get(`/api/mail/messages?mailboxId=${inbox.id}&folder=inbox`)).body.messages[0];
    const thread = await c.get(`/api/mail/messages/${helloInbox.id}`);
    expect(thread.body.thread.map((m: { subject: string }) => m.subject)).toEqual(["Kickoff", "Re: Kickoff"]);
  });

  it("enforces the daily sending limit", async () => {
    await verifyDomain();
    // Past its first week with a clean record, so the plan's cap (not the R34 new sender limit) is the one in play.
    const { organizations } = await import("@/server/db/schema");
    await ctx.deps.db.update(organizations).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) });
    // The shared sender headroom (90 a day across every workspace) would stop this first; turn it off here.
    ctx.deps.config.sendGuard = { ...ctx.deps.config.sendGuard!, providerDailyCap: 0 };
    const many = Array.from({ length: 50 }, (_, i) => `r${i}@example.com`);
    expect((await c.post("/api/mail/send", { mailboxId: inbox.id, to: many, subject: "a", text: "a" })).status).toBe(201);
    expect((await c.post("/api/mail/send", { mailboxId: inbox.id, to: many, subject: "b", text: "b" })).status).toBe(201);
    // R34 (MB-166): over the cap the message is queued until midnight UTC with the reason, never refused or dropped.
    const over = await c.post("/api/mail/send", { mailboxId: inbox.id, to: ["one-more@example.com"], subject: "c", text: "c" });
    expect(over.status).toBe(202);
    expect(over.body.queued.reason).toMatch(/Daily sending limit reached \(100 recipients a day\)/);
  });
});

describe("webmail", () => {
  it("searches, stars, archives, trashes and deletes", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    await viaWorker(rawEmail({ subject: "Invoice #42", body: "Your invoice is attached" }), key);
    await viaWorker(rawEmail({ subject: "Lunch?", body: "Tacos at noon" }), key);
    const hit = await c.get("/api/mail/messages?q=tacos");
    expect(hit.body.messages.map((m: { subject: string }) => m.subject)).toEqual(["Lunch?"]);
    expect((await c.get("/api/mail/messages?q=100%25")).body.messages).toHaveLength(0);
    const id = hit.body.messages[0].id;
    await c.patch(`/api/mail/messages/${id}`, { isStarred: true });
    expect((await c.get("/api/mail/messages?folder=starred")).body.messages).toHaveLength(1);
    await c.patch(`/api/mail/messages/${id}`, { folder: "archive" });
    expect((await c.get("/api/mail/messages?folder=archive")).body.messages).toHaveLength(1);
    await c.del(`/api/mail/messages/${id}`);
    expect((await c.get("/api/mail/messages?folder=trash")).body.messages).toHaveLength(1);
    const del = await c.del(`/api/mail/messages/${id}`);
    expect(del.body.permanent).toBe(true);
    const ov = await c.get("/api/mail/overview");
    expect(ov.body.mailboxes[0].folders.inbox).toEqual({ total: 1, unread: 1 });
  });

  it("paginates with a stable cursor", async () => {
    await verifyDomain(); // PRIV1b (P36): only a verified domain receives mail
    const key = (await c.post("/api/inbound-keys")).body.key;
    for (let i = 0; i < 5; i++) await viaWorker(rawEmail({ subject: `m${i}` }), key);
    const p1 = await c.get("/api/mail/messages?limit=2");
    const p2 = await c.get(`/api/mail/messages?limit=2&cursor=${p1.body.nextCursor}`);
    const p3 = await c.get(`/api/mail/messages?limit=2&cursor=${p2.body.nextCursor}`);
    const ids = [...p1.body.messages, ...p2.body.messages, ...p3.body.messages].map((m: { id: string }) => m.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.body.nextCursor).toBeNull();
  });

  it("saves drafts and keeps tenants' mail private", async () => {
    const d = await c.post("/api/mail/drafts", { mailboxId: inbox.id, subject: "WIP", text: "half-written" });
    expect(d.status).toBe(201);
    expect((await c.get("/api/mail/messages?folder=drafts")).body.messages[0].subject).toBe("WIP");
    const other = new Client(ctx.app);
    await other.signup();
    expect((await other.get(`/api/mail/messages/${d.body.id}`)).status).toBe(404);
    expect((await other.get("/api/mail/messages")).body.messages).toHaveLength(0);
  });
});
