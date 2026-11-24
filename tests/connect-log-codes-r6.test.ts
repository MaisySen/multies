/**
 * R6: the live mail window and the sent copy logged a mail server's raw error text, which can name the account (the
 * sync pass already logs only the classified code). These logs now carry the code only.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, users } from "@/server/db/schema";
import { LiveMail } from "@/server/services/connect/live";
import { connectionOutbound } from "@/server/services/connect/outbound";

const GMAIL = "ada.lovelace@gmail.com";
const PW = "abcd efgh ijkl mnop";
const SECRET_WORDS = "AUTHENTICATIONFAILED Invalid credentials for user secret.person@private.example";

async function setup() {
  const ctx = await makeTestApp();
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" });
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.imapWatcher = imap.watcher;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  expect((await c.post("/api/connections", { email: GMAIL, password: PW })).status).toBe(201);
  const conn = (await ctx.db.select().from(mailConnections).get())!;
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const push = (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); };
  ctx.deps.log = { ...ctx.deps.log, warn: push, error: push, info: () => {}, debug: () => {} } as typeof ctx.deps.log;
  return { ctx, conn, lines };
}

describe("R6: connected mail logs carry a code, never the server's words", () => {
  it("a watch that fails and a pass that fails in the live window", async () => {
    const { ctx, conn, lines } = await setup();
    const live = new LiveMail(async () => ctx.deps, {
      lease: async () => true,
      watcher: async () => { throw new Error(SECRET_WORDS); },
      sync: async () => { throw new Error(SECRET_WORDS); },
    });
    await live.touch(conn.id);
    await live.settle();
    await live.stopAll();
    const watch = lines.find((l) => l.event === "mail_live.watch_failed");
    const sync = lines.find((l) => l.event === "mail_live.sync_failed");
    expect(watch?.fields).toMatchObject({ connection: conn.id, code: expect.stringMatching(/^[a-z_]+$/) });
    expect(sync?.fields).toMatchObject({ connection: conn.id, code: expect.stringMatching(/^[a-z_]+$/) });
    expect(JSON.stringify(lines)).not.toMatch(/secret\.person|private\.example|Invalid credentials/);
  });

  it("a sent copy that fails", async () => {
    const { ctx, conn, lines } = await setup();
    const row = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, conn.id)).get())!;
    ctx.deps.imap = (() => { throw new Error(SECRET_WORDS); }) as never;
    const out = connectionOutbound(ctx.deps, { ...row, savesSent: false });
    await out.send({ from: { address: GMAIL }, to: ["bob@example.com"], subject: "Hi", text: "Hi", messageId: "<r6-1@acme.io>" });
    const copy = lines.find((l) => l.event === "mail_connect.sent_copy_failed");
    expect(copy?.fields).toMatchObject({ connection: conn.id });
    expect(copy?.fields.code).toMatch(/^[a-z_]+$/);
    expect(JSON.stringify(lines)).not.toMatch(/secret\.person|private\.example|Invalid credentials/);
  });
});
