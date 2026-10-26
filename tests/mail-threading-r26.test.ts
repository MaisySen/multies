import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliveries, mailboxes, messages } from "@/server/db/schema";
import { handleResendEvent } from "@/server/services/deliverability/resend-events";
import { fetchSentMessageIdHeader, SENT_MESSAGE_ID_TIMEOUT_MS } from "@/server/services/mail/provider-domains";
import { resolveThreadId, storeMessage } from "@/server/services/mail/store";
import { fallbackMessageId } from "@/server/services/mail/deliver-job";
import { ResendOutbound, plainFromHtml } from "@/server/services/mail/outbound";
import { newId } from "@/server/lib/crypto";

/**
 * Round 26 (MB-80): replies to mail sent through Resend thread. Resend sends our mail under its own
 * Message-ID; the sent (or delivered) event reads it once, and thread lookup matches it and ours,
 * across the workspace's mailboxes but never another workspace's.
 */
const RESEND_ID = "<0100019a-r26@email.amazonses.com>";

afterEach(() => vi.unstubAllGlobals());

async function workspace(app: Awaited<ReturnType<typeof makeTestApp>>, domain: string, locals: string[]) {
  const c = new Client(app.app);
  await c.signup();
  const domainId = (await c.post("/api/domains", { name: domain })).body.domain.id;
  for (const l of locals) await c.post("/api/mailboxes", { domainId, localPart: l, displayName: l });
  const boxes = await app.db.select().from(mailboxes).where(eq(mailboxes.domainId, domainId));
  return Object.fromEntries(boxes.map((b) => [b.localPart, b]));
}

