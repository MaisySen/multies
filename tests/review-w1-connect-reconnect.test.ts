/**
 * Wave 1 review V3 (P60 bypass): a connection waiting for its emailed code could be turned on without the code by
 * Reconnect (PUT /api/connections/:id set it active), and its mailbox unsuspended by PATCH /api/mailboxes/:id; a
 * verified Gmail could also be switched to any servers without a code. Now Reconnect keeps a waiting connection
 * waiting, a move to servers that don't prove the address asks for a new code, a waiting mailbox can't be
 * unsuspended, and nothing sends while the connection waits.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, mailboxes, users } from "@/server/db/schema";

const ME = "me@example.org";
const PW = "custom-app-pass";
const GMAIL = "ada.lovelace@gmail.com";
const GPW = "abcd efgh ijkl mnop";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  const imap = new FakeImapServer().addAccount(ME, PW).addAccount(GMAIL, GPW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  smtp.accounts.set(GMAIL, GPW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "ada@acme.io"));
});
const conn = (id: string) => ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get();
const box = (id: string) => ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
const codes = (to: string) => ctx.outbound.sent.filter((m) => m.to.includes(to) && /code/i.test(m.subject)).length;

describe("Wave 1 review V3: Reconnect and unsuspend don't skip the emailed code", () => {
  it("a waiting connection stays waiting after Reconnect; its mailbox can't be unsuspended; it can't send", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    expect(made.body.connection.status).toBe("verifying");
    const id = made.body.connection.id as string;
    const re = await c.put(`/api/connections/${id}`, { password: PW });
    expect(re.status).toBe(200);
    expect(re.body.connection.status).toBe("verifying");
    const row = (await conn(id))!;
    expect(row.status).toBe("verifying");
    expect((await box(row.mailboxId))?.status).toBe("suspended");
    const un = await c.patch(`/api/mailboxes/${row.mailboxId}`, { status: "active" });
    expect(un.status).toBe(409);
    expect((await box(row.mailboxId))?.status).toBe("suspended");
    // Even with the mailbox forced active, a send through a waiting connection is refused.
    await ctx.db.update(mailboxes).set({ status: "active" }).where(eq(mailboxes.id, row.mailboxId));
    const sent = await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: ["x@example.com"], subject: "Hi", text: "Hi" });
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe("connection_unverified");
  });

  it("a verified Gmail moved to other servers waits for a new code", async () => {
    const made = await c.post("/api/connections", { email: GMAIL, password: GPW });
    expect(made.body.connection.status).toBe("active");
    const id = made.body.connection.id as string;
    // A new password on its own servers: still active, no code.
    expect((await c.put(`/api/connections/${id}`, { password: GPW })).body.connection.status).toBe("active");
    expect(codes(GMAIL)).toBe(0);
    const moved = await c.put(`/api/connections/${id}`, { password: GPW, imap: { host: "imap.attacker-mail.com", port: 993, security: "tls" }, smtp: { host: "smtp.attacker-mail.com", port: 465, security: "tls" } });
    expect(moved.status).toBe(200);
    expect(moved.body.connection.status).toBe("verifying");
    expect((await box((await conn(id))!.mailboxId))?.status).toBe("suspended");
    expect(codes(GMAIL)).toBe(1);
  });
});
