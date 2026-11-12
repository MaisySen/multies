/**
 * AIS1 (audit row 50), after review: the hourly read rollup (agents/index.ts readThread) used to match on agent, thread
 * and hour only. Now that the row names the key that read, a second key of the same agent reading the same thread in
 * that hour gets its own row; otherwise the log would say only the first key read it. The same key reading again still
 * writes nothing (round 20's write rule), so it costs at most one row per key or app, thread and hour.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";

describe("AIS1: the read rollup and the caller", () => {
  it("a second agent key reading the same thread within the hour is named; the same key reading again is not a new row", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
    const made = await c.post("/api/agents", { name: "Reader", localPart: "reader" });
    expect(made.status).toBe(201);
    const agentId = made.body.agent.id as string;
    const keyA = made.body.apiKey.secret as string;
    const second = await c.post(`/api/agents/${agentId}/keys`, { name: "Leaked laptop key" });
    expect(second.status).toBe(201);
    const keyB = second.body.secret as string;
    await deliverInbound(ctx.deps, {
      envelopeFrom: "grace@example.com", rcptTo: "reader@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<q1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "reader@acme.io" }], cc: [], subject: "Bank details", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const get = (key: string, p: string) => ctx.app.request(`/api/v1${p}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    const threadId = ((await (await get(keyA, `/agents/${agentId}/threads`)).json()) as { data: { id: string }[] }).data[0].id;
    expect((await get(keyA, `/threads/${threadId}`)).status).toBe(200);
    expect((await get(keyA, `/threads/${threadId}`)).status).toBe(200);
    expect((await get(keyB, `/threads/${threadId}`)).status).toBe(200);
    expect((await get(keyB, `/threads/${threadId}`)).status).toBe(200);
    const reads = (await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "agent.message_read")))
      .map((r) => (JSON.parse(r.metadata ?? "{}") as { caller?: { key?: string } }).caller?.key);
    expect(reads.sort()).toEqual(["Leaked laptop key", "Reader agent key"]);
  });
});
