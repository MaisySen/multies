/**
 * Live mail against a real IMAP and SMTP server (Stalwart on this box), with the real ImapFlow
 * IDLE watch, and the measured delay from the moment the provider accepts a message to the moment
 * it is stored in Multies. Skipped unless STALWART_TEST_URL is set (see tests/connect.live.test.ts).
 * Writes the measurements to LIVE_MAIL_REPORT when set.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailConnections, messages } from "@/server/db/schema";
import { smtpSend } from "@/server/services/connect/smtp";
import { nodeSocketOpener } from "@/server/services/connect/node-socket";
import { localLiveMail } from "@/server/services/connect/live";

const env = process.env;
const live = !!env.STALWART_TEST_URL;
const [imapHost, imapPort] = (env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");
const domain = `l${Date.now().toString(36)}.mymail.test`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stalwartMailbox(local: string) {
  const host = await makeTestApp({ STALWART_URL: env.STALWART_TEST_URL!, STALWART_ADMIN_USER: env.STALWART_TEST_ADMIN_USER!, STALWART_ADMIN_SECRET: env.STALWART_TEST_ADMIN_SECRET! }, { fetch: globalThis.fetch.bind(globalThis) });
  const c = new Client(host.app);
  await c.signup();
  await c.post("/api/org/plan", { plan: "pro" });
  const domainId = (await c.post("/api/domains", { name: domain })).body.domain.id;
  const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: local, displayName: "Live" })).body.mailbox.id;
  const made = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Connected from Multies" });
  return { user: made.body.username as string, pass: made.body.secret as string };
}

describe.skipIf(!live)("live mail, against a real IMAP server", () => {
  it("copies new mail in seconds while the app is open, and writes nothing while nothing arrives", { timeout: 120_000 }, async () => {
    const { user, pass } = await stalwartMailbox("live");
    const ctx = await makeTestApp({ MAIL_CONNECT_ALLOW_SELF_SIGNED: "true", MAIL_CONNECT_ALLOW_PRIVATE_HOSTS: "true" });
    const c = new Client(ctx.app);
    await c.signup();
    const body = { email: user, password: pass, preset: "custom", imap: { host: imapHost, port: Number(imapPort), security: "starttls" }, smtp: { host: smtpHost, port: Number(smtpPort), security: "starttls" } };
    expect((await c.post("/api/connections", body)).status).toBe(201);
    const row = (await ctx.db.select().from(mailConnections).get())!;
    const poked = await c.post("/api/connections/live", { poke: true });
    expect(poked.body.connections[0].mode).toBe("push");

    const opener = nodeSocketOpener({ allowSelfSigned: true });
    const smtp = { host: smtpHost, port: Number(smtpPort), security: "starttls" as const };
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const subject = `Live ${i} ${Date.now()}`;
      const t0 = Date.now();
      await smtpSend(opener, smtp, { user, secret: pass }, { from: user, to: [user] }, `From: ${user}\r\nTo: ${user}\r\nSubject: ${subject}\r\nMessage-ID: <live-${i}-${t0}@mymail.test>\r\n\r\nHello.\r\n`);
      const accepted = Date.now();
      let at = 0;
      for (let k = 0; k < 400 && !at; k++) {
        const hit = await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, subject)).get();
        if (hit) at = Date.now(); else await wait(50);
      }
      expect(at).toBeGreaterThan(0);
      delays.push(at - accepted);
      // The app's next heartbeat sees the new count.
      const beat = await c.post("/api/connections/live", { poke: i % 2 === 0 });
      expect(beat.body.stamp).toBeGreaterThan(0);
      await wait(300);
    }

    // The app's waiting heartbeat (long poll) answers as soon as the message is in.
    const subject = `Long poll ${Date.now()}`;
    const stampBefore = (await c.post("/api/connections/live", {})).body.stamp;
    const held = c.post("/api/connections/live", { wait: 20_000 });
    await wait(200);
    const tSend = Date.now();
    await smtpSend(opener, smtp, { user, secret: pass }, { from: user, to: [user] }, `From: ${user}\r\nTo: ${user}\r\nSubject: ${subject}\r\nMessage-ID: <lp-${tSend}@mymail.test>\r\n\r\nHello.\r\n`);
    const answer = await held;
    const heartbeatMs = Date.now() - tSend;
    expect(answer.body.stamp).toBe(stampBefore + 1);
    expect(heartbeatMs).toBeLessThan(5000);

    // Quiet: the live window keeps watching but writes nothing.
    const before = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!;
    await wait(3000);
    const after = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!;
    expect(after.lastSyncAt?.getTime()).toBe(before.lastSyncAt?.getTime());

    await localLiveMail(ctx.deps).stopAll();
    const sorted = [...delays].sort((a, b) => a - b);
    const report = { heartbeatAnsweredMs: heartbeatMs, delaysMs: delays, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), server: "Stalwart (local)", mode: "push (IDLE)" };
    if (env.LIVE_MAIL_REPORT) writeFileSync(env.LIVE_MAIL_REPORT, JSON.stringify(report, null, 2));
    console.log("live mail delay", JSON.stringify(report));
    expect(report.maxMs).toBeLessThan(10_000);
  });
});
