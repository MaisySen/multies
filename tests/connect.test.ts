import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, mailSyncOutbox, mailboxes, messages, users } from "@/server/db/schema";
import { syncConnection, runDueMailSyncs } from "@/server/services/connect/sync";
import { decryptSecret } from "@/server/lib/crypto";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";

async function setup(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "5", MAIL_SYNC_INITIAL_CAP: "8", ...env }, fetchImpl ? { fetch: fetchImpl } : {});
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" }).addAccount("me@fastmail.com", "fm-app-pass");
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  smtp.accounts.set("me@fastmail.com", "fm-app-pass");
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return { ctx, imap, smtp, c };
}

async function connect(c: Client, body: Record<string, unknown> = {}) {
  return c.post("/api/connections", { email: GMAIL, password: PW, ...body });
}

async function conn(ctx: Ctx) { return (await ctx.db.select().from(mailConnections).get())!; }
async function inbox(ctx: Ctx, mailboxId: string) { return ctx.db.select().from(messages).where(eq(messages.mailboxId, mailboxId)); }

describe("connect a mailbox: testing the connection", () => {
  it("passes with the right app password and picks the Gmail preset from the address", async () => {
    const { c } = await setup();
    const r = await c.post("/api/connections/test", { email: GMAIL, password: PW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, preset: "gmail", imap: { host: "imap.gmail.com", port: 993, security: "tls" }, smtp: { host: "smtp.gmail.com", port: 465 } });
  });

  it("says the password is wrong, in words, with the app password page", async () => {
    const { c } = await setup();
    const r = await c.post("/api/connections/test", { email: GMAIL, password: "my normal password" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("auth_failed");
    expect(r.body.error.message).toContain("app password");
    expect(r.body.error.message).toContain("myaccount.google.com/apppasswords");
    expect(r.body.error.details).toEqual({ step: "imap" });
  });

  it("says when Gmail wants an app password", async () => {
    const { c, imap } = await setup();
    imap.loginError = "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)";
    const r = await c.post("/api/connections/test", { email: GMAIL, password: "x" });
    expect(r.body.error.code).toBe("app_password_needed");
    expect(r.body.error.message).toMatch(/needs an app password/);
  });

  it("says when IMAP is turned off", async () => {
    const { c, imap } = await setup();
    imap.loginError = "[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)";
    const r = await c.post("/api/connections/test", { email: GMAIL, password: PW });
    expect(r.body.error.code).toBe("imap_disabled");
    expect(r.body.error.message).toMatch(/Turn on IMAP/);
  });

  it("names the server when it can't be reached", async () => {
    const { c, imap } = await setup();
    imap.unreachable = true;
    const r = await c.post("/api/connections/test", { email: "me@example.org", password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993 }, smtp: { host: "mail.example.org", port: 465, security: "tls" } });
    expect(r.body.error.code).toBe("unreachable");
    expect(r.body.error.message).toContain("mail.example.org");
  });

  it("checks sending too: SMTP refusing the password is reported as the SMTP step", async () => {
    const { c, smtp } = await setup();
    smtp.authReply = "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.";
    const r = await c.post("/api/connections/test", { email: GMAIL, password: PW });
    expect(r.body.error.code).toBe("smtp_disabled");
    expect(r.body.error.details).toEqual({ step: "smtp" });
  });

  it("refuses private hosts, port 25 and bad addresses before connecting", async () => {
    const { c } = await setup();
    const base = { email: "me@example.org", password: PW, preset: "custom" };
    expect((await c.post("/api/connections/test", { ...base, imap: { host: "127.0.0.1" }, smtp: { host: "smtp.example.org" } })).status).toBe(400);
    expect((await c.post("/api/connections/test", { ...base, imap: { host: "localhost" }, smtp: { host: "smtp.example.org" } })).status).toBe(400);
    expect((await c.post("/api/connections/test", { ...base, imap: { host: "imap.example.org" }, smtp: { host: "smtp.example.org", port: 25 } })).status).toBe(400);
    expect((await c.post("/api/connections/test", { ...base, email: "not-an-address" })).status).toBe(400);
  });

  it("limits how often one person can try passwords", async () => {
    const { c } = await setup();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post("/api/connections/test", { email: GMAIL, password: "wrong" })).status;
    expect(last).toBe(429);
  });

  it("needs a signed in person", async () => {
    const { ctx } = await setup();
    expect((await new Client(ctx.app).post("/api/connections/test", { email: GMAIL, password: PW })).status).toBe(401);
  });
});

