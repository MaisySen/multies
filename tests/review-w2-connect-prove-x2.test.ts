/**
 * Wave 2 review X2: signing in proves an address only when the provider is the address's own AND the sign in name is
 * that address. Before, serversProveAddress ignored the username, so connecting ceo@victim.com with the Gmail preset and
 * the username attacker@gmail.com (the attacker's own Gmail password) connected at once, with no code, and held the
 * address. Now that connection waits for a code emailed to ceo@victim.com; so does a Reconnect that changes the
 * username to one that doesn't prove the address.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, mailboxes, users } from "@/server/db/schema";
import { serversProveAddress } from "@/server/services/connect";
import { serversFor } from "@/shared/mail-connect";

const VICTIM = "ceo@victim.com";
const ATTACKER = "attacker@gmail.com";
const APW = "abcd efgh ijkl mnop";
const GMAIL = "ada.lovelace@gmail.com";
const GPW = "qrst uvwx yzab cdef";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

async function signup(email: string) {
  const cl = new Client(ctx.app);
  await cl.signup(email, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return cl;
}
const codeTo = (to: string) => ctx.outbound.sent.some((m) => m.to.includes(to) && /code/i.test(m.subject));

beforeEach(async () => {
  ctx = await makeTestApp({});
  const imap = new FakeImapServer().addAccount(ATTACKER, APW).addAccount(GMAIL, GPW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ATTACKER, APW);
  smtp.accounts.set(GMAIL, GPW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  c = await signup("ada@acme.io");
});

const own = (preset: "gmail" | "icloud" | "google_workspace" | "microsoft365" | "outlook", email: string, username: string) => {
  const s = serversFor(preset, email);
  return { preset, email, username, imap: { ...s.imap, host: s.imap.host.toLowerCase() }, smtp: { ...s.smtp, host: s.smtp.host.toLowerCase() } };
};

describe("X2: the sign in name has to be the address", () => {
  it("serversProveAddress needs the address's own provider and the address as the username", () => {
    expect(serversProveAddress(own("gmail", GMAIL, GMAIL))).toBe(true);
    expect(serversProveAddress(own("gmail", GMAIL, "ADA.LOVELACE@GMAIL.COM"))).toBe(true);
    expect(serversProveAddress(own("gmail", VICTIM, ATTACKER))).toBe(false);
    expect(serversProveAddress(own("gmail", GMAIL, ATTACKER))).toBe(false);
    // A Gmail preset for an Outlook address: not the address's own provider.
    expect(serversProveAddress(own("gmail", "ada@outlook.com", "ada@outlook.com"))).toBe(false);
    // iCloud documents the address's name alone as the user name for @icloud.com, @me.com and @mac.com.
    expect(serversProveAddress(own("icloud", "ada@icloud.com", "ada"))).toBe(true);
    expect(serversProveAddress(own("icloud", "ada@icloud.com", "eve"))).toBe(false);
    // Google Workspace and Microsoft 365 sign in a company address only once its domain is verified with them, so the
    // address itself as the user name proves it there; anyone else's name does not.
    expect(serversProveAddress(own("google_workspace", VICTIM, VICTIM))).toBe(true);
    expect(serversProveAddress(own("google_workspace", VICTIM, ATTACKER))).toBe(false);
    expect(serversProveAddress(own("microsoft365", VICTIM, VICTIM))).toBe(true);
    expect(serversProveAddress(own("microsoft365", VICTIM, "eve@victim.com"))).toBe(false);
    // The consumer presets don't cover a company domain.
    expect(serversProveAddress(own("gmail", VICTIM, VICTIM))).toBe(false);
    expect(serversProveAddress(own("outlook", VICTIM, VICTIM))).toBe(false);
  });

  it("a Gmail preset with someone else's username waits for a code sent to the address", async () => {
    const made = await c.post("/api/connections", { email: VICTIM, password: APW, preset: "gmail", username: ATTACKER });
    expect(made.status).toBe(201);
    expect(made.body.connection.status).toBe("verifying");
    const row = (await ctx.db.select().from(mailConnections).get())!;
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get())?.status).toBe("suspended");
    expect(codeTo(VICTIM)).toBe(true);
    // Gmail's own address with its own username still connects at once.
    const ok = await c.post("/api/connections", { email: GMAIL, password: GPW });
    expect(ok.status).toBe(201);
    expect(ok.body.connection.status).toBe("active");
  });

  it("Reconnect that changes the username to one that doesn't prove the address asks for a new code", async () => {
    const made = await c.post("/api/connections", { email: GMAIL, password: GPW });
    expect(made.body.connection.status).toBe("active");
    const id = made.body.connection.id as string;
    // Same username, new password: stays active.
    const same = await c.put(`/api/connections/${id}`, { password: GPW });
    expect(same.status).toBe(200);
    expect(same.body.connection.status).toBe("active");
    expect(codeTo(GMAIL)).toBe(false);
    const moved = await c.put(`/api/connections/${id}`, { password: APW, username: ATTACKER });
    expect(moved.status).toBe(200);
    expect(moved.body.connection.status).toBe("verifying");
    expect(codeTo(GMAIL)).toBe(true);
    const row = (await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!;
    expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get())?.status).toBe("suspended");
  });
});
