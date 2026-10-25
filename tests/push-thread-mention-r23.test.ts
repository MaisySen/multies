import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { pushPayload } from "@/server/services/suite/push";

/** Round 23: a "mentioned you on a thread" push carries the newest message id, so a phone opens the thread. */
describe("thread mention push", () => {
  it("keeps the payload to type and id unless a message id rides along", () => {
    expect(pushPayload({ type: "message.received", id: "msg_1" })).toEqual({ type: "message.received", id: "msg_1" });
    expect(pushPayload({ type: "thread_mention", id: "thr_1", mid: "msg_9" })).toEqual({ type: "thread_mention", id: "thr_1", mid: "msg_9" });
  });

  it("sends the thread id and the newest message id, never the note or the subject", async () => {
    const sent: { url: string; body: { to: string; data: Record<string, string> }[] }[] = [];
    const ctx = await makeTestApp({ PUSH_ENABLED: "1" }, { fetch: (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ data: [{ status: "ok" }] })); }) as unknown as typeof fetch });
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    await owner.post("/api/org/plan", { plan: "pro" });
    const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await owner.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await owner.post(`/api/domains/${domainId}/verify`);
    const supportId = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox.id;
    const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member", mailboxIds: [supportId] });
    const maya = new Client(ctx.app);
    await maya.signup("maya@acme.io", "Maya Lopez");
    expect((await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await maya.post("/api/push/devices", { token: "ExponentPushToken[mayaphone1234567]", platform: "ios" })).status).toBe(201);
    for (const subject of ["Refund for order 77", "Re: Refund for order 77"]) {
      await deliverInbound(ctx.deps, {
        envelopeFrom: "grace@example.com", rcptTo: "support@acme.io", sizeBytes: 300, via: "test",
        email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "support@acme.io" }], cc: [], subject, text: "Hi, a refund please.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
      });
    }
    const threadId = (await owner.get("/api/agents/threads")).body.data[0].id as string;
    const thread = (await owner.get(`/api/agents/threads/${threadId}`)).body;
    const ids = JSON.stringify(thread);
    sent.length = 0;
    expect((await owner.post(`/api/threads/${threadId}/comments`, { body: "@Maya Lopez secret refund cap note" })).status).toBe(201);
    const push = sent.find((s) => s.url.includes("exp.host"));
    expect(push).toBeTruthy();
    const data = push!.body[0].data;
    expect(data.type).toBe("thread_mention");
    expect(data.id).toBe(threadId);
    expect(data.mid).toMatch(/^msg_/);
    expect(ids).toContain(data.mid);
    expect(JSON.stringify(push!.body)).not.toContain("secret refund");
    expect(JSON.stringify(push!.body)).not.toContain("Refund for order");
  });
});
