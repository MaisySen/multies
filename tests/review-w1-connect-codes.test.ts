/**
 * Wave 1 review V5: the emailed connect code (P60) could be brute forced. verifyConnection read the wrong tries, then
 * compared, so parallel guesses all got through; a resend reset the tries every minute; and connecting again mailed a
 * fresh code to any address without limit. Now each guess takes a try atomically before it is compared, a resend
 * keeps the tries, one connection gets at most 5 codes, and one address at most 5 codes a day from any workspace.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { mailConnections, users } from "@/server/db/schema";

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
const lastCode = () => ([...ctx.outbound.sent].reverse().find((m) => m.to.includes(ME) && /code/i.test(m.subject))?.text ?? "").match(/\b(\d{6})\b/)?.[1] ?? "";
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

describe("Wave 1 review V5: the connect code can't be brute forced", () => {
  it("ten parallel wrong guesses count as ten tries: at most five are compared, then even the right code is refused", async () => {
    const id = (await c.post("/api/connections", CUSTOM)).body.connection.id as string;
    const code = lastCode();
    const all = await Promise.all(Array.from({ length: 10 }, () => c.post(`/api/connections/${id}/verify`, { code: wrong(code) })));
    expect(all.filter((r) => r.status === 400).length).toBeLessThanOrEqual(5);
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
    expect((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())?.verifyTries).toBe(5);
    expect((await c.post(`/api/connections/${id}/verify`, { code })).status).toBe(429);
  });

  it("a resend keeps the wrong tries, and one connection gets at most five codes", async () => {
    const id = (await c.post("/api/connections", CUSTOM)).body.connection.id as string;
    for (let i = 0; i < 3; i++) expect((await c.post(`/api/connections/${id}/verify`, { code: wrong(lastCode()) })).status).toBe(400);
    const real = ctx.deps.now;
    let shift = 0;
    ctx.deps.now = () => new Date(real().getTime() + shift);
    try {
      shift += 61_000;
      expect((await c.post(`/api/connections/${id}/verify/resend`, {})).status).toBe(200);
      expect((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())?.verifyTries).toBe(3);
      for (let i = 0; i < 3; i++) { shift += 61_000; expect((await c.post(`/api/connections/${id}/verify/resend`, {})).status).toBe(200); }
      shift += 61_000;
      expect((await c.post(`/api/connections/${id}/verify/resend`, {})).status).toBe(429);
    } finally { ctx.deps.now = real; }
  });

  it("one address gets at most five codes a day, whoever connects it", async () => {
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      const who = i % 2 ? c : await signup(`p${i}@other${i}.io`);
      const r = await who.post("/api/connections", CUSTOM);
      expect(r.status).toBe(201);
      sent++;
    }
    expect(sent).toBe(5);
    const blocked = await (await signup("eve@evil.io")).post("/api/connections", CUSTOM);
    expect(blocked.status).toBe(429);
    expect(ctx.outbound.sent.filter((m) => m.to.includes(ME) && /code/i.test(m.subject))).toHaveLength(5);
  });
});
