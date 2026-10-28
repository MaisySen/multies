import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, messages, users } from "@/server/db/schema";
import { folderFingerprint, syncConnection } from "@/server/services/connect/sync";
import type { ImapConnector, ImapSession } from "@/server/services/connect/imap";

/**
 * R52: a sync pass reads the flags of a folder only when the folder changed since its last full read. With CONDSTORE
 * (RFC 7162) the server's HIGHESTMODSEQ moves on every flag change; with the message count and the next UID it also
 * catches mail that was removed or added. A server without mod-sequences is read every pass, as before.
 */
const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";

async function setup(condstore: boolean) {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "5", MAIL_SYNC_INITIAL_CAP: "8" });
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" });
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  let modseq = 100;
  const calls = { flags: 0 };
  const base = imap.connector;
  const wrapped: ImapConnector = async (...a) => {
    const s = await base(...a);
    const out: ImapSession = Object.create(s);
    out.open = async (path, opts) => {
      const r = await s.open(path, opts);
      const f = imap.folder(GMAIL, path);
      return condstore ? { ...r, exists: f.msgs.length, modseq: String(modseq) } : r;
    };
    out.flags = async (lo, hi) => { calls.flags++; return s.flags(lo, hi); };
    return out;
  };
  ctx.deps.imap = wrapped;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  const uid = imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Read me", id: "<rm@x>" }));
  imap.deliver(GMAIL, rawMail({ to: GMAIL, subject: "Leave me", id: "<lm@x>" }));
  expect((await c.post("/api/connections", { email: GMAIL, password: PW })).status).toBe(201);
  const row = (await ctx.db.select().from(mailConnections).get())!;
  return { ctx, imap, row, uid, calls, bump: () => { modseq++; } };
}

describe("R52 mail sync: unchanged folders are not read for flags", () => {
  it("fingerprints only with a mod-sequence", () => {
    expect(folderFingerprint({ uidNext: 5, exists: 4, modseq: "77" }, 4)).toBe("77:4:5:4");
    expect(folderFingerprint({ uidNext: 5, exists: 4 }, 4)).toBeUndefined();
  });

  it("with CONDSTORE: reads once, skips while nothing changes, reads again after a flag change at the provider", async () => {
    const { ctx, imap, row, uid, calls, bump } = await setup(true);
    await syncConnection(ctx.deps, row.id); // first full read of every folder's flags
    const afterFirst = calls.flags;
    expect(afterFirst).toBeGreaterThan(0);
    const r2 = await syncConnection(ctx.deps, row.id);
    expect(r2.error).toBeUndefined();
    expect(calls.flags).toBe(afterFirst); // nothing changed: no FETCH FLAGS at all
    imap.folder(GMAIL, "INBOX").msgs.find((m) => m.uid === uid)!.flags = new Set(["\\Seen", "\\Flagged"]);
    bump(); // the server moves its mod-sequence on any flag change
    const r3 = await syncConnection(ctx.deps, row.id);
    expect(calls.flags).toBeGreaterThan(afterFirst);
    expect(r3.flagsUpdated).toBe(1);
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Read me")).get())).toMatchObject({ isRead: true, isStarred: true });
  });

  it("with CONDSTORE: mail removed at the provider changes the count, so the folder is read and the mail let go", async () => {
    const { ctx, imap, row, calls } = await setup(true);
    await syncConnection(ctx.deps, row.id);
    const before = calls.flags;
    const inbox = imap.folder(GMAIL, "INBOX");
    inbox.msgs = inbox.msgs.filter((m) => !m.raw.includes("Leave me")); // expunged at the provider, same modseq
    await syncConnection(ctx.deps, row.id);
    expect(calls.flags).toBeGreaterThan(before);
    expect((await ctx.db.select().from(messages).where(eq(messages.subject, "Leave me")).get())).toMatchObject({ folder: "archive", remoteUid: null });
  });

  it("without CONDSTORE: every pass reads flags, as before", async () => {
    const { ctx, row, calls } = await setup(false);
    await syncConnection(ctx.deps, row.id);
    const a = calls.flags;
    await syncConnection(ctx.deps, row.id);
    expect(calls.flags).toBeGreaterThan(a);
  });
});
