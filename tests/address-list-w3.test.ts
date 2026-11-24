/**
 * Wave 3 (M4): a message's stored to, cc and bcc are JSON lists of { address, name }, but older rows (and some imports)
 * hold plain strings, a single object, or text that isn't JSON. presentMessage handed those to API clients as they
 * were (strings where objects were documented) and a malformed list failed the whole read with a 500, so the web and
 * the phone read different shapes. parseAddressList normalises every list to [{ address, name? }].
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseAddressList } from "@/server/services/mail/address-list";
import { presentListItem, presentMessage } from "@/server/services/mail/mailbox-view";
import { agentMessage } from "@/server/services/agents/parse";

describe("M4: stored address lists come back in the documented shape", () => {
  it("parseAddressList accepts objects, plain strings and a single object, and drops the rest", () => {
    expect(parseAddressList(JSON.stringify([{ address: "a@b.io", name: "A" }, { address: "c@d.io" }]))).toEqual([{ address: "a@b.io", name: "A" }, { address: "c@d.io" }]);
    expect(parseAddressList(JSON.stringify(["a@b.io", " c@d.io "]))).toEqual([{ address: "a@b.io" }, { address: "c@d.io" }]);
    expect(parseAddressList(JSON.stringify({ address: "a@b.io", name: "A" }))).toEqual([{ address: "a@b.io", name: "A" }]);
    expect(parseAddressList(JSON.stringify([null, 3, {}, { name: "no address" }, "", { address: "x@y.io", name: 5 }]))).toEqual([{ address: "x@y.io" }]);
    expect(parseAddressList("not json")).toEqual([]);
    expect(parseAddressList("a@b.io")).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(JSON.stringify("a@b.io"))).toEqual([{ address: "a@b.io" }]);
  });

  const row = (over: Record<string, unknown>) => ({
    id: "msg_1", orgId: "org_1", mailboxId: "mbx_1", folder: "inbox", threadId: "thr_1", fromAddress: "f@x.io", fromName: "F", to: "[]", cc: "[]", bcc: "[]",
    subject: "S", snippet: "s", text: "t", html: null, date: new Date(0), isRead: true, isStarred: false, hasAttachments: false, sentByAgentId: null, remoteBox: null,
    createdAt: new Date(0), replyTo: null, messageIdHeader: null, authResults: null, sizeBytes: 10, ...over,
  }) as never;

  it("presentMessage and presentListItem don't fail and don't hand out strings", () => {
    const m = presentMessage(row({ to: JSON.stringify(["a@b.io"]), cc: "oops", bcc: JSON.stringify({ address: "z@b.io" }) }));
    expect(m.to).toEqual([{ address: "a@b.io" }]);
    expect(m.cc).toEqual([]);
    expect(m.bcc).toEqual([{ address: "z@b.io" }]);
    expect(presentListItem(row({ to: "{broken" })).to).toEqual([]);
  });

  it("an agent's view of the message gets the same shape", () => {
    const a = agentMessage(row({ to: JSON.stringify(["a@b.io"]), cc: "oops" }) as never, [], "http://localhost");
    expect(a.to).toEqual([{ address: "a@b.io" }]);
    expect(a.cc).toEqual([]);
  });
});

/** Through the routes: rows whose lists hold plain strings or a lone string still read and reply. */
describe("M4: routes that read stored address lists", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  let domainId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    await c.post("/api/org/plan", { plan: "pro" });
    domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    for (const r of (await c.get(`/api/domains/${domainId}`)).body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  });

  const inbound = (to: string, subject: string, cc: { address: string }[] = []) => deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: to, sizeBytes: 300, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: "grace@example.com", name: "Grace" }, to: [{ address: to }], cc, subject, text: "Hello", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });

  it("a draft with string lists lists and takes over with addresses, not a 500", async () => {
    const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox.id as string;
    await inbound("sales@acme.io", "Quote");
    const thread = (await c.get("/api/agents/threads")).body.data.find((t: { subject: string }) => t.subject === "Quote") as { threadId?: string; id?: string };
    const threadId = (thread.threadId ?? thread.id)!;
    const first = (await c.get(`/api/agents/threads/${threadId}`)).body.messages[0].id as string;
    const saved = await c.post("/api/mail/drafts", { mailboxId, to: ["buyer@example.com"], cc: ["carol@example.com"], subject: "Re: Quote", text: "Draft", inReplyToId: first });
    expect(saved.status).toBe(201);
    await ctx.db.update(messages).set({ to: JSON.stringify(["buyer@example.com"]), cc: JSON.stringify("carol@example.com"), bcc: "not json" }).where(eq(messages.id, saved.body.id));
    const list = await c.get(`/api/threads/${threadId}/drafts`);
    expect(list.status).toBe(200);
    expect(list.body.drafts[0].to).toEqual(["buyer@example.com"]);
    const took = await c.post(`/api/threads/drafts/${saved.body.id}/take-over`);
    expect(took.status).toBe(200);
    expect(took.body.draft).toMatchObject({ to: ["buyer@example.com"], cc: ["carol@example.com"], bcc: [] });
  });

  it("an agent's reply-all reads a message whose to and cc hold plain strings", async () => {
    const wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret as string;
    const call = async (key: string, method: string, path: string, body?: unknown) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const { agent, apiKey } = (await call(wsKey, "POST", "/agents", { name: "Support bot", localPart: "support-bot", allowedRecipients: ["@example.com"] })).body;
    await inbound(agent.address, "Order", [{ address: "carol@example.com" }]);
    const thread = (await call(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body.data[0];
    await ctx.db.update(messages).set({ to: JSON.stringify([agent.address, "dan@example.com"]), cc: JSON.stringify("carol@example.com") })
      .where(and(eq(messages.threadId, thread.id), eq(messages.folder, "inbox")));
    const reply = await call(apiKey.secret, "POST", `/agents/${agent.id}/threads/${thread.id}/reply`, { text: "On it.", replyAll: true });
    expect(reply.status).toBe(202);
    expect(reply.body.approval.to).toEqual(["grace@example.com"]);
    expect([...reply.body.approval.cc].sort()).toEqual(["carol@example.com", "dan@example.com"]);
  });
});