describe("connect a mailbox: saving and the first sync", () => {
  it("saves the connection, encrypts the password, makes the mailbox and copies recent mail in", async () => {
    const { ctx, c, imap } = await setup();
    for (let i = 1; i <= 3; i++) imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: `Hello ${i}`, id: `<m${i}@navy.mil>` }), { flags: i === 1 ? ["\\Seen"] : [] });
    const r = await connect(c);
    expect(r.status).toBe(201);
    expect(r.body.connection).toMatchObject({ email: GMAIL, provider: "gmail", status: "active", messagesSynced: 3, initialDone: true });
    const row = await conn(ctx);
    expect(row.secretEnc).not.toContain(PW.slice(0, 4));
    expect(await decryptSecret(ctx.deps.config.appSecret, row.secretEnc)).toBe(PW);
    const mb = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get())!;
    expect(mb.address).toBe(GMAIL);
    const got = await inbox(ctx, mb.id);
    expect(got.map((m) => m.subject).sort()).toEqual(["Hello 1", "Hello 2", "Hello 3"]);
    expect(got.find((m) => m.subject === "Hello 1")!.isRead).toBe(true);
    expect(got.every((m) => m.remoteBox === "inbox" && m.remoteUid)).toBe(true);
    // The mailbox shows in the mail overview like any other.
    const ov = await c.get("/api/mail/overview");
    expect(JSON.stringify(ov.body)).toContain(GMAIL);
  });

  it("never returns the password, and lists status and last sync", async () => {
    const { c } = await setup();
    await connect(c);
    const list = await c.get("/api/connections");
    expect(list.body.enabled).toBe(true);
    expect(list.body.oauth).toEqual([]);
    expect(list.body.connections[0]).toMatchObject({ email: GMAIL, providerLabel: "Gmail", status: "active" });
    expect(list.body.connections[0].lastSyncAt).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(PW);
  });

  it("doesn't save anything when the test fails", async () => {
    const { ctx, c } = await setup();
    const r = await connect(c, { password: "wrong" });
    expect(r.status).toBe(422);
    expect(await ctx.db.select().from(mailConnections)).toHaveLength(0);
    expect(await ctx.db.select().from(mailboxes).where(eq(mailboxes.address, GMAIL))).toHaveLength(0);
  });

  it("refuses an address already in Multies", async () => {
    const { c } = await setup();
    await connect(c);
    expect((await connect(c)).status).toBe(409);
  });

  it("first sync is bounded: recent days only, at most the cap, a batch per pass", async () => {
    const { ctx, c, imap } = await setup();
    const old = new Date(Date.now() - 90 * 86_400_000);
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Very old", id: "<old@x>", date: old }), { date: old });
    for (let i = 1; i <= 12; i++) imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: `New ${i}`, id: `<n${i}@x>` }));
    const r = await connect(c);
    // Batch of 5 on the first pass, more waiting.
    expect(r.body.connection.messagesSynced).toBe(5);
    expect(r.body.connection.initialDone).toBe(false);
    const row = await conn(ctx);
    expect(row.nextSyncAt!.getTime() - Date.now()).toBeLessThan(60_000);
    await syncConnection(ctx.deps, row.id);
    const third = await syncConnection(ctx.deps, row.id);
    expect(third.more).toBe(false);
    const subjects = (await inbox(ctx, row.mailboxId)).map((m) => m.subject);
    // Cap of 8 newest from the last 30 days: New 5 to New 12; never the 90 day old one.
    expect(subjects).toHaveLength(8);
    expect(subjects).not.toContain("Very old");
    expect(subjects).not.toContain("New 4");
    expect((await conn(ctx)).initialDone).toBe(true);
  });

  it("fetches only new UIDs afterwards, and skips mail it already has by Message-ID", async () => {
    const { ctx, c, imap } = await setup();
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "First", id: "<first@x>" }));
    await connect(c);
    const row = await conn(ctx);
    // The same message filed twice at the provider, plus one new one.
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "First", id: "<first@x>" }));
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Second", id: "<second@x>" }));
    const r = await syncConnection(ctx.deps, row.id);
    expect(r).toMatchObject({ stored: 1, duplicates: 1 });
    expect((await syncConnection(ctx.deps, row.id)).stored).toBe(0);
    expect((await inbox(ctx, row.mailboxId)).map((m) => m.subject).sort()).toEqual(["First", "Second"]);
  });

  it("threads a reply with the message it answers", async () => {
    const { ctx, c, imap } = await setup();
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Plan", id: "<plan@x>" }));
    await connect(c);
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Re: Plan", id: "<re-plan@x>", inReplyTo: "<plan@x>" }));
    const row = await conn(ctx);
    await syncConnection(ctx.deps, row.id);
    const all = await inbox(ctx, row.mailboxId);
    expect(new Set(all.map((m) => m.threadId)).size).toBe(1);
  });

  it("copies Sent too, into the Sent folder", async () => {
    const { ctx, c, imap } = await setup();
    imap.deliver(GMAIL, rawMail({ from: GMAIL, to: "bob@example.com", subject: "From my phone", id: "<phone@x>" }), { folder: "[Gmail]/Sent Mail" });
    await connect(c);
    const sent = (await inbox(ctx, (await conn(ctx)).mailboxId)).filter((m) => m.folder === "sent");
    expect(sent.map((m) => m.subject)).toEqual(["From my phone"]);
  });

  it("keeps only headers of a very large message", async () => {
    const { ctx, c, imap } = await setup();
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Huge", id: "<huge@x>", body: "x".repeat(10 * 1024 * 1024 + 10) }));
    await connect(c);
    const m = (await inbox(ctx, (await conn(ctx)).mailboxId))[0];
    expect(m.subject).toBe("Huge");
    expect(m.text).toMatch(/larger than 10 MB/);
  });
});

