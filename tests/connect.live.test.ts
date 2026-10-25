/**
 * Connected mailbox, end to end against a real IMAP and SMTP server (Stalwart on this box), with
 * the real clients: ImapFlow for IMAP and the MailSocket SMTP client over node:tls. Skipped unless
 * STALWART_TEST_URL is set (same variables as tests/stalwart.live.test.ts):
 *
 *   STALWART_TEST_URL=http://127.0.0.1:8080 STALWART_TEST_ADMIN_USER=... STALWART_TEST_ADMIN_SECRET=... \
 *   STALWART_TEST_IMAP=127.0.0.1:1143 STALWART_TEST_SMTP=127.0.0.1:1587 npx vitest run tests/connect.live.test.ts
 */
import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailConnections, messages } from "@/server/db/schema";
import { syncConnection } from "@/server/services/connect/sync";
import { smtpSend } from "@/server/services/connect/smtp";
import { nodeSocketOpener } from "@/server/services/connect/node-socket";

const env = process.env;
const live = !!env.STALWART_TEST_URL;
const [imapHost, imapPort] = (env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");
const domain = `c${Date.now().toString(36)}.mymail.test`;

/** A real mailbox on the test server: a Multies workspace that provisions it there, with an app password. */
export async function provisionStalwartMailbox(local = "ada") {
  const host = await makeTestApp({ STALWART_URL: env.STALWART_TEST_URL!, STALWART_ADMIN_USER: env.STALWART_TEST_ADMIN_USER!, STALWART_ADMIN_SECRET: env.STALWART_TEST_ADMIN_SECRET! }, { fetch: globalThis.fetch.bind(globalThis) });
  const c = new Client(host.app);
  await c.signup();
  await c.post("/api/org/plan", { plan: "pro" });
  const domainId = (await c.post("/api/domains", { name: domain })).body.domain.id;
  const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: local, displayName: "Ada" })).body.mailbox.id;
  const made = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Connected from Multies" });
  return { user: made.body.username as string, pass: made.body.secret as string };
}

async function imapList(user: string, pass: string, path: string) {
  const imap = new ImapFlow({ host: imapHost, port: Number(imapPort), secure: false, doSTARTTLS: true, logger: false, auth: { user, pass }, tls: { rejectUnauthorized: false } });
  await imap.connect();
  const out: string[] = [];
  const lock = await imap.getMailboxLock(path);
  try { for await (const m of imap.fetch("1:*", { envelope: true })) out.push(m.envelope?.subject ?? ""); } catch { /* empty folder */ } finally { lock.release(); }
  const folders = await imap.list();
  await imap.logout();
  return { subjects: out, folders };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)("connected mailbox, live against a real IMAP and SMTP server", () => {
  it("tests, connects, syncs, sends as the address, and files the Sent copy", { timeout: 90_000 }, async () => {
    const { user, pass } = await provisionStalwartMailbox();
    const opener = nodeSocketOpener({ allowSelfSigned: true });
    const smtp = { host: smtpHost, port: Number(smtpPort), security: "starttls" as const };
    // Mail already in the mailbox before it is connected.
    await smtpSend(opener, smtp, { user, secret: pass }, { from: user, to: [user] }, `From: ${user}\r\nTo: ${user}\r\nSubject: Before connecting\r\nMessage-ID: <before-${Date.now()}@mymail.test>\r\n\r\nAlready here.\r\n`);
    await wait(1500);

    const ctx = await makeTestApp({ MAIL_CONNECT_ALLOW_SELF_SIGNED: "true", MAIL_CONNECT_ALLOW_PRIVATE_HOSTS: "true" });
    const c = new Client(ctx.app);
    await c.signup();
    const body = { email: user, password: pass, preset: "custom", imap: { host: imapHost, port: Number(imapPort), security: "starttls" }, smtp: { host: smtpHost, port: Number(smtpPort), security: "starttls" } };

    const bad = await c.post("/api/connections/test", { ...body, password: "not-the-password-123" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("auth_failed");

    const ok = await c.post("/api/connections/test", body);
    expect(ok.status).toBe(200);

    const made = await c.post("/api/connections", body);
    expect(made.status).toBe(201);
    const row = (await ctx.db.select().from(mailConnections).get())!;
    let subjects = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId))).map((m) => m.subject);
    expect(subjects).toContain("Before connecting");

    // New mail at the provider arrives on the next pass.
    await smtpSend(opener, smtp, { user, secret: pass }, { from: user, to: [user] }, `From: ${user}\r\nTo: ${user}\r\nSubject: After connecting\r\nMessage-ID: <after-${Date.now()}@mymail.test>\r\n\r\nNew mail.\r\n`);
    for (let i = 0; i < 10 && !subjects.includes("After connecting"); i++) {
      await wait(700);
      await syncConnection(ctx.deps, row.id);
      subjects = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId))).map((m) => m.subject);
    }
    expect(subjects).toContain("After connecting");

    // Reading it in Multies marks it read at the provider.
    const after = (await ctx.db.select().from(messages).where(eq(messages.subject, "After connecting")).get())!;
    await c.get(`/api/mail/messages/${after.id}`);
    const pushed = await syncConnection(ctx.deps, row.id);
    expect(pushed.pushed).toBe(1);

    // Send from Multies as that address: through the provider's SMTP, with a copy in its Sent folder.
    const sent = await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: [user], subject: "Sent from Multies", text: "Through my own provider." });
    expect(sent.status).toBe(201);
    expect(sent.body.external[0].status).toBe("sent");
    let inbox: string[] = [];
    let sentBox: string[] = [];
    for (let i = 0; i < 15; i++) {
      const listed = await imapList(user, pass, "INBOX");
      inbox = listed.subjects;
      const sentPath = listed.folders.find((f) => f.specialUse === "\\Sent")?.path ?? "Sent Items";
      sentBox = (await imapList(user, pass, sentPath)).subjects;
      if (inbox.includes("Sent from Multies") && sentBox.includes("Sent from Multies")) break;
      await wait(500);
    }
    expect(inbox).toContain("Sent from Multies");
    expect(sentBox).toContain("Sent from Multies");

    // The provider's Sent copy and the Multies Sent copy are one message after the next sync.
    await syncConnection(ctx.deps, row.id);
    const local = await ctx.db.select().from(messages).where(eq(messages.subject, "Sent from Multies"));
    expect(local.filter((m) => m.folder === "sent")).toHaveLength(1);

    // Remove: the stored password goes with it.
    expect((await c.del(`/api/connections/${row.id}`)).status).toBe(200);
    expect(await ctx.db.select().from(mailConnections)).toHaveLength(0);
  });
});
