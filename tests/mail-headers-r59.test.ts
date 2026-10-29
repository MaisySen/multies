import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, messages, users } from "@/server/db/schema";
import { parsePartial, parseState, syncConnection, REPAIR_BATCH } from "@/server/services/connect/sync";
import { headerEnd, secondPeek, HEAD_PEEK_MAX } from "@/server/services/connect/imap";
import { PENDING_FROM } from "@/server/services/mail/pending-from";
import { makeSnippet } from "@/server/services/mail/mime";

/**
 * R59: older mail stored as "unknown@invalid (no subject)". The backfill fetched the envelope and the first 6,144 bytes;
 * when a message's header block was longer (a long Gmail Received/ARC/DKIM chain), From, Subject and Date lay past the
 * cut, parseMime filled placeholders, and those won over the envelope. Prod rows on 29 Oct 2026 had a Message-ID (from
 * the envelope), an empty subject and the store time as date: the fixture below gives exactly that before the fix.
 */
const PEEK = 6144;
const ACC = "grace.hopper@gmail.com";
const PW = "abcd efgh ijkl mnop";
const OLD = new Date(Date.UTC(2025, 4, 29, 10));

/** The failing shape: about 7.8 KB of trace headers in front of From, Date, Message-ID and Subject (Gmail order). */
function longHeaders(n = 40) {
  return Array.from({ length: n }, (_, i) => `Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.${i}]) by mx.google.com with SMTPS id abc${i}\r\n        for <owner@example.com>; Thu, 29 May 2025 10:00:00 -0700 (PDT)`);
}
const bigHeaderMail = (i: number) => rawMail({ from: "Alice Example <alice@example.com>", to: ACC, subject: `Quarterly figures ${i}`, id: `<q${i}@example.com>`, body: `Hello there, the numbers for quarter ${i} are attached. `.repeat(60), date: OLD, extraHeaders: ["Delivered-To: owner@example.com", ...longHeaders()] });

function fetched(raw: string, peek = PEEK, envelope = true) {
  const bytes = new TextEncoder().encode(raw);
  return {
    uid: 1, flags: new Set<string>(), size: bytes.length, partial: true, source: bytes.slice(0, peek), internalDate: OLD,
    envelope: envelope ? { subject: "Quarterly figures 1", messageId: "<q1@example.com>", date: OLD, from: { address: "alice@example.com", name: "Alice Example" }, to: [{ address: ACC }] } : undefined,
  };
}

describe("R59 partial fetch headers", () => {
  it("the failing shape: headers past the 6 KB cut no longer become unknown@invalid, the envelope wins", async () => {
    const raw = bigHeaderMail(1);
    expect(raw.indexOf("\r\n\r\n")).toBeGreaterThan(PEEK); // the header block really is longer than the peek
    const e = await parsePartial(fetched(raw));
    expect(e.from).toEqual({ address: "alice@example.com", name: "Alice Example" });
    expect(e.subject).toBe("Quarterly figures 1");
    expect(e.date.getTime()).toBe(OLD.getTime());
    expect(e.messageId).toBe("<q1@example.com>");
    expect(e.pending).toBe(false);
  });

  it("without an envelope the row is pending (hidden and retried), never a placeholder with today's date", async () => {
    const e = await parsePartial(fetched(bigHeaderMail(1), PEEK, false));
    expect(e.pending).toBe(true);
    expect(e.from.address).toBe(PENDING_FROM);
    expect(e.date.getTime()).toBe(OLD.getTime()); // the server's received date, not now
  });

  it("parsed headers still count when they are really there and the envelope lacks them", async () => {
    const raw = rawMail({ from: "Bob <bob@example.com>", to: ACC, subject: "Hi", id: "<b@x>", date: OLD });
    const m = { ...fetched(raw), envelope: { messageId: "<b@x>" } };
    const e = await parsePartial(m);
    expect(e.from.address).toBe("bob@example.com");
    expect(e.subject).toBe("Hi");
    expect(e.date.getTime()).toBe(OLD.getTime());
  });

  it("secondPeek asks for more only when the headers outrun the peek or the body barely starts", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const raw = bigHeaderMail(1);
    const all = enc(raw);
    expect(headerEnd(all)).toBe(raw.indexOf("\r\n\r\n") + 4);
    expect(headerEnd(all.slice(0, PEEK))).toBe(-1);
    expect(secondPeek(all.slice(0, PEEK), all.length, PEEK)).toBe(Math.min(all.length, HEAD_PEEK_MAX));
    const small = enc(rawMail({ to: ACC, subject: "s", id: "<s@x>", body: "x".repeat(9000) }));
    expect(secondPeek(small.slice(0, PEEK), small.length, PEEK)).toBe(0); // headers done, plenty of body
    expect(secondPeek(small, small.length, PEEK)).toBe(0); // whole message in hand
    const tight = enc(`X-Pad: ${"p".repeat(PEEK - 1000)}\r\nFrom: a@b.c\r\nSubject: t\r\n\r\n${"y".repeat(9000)}`);
    const end = headerEnd(tight.slice(0, PEEK));
    expect(end).toBeGreaterThan(PEEK - 2048);
    expect(secondPeek(tight.slice(0, PEEK), tight.length, PEEK)).toBe(end + PEEK);
  });

  it("the preview leaves out a style block cut off by the peek", () => {
    expect(makeSnippet("", `<html><head><style>${"a{color:red}".repeat(50)}`)).toBe("");
    expect(makeSnippet("", "<style>p{}</style><p>Hello</p>")).toBe("Hello");
  });
});

