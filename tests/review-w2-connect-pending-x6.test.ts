/**
 * Wave 2 review X6: dropping a connection that never got its code deleted the mailbox it made even when that mailbox
 * held mail or a legal hold, and an import (IMAP or .mbox) or a draft save could put mail into a mailbox still waiting
 * for its code. Now the drop deletes the mailbox only when it holds no messages and no hold (otherwise it stays,
 * suspended), and imports and draft saves into a waiting mailbox are refused.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, mailLegalHolds, mailboxes, messages, users } from "@/server/db/schema";
import { PENDING_CONNECTION_MS, pruneUnverifiedConnections } from "@/server/services/connect";
import { storeMessage } from "@/server/services/mail/store";

const ME = "me@example.org";
const PW = "custom-app-pass";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp({ IMPORT_RUNNER_TOKEN: "x6-import-runner-token-0123456789" });
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
  const row = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, made.body.connection.id)).get())!;
  return row;
}
async function later<T>(fn: () => Promise<T>) {
  const real = ctx.deps.now;
  ctx.deps.now = () => new Date(real().getTime() + PENDING_CONNECTION_MS + 60_000);
  try { return await fn(); } finally { ctx.deps.now = real; }
}

describe("X6: nothing goes into a waiting mailbox", () => {
  it("draft saves, IMAP imports and .mbox imports are refused while the code is pending", async () => {
    const row = await waiting();
    const draft = await c.post("/api/mail/drafts", { mailboxId: row.mailboxId, to: ["x@example.com"], subject: "Draft", text: "hi" });
    expect(draft.status).toBe(409);
    expect(draft.body.error.code).toBe("connection_unverified");
    const imp = await c.post("/api/imports", { mailboxId: row.mailboxId, provider: "imap", sourceUser: "someone@old.example", appPassword: "secret-pass", sourceHost: "imap.old.example" });
    expect(imp.status).toBe(409);
    expect(imp.body.error.code).toBe("connection_unverified");
    const raw = Buffer.from(rawMail({ subject: "MBOX-IN", from: "x@example.com", to: ME, id: "<x6@example.com>" })).toString("base64");
    const mbox = await c.post("/api/data-moves/mbox/batch", { mailboxId: row.mailboxId, total: 1, messages: [raw], last: true });
    expect(mbox.status).toBe(409);
    expect(mbox.body.error.code).toBe("connection_unverified");
    expect(await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId)).all()).toEqual([]);
  });
});

describe("X6: the 24 hour drop keeps a mailbox that holds mail or a hold", () => {
  it("an empty mailbox the connection made is deleted, as before", async () => {
    const row = await waiting();
    await later(() => pruneUnverifiedConnections(ctx.deps));
    expect(await box(row.mailboxId)).toBeUndefined();
  });

  it("one that holds a message stays, suspended, with its mail", async () => {
    const row = await waiting();
    // Mail that got in before this fix (or any other way).
    await storeMessage(ctx.db, { bodyStore: ctx.deps.bodyStore, orgId: row.orgId, mailboxId: row.mailboxId, folder: "inbox", from: { address: "x@example.com" }, to: [{ address: ME }], cc: [], bcc: [], subject: "KEEP-ME", text: "hi", date: new Date(), isRead: false } as never);
    await later(() => pruneUnverifiedConnections(ctx.deps));
    expect(await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get()).toBeUndefined();
    expect((await box(row.mailboxId))?.status).toBe("suspended");
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId)).all()).map((m) => m.subject)).toEqual(["KEEP-ME"]);
  });

  // Wave 3 review Y6 (deliberate change): a hold can no longer be placed on a waiting mailbox (409), so this one is
  // written directly, as a hold placed before that fix. It still stays, suspended (and now off the address).
  it("one under a legal hold stays, suspended", async () => {
    const row = await waiting();
    const hold = await c.post("/api/mail-archive/holds", { kind: "mailbox", targetId: row.mailboxId, name: "Matter" });
    expect(hold.status).toBe(409);
    await ctx.db.insert(mailLegalHolds).values({ id: "hold_x6", orgId: row.orgId, kind: "mailbox", targetId: row.mailboxId, name: "Matter", createdAt: new Date() } as never);
    await later(() => pruneUnverifiedConnections(ctx.deps));
    expect((await box(row.mailboxId))?.status).toBe("suspended");
  });
});

describe("X6: connecting again over a waiting mailbox that holds mail", () => {
  it("its owner takes it over with its mail; another workspace is refused and nothing is deleted", async () => {
    const row = await waiting();
    await storeMessage(ctx.db, { bodyStore: ctx.deps.bodyStore, orgId: row.orgId, mailboxId: row.mailboxId, folder: "inbox", from: { address: "x@example.com" }, to: [{ address: ME }], cc: [], bcc: [], subject: "KEEP-ME", text: "hi", date: new Date(), isRead: false } as never);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "eve@evil.io"));
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 61_000);
    try {
      expect((await other.post("/api/connections", CUSTOM)).status).toBe(409);
      expect((await box(row.mailboxId))?.orgId).toBe(row.orgId);
      const again = await c.post("/api/connections", CUSTOM);
      expect(again.status).toBe(201);
      const now = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, again.body.connection.id)).get())!;
      expect(now.mailboxId).toBe(row.mailboxId);
    } finally { ctx.deps.now = real; }
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId)).all()).map((m) => m.subject)).toEqual(["KEEP-ME"]);
  });
});