async function setup(fetchImpl?: typeof fetch) {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const f = fetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    if (String(input).endsWith("/emails/em_r26")) return new Response(JSON.stringify({ id: "em_r26", message_id: RESEND_ID }), { headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const app = await makeTestApp();
  const a = await workspace(app, "acme.io", ["ada", "help"]);
  const b = await workspace(app, "other.io", ["bob"]);
  const warn = vi.fn();
  const ctx = { ...app, deps: { ...app.deps, fetch: f, log: { info: () => {}, warn, error: () => {} }, config: { ...app.deps.config, outbound: { driver: "resend" as const, resendApiKey: "re_test" } } } };
  const ada = a.ada!;
  const sentId = await storeMessage(ctx.db, {
    orgId: ada.orgId, mailboxId: ada.id, folder: "sent", messageIdHeader: "<ours.1@acme.io>",
    from: { address: ada.address }, to: [{ address: "pat@gmail.com" }], subject: "Quote", text: "Hello", date: new Date(), isRead: true,
  });
  await ctx.db.insert(deliveries).values({
    id: newId("dlv"), orgId: ada.orgId, messageId: sentId, direction: "outbound", fromAddress: ada.address, toAddress: "pat@gmail.com",
    subject: "Quote", status: "sent", provider: "resend", providerMessageId: "em_r26",
  });
  const sent = async () => (await ctx.db.select().from(messages).where(eq(messages.id, sentId)).get())!;
  const reply = (mb: typeof ada, inReplyTo: string, references?: string) => storeMessage(ctx.db, {
    orgId: mb.orgId, mailboxId: mb.id, folder: "inbox", messageIdHeader: `<${newId("r")}@gmail.com>`, inReplyTo, references,
    from: { address: "pat@gmail.com" }, to: [{ address: mb.address }], subject: "Re: Quote", text: "Yes", date: new Date(),
  }).then(async (id) => (await ctx.db.select().from(messages).where(eq(messages.id, id)).get())!);
  return { ctx, calls, warn, a, b, ada, sent, reply };
}

describe("Resend Message-ID on the sent event", () => {
  it("reads it on email.sent, once, with a 5 second timeout, and leaves the delivery status alone", async () => {
    const { ctx, calls, sent } = await setup();
    const r = await handleResendEvent(ctx.deps, { type: "email.sent", data: { email_id: "em_r26", to: ["pat@gmail.com"] } });
    expect(r).toEqual({ handled: true, updated: 0 });
    expect((await sent()).providerMessageIdHeader).toBe(RESEND_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(SENT_MESSAGE_ID_TIMEOUT_MS).toBe(5000);
    await handleResendEvent(ctx.deps, { type: "email.delivered", data: { email_id: "em_r26", to: ["pat@gmail.com"] } });
    expect(calls).toHaveLength(1);
    const d = (await ctx.db.select().from(deliveries).where(eq(deliveries.providerMessageId, "em_r26")).get())!;
    expect(d.status).toBe("delivered");
  });

  it("a provider failure or timeout is logged and not fatal", async () => {
    const boom = (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as typeof fetch;
    const { ctx, warn, sent } = await setup(boom);
    expect(await handleResendEvent(ctx.deps, { type: "email.delivered", data: { email_id: "em_r26", to: ["pat@gmail.com"] } })).toEqual({ handled: true, updated: 1 });
    expect((await sent()).providerMessageIdHeader).toBeNull();
    expect(warn).toHaveBeenCalledWith("resend.sent_message_id_failed", expect.objectContaining({ emailId: "em_r26", error: "TimeoutError" }));
    const down = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const s2 = await setup(down);
    expect(await fetchSentMessageIdHeader(s2.ctx.deps, "em_r26")).toBeNull();
    expect(s2.warn).toHaveBeenCalledWith("resend.sent_message_id_failed", { emailId: "em_r26", status: 500 });
  });
});

describe("thread lookup matches our id and the provider's, inside the workspace", () => {
  it("a reply that references only the Resend id joins the thread, in the same mailbox and in another of the workspace", async () => {
    const { ctx, a, ada, sent, reply } = await setup();
    await handleResendEvent(ctx.deps, { type: "email.sent", data: { email_id: "em_r26" } });
    const threadId = (await sent()).threadId;
    expect((await reply(ada, RESEND_ID)).threadId).toBe(threadId);
    // Sent with a reply-to of help@: the reply lands in another mailbox and still finds the thread.
    expect((await reply(a.help!, RESEND_ID)).threadId).toBe(threadId);
    expect((await reply(a.help!, "<nope@x>", `<x@y> ${RESEND_ID}`)).threadId).toBe(threadId);
    expect((await reply(a.help!, "<ours.1@acme.io>")).threadId).toBe(threadId);
    expect(await resolveThreadId(ctx.db, a.help!.id, RESEND_ID)).toBeNull(); // without the org, only the receiving mailbox
  });

  it("a reply in another workspace with the same id does not join", async () => {
    const { ctx, b, sent, reply } = await setup();
    await handleResendEvent(ctx.deps, { type: "email.sent", data: { email_id: "em_r26" } });
    const threadId = (await sent()).threadId;
    const theirs = await reply(b.bob!, RESEND_ID);
    expect(theirs.threadId).not.toBe(threadId);
    expect((await reply(b.bob!, "<ours.1@acme.io>")).threadId).not.toBe(threadId);
    expect(await resolveThreadId(ctx.db, b.bob!.id, RESEND_ID, undefined, b.bob!.orgId)).toBeNull();
  });
});

describe("Message-ID fallback on a retried send", () => {
  it("uses the sending mailbox's domain, then the app mail domain", () => {
    expect(fallbackMessageId("msg_1", "ada@acme.com", "no-reply@multies.si")).toBe("<msg_1@acme.com>");
    expect(fallbackMessageId("msg_1", "Ada@Mail.Acme.COM", "no-reply@multies.si")).toBe("<msg_1@mail.acme.com>");
    expect(fallbackMessageId("msg_1", "broken", "no-reply@multies.si")).toBe("<msg_1@multies.si>");
    expect(fallbackMessageId("msg_1", "x@", "no-reply@multies.si")).toBe("<msg_1@multies.si>");
    expect(fallbackMessageId("msg_1", "", "")).toBe("<msg_1@localhost>");
  });
});

describe("Resend request body", () => {
  const answer = () => vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200, headers: { "content-type": "application/json" } }));
  const base = { from: { address: "a@acme.io" }, to: ["b@example.com"], subject: "Hi", messageId: "<m1@acme.io>" };
  const body = (f: ReturnType<typeof answer>) => JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));

  it("sends the HTML part beside the text part", async () => {
    const f = answer();
    vi.stubGlobal("fetch", f);
    await new ResendOutbound("re_test").send({ ...base, text: "Hello there", html: "<p>Hello <b>there</b></p>" });
    expect(body(f)).toMatchObject({ text: "Hello there", html: "<p>Hello <b>there</b></p>" });
  });

  it("keeps a text part always, and sends no html key for a plain message", async () => {
    let f = answer();
    vi.stubGlobal("fetch", f);
    await new ResendOutbound("re_test").send({ ...base, text: "Plain only" });
    expect(body(f).text).toBe("Plain only");
    expect(body(f).html).toBeUndefined();
    f = answer();
    vi.stubGlobal("fetch", f);
    await new ResendOutbound("re_test").send({ ...base, text: "", html: "<p>Line one</p><p>Two &amp; three</p><style>p{}</style>" });
    expect(body(f).text).toBe("Line one\nTwo & three");
    expect(plainFromHtml("a<br>b")).toBe("a\nb");
  });
});
