import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, messages, users } from "@/server/db/schema";
import { parseFingerprint, removedSince, syncConnection } from "@/server/services/connect/sync";
import type { ImapConnector, ImapSession } from "@/server/services/connect/imap";

/**
 * R53: two mail sync costs measured on the production Gmail connection.
 * 1. Gmail keeps ONE mod-sequence for the whole account, so the R52 "folder unchanged" skip almost never applies: any
 *    new mail or flag change anywhere moves every folder's modseq, and each pass read the flags of up to 200 messages
 *    per folder plus the same rows from the database. Now, when nothing left a folder, the pass asks only for the
 *    messages changed since the stored modseq (CHANGEDSINCE) and reads only those rows.
 * 2. Gmail shows a new message in Inbox AND All Mail: the body was downloaded and parsed twice, then the second copy
 *    was dropped as a duplicate. Now the second copy (and any message already stored) keeps its header only.
 */
const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";

async function setup() {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "25", MAIL_SYNC_INITIAL_CAP: "40" });
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" });
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  // Gmail: one account wide mod-sequence; each flag change records the modseq it happened at.
  let modseq = 100;
  const changedAt = new Map<string, number>(); // "<path>:<uid>" -> modseq of its last flag change
  const calls = { flags: 0, flagRows: 0, incremental: 0, bodies: 0 };
  const base = imap.connector;
  const wrapped: ImapConnector = async (...a) => {
    const s = await base(...a);
    const out: ImapSession = Object.create(s);
    let current = "";
    out.open = async (path, opts) => {
      current = path;
      const r = await s.open(path, opts);
      return { ...r, exists: imap.folder(GMAIL, path).msgs.length, modseq: String(modseq) };
    };
    out.flags = async (lo, hi, opts) => {
      calls.flags++;
      const all = await s.flags(lo, hi);
      if (opts?.changedSince) {
        calls.incremental++;
        const since = Number(opts.changedSince);
        for (const uid of [...all.keys()]) if ((changedAt.get(`${current}:${uid}`) ?? 0) <= since) all.delete(uid);
      }
      calls.flagRows += all.size;
      return all;
    };
    out.fetch = async (uids, max, need) => {
      const heads = await s.fetch(uids, max);
      const want = need ? await need(heads) : undefined;
      for (const h of heads) { if (want && !want.has(h.uid)) delete h.source; else if (h.source) calls.bodies++; }
      return heads;
    };
    return out;
  };
  ctx.deps.imap = wrapped;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  const uids: number[] = [];
  for (let i = 0; i < 30; i++) uids.push(imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: `Mail ${i}`, id: `<m${i}@x>` })));
  expect((await c.post("/api/connections", { email: GMAIL, password: PW })).status).toBe(201);
  const row = (await ctx.db.select().from(mailConnections).get())!;
  const setFlags = (path: string, uid: number, flags: string[]) => {
    modseq++;
    imap.folder(GMAIL, path).msgs.find((m) => m.uid === uid)!.flags = new Set(flags);
    changedAt.set(`${path}:${uid}`, modseq);
  };
  return { ctx, imap, row, uids, calls, setFlags, bump: () => { modseq++; } };
}

