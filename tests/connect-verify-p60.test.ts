/**
 * PRIV1b P60 (round 2, owner decision): signing in to a server proves the address only when the server is the address's
 * known provider. With "Other server" (or a known provider's host changed), anyone could point Multies at a server they
 * run and claim someone else's address. Such a connection is saved inactive: nothing syncs or sends until the person
 * enters a code Multies emailed to that address. A connection waiting for its code holds no claim on the address (a new
 * connect replaces it) and is removed after 24 hours. Known providers are unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, mailboxes, messages, users } from "@/server/db/schema";
import { runMaintenance } from "@/server/services/maintenance";
import { PENDING_CONNECTION_MS } from "@/server/services/connect";

const ME = "me@example.org";
const PW = "custom-app-pass";
const GMAIL = "ada.lovelace@gmail.com";
const GPW = "abcd efgh ijkl mnop";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let imap: FakeImapServer;

async function signup(email: string) {
  const cl = new Client(ctx.app);
  await cl.signup(email, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return cl;
}
const codeMail = () => [...ctx.outbound.sent].reverse().find((m) => m.to.includes(ME) && /code/i.test(m.subject));
const codeIn = (text: string) => text.match(/\b(\d{6})\b/)?.[1] ?? "";

beforeEach(async () => {
  ctx = await makeTestApp({ MAIL_SYNC_BATCH: "5", MAIL_SYNC_INITIAL_CAP: "8" });
  imap = new FakeImapServer().addAccount(ME, PW).addAccount(GMAIL, GPW);
  imap.deliver(ME, rawMail({ subject: "PRIVATE-AT-SERVER", from: "x@example.com", to: ME, id: "<p60@example.com>" }));
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  smtp.accounts.set(GMAIL, GPW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  c = await signup("ada@acme.io");
});

describe("PRIV1b P60: an unrecognised server needs a code sent to the address", () => {
  it("saves it waiting, syncs nothing, emails a code; the right code turns it on, a wrong one doesn't", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    expect(made.status).toBe(201);
    expect(made.body.connection).toMatchObject({ status: "verifying", email: ME });
    const row = (await ctx.db.select().from(mailConnections).get())!;
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get())?.status).toBe("suspended");
    expect(await ctx.db.select().from(messages).where(eq(messages.mailboxId, row.mailboxId)).all()).toEqual([]);
    const mail = codeMail();
    expect(mail).toBeTruthy();
    const code = codeIn(mail!.text ?? "");
    expect(code).toMatch(/^\d{6}$/);
    // Sending from it is refused while it waits.
    expect((await c.post("/api/mail/send", { mailboxId: row.mailboxId, to: ["x@example.com"], subject: "Hi", text: "Hi" })).status).toBeGreaterThanOrEqual(400);

    const wrong = await c.post(`/api/connections/${row.id}/verify`, { code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    const ok = await c.post(`/api/connections/${row.id}/verify`, { code });
    expect(ok.status).toBe(200);
    expect(ok.body.connection.status).toBe("active");
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get())?.status).toBe("active");
    // Used once.
    expect((await c.post(`/api/connections/${row.id}/verify`, { code })).status).toBe(409);
  });

  it("someone else can't enter the code; a new code waits a minute", async () => {
    const made = await c.post("/api/connections", CUSTOM);
    const id = made.body.connection.id as string;
    expect((await c.post(`/api/connections/${id}/verify/resend`, {})).status).toBe(429);
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 61_000);
    try { expect((await c.post(`/api/connections/${id}/verify/resend`, {})).status).toBe(200); } finally { ctx.deps.now = real; }
    const other = await signup("eve@evil.io");
    expect((await other.post(`/api/connections/${id}/verify`, { code: codeIn(codeMail()!.text ?? "") })).status).toBe(404);
  });

  it("a known provider at its own servers is connected at once, with no code", async () => {
    const made = await c.post("/api/connections", { email: GMAIL, password: GPW });
    expect(made.status).toBe(201);
    expect(made.body.connection.status).toBe("active");
    expect(ctx.outbound.sent.some((m) => /code/i.test(m.subject))).toBe(false);
  });

  it("a known provider with its servers changed needs the code too", async () => {
    const made = await c.post("/api/connections", { email: GMAIL, password: GPW, preset: "gmail", imap: { host: "imap.attacker-mail.com", port: 993, security: "tls" }, smtp: { host: "smtp.attacker-mail.com", port: 465, security: "tls" } });
    expect(made.status).toBe(201);
    expect(made.body.connection.status).toBe("verifying");
  });

  it("a waiting connection holds no claim: another workspace's connect replaces it; after 24 hours it is removed", async () => {
    expect(PENDING_CONNECTION_MS).toBe(24 * 3_600_000);
    await c.post("/api/connections", CUSTOM);
    const owner = await signup("me.real@example.net");
    const theirs = await owner.post("/api/connections", CUSTOM);
    expect(theirs.status).toBe(201);
    const rows = await ctx.db.select().from(mailConnections).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(theirs.body.connection.id);

    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + PENDING_CONNECTION_MS + 60_000);
    try { await runMaintenance(ctx.deps); } finally { ctx.deps.now = real; }
    expect(await ctx.db.select().from(mailConnections).all()).toEqual([]);
    expect(await ctx.db.select().from(mailboxes).where(eq(mailboxes.address, ME)).all()).toEqual([]);
  });
});
