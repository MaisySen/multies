import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { backoff, BACKOFF_MS, enqueue, queueStats, registerJob, replayJobs, runDueJobs, RetryableJobError } from "@/server/services/jobs";
import { breakerState, ResilientOutbound, resetBreakers } from "@/server/services/resilience";
import { OutboundError, type OutboundMessage, type OutboundProvider } from "@/server/services/mail/outbound";
import { deliveries, jobs, messages } from "@/server/db/schema";
import { recordUptimeCheck, resetStatusCache, uptimeHistory } from "@/server/services/status";
import { runMaintenance } from "@/server/services/maintenance";

/** An outbound provider that fails until told otherwise. */
class FlakyOutbound implements OutboundProvider {
  readonly name = "resend";
  down = true;
  sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    if (this.down) throw new OutboundError("The email provider could not be reached.", true);
    this.sent.push(msg);
    return { provider: "resend", status: "sent" as const, providerMessageId: "re_123" };
  }
}

async function verifiedMailbox(ctx: Awaited<ReturnType<typeof makeTestApp>>, c: Client, name = "retry.example") {
  const d = await c.post("/api/domains", { name });
  const domainId = d.body.domain?.id ?? d.body.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  const mb = await c.post("/api/mailboxes", { domainId, localPart: "ops", displayName: "Ops" });
  return (mb.body.mailbox?.id ?? mb.body.id) as string;
}

afterEach(() => resetBreakers());

describe("job queue", () => {
  it("backs off exponentially with bounded jitter", () => {
    expect(backoff(1, () => 0)).toBe(BACKOFF_MS[0]);
    expect(backoff(3, () => 1)).toBe(Math.round(BACKOFF_MS[2] * 1.2));
    expect(backoff(99, () => 0)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it("retries a failing job, dead-letters it after the last attempt, and replays it", async () => {
    const { deps } = await makeTestApp();
    let calls = 0;
    let deadCalled = false;
    registerJob("test.flaky", async () => { calls++; throw new RetryableJobError("still down"); }, async () => { deadCalled = true; });
    let clock = Date.now();
    deps.now = () => new Date(clock);
    const id = await enqueue(deps, "test.flaky", { to: "x@example.com" }, { maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await runDueJobs(deps);
      clock += 2 * 86_400_000;
    }
    const row = await deps.db.select().from(jobs).where(eq(jobs.id, id)).get();
    expect(calls).toBe(3);
    expect(row?.status).toBe("dead");
    expect(row?.lastError).toBe("still down");
    expect(deadCalled).toBe(true);
    expect((await queueStats(deps)).dead).toBe(1);
    expect(await replayJobs(deps, [id])).toBe(1);
    expect((await deps.db.select().from(jobs).where(eq(jobs.id, id)).get())?.status).toBe("pending");
  });

  it("never runs one job twice when two workers drain at once", async () => {
    const { deps } = await makeTestApp();
    let calls = 0;
    registerJob("test.slow", async () => { calls++; await new Promise((r) => setTimeout(r, 20)); });
    await enqueue(deps, "test.slow", {});
    await Promise.all([runDueJobs(deps), runDueJobs(deps)]);
    expect(calls).toBe(1);
  });
});

describe("graceful degradation when the email provider is down", () => {
  it("queues outbound mail, retries it, and updates the delivery log when the provider recovers", async () => {
    const ctx = await makeTestApp();
    const flaky = new FlakyOutbound();
    ctx.deps.outbound = new ResilientOutbound(flaky);
    const c = new Client(ctx.app);
    await c.signup();
    const mailboxId = await verifiedMailbox(ctx, c);
    const sent = await c.post("/api/mail/send", { mailboxId, to: ["friend@outside.example"], cc: [], bcc: [], subject: "Hello", text: "Are you there?" });
    expect(sent.status).toBe(201);
    expect(sent.body.external[0].status).toBe("queued");
    const logged = await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "friend@outside.example")).get();
    expect(logged?.status).toBe("delayed");

    flaky.down = false;
    let clock = Date.now() + 60_000;
    ctx.deps.now = () => new Date(clock);
    const r = await runDueJobs(ctx.deps);
    // The signup confirmation email was queued too while the provider was down.
    expect(r.ran).toBe(2);
    expect(flaky.sent.map((m) => m.subject)).toContain("Hello");
    const after = await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "friend@outside.example")).get();
    expect(after?.status).toBe("sent");
    clock += 1;
  });

  it("opens the circuit after repeated failures and fails fast", async () => {
    const flaky = new FlakyOutbound();
    const out = new ResilientOutbound(flaky);
    for (let i = 0; i < 5; i++) await out.send({ from: { address: "a@b.c" }, to: ["x@y.z"], subject: "s", text: "t", messageId: "<1@b.c>" }).catch(() => undefined);
    expect(breakerState("outbound")).toBe("open");
    await expect(out.send({ from: { address: "a@b.c" }, to: ["x@y.z"], subject: "s", text: "t", messageId: "<2@b.c>" })).rejects.toMatchObject({ retryable: true });
  });

  it("sends a non-delivery notice to the sender when retries run out", async () => {
    const ctx = await makeTestApp();
    const flaky = new FlakyOutbound();
    ctx.deps.outbound = flaky;
    const c = new Client(ctx.app);
    await c.signup();
    const mailboxId = await verifiedMailbox(ctx, c, "ndr.example");
    await c.post("/api/mail/send", { mailboxId, to: ["gone@outside.example"], cc: [], bcc: [], subject: "Lost", text: "Nobody home." });
    await ctx.db.update(jobs).set({ maxAttempts: 1, runAt: new Date(0) });
    await runDueJobs(ctx.deps);
    const inbox = await ctx.db.select().from(messages).where(eq(messages.folder, "inbox"));
    expect(inbox.find((m) => m.subject === "Undeliverable: Lost")).toBeTruthy();
    expect((await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "gone@outside.example")).get())?.status).toBe("failed");
  });
});

