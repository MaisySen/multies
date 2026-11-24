/**
 * Wave 3 review Y6: a legal hold on the mailbox of a connection that never proved its address (still waiting for its
 * emailed code) kept the address squatted for ever: the drop kept the mailbox, at the address. Now a hold can't be
 * placed on such a mailbox, and when a waiting connection is dropped (24 hour prune or Remove) a mailbox it made that
 * must stay (it holds mail or a hold) keeps its data but moves off the address, so the real owner can connect it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { auditLogs, mailConnections, mailLegalHolds, mailboxes, messages, users } from "@/server/db/schema";
import { PENDING_CONNECTION_MS, pruneUnverifiedConnections } from "@/server/services/connect";
import { storeMessage } from "@/server/services/mail/store";

const ME = "me@example.org";
const PW = "custom-app-pass";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  (ctx.deps.config as { mailArchive: boolean }).mailArchive = true;
  const imap = new FakeImapServer().addAccount(ME, PW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "ada@acme.io"));
});
const box = (id: string) => ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
async function waiting() {
  const made = await c.post("/api/connections", CUSTOM);
  expect(made.body.connection.status).toBe("verifying");
  return (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, made.body.connection.id)).get())!;
}
async function later<T>(fn: () => Promise<T>) {
  const real = ctx.deps.now;
  ctx.deps.now = () => new Date(real().getTime() + PENDING_CONNECTION_MS + 60_000);
  try { return await fn(); } finally { ctx.deps.now = real; }
}
const mail = (orgId: string, mailboxId: string) => storeMessage(ctx.db, { bodyStore: ctx.deps.bodyStore, orgId, mailboxId, folder: "inbox", from: { address: "x@example.com" }, to: [{ address: ME }], cc: [], bcc: [], subject: "KEEP-ME", text: "hi", date: new Date(), isRead: false } as never);

describe("Y6: holds and waiting connections", () => {
  it("a hold can't be placed on a mailbox still waiting for its code", async () => {
    const row = await waiting();
    const hold = await c.post("/api/mail-archive/holds", { kind: "mailbox", targetId: row.mailboxId, name: "Matter" });
    expect(hold.status).toBe(409);
    expect(hold.body.error.code).toBe("connection_unverified");
    expect(await ctx.db.select().from(mailLegalHolds).all()).toEqual([]);
  });

  it("the prune keeps a made mailbox's mail and hold but frees the address for the real owner", async () => {
    const row = await waiting();
    await mail(row.orgId, row.mailboxId);
    // A hold that came in some other way (placed before this fix).
    await ctx.db.insert(mailLegalHolds).values({ id: "hold_y6", orgId: row.orgId, kind: "mailbox", targetId: row.mailboxId, name: "Old", createdAt: new Date() } as never);
    await later(() => pruneUnverifiedConnections(ctx.deps));
    const b = (await box(row.mailboxId))!;
    expect(b.status).toBe("suspended");
    expect(b.address).not.toBe(ME);
    expect(b.address).toMatch(/@released\.invalid$/);
    expect(b.address).toContain("me=example.org");
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId)).all()).map((m) => m.subject)).toEqual(["KEEP-ME"]);
    const a = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, row.orgId), eq(auditLogs.action, "mailbox.address_released"))).all();
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.metadata as unknown as string)).toMatchObject({ address: ME });

    const owner = new Client(ctx.app);
    await owner.signup("me@example.org", "Real Me", "Mine");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "me@example.org"));
    const mine = await owner.post("/api/connections", CUSTOM);
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
  });

  it("Remove on a waiting connection whose mailbox is kept also frees the address", async () => {
    const row = await waiting();
    await mail(row.orgId, row.mailboxId);
    await ctx.db.insert(mailLegalHolds).values({ id: "hold_y6b", orgId: row.orgId, kind: "mailbox", targetId: row.mailboxId, name: "Old", createdAt: new Date() } as never);
    expect((await c.del(`/api/connections/${row.id}`)).status).toBe(200);
    const b = (await box(row.mailboxId))!;
    expect(b.status).toBe("suspended");
    expect(b.address).toMatch(/@released\.invalid$/);
  });
});