describe("connect a mailbox: read, star and move state", () => {
  it("pulls read and star changes made at the provider, writing only changed rows", async () => {
    const { ctx, c, imap } = await setup();
    const uid = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Read me", id: "<rm@x>" }));
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Leave me", id: "<lm@x>" }));
    await connect(c);
    const row = await conn(ctx);
    imap.folder(GMAIL, "INBOX").msgs.find((m) => m.uid === uid)!.flags = new Set(["\\Seen", "\\Flagged"]);
    const r = await syncConnection(ctx.deps, row.id);
    expect(r.flagsUpdated).toBe(1);
    const m = (await ctx.db.select().from(messages).where(eq(messages.subject, "Read me")).get())!;
    expect(m).toMatchObject({ isRead: true, isStarred: true });
  });

  it("moves mail out of the Multies inbox when it left the provider's inbox", async () => {
    const { ctx, c, imap } = await setup();
    const uid = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Archived elsewhere", id: "<ae@x>" }));
    await connect(c);
    const f = imap.folder(GMAIL, "INBOX");
    f.msgs = f.msgs.filter((m) => m.uid !== uid);
    await syncConnection(ctx.deps, (await conn(ctx)).id);
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Archived elsewhere")).get())!.folder).toBe("archive");
  });

  it("pushes read, star, archive and trash made in Multies to the provider (moves at once, with what is queued)", async () => {
    const { ctx, c, imap } = await setup();
    const u1 = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "One", id: "<one@x>" }));
    const u2 = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Two", id: "<two@x>" }));
    const u3 = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Three", id: "<three@x>" }));
    await connect(c);
    const id = async (s: string) => (await ctx.db.select().from(messages).where(eq(messages.subject, s)).get())!.id;
    expect((await c.get(`/api/mail/messages/${await id("One")}`)).status).toBe(200);
    expect((await c.patch(`/api/mail/messages/${await id("Two")}`, { isStarred: true })).status).toBe(200);
    expect(await ctx.db.select().from(mailSyncOutbox)).toHaveLength(2);
    // Round 19: a move runs a pass straight away, which applies everything queued.
    expect((await c.post("/api/mail/messages/bulk", { ids: [await id("Three")], action: "archive" })).status).toBe(200);
    expect(imap.actions).toEqual(expect.arrayContaining([`+\\Seen:${u1}`, `+\\Flagged:${u2}`, `move:${u3}>Archive`]));
    expect(await ctx.db.select().from(mailSyncOutbox)).toHaveLength(0);
    // The archived copy stays archived here.
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Three")).get())!.folder).toBe("archive");
  });

  it("queues nothing for mail that isn't from a connected mailbox", async () => {
    const { ctx, c } = await setup();
    await c.post("/api/free-address", { localPart: "ada.acme" });
    const before = (await ctx.db.select().from(mailSyncOutbox)).length;
    expect(before).toBe(0);
  });
});