describe("uptime history", () => {
  it("records self checks and reports daily uptime", async () => {
    const { deps, app } = await makeTestApp();
    resetStatusCache();
    await recordUptimeCheck(deps);
    await recordUptimeCheck(deps);
    const h = await uptimeHistory(deps);
    expect(h.days).toHaveLength(90);
    expect(h.days.at(-1)?.checks).toBe(2);
    expect(h.uptime30d).toBe(1);
    const res = await app.request("/api/status");
    expect((await res.json()).history.days).toHaveLength(90);
  });

  it("cross checks other deployments and alerts once, only after repeated failures", async () => {
    const reported: unknown[] = [];
    let downStatus = 503;
    const { deps } = await makeTestApp({ MONITOR_URLS: "https://up.example,https://down.example" }, {
      fetch: (async (url: string) => new Response("{}", { status: String(url).includes("down") ? downStatus : 200 })) as unknown as typeof fetch,
    });
    deps.reportError = (e) => (reported.push(e), "evt");
    const { crossCheck } = await import("@/server/services/status");
    const out = await crossCheck(deps);
    expect(out.map((o) => o.ok)).toEqual([true, false]);
    expect(reported).toHaveLength(0); // one blip, for example mid deploy, stays quiet
    await crossCheck(deps);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("down.example");
    await crossCheck(deps);
    expect(reported).toHaveLength(1); // no repeat alert for the same outage
    downStatus = 200;
    await crossCheck(deps);
    downStatus = 404;
    await crossCheck(deps);
    await crossCheck(deps);
    expect(reported).toHaveLength(2); // a new outage after recovery alerts again
  });

  it("runs maintenance steps independently", async () => {
    const { deps } = await makeTestApp();
    const out = await runMaintenance(deps);
    expect(out.uptime?.ok).toBe(true);
    expect(out.jobs).toBeTruthy();
  });
});