describe("R53 mail sync: Gmail's account wide modseq and its double copies", () => {
  it("parses fingerprints and counts what left a folder", () => {
    expect(parseFingerprint("137772:1382:1438:1437")).toEqual({ modseq: "137772", exists: 1382, uidNext: 1438, last: 1437 });
    expect(parseFingerprint("77::5:4")).toBeUndefined();
    expect(parseFingerprint(undefined)).toBeUndefined();
    expect(removedSince({ exists: 10, uidNext: 11 }, { exists: 12, uidNext: 13 })).toBe(0); // 2 arrived, none left
    expect(removedSince({ exists: 10, uidNext: 11 }, { exists: 11, uidNext: 13 })).toBe(1); // 2 arrived, 1 left
    expect(removedSince({ exists: 10, uidNext: 11 }, { exists: 9, uidNext: 11 })).toBe(1);
    expect(removedSince({ exists: 10, uidNext: 11 }, { uidNext: 11 })).toBeUndefined();
  });

  it("modseq moved but nothing changed in the folder: no flag rows come back and nothing is written", async () => {
    const { ctx, row, calls, bump } = await setup();
    await syncConnection(ctx.deps, row.id);
    await syncConnection(ctx.deps, row.id); // first full flag read now that every folder has a cursor
    const rowsAfterFull = calls.flagRows;
    expect(rowsAfterFull).toBeGreaterThanOrEqual(30);
    bump(); // a change somewhere else in the account (Gmail: every folder's modseq moves)
    const r = await syncConnection(ctx.deps, row.id);
    expect(r.error).toBeUndefined();
    expect(calls.incremental).toBeGreaterThan(0);
    expect(calls.flagRows).toBe(rowsAfterFull); // CHANGEDSINCE answered nothing: 0 rows instead of the 30 message window
    expect(r.flagsUpdated).toBe(0);
  });

  it("a flag change at the provider still lands, from a one row answer", async () => {
    const { ctx, row, uids, calls, setFlags } = await setup();
    await syncConnection(ctx.deps, row.id);
    await syncConnection(ctx.deps, row.id);
    const before = calls.flagRows;
    setFlags("INBOX", uids[3], ["\\Seen", "\\Flagged"]);
    const r = await syncConnection(ctx.deps, row.id);
    expect(calls.flagRows - before).toBe(1);
    expect(r.flagsUpdated).toBe(1);
    expect(await ctx.db.select().from(messages).where(eq(messages.subject, "Mail 3")).get()).toMatchObject({ isRead: true, isStarred: true });
    // and nothing else changed
    expect((await ctx.db.select().from(messages).where(eq(messages.isStarred, true)).all()).length).toBe(1);
  });

  it("mail removed at the provider falls back to the full read and is let go", async () => {
    const { ctx, imap, row, calls, bump } = await setup();
    await syncConnection(ctx.deps, row.id);
    await syncConnection(ctx.deps, row.id);
    const inc = calls.incremental;
    const inbox = imap.folder(GMAIL, "INBOX");
    inbox.msgs = inbox.msgs.filter((m) => !m.raw.includes("Mail 5\r") && !m.raw.includes("Mail 5\n"));
    bump();
    await syncConnection(ctx.deps, row.id);
    expect(await ctx.db.select().from(messages).where(eq(messages.subject, "Mail 5")).get()).toMatchObject({ folder: "archive", remoteUid: null });
    expect(calls.incremental).toBeGreaterThanOrEqual(inc); // other folders may still go incremental; Inbox read in full
  });

  it("the same new message in Inbox and All Mail is downloaded once and stored once", async () => {
    const { ctx, imap, row, calls } = await setup();
    await syncConnection(ctx.deps, row.id);
    const bodies = calls.bodies;
    const raw = rawMail({ to: GMAIL, subject: "Twice", id: "<twice@x>" });
    imap.deliver(GMAIL, raw);
    imap.deliver(GMAIL, raw, { folder: "Archive" }); // Gmail's All Mail holds every message
    const r = await syncConnection(ctx.deps, row.id);
    expect(r.error).toBeUndefined();
    expect(calls.bodies - bodies).toBe(1);
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Twice")).all()).length).toBe(1);
    expect(r.stored).toBe(1);
    expect(r.duplicates).toBeGreaterThanOrEqual(1);
  });

  it("a message already stored that shows up in another folder is not downloaded again, and is tied to it when it left its old one", async () => {
    const { ctx, imap, row, calls } = await setup();
    await syncConnection(ctx.deps, row.id);
    await syncConnection(ctx.deps, row.id);
    // archived at the provider: leaves the Inbox, appears in Archive with a new UID
    imap.moveAt(GMAIL, "INBOX", "Mail 7", "Archive");
    const bodies = calls.bodies;
    await syncConnection(ctx.deps, row.id);
    expect(calls.bodies).toBe(bodies);
    const m = await ctx.db.select().from(messages).where(eq(messages.subject, "Mail 7")).get();
    expect(m).toMatchObject({ folder: "archive", remoteBox: "archive" });
    expect(m!.remoteUid).not.toBeNull();
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Mail 7")).all()).length).toBe(1);
  });
});