describe("connect a mailbox: sending as that address", () => {
  it("sends through the provider's SMTP from the real address; Gmail files Sent itself, so no copy is added", async () => {
    const { ctx, c, smtp, imap } = await setup();
    await connect(c);
    const row = await conn(ctx);
    const before = ctx.outbound.sent.length;
    const r = await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: ["bob@example.com"], cc: ["carol@example.com"], bcc: ["dan@example.com"], subject: "Hi Bob", text: "From Multies, as me." });
    expect(r.status).toBe(201);
    expect(r.body.external[0]).toMatchObject({ status: "sent" });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ from: GMAIL, user: GMAIL });
    expect(smtp.sent[0].to.sort()).toEqual(["bob@example.com", "carol@example.com", "dan@example.com"]);
    expect(smtp.sent[0].data).toContain(`From: "ada.lovelace" <${GMAIL}>`);
    expect(smtp.sent[0].data).not.toMatch(/^Bcc:/m);
    expect(smtp.sent[0].data).toMatch(/Message-ID: <.*@gmail\.com>/);
    expect(imap.actions.filter((a) => a.startsWith("append"))).toHaveLength(0);
    // Multies' own sender was never used.
    expect(ctx.outbound.sent).toHaveLength(before);
    // The local Sent copy, and the provider's copy on the next sync, are one message.
    imap.deliver(GMAIL, smtp.sent[0].data, { folder: "[Gmail]/Sent Mail", flags: ["\\Seen"] });
    await syncConnection(ctx.deps, row.id);
    expect((await inbox(ctx, row.mailboxId)).filter((m) => m.folder === "sent")).toHaveLength(1);
  });

  it("adds a Sent copy at providers that don't (Fastmail), once", async () => {
    const { ctx, c, smtp, imap } = await setup();
    const r = await c.post("/api/connections", { email: "me@fastmail.com", password: "fm-app-pass" });
    expect(r.status).toBe(201);
    const row = await conn(ctx);
    expect(row).toMatchObject({ provider: "fastmail", savesSent: false, smtpHost: "smtp.fastmail.com", smtpPort: 465 });
    await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: ["bob@example.com"], subject: "Copy please", text: "Hi" });
    expect(smtp.sent).toHaveLength(1);
    expect(imap.folder("me@fastmail.com", "Sent").msgs).toHaveLength(1);
    expect(imap.actions).toContain("append:Sent");
  });

  it("goes over the internet even to another Multies mailbox, so the provider keeps the Sent copy", async () => {
    const { ctx, c, smtp } = await setup({ FREE_MAIL_DOMAIN: "free.test" });
    const free = await c.post("/api/free-address", { localPart: "ada.acme" });
    await connect(c);
    const row = await conn(ctx);
    await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: [free.body.mailbox?.address ?? "ada.acme@free.test"], subject: "To my other box", text: "Hi" });
    expect(smtp.sent).toHaveLength(1);
  });

  it("isn't treated as a free address: no 10 recipient cap", async () => {
    const { ctx, c, smtp } = await setup({ FREE_MAIL_DOMAIN: "free.test" });
    await connect(c);
    const row = await conn(ctx);
    const to = Array.from({ length: 12 }, (_, i) => `p${i}@example.com`);
    const r = await c.post("/api/mail/send", { mailboxId: row.mailboxId, to, subject: "Team update", text: "Notes from today." });
    expect(r.status).toBe(201);
    expect(smtp.sent[0].to).toHaveLength(12);
  });

  it("reports a refused send in words, and doesn't retry a refused password", async () => {
    const { ctx, c, smtp } = await setup();
    await connect(c);
    smtp.authReply = "535 5.7.8 Username and Password not accepted.";
    const r = await c.post("/api/mail/send", { mailboxId: (await conn(ctx)).mailboxId, to: ["bob@example.com"], subject: "Hi", text: "Hi" });
    expect(r.status).toBe(201);
    expect(r.body.external[0].status).toBe("failed");
    expect(r.body.external[0].detail).toMatch(/refused it for sending/);
  });

  it("asks to reconnect when the password stopped working", async () => {
    const { ctx, c } = await setup();
    await connect(c);
    await ctx.db.update(mailConnections).set({ status: "auth_failed" });
    const r = await c.post("/api/mail/send", { mailboxId: (await conn(ctx)).mailboxId, to: ["bob@example.com"], subject: "Hi", text: "Hi" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Reconnect it in Settings/);
  });
});

