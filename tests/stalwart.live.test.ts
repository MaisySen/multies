/**
 * End to end against a real Stalwart server, with real mail clients (ImapFlow for
 * IMAP, Nodemailer for SMTP submission). Skipped unless STALWART_TEST_URL is set:
 *
 *   STALWART_TEST_URL=http://127.0.0.1:8080 STALWART_TEST_ADMIN_USER=... STALWART_TEST_ADMIN_SECRET=... \
 *   STALWART_TEST_IMAP=127.0.0.1:1143 STALWART_TEST_SMTP=127.0.0.1:1587 npx vitest run tests/stalwart.live.test.ts

 */
import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMime } from "@/server/services/mail/mime";

const env = process.env;
const live = !!env.STALWART_TEST_URL;
const [imapHost, imapPort] = (env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");
const domain = env.STALWART_TEST_DOMAIN ?? `t${Date.now().toString(36)}.mymail.test`;

async function imapLogin(user: string, pass: string) {
  const client = new ImapFlow({
    host: imapHost, port: Number(imapPort), secure: false, logger: false,
    auth: { user, pass }, tls: { rejectUnauthorized: false }, doSTARTTLS: true,
  });
  await client.connect();
  return client;
}

describe.skipIf(!live)("Stalwart, live", () => {
  it("provisions a mailbox, then Apple Mail style IMAP and SMTP work with the app password", { timeout: 60_000 }, async () => {
    const ctx = await makeTestApp({
      STALWART_URL: env.STALWART_TEST_URL!, STALWART_ADMIN_USER: env.STALWART_TEST_ADMIN_USER!, STALWART_ADMIN_SECRET: env.STALWART_TEST_ADMIN_SECRET!,
    }, { fetch: globalThis.fetch.bind(globalThis) });
    const c = new Client(ctx.app);
    await c.signup();
    await c.post("/api/org/plan", { plan: "pro" });
    const domainId = (await c.post("/api/domains", { name: domain })).body.domain.id;
    const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id;
    const made = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Apple Mail" });
    expect(made.status).toBe(201);
    const user = made.body.username as string;
    const pass = made.body.secret as string;

    // Inbound mail delivered by Multies shows up over IMAP.
    const raw = new TextEncoder().encode(`From: Bob <bob@example.com>\r\nTo: ${user}\r\nSubject: Delivered by Multies\r\nMessage-ID: <live-${Date.now()}@example.com>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello over IMAP.\r\n`);
    await deliverInbound(ctx.deps, { envelopeFrom: "bob@example.com", rcptTo: user, email: await parseMime(raw), sizeBytes: raw.length, via: "test", raw });

    // SMTP submission with the app password, to the same mailbox.
    const transport = nodemailer.createTransport({ host: smtpHost, port: Number(smtpPort), secure: false, requireTLS: true, auth: { user, pass }, tls: { rejectUnauthorized: false } });
    const sent = await transport.sendMail({ from: user, to: user, subject: "Sent from a mail app", text: "Hello over SMTP." });
    expect(sent.accepted).toContain(user);

    const imap = await imapLogin(user, pass);
    let subjects: string[] = [];
    for (let i = 0; i < 20; i++) {
      const lock = await imap.getMailboxLock("INBOX");
      try {
        subjects = [];
        for await (const msg of imap.fetch("1:*", { envelope: true })) subjects.push(msg.envelope?.subject ?? "");
      } catch { subjects = []; } finally { lock.release(); }
      if (subjects.length >= 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await imap.logout();
    expect(subjects).toEqual(expect.arrayContaining(["Delivered by Multies", "Sent from a mail app"]));

    // A revoked app password stops working.
    expect((await c.del(`/api/mail-access/app-passwords/${made.body.appPassword.id}`)).status).toBe(200);
    await expect(imapLogin(user, pass)).rejects.toThrow();

    // Deleting the mailbox removes the account from the server.
    expect((await c.del(`/api/mailboxes/${mailboxId}`)).status).toBe(200);
  });
});
