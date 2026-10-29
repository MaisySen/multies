import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, messages, users } from "@/server/db/schema";
import { backfillAllowance, loadBody, parseState, setBackfillPaused, syncConnection } from "@/server/services/connect/sync";
import { backfillProgress } from "@/server/services/connect/backfill-progress";

/**
 * R57: full history backfill. After new mail, each pass walks older UIDs downward (Inbox and Sent first), stores them
 * header and snippet only (one row each, no attachment rows), and the body comes from the provider when first opened.
 */
const ACC = "grace.hopper@gmail.com";
const PW = "abcd efgh ijkl mnop";
const OLD = new Date(Date.UTC(2024, 0, 1));

async function setup(env: Record<string, string> = {}, inbox = 60, sent = 20) {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "25", MAIL_SYNC_INITIAL_CAP: "10", MAIL_SYNC_BACKFILL_BATCH: "30", ...env });
  const imap = new FakeImapServer().addAccount(ACC, PW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ACC, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Grace Hopper", "Navy");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  for (let i = 0; i < inbox; i++) imap.deliver(ACC, rawMail({ to: ACC, subject: `In ${i}`, id: `<in${i}@x>`, body: `Body of inbox mail ${i}. `.repeat(400), date: OLD }), { date: i >= inbox - 10 ? new Date() : OLD });
  for (let i = 0; i < sent; i++) imap.deliver(ACC, rawMail({ to: "x@y.z", subject: `Out ${i}`, id: `<out${i}@x>`, date: OLD }), { folder: "Sent", date: OLD });
  expect((await c.post("/api/connections", { email: ACC, password: PW })).status).toBe(201);
  const row = (await ctx.db.select().from(mailConnections).get())!;
  const count = async () => (await ctx.db.select({ n: sql<number>`count(*)` }).from(messages).where(eq(messages.mailboxId, row.mailboxId)).get())!.n;
  return { ctx, imap, row, c, count };
}

async function drain(ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: string, max = 30) {
  const results = [];
  for (let i = 0; i < max; i++) { const r = await syncConnection(ctx.deps, id); results.push(r); if (!r.more) break; }
  return results;
}