async function setup(inbox: number, mk: (i: number) => string, noEnvelope = false) {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "25", MAIL_SYNC_INITIAL_CAP: "5", MAIL_SYNC_BACKFILL_BATCH: "30" });
  const imap = new FakeImapServer().addAccount(ACC, PW);
  imap.noEnvelope = noEnvelope;
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ACC, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Grace Hopper", "Navy");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  for (let i = 0; i < inbox; i++) imap.deliver(ACC, mk(i), { date: i >= inbox - 5 ? new Date() : OLD });
  expect((await c.post("/api/connections", { email: ACC, password: PW })).status).toBe(201);
  const row = (await ctx.db.select().from(mailConnections).get())!;
  return { ctx, imap, row, c };
}
async function drain(ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: string, max = 30) {
  for (let i = 0; i < max; i++) { const r = await syncConnection(ctx.deps, id); if (!r.more) break; }
}

describe("R59 backfill and repair on a mailbox with long headers", () => {
  it("backfilled rows get the real sender, subject, date and a preview", async () => {
    const { ctx, row } = await setup(30, bigHeaderMail);
    await drain(ctx, row.id);
    const rows = await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, row.mailboxId), sql`${messages.sizeBytes} < 0`));
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.fromAddress).toBe("alice@example.com");
      expect(r.subject).toMatch(/^Quarterly figures \d+$/);
      expect(r.date.getTime()).toBe(OLD.getTime());
      expect(r.snippet).toContain("Hello there, the numbers");
    }
  });

  it("rows whose headers could not be read are hidden from lists and counts, then repaired by a later pass", async () => {
    const { ctx, row, imap, c } = await setup(30, bigHeaderMail, true); // no usable sender on the first read
    await drain(ctx, row.id);
    const pending = async () => (await ctx.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(eq(messages.mailboxId, row.mailboxId), eq(messages.fromAddress, PENDING_FROM))).get())!.n;
    const before = await pending();
    expect(before).toBeGreaterThan(20);
    // Hidden: the list never shows the placeholder rows, and the folder count leaves them out.
    const list = (await c.get(`/api/mail/messages?mailboxId=${row.mailboxId}&folder=inbox&limit=100`)).body as { messages: { from: { address: string } }[] };
    expect(list.messages.some((m) => m.from.address === PENDING_FROM)).toBe(false);
    const all = (await ctx.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(eq(messages.mailboxId, row.mailboxId), eq(messages.folder, "inbox"))).get())!.n;
    const ov = (await c.get("/api/mail/overview")).body as { mailboxes: { id: string; folders: Record<string, { total: number }> }[] };
    expect(ov.mailboxes.find((m) => m.id === row.mailboxId)!.folders.inbox.total).toBe(all - before);
    // The sweep stopped once it found nothing it could fix; a later pass with the envelope back starts it again.
    imap.noEnvelope = false;
    const conn = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!;
    const st = parseState(conn.syncState);
    delete st.rp;
    await ctx.db.update(mailConnections).set({ syncState: JSON.stringify(st), nextSyncAt: new Date(0) }).where(eq(mailConnections.id, row.id));
    await drain(ctx, row.id);
    expect(await pending()).toBe(0);
    const fixed = await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, row.mailboxId), sql`${messages.sizeBytes} < 0`));
    for (const r of fixed) { expect(r.fromAddress).toBe("alice@example.com"); expect(r.subject).toMatch(/^Quarterly figures/); expect(r.date.getTime()).toBe(OLD.getTime()); }
    const after = parseState((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!.syncState);
    expect(after.rp).toEqual({ done: true });
    // Cursors and caps untouched by the repair: the backfill is done and its counters stand.
    expect(after.inbox).toMatchObject({ done: true, low: 1 });
    expect(REPAIR_BATCH).toBe(100);
  });

  it("the repair waits while the day's writes are over the backfill stop line", async () => {
    const { ctx, row, imap } = await setup(12, bigHeaderMail, true);
    await drain(ctx, row.id);
    imap.noEnvelope = false;
    const st = parseState((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!.syncState);
    delete st.rp;
    await ctx.db.update(mailConnections).set({ syncState: JSON.stringify(st) }).where(eq(mailConnections.id, row.id));
    const { repairStep } = await import("@/server/services/connect/sync");
    const session = await ctx.deps.imap!({ host: "imap.gmail.com", port: 993, security: "tls" }, { user: ACC, secret: PW }, {});
    const r = await repairStep(ctx.deps, { id: row.id, mailboxId: row.mailboxId }, session, st, { rowsWritten: 60_000, budget: 100_000, level: "warn" });
    expect(r).toMatchObject({ repaired: 0, more: false });
    expect(r.statements.length).toBe(0);
    const ok = await repairStep(ctx.deps, { id: row.id, mailboxId: row.mailboxId }, session, st, { rowsWritten: 10_000, budget: 100_000, level: "ok" });
    expect(ok.repaired).toBeGreaterThan(5);
    await session.close();
  });
});
