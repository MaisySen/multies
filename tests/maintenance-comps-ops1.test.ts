/**
 * OPS1 Billing: the cron's comp_expiry step. A comped plan whose end date has passed is ended once (in the slot 0 pass
 * of the midnight UTC hour), audited as billing.comp_expired, and a later pass does nothing more. Skipped while
 * optional writes are paused.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, organizations } from "@/server/db/schema";
import { runMaintenance } from "@/server/services/maintenance";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

afterEach(() => { resetWriteBudgetCache(); vi.restoreAllMocks(); });

async function setup(env: Record<string, string> = {}, opts: Parameters<typeof makeTestApp>[1] = {}) {
  resetWriteBudgetCache();
  const ctx = await makeTestApp(env, opts);
  const c = new Client(ctx.app);
  await c.signup("comp-owner@example.com", "Cora", "Comp Co");
  const org = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Comp Co")).get())!;
  let now = new Date("2026-11-21T00:20:00Z");
  ctx.deps.now = () => now;
  const at = (iso: string) => { now = new Date(iso); };
  await ctx.db.update(organizations).set({ compPlan: true, compUntil: new Date("2026-11-20T12:00:00Z"), compNote: "Partner trial" }).where(eq(organizations.id, org.id));
  const row = async () => (await ctx.db.select({ compPlan: organizations.compPlan, compUntil: organizations.compUntil }).from(organizations).where(eq(organizations.id, org.id)).get())!;
  const expiredAudits = async () => ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, "billing.comp_expired"))).all();
  return { ctx, at, row, expiredAudits };
}

describe("maintenance: comp expiry", () => {
  it("ends a past comp once, audited, in the midnight slot 0 pass only", async () => {
    const { ctx, at, row, expiredAudits } = await setup();
    // Slot 1 (minute 20) and a slot 0 pass outside the midnight hour: not this step.
    await runMaintenance(ctx.deps, { rotate: true });
    at("2026-11-21T05:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect((await row()).compPlan).toBe(true);
    // The midnight slot 0 pass ends it, with one audit row.
    at("2026-11-22T00:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect(await row()).toEqual({ compPlan: false, compUntil: null });
    const audits = await expiredAudits();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].metadata ?? "{}")).toMatchObject({ until: "2026-11-20T12:00:00.000Z", note: "Partner trial" });
    // A second pass does nothing.
    at("2026-11-23T00:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect(await expiredAudits()).toHaveLength(1);
    expect((await row()).compPlan).toBe(false);
  }, 120_000);

  it("leaves a comp whose end date is still ahead", async () => {
    const { ctx, at, row, expiredAudits } = await setup();
    await ctx.db.update(organizations).set({ compUntil: new Date("2026-12-31T00:00:00Z") });
    at("2026-11-22T00:05:00Z");
    await runMaintenance(ctx.deps);
    expect((await row()).compPlan).toBe(true);
    expect(await expiredAudits()).toHaveLength(0);
  }, 120_000);

  it("writes nothing while optional writes are paused", async () => {
    const analytics = (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 90_000 }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { ctx, at, row, expiredAudits } = await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, { fetch: analytics });
    const warn = vi.spyOn(ctx.deps.log!, "warn");
    at("2026-11-22T00:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect((await row()).compPlan).toBe(true);
    expect(await expiredAudits()).toHaveLength(0);
    expect(warn.mock.calls.map((c) => c[0])).toContain("billing.comp_expiry_skipped");
  }, 120_000);
});
