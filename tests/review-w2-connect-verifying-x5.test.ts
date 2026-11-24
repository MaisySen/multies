/**
 * Wave 2 review X5: a connection sent back to "verifying" (a Reconnect to servers that don't prove the address) could
 * be set active again by a sync pass that had started before it: the pass's status writes (connect failure, end of
 * pass, error) didn't look at "verifying". And entering the code set the mailbox active unconditionally, undoing a
 * suspend its owner made while the code was pending. Now no sync write touches a waiting connection, and the code
 * clears only the suspension the verification itself set.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, mailboxes, users } from "@/server/db/schema";
import { syncConnection } from "@/server/services/connect/sync";
import type { ImapConnector } from "@/server/services/connect/imap";

const ME = "me@example.org";
const PW = "custom-app-pass";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let real: ImapConnector;

beforeEach(async () => {
  ctx = await makeTestApp();
  const imap = new FakeImapServer().addAccount(ME, PW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  real = imap.connector;
  ctx.deps.imap = real;
  ctx.deps.openSocket = smtp.opener;
  c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "ada@acme.io"));
});
const conn = (id: string) => ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get();
const box = (id: string) => ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
const lastCode = () => ([...ctx.outbound.sent].reverse().find((m) => m.to.includes(ME) && /code/i.test(m.subject))?.text ?? "").match(/\b(\d{6})\b/)?.[1] ?? "";

/** A verified connection, with mail synced once, so a pass runs through to the end. */
async function verified() {
  const made = await c.post("/api/connections", CUSTOM);
  const id = made.body.connection.id as string;
  expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
  expect((await conn(id))!.status).toBe("active");
  return id;
}
const goVerifying = (id: string) => ctx.db.update(mailConnections).set({ status: "verifying" }).where(eq(mailConnections.id, id));

describe("X5: sync never turns a waiting connection back on", () => {
  it("the end of a pass that started before the reverify leaves it waiting", async () => {
    const id = await verified();
    // The reverify lands while the pass is connected (it read the row as active before).
    ctx.deps.imap = async (...a) => { const s = await real(...a); await goVerifying(id); return s; };
    await syncConnection(ctx.deps, id, { force: true });
    expect((await conn(id))!.status).toBe("verifying");
  });

  it("a connect failure during the reverify leaves it waiting", async () => {
    const id = await verified();
    ctx.deps.imap = async () => { await goVerifying(id); throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); };
    await syncConnection(ctx.deps, id, { force: true });
    expect((await conn(id))!.status).toBe("verifying");
  });

  it("an error mid pass leaves it waiting", async () => {
    const id = await verified();
    ctx.deps.imap = async (...a) => {
      const s = await real(...a);
      await goVerifying(id);
      return new Proxy(s, { get: (t, k) => (k === "close" ? t.close.bind(t) : typeof (t as never)[k] === "function" ? () => { throw new Error("socket hang up"); } : (t as never)[k]) });
    };
    await syncConnection(ctx.deps, id, { force: true });
    expect((await conn(id))!.status).toBe("verifying");
  });
});

describe("X5: the code clears only the suspension the verification set", () => {
  it("a mailbox its owner suspended while the code was pending stays suspended", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    const id = made.body.connection.id as string;
    const mailboxId = (await conn(id))!.mailboxId;
    // The owner suspends it herself while waiting (P59: her personal mailbox).
    expect((await c.patch(`/api/mailboxes/${mailboxId}`, { status: "suspended" })).status).toBe(200);
    expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
    expect((await conn(id))!.status).toBe("active");
    expect((await box(mailboxId))!.status).toBe("suspended");
  });

  it("a mailbox the verification suspended comes back on with the code, at connect and after a reverify", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    const id = made.body.connection.id as string;
    const mailboxId = (await conn(id))!.mailboxId;
    expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
    expect((await box(mailboxId))!.status).toBe("active");
    // A reverify: moved to other servers, a new code; the mailbox waits and comes back on with the code.
    const real2 = ctx.deps.now;
    ctx.deps.now = () => new Date(real2().getTime() + 61_000);
    try {
      const moved = await c.put(`/api/connections/${id}`, { password: PW, imap: { host: "mail2.example.org" }, smtp: { host: "mail2.example.org" } });
      expect(moved.body.connection.status).toBe("verifying");
      expect((await box(mailboxId))!.status).toBe("suspended");
      expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
    } finally { ctx.deps.now = real2; }
    expect((await box(mailboxId))!.status).toBe("active");
  });

  it("a mailbox suspended before a reverify stays suspended after the code", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    const id = made.body.connection.id as string;
    const mailboxId = (await conn(id))!.mailboxId;
    expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
    expect((await c.patch(`/api/mailboxes/${mailboxId}`, { status: "suspended" })).status).toBe(200);
    const moved = await c.put(`/api/connections/${id}`, { password: PW, imap: { host: "mail2.example.org" }, smtp: { host: "mail2.example.org" } });
    expect(moved.body.connection.status).toBe("verifying");
    expect((await c.post(`/api/connections/${id}/verify`, { code: lastCode() })).status).toBe(200);
    expect((await box(mailboxId))!.status).toBe("suspended");
  });
});
