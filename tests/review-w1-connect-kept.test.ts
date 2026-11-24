/**
 * Wave 1 review V4: dropping a connection that never got its emailed code (P60) deleted its mailbox, even when that
 * mailbox was a copy kept for a legal hold that the connection had taken over, with all its mail; and a connect of
 * the same address from any workspace triggered it. Now a waiting connection remembers whether it made its mailbox;
 * only such a mailbox is deleted with it. A kept copy stays (suspended), another workspace can't replace it, and the
 * 24 hour prune leaves it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, mailboxes, messages, users } from "@/server/db/schema";
import { runMaintenance } from "@/server/services/maintenance";
import { PENDING_CONNECTION_MS } from "@/server/services/connect";

const ME = "me@example.org";
const PW = "custom-app-pass";
const CUSTOM = { email: ME, password: PW, preset: "custom", imap: { host: "mail.example.org", port: 993, security: "tls" }, smtp: { host: "mail.example.org", port: 465, security: "tls" } };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
async function signup(email: string) {
  const cl = new Client(ctx.app);
  await cl.signup(email, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return cl;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  const imap = new FakeImapServer().addAccount(ME, PW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  c = await signup("ada@acme.io");
});

/** A copy kept after its connection was removed (as a legal hold keeps it), with one message in it. */
async function keptCopy() {
  const made = await c.post("/api/connections", CUSTOM);
  const id = made.body.connection.id as string;
  const mailboxId = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!.mailboxId;
  await ctx.db.delete(mailConnections).where(eq(mailConnections.id, id));
  await ctx.db.update(mailboxes).set({ status: "suspended" }).where(eq(mailboxes.id, mailboxId));
  const orgId = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!.orgId;
  await ctx.db.insert(messages).values({ id: "msg_keptcopy0000000001", orgId, mailboxId, folder: "inbox", threadId: "thr_keptcopy000000001", fromAddress: "x@example.com", fromName: "X",
    to: JSON.stringify([{ name: "", address: ME }]), subject: "HELD-MAIL", text: "kept", snippet: "kept", date: new Date(), isRead: false });
  return mailboxId;
}
const held = async (mailboxId: string) => ({
  box: (await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get()) ?? null,
  mail: (await ctx.db.select().from(messages).where(eq(messages.mailboxId, mailboxId)).all()).length,
});

describe("Wave 1 review V4: a waiting connection never deletes a kept copy", () => {
  it("another workspace can't replace it, and the 24 hour prune leaves the kept copy and its mail", async () => {
    const kept = await keptCopy();
    // Its owner connects again through an unrecognised server: the connection waits, on the kept copy.
    const again = await c.post("/api/connections", CUSTOM);
    expect(again.status).toBe(201);
    expect(again.body.connection.status).toBe("verifying");
    expect(again.body.connection.mailboxId ?? (await ctx.db.select().from(mailConnections).get())!.mailboxId).toBe(kept);
    // Someone in another workspace connects the same address: refused, nothing removed.
    const other = await signup("eve@evil.io");
    expect((await other.post("/api/connections", CUSTOM)).status).toBe(409);
    expect(await held(kept)).toMatchObject({ mail: 1 });
    // A day later the prune removes the waiting connection but keeps the copy, suspended.
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + PENDING_CONNECTION_MS + 60_000);
    try { await runMaintenance(ctx.deps); } finally { ctx.deps.now = real; }
    expect(await ctx.db.select().from(mailConnections).all()).toEqual([]);
    const after = await held(kept);
    expect(after.box?.status).toBe("suspended");
    expect(after.mail).toBe(1);
  });

  it("the owner connecting again takes the kept copy back, without deleting it", async () => {
    const kept = await keptCopy();
    expect((await c.post("/api/connections", CUSTOM)).status).toBe(201);
    const second = await c.post("/api/connections", CUSTOM);
    expect(second.status).toBe(201);
    const rows = await ctx.db.select().from(mailConnections).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].mailboxId).toBe(kept);
    expect((await held(kept)).mail).toBe(1);
  });
});