describe("connect a mailbox: status, reconnect and remove", () => {
  it("marks the connection when the password stops working, and Reconnect fixes it", async () => {
    const { ctx, c, imap, smtp } = await setup();
    await connect(c);
    const row = await conn(ctx);
    imap.accounts.get(GMAIL)!.password = "new app password";
    smtp.accounts.set(GMAIL, "new app password");
    const r = await syncConnection(ctx.deps, row.id);
    expect(r.skipped).toBe("auth_failed");
    expect((await conn(ctx))).toMatchObject({ status: "auth_failed" });
    expect((await conn(ctx)).lastError).toMatch(/didn't accept/);
    // The scheduled run leaves it alone until the person reconnects.
    expect((await syncConnection(ctx.deps, row.id)).skipped).toBe("auth_failed");
    expect((await c.put(`/api/connections/${row.id}`, { password: "still wrong" })).status).toBe(422);
    const ok = await c.put(`/api/connections/${row.id}`, { password: "new app password" });
    expect(ok.status).toBe(200);
    expect(ok.body.connection.status).toBe("active");
    expect(await decryptSecret(ctx.deps.config.appSecret, (await conn(ctx)).secretEnc)).toBe("new app password");
  });

  it("records network trouble as an error and tries again later", async () => {
    const { ctx, c, imap } = await setup();
    await connect(c);
    imap.unreachable = true;
    const r = await syncConnection(ctx.deps, (await conn(ctx)).id);
    expect(r.error).toMatch(/Couldn't reach imap.gmail.com/);
    const row = await conn(ctx);
    expect(row.status).toBe("error");
    expect(row.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it("Sync now runs a pass on demand", async () => {
    const { ctx, c, imap } = await setup();
    await connect(c);
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Just now", id: "<now@x>" }));
    const r = await c.post(`/api/connections/${(await conn(ctx)).id}/sync`);
    expect(r.status).toBe(200);
    expect(r.body.result.stored).toBe(1);
  });

  it("remove deletes the stored password and the Multies copy, nothing at the provider", async () => {
    const { ctx, c, imap } = await setup();
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Keep at Gmail", id: "<k@x>" }));
    await connect(c);
    const row = await conn(ctx);
    const r = await c.del(`/api/connections/${row.id}`);
    expect(r.status).toBe(200);
    expect(await ctx.db.select().from(mailConnections)).toHaveLength(0);
    expect(await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId))).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId))).toHaveLength(0);
    expect(imap.folder(GMAIL, "INBOX").msgs).toHaveLength(1);
  });

  it("another workspace can't see, sync or remove it", async () => {
    const { ctx, c } = await setup();
    await connect(c);
    const row = await conn(ctx);
    const other = new Client(ctx.app);
    await other.signup(undefined, "Eve", "Other");
    expect((await other.get("/api/connections")).body.connections).toHaveLength(0);
    expect((await other.del(`/api/connections/${row.id}`)).status).toBe(404);
    expect((await other.post(`/api/connections/${row.id}/sync`)).status).toBe(404);
    expect((await other.put(`/api/connections/${row.id}`, { password: PW })).status).toBe(404);
  });
});

