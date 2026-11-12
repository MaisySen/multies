/**
 * PRIV1b rule-lifecycle review (S1): a sync pass already running when the owner leaves doesn't set the paused
 * connection going again, at the end of the pass or on an error.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, users } from "@/server/db/schema";
import { syncConnection } from "@/server/services/connect/sync";

const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";

async function setup() {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "5", MAIL_SYNC_INITIAL_CAP: "8" });
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" });
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  expect((await c.post("/api/connections", { email: GMAIL, password: PW })).status).toBe(201);
  const row = (await ctx.db.select().from(mailConnections).get())!;
  // The owner leaves while the pass is signing in (endPersonalMail pauses the connection).
  const pauseDuring = (fail: boolean) => {
    ctx.deps.imap = (async (...args: Parameters<typeof imap.connector>) => {
      await ctx.db.update(mailConnections).set({ status: "paused" }).where(eq(mailConnections.id, row.id));
      if (fail) throw new Error("connect ECONNREFUSED");
      return imap.connector(...args);
    }) as typeof imap.connector;
  };
  const st = async () => (await ctx.db.select({ s: mailConnections.status }).from(mailConnections).where(eq(mailConnections.id, row.id)).get())!.s;
  return { ctx, row, pauseDuring, st, imap };
}

describe("PRIV1b (P9, review S1) a running sync keeps a paused connection paused", () => {
  it("the end of the pass leaves it paused; a pass on an active connection still sets active", async () => {
    const { ctx, row, pauseDuring, st, imap } = await setup();
    await ctx.db.update(mailConnections).set({ status: "error" }).where(eq(mailConnections.id, row.id));
    expect((await syncConnection(ctx.deps, row.id, { force: true })).error).toBeUndefined();
    expect(await st()).toBe("active");
    pauseDuring(false);
    await syncConnection(ctx.deps, row.id, { force: true });
    expect(await st()).toBe("paused");
    // And the next run skips it.
    ctx.deps.imap = imap.connector;
    expect((await syncConnection(ctx.deps, row.id, { force: true })).skipped).toBe("paused");
  }, 60_000);

  it("a sign in error during the pass leaves it paused, not error (which the scheduler would run)", async () => {
    const { ctx, row, pauseDuring, st } = await setup();
    pauseDuring(true);
    const r = await syncConnection(ctx.deps, row.id, { force: true });
    expect(r.error).toBeTruthy();
    expect(await st()).toBe("paused");
  }, 60_000);
});
