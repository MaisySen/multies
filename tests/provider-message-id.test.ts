import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliveries, mailboxes, messages } from "@/server/db/schema";
import { handleResendEvent } from "@/server/services/deliverability/resend-events";
import { resolveThreadId, storeMessage } from "@/server/services/mail/store";
import { newId } from "@/server/lib/crypto";

/**
 * Round 19: Resend sends our mail under its own Message-ID, so an outside reply's In-Reply-To
 * names Resend's id. The first delivery event reads it once and keeps it on the Sent copy.
 */
function fakeResend(messageId: string | null) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.resend.com", "")}`);
    if (url.endsWith("/emails/em_out")) return new Response(JSON.stringify(messageId ? { id: "em_out", message_id: messageId } : { id: "em_out" }), { headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function setup(messageId: string | null = "<010001a1b2c3-0000@email.amazonses.com>") {
  const p = fakeResend(messageId);
  const app = await makeTestApp();
  const c = new Client(app.app);
  await c.signup();
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" });
  const mb = (await app.db.select().from(mailboxes).get())!;
  // The webhook handler with sending through Resend switched on, and the provider faked.
  const ctx = { ...app, deps: { ...app.deps, fetch: p.fetch, config: { ...app.deps.config, outbound: { driver: "resend" as const, resendApiKey: "re_test" } } } };
  const sentId = await storeMessage(ctx.db, {
    orgId: mb.orgId, mailboxId: mb.id, folder: "sent", messageIdHeader: "<abc.1@mail.multies.si>",
    from: { address: mb.address }, to: [{ address: "pat@gmail.com" }], subject: "Quote", text: "Hello", date: new Date(), isRead: true,
  });
  await ctx.db.insert(deliveries).values({
    id: newId("dlv"), orgId: mb.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: "pat@gmail.com",
    subject: "Quote", status: "sent", provider: "resend", providerMessageId: "em_out",
  });
  const sent = async () => (await ctx.db.select().from(messages).where(eq(messages.id, sentId)).get())!;
  return { ctx, p, mb, sentId, sent };
}

describe("outside replies to mail sent through Resend join the thread", () => {
  it("keeps the Message-ID Resend sent under, read once on the first delivery", async () => {
    const { ctx, p, mb, sent } = await setup();
    await handleResendEvent(ctx.deps, { type: "email.delivered", data: { email_id: "em_out", to: ["pat@gmail.com"] } });
    const s = await sent();
    expect(s.providerMessageIdHeader).toBe("<010001a1b2c3-0000@email.amazonses.com>");
    expect(s.messageIdHeader).toBe("<abc.1@mail.multies.si>");
    await handleResendEvent(ctx.deps, { type: "email.delivered", data: { email_id: "em_out", to: ["pat@gmail.com"] } });
    expect(p.calls.filter((x) => x === "GET /emails/em_out")).toHaveLength(1);
    // A reply from outside names Resend's id, an inside reply names ours: both find the thread.
    expect(await resolveThreadId(ctx.db, mb.id, "<010001a1b2c3-0000@email.amazonses.com>")).toBe(s.threadId);
    expect(await resolveThreadId(ctx.db, mb.id, "<abc.1@mail.multies.si>")).toBe(s.threadId);
    expect(await resolveThreadId(ctx.db, mb.id, undefined, "<x@y> <010001a1b2c3-0000@email.amazonses.com>")).toBe(s.threadId);
  });

  it("adds angle brackets when the provider leaves them off, and writes nothing when it has no id", async () => {
    const a = await setup("010001ff-0000@email.amazonses.com");
    await handleResendEvent(a.ctx.deps, { type: "email.delivered", data: { email_id: "em_out" } });
    expect((await a.sent()).providerMessageIdHeader).toBe("<010001ff-0000@email.amazonses.com>");
    const b = await setup(null);
    await handleResendEvent(b.ctx.deps, { type: "email.delivered", data: { email_id: "em_out" } });
    expect((await b.sent()).providerMessageIdHeader).toBeNull();
  });

  it("doesn't read it on a bounce", async () => {
    const { ctx, p, sent } = await setup();
    await handleResendEvent(ctx.deps, { type: "email.bounced", data: { email_id: "em_out", bounce: { type: "Permanent" } } });
    expect(p.calls).toHaveLength(0);
    expect((await sent()).providerMessageIdHeader).toBeNull();
  });
});