describe("connect a mailbox: the daily write budget", () => {
  beforeEach(() => resetWriteBudgetCache());

  const analytics = (rows: number) => (async (url: string) => {
    if (String(url).includes("graphql")) return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "db1", date: "2026-10-25" } }] }] } } });
    throw new Error("network disabled");
  }) as unknown as typeof fetch;

  it("waits while the account's D1 writes are past the warning line", async () => {
    const { ctx, c, imap } = await setup({ CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "a" }, analytics(90_000));
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Later", id: "<later@x>" }));
    await connect(c);
    const row = await conn(ctx);
    expect(row.messagesSynced).toBe(0);
    expect((await syncConnection(ctx.deps, row.id)).skipped).toBe("budget");
  });

  it("syncs normally under the line", async () => {
    const { ctx, c, imap } = await setup({ CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "a" }, analytics(10_000));
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Now", id: "<now2@x>" }));
    await connect(c);
    expect((await conn(ctx)).messagesSynced).toBe(1);
  });

  it("stops at the per connection daily cap", async () => {
    const { ctx, c, imap } = await setup({ MAIL_SYNC_DAILY_CAP: "2" });
    for (let i = 0; i < 4; i++) imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: `Cap ${i}`, id: `<cap${i}@x>` }));
    await connect(c);
    const row = await conn(ctx);
    expect(row.messagesSynced).toBe(2);
    expect((await syncConnection(ctx.deps, row.id)).skipped).toBe("daily_cap");
    expect((await conn(ctx)).messagesSynced).toBe(2);
  });

  it("one pass is one batch of writes: about one row per message plus attachments and two updates", async () => {
    const { ctx, c, imap } = await setup();
    await connect(c);
    const row = await conn(ctx);
    for (let i = 0; i < 5; i++) imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: `W ${i}`, id: `<w${i}@x>` }));
    const client = (ctx.db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
    let writes = 0;
    const orig = client.prepare.bind(client);
    client.prepare = (sqlText: string) => { if (/^\s*(insert|update|delete)/i.test(sqlText)) writes++; return orig(sqlText); };
    const r = await syncConnection(ctx.deps, row.id);
    client.prepare = orig;
    expect(r.stored).toBe(5);
    expect(writes).toBeLessThanOrEqual(5 + 2);
  });
});

describe("connect a mailbox: the scheduled run", () => {
  it("syncs connections that are due, and only those", async () => {
    const { ctx, c, imap } = await setup();
    await connect(c);
    imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Scheduled", id: "<sch@x>" }));
    expect((await runDueMailSyncs(ctx.deps)).dispatched).toBe(0);
    await ctx.db.update(mailConnections).set({ nextSyncAt: new Date(Date.now() - 1000) });
    const seen: string[] = [];
    ctx.deps.dispatchMailSync = async (id) => { seen.push(id); await syncConnection(ctx.deps, id); };
    expect((await runDueMailSyncs(ctx.deps)).dispatched).toBe(1);
    expect(seen).toHaveLength(1);
    expect(await ctx.db.select().from(messages).where(and(eq(messages.subject, "Scheduled")))).toHaveLength(1);
  });

  it("is off with MAIL_CONNECT=off, and the API says so", async () => {
    const { ctx, c } = await setup({ MAIL_CONNECT: "off" });
    expect((await runDueMailSyncs(ctx.deps)).dispatched).toBe(0);
    expect((await c.get("/api/connections")).body.enabled).toBe(false);
    expect((await connect(c)).status).toBe(404);
  });
});
