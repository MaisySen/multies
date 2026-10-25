import { it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { READ_AUDIT_ROLLUP_MS } from "@/server/services/agents";

/** Round 20: an agent reading the same thread again within the hour adds no audit row (D1 writes). */
it("rolls agent thread reads up to one audit row per thread per hour", async () => {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  const wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret;
  const api = async (key: string, path: string, method = "GET", b?: unknown) => (await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
  const { agent, apiKey } = await api(wsKey, "/agents", "POST", { name: "Reader", localPart: "reader" });
  await deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: "reader@acme.io", sizeBytes: 300, via: "test",
    email: { messageId: "<r1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "reader@acme.io" }], cc: [], subject: "Hello", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  const threadId = (await api(apiKey.secret, `/agents/${agent.id}/threads`)).data[0].id;
  const reads = async () => (await api(wsKey, `/agents/${agent.id}/audit`)).data.filter((e: { action: string }) => e.action === "agent.message_read").length;
  for (let i = 0; i < 4; i++) await api(apiKey.secret, `/threads/${threadId}`);
  expect(await reads()).toBe(1);
  const real = ctx.deps.now;
  ctx.deps.now = () => new Date(real().getTime() + READ_AUDIT_ROLLUP_MS + 60_000);
  try {
    await api(apiKey.secret, `/threads/${threadId}`);
    expect(await reads()).toBe(2);
  } finally { ctx.deps.now = real; }
});
