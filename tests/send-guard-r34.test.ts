import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliveries, mailboxes, mailSchedules, organizations, users } from "@/server/db/schema";
import { decide, newSenderCap, nextUtcMidnight, SEND_GUARD_DEFAULTS } from "@/server/services/mail/send-guard-r34";
import { runMailSchedules } from "@/server/services/mail/schedules";
import { scoreOutbound } from "@/server/services/abuse";

/** R34 (MB-166, MB-169): daily caps that queue instead of refusing, the new sender limit, the shared sender headroom and the kill switch. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let ops: Client;
let mailboxId: string;
let orgId: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id;
  orgId = (await ctx.deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!.orgId;
  ops = new Client(ctx.app);
  await ops.signup("ops@platform.io", "Ops Person", "Platform");
  await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@platform.io"));
});

const send = (to: string[], subject = "Hello there") => owner.post("/api/mail/send", { mailboxId, to, subject, text: "Quick note about the plan for next week." });
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("send guard", () => {
  it("decide: plan cap, new sender limit and shared headroom each queue with a reason", () => {
    const base = { cfg: SEND_GUARD_DEFAULTS, used: 0, cap: 2000, recipients: 1, external: 1, externalUsed: 0, newCap: null, providerUsed: 0, underReview: false };
    expect(decide(base)).toEqual({ ok: true });
    expect(decide({ ...base, used: 2000 })).toMatchObject({ ok: false, kind: "plan_cap" });
    expect(decide({ ...base, newCap: 20, externalUsed: 20 })).toMatchObject({ ok: false, kind: "new_sender" });
    expect(decide({ ...base, providerUsed: 90 })).toMatchObject({ ok: false, kind: "headroom" });
    expect(decide({ ...base, providerUsed: 90, external: 0 })).toEqual({ ok: true }); // mail inside Multies never uses the shared allowance
    expect(decide({ ...base, providerUsed: 500, cfg: { ...SEND_GUARD_DEFAULTS, providerDailyCap: 0 } })).toEqual({ ok: true }); // 0 turns the headroom off
  });

  it("newSenderCap grows after 7 clean days and stays low on bounces or complaints", () => {
    const clean = { sent: 100, bounced: 1, complained: 0 };
    expect(newSenderCap(SEND_GUARD_DEFAULTS, 2, clean)).toBe(20);
    expect(newSenderCap(SEND_GUARD_DEFAULTS, 8, clean)).toBeNull();
    expect(newSenderCap(SEND_GUARD_DEFAULTS, 8, { sent: 100, bounced: 6, complained: 0 })).toBe(20);
    expect(newSenderCap(SEND_GUARD_DEFAULTS, 30, { sent: 100, bounced: 0, complained: 1 })).toBe(20);
    expect(nextUtcMidnight(new Date("2026-10-26T13:00:00Z")).toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });

  it("a new workspace's 21st outside recipient is queued until tomorrow, shown in Scheduled with the reason, and an operator can send it anyway", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `p${i}@outside.example`);
    expect((await send(twenty)).status).toBe(201);
    const r = await send(["late@outside.example"]);
    expect(r.status).toBe(202);
    expect(r.body.queued.reason).toMatch(/New workspaces send to 20 outside recipients a day/);
    expect(r.body.queued.dueAt.endsWith("T00:00:00.000Z")).toBe(true);
    const list = (await owner.get(`/api/mail-schedules?view=scheduled`)).body;
    const items = list.items ?? list.schedules ?? list;
    expect(JSON.stringify(items)).toMatch(/New workspaces send to 20/);
    // Operator: list and send anyway; the next pass sends it past the limit.
    // OPS1 security: the console routes (reason required) replaced the retired /api/admin ones.
    const q = (await ops.get(`/api/console/workspaces/${orgId}/queued-sends`)).body.items;
    expect(q).toHaveLength(1);
    expect((await ops.post(`/api/console/workspaces/${orgId}/queued-sends/${q[0].id}/send`, { reason: "Customer asked" })).status).toBe(200);
    await runMailSchedules(ctx.deps);
    expect((await ctx.deps.db.select().from(mailSchedules).all()).length).toBe(0);
    const out = await ctx.deps.db.select().from(deliveries).where(eq(deliveries.toAddress, "late@outside.example")).all();
    expect(out.length).toBe(1);
    // The owner can't use the operator routes.
    expect((await owner.get(`/api/console/workspaces/${orgId}/queued-sends`)).status).toBe(403);
  });

  it("past its first week with a clean record the plan's cap applies; over the plan cap it queues instead of refusing", async () => {
    await ctx.deps.db.update(organizations).set({ createdAt: ago(30), sendCapDaily: 25 }).where(eq(organizations.id, orgId));
    // Under review cap of 25 (operator), past the new sender limit of 20.
    expect((await send(Array.from({ length: 24 }, (_, i) => `x${i}@outside.example`))).status).toBe(201);
    const r = await send(["a@outside.example", "b@outside.example"]);
    expect(r.status).toBe(202);
    expect(r.body.queued.reason).toMatch(/25 recipients a day while its sending is under review/);
  });

  it("the shared sender headroom queues person mail at 90 sent today (every workspace and system mail)", async () => {
    await ctx.deps.db.update(organizations).set({ createdAt: ago(30) }).where(eq(organizations.id, orgId));
    const now = new Date();
    const rows = Array.from({ length: 90 }, (_, i) => ({ id: `dlv_seed_${i}`, orgId, direction: "outbound" as const, fromAddress: "x@multies.si", toAddress: `s${i}@else.example`, subject: "Code", status: "sent" as const, provider: ctx.deps.outbound.name, createdAt: now }));
    for (let i = 0; i < rows.length; i += 5) await ctx.deps.db.insert(deliveries).values(rows.slice(i, i + 5));
    const r = await send(["one@outside.example"]);
    expect(r.status).toBe(202);
    expect(r.body.queued.reason).toMatch(/Outside sending is at its limit for today/);
  });

  it("the kill switch refuses sends with a clear message, and turning it back on restores the plan cap", async () => {
    expect((await ops.put(`/api/console/workspaces/${orgId}/sending`, { enabled: false, reason: "Spam wave" })).body).toMatchObject({ sending: false, sendCapDaily: 0 });
    const r = await send(["one@outside.example"]);
    expect(r.status).toBe(403);
    expect(r.body.error?.code ?? r.body.code).toBe("sending_off");
    expect((await ops.put(`/api/console/workspaces/${orgId}/sending`, { enabled: true, reason: "Cleared" })).body.sendCapDaily).toBeNull();
    expect((await send(["one@outside.example"])).status).toBe(201);
  });

  it("spam score: many first-time recipients and a link-only body add points", () => {
    const base = { subject: "Hello", text: "A short note about the plan for next week, nothing more.", recipients: 3, workspaceAgeDays: 30, recent: { sent: 0, bounced: 0, complained: 0 } };
    expect(scoreOutbound(base).score).toBe(0);
    expect(scoreOutbound({ ...base, newRecipients: 12 }).reasons.join()).toMatch(/never wrote to before/);
    const linkOnly = scoreOutbound({ ...base, text: "https://example.com/offer" });
    expect(linkOnly.reasons.join()).toMatch(/only a link/);
    expect(scoreOutbound({ ...base, subject: "FREE MONEY TODAY NOW", text: "https://bit.ly/x act now", newRecipients: 15 }).score).toBeGreaterThanOrEqual(10);
  });
});