describe("R57 full mailbox sync", () => {
  it("walks older mail downward through chained passes, Inbox first, until every folder is done", async () => {
    const { ctx, row, count, imap } = await setup();
    const results = await drain(ctx, row.id);
    expect(await count()).toBe(80); // 60 inbox + 20 sent, no duplicates
    const state = parseState((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!.syncState);
    expect(state.inbox).toMatchObject({ low: 1, done: true, left: 0 });
    expect(state.sent).toMatchObject({ done: true });
    expect(results.some((r) => (r.backfilled ?? 0) > 0)).toBe(true);
    expect(results.at(-1)!.more).toBe(false);
    expect(imap.headFetches).toBeGreaterThan(0);
    // Inbox's oldest message came in before Sent's started (Inbox and Sent first, Inbox before Sent).
    const p = backfillProgress(state, (await ctx.db.select().from(mailConnections).get())!.messagesSynced);
    expect(p).toMatchObject({ done: true, counted: true, total: p.synced });
  });

  it("backfilled mail is one row, header and snippet, and its body loads when opened", async () => {
    const { ctx, row, c } = await setup({}, 30, 0);
    await drain(ctx, row.id);
    const old = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, row.mailboxId), eq(messages.subject, "In 0"))).get())!;
    expect(old.sizeBytes).toBeLessThan(0);
    expect(old.text).toBe("");
    expect(old.snippet).toContain("Body of inbox mail 0");
    const res = await c.get(`/api/mail/messages/${old.id}`);
    expect(res.status).toBe(200);
    const body = res.body as { message: { text: string; bodyPending?: boolean } };
    expect(body.message.bodyPending).toBeUndefined();
    expect(body.message.text.length).toBeGreaterThan(5000);
    const after = (await ctx.db.select().from(messages).where(eq(messages.id, old.id)).get())!;
    expect(after.sizeBytes).toBeGreaterThan(0);
    expect(await loadBody(ctx.deps, old.id)).toBe(true); // already loaded: nothing to do
  });

  it("is restart safe: a pass that fails before it commits leaves the cursor, and nothing is stored twice", async () => {
    const { ctx, row, count, imap } = await setup({}, 50, 0);
    await syncConnection(ctx.deps, row.id);
    const before = await count();
    imap.unreachable = true;
    const failed = await syncConnection(ctx.deps, row.id);
    expect(failed.error).toBeTruthy();
    imap.unreachable = false;
    await ctx.db.update(mailConnections).set({ status: "active" }).where(eq(mailConnections.id, row.id));
    await drain(ctx, row.id);
    expect(before).toBeGreaterThan(0);
    expect(await count()).toBe(50);
  });

  it("dedupes by Message-ID across a UIDVALIDITY change (the folder starts again, mail is not doubled)", async () => {
    const { ctx, row, count, imap } = await setup({}, 40, 0);
    await drain(ctx, row.id);
    expect(await count()).toBe(40);
    imap.folder(ACC, "INBOX").uidValidity = "9999";
    await drain(ctx, row.id);
    expect(await count()).toBe(40);
    const state = parseState((await ctx.db.select().from(mailConnections).get())!.syncState);
    expect(state.inbox).toMatchObject({ v: "9999", done: true });
  });

  it("stops at the per connection daily cap and says why; the next UTC day resumes", async () => {
    const { ctx, row, count } = await setup({ MAIL_SYNC_BACKFILL_DAILY_CAP: "20" }, 60, 0);
    const results = await drain(ctx, row.id);
    expect(await count()).toBe(10 + 20); // the recent 10, then 20 older
    expect(results.at(-1)!.more).toBe(false);
    const st = parseState((await ctx.db.select().from(mailConnections).get())!.syncState);
    expect(st.bf).toMatchObject({ n: 20, wait: "daily" });
    // A new UTC day: the count starts again.
    const realNow = ctx.deps.now;
    ctx.deps.now = () => new Date(realNow().getTime() + 86_400_000);
    await drain(ctx, row.id);
    expect(await count()).toBe(50);
  });

  it("sheds backfill (never new mail) once the account's D1 writes pass the stop level", async () => {
    const { ctx } = await setup({}, 0, 0);
    const state = { inbox: { path: "INBOX", v: "1", last: 1 } };
    const day = "2026-10-29";
    expect((await backfillAllowance(ctx.deps, state, { rowsWritten: 10_000, budget: 100_000, level: "ok" }, day)).n).toBe(30);
    expect(await backfillAllowance(ctx.deps, state, { rowsWritten: 51_000, budget: 100_000, level: "ok" }, day)).toEqual({ n: 0, wait: "budget" });
    expect((await backfillAllowance(ctx.deps, state, { rowsWritten: 0, budget: 100_000, level: "off" }, day)).n).toBe(30);
  });

  it("respects the account wide daily share across connections", async () => {
    const { ctx, row } = await setup({ MAIL_SYNC_BACKFILL_GLOBAL_DAILY: "25" }, 0, 0);
    const day = ctx.deps.now().toISOString().slice(0, 10);
    await ctx.db.update(mailConnections).set({ syncState: JSON.stringify({ bf: { day, n: 25 } }) }).where(eq(mailConnections.id, row.id));
    expect(await backfillAllowance(ctx.deps, {}, { rowsWritten: 0, budget: 100_000, level: "ok" }, day)).toEqual({ n: 0, wait: "daily" });
  });

  it("pause holds older mail but new mail still comes in; resume carries on", async () => {
    const { ctx, row, count, imap } = await setup({}, 60, 0);
    await setBackfillPaused(ctx.deps, row.id, true);
    const paused = await count(); // the first pass at connect: 10 recent and the first 30 older
    await drain(ctx, row.id);
    expect(await count()).toBe(paused);
    imap.deliver(ACC, rawMail({ to: ACC, subject: "Brand new", id: "<new1@x>" }));
    await drain(ctx, row.id);
    expect(await count()).toBe(paused + 1);
    await setBackfillPaused(ctx.deps, row.id, false);
    await drain(ctx, row.id);
    expect(await count()).toBe(61);
  });

  it("a connection synced before R57 starts below its oldest stored copy", async () => {
    const { ctx, row, count } = await setup({ MAIL_SYNC_BACKFILL: "off" }, 40, 0);
    await drain(ctx, row.id);
    expect(await count()).toBe(10);
    // Strip the R57 cursor as an older release would have left it.
    const st = parseState((await ctx.db.select().from(mailConnections).get())!.syncState);
    delete st.inbox!.low; delete st.inbox!.done; delete st.inbox!.left;
    await ctx.db.update(mailConnections).set({ syncState: JSON.stringify(st) }).where(eq(mailConnections.id, row.id));
    ctx.deps.config.mailConnect.backfill.enabled = true;
    await drain(ctx, row.id);
    expect(await count()).toBe(40);
  });

  it("progress: the total is the provider's count; Gmail's All Mail holds Inbox and Sent, so it is not counted twice", () => {
    const plain = { paths: { inbox: "INBOX", sent: "Sent" }, inbox: { path: "INBOX", v: "1", last: 9, size: 900, left: 700 }, sent: { path: "Sent", v: "2", last: 9, size: 100, left: 80 } };
    expect(backfillProgress(plain, 220)).toMatchObject({ done: false, counted: true, synced: 220, total: 1000 });
    const gmail = {
      paths: { inbox: "INBOX", sent: "[Gmail]/Sent Mail", archive: "[Gmail]/All Mail" },
      list: [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
      inbox: { path: "INBOX", v: "1", last: 9, size: 900 }, sent: { path: "[Gmail]/Sent Mail", v: "2", last: 9, size: 100 },
      boxes: { archive: { path: "[Gmail]/All Mail", v: "3", last: 9, size: 5000 } },
    };
    expect(backfillProgress(gmail, 300)).toMatchObject({ counted: true, total: 5000 });
    expect(backfillProgress({ ...plain, inbox: { ...plain.inbox, done: true }, sent: { ...plain.sent, done: true } }, 990)).toMatchObject({ done: true, total: 990 });
    expect(backfillProgress({ ...plain, bf: { day: "x", n: 1, paused: true } } as never, 220)).toMatchObject({ paused: true });
  });

  it("older mail does not use up the new mail cap: a backfill past it keeps chaining to the end", async () => {
    const { ctx, row, count } = await setup({ MAIL_SYNC_DAILY_CAP: "20" }, 90, 0);
    const results = await drain(ctx, row.id, 40);
    expect(results.every((r) => r.skipped === undefined)).toBe(true);
    expect(await count()).toBe(90);
    // New mail still has its own cap of 20 a day, older mail aside.
    const c = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, row.id)).get())!;
    expect(c.messagesToday).toBe(90);
  });
});
