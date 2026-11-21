/**
 * OPS1 Trends: the cron's platform_metrics step. With rotate it runs in slot 0 only (minutes 0 to 14), writes
 * yesterday's numbers on the first such pass of the day and only probes afterwards, and writes nothing while optional
 * writes are paused.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestApp } from "./helpers";
import { platformMetricsDaily } from "@/server/db/schema";
import { runMaintenance } from "@/server/services/maintenance";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

afterEach(() => { resetWriteBudgetCache(); vi.restoreAllMocks(); });

async function setup(env: Record<string, string> = {}, opts: Parameters<typeof makeTestApp>[1] = {}) {
  resetWriteBudgetCache();
  const ctx = await makeTestApp(env, opts);
  let now = new Date("2026-11-21T00:20:00Z");
  ctx.deps.now = () => now;
  const at = (iso: string) => { now = new Date(iso); };
  const stored = async () => (await ctx.db.select().from(platformMetricsDaily)).length;
  return { ctx, at, stored };
}

describe("maintenance: platform metrics rollup", () => {
  it("runs in the slot 0 pass only, once a day", async () => {
    const { ctx, at, stored } = await setup();
    // Slot 1 (minute 20): not this step.
    await runMaintenance(ctx.deps, { rotate: true });
    expect(await stored()).toBe(0);
    // Slot 0: yesterday (and the catch-up days) are rolled.
    at("2026-11-21T01:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    const first = await stored();
    expect(first).toBeGreaterThan(0);
    const days = (await ctx.db.select({ day: platformMetricsDaily.day }).from(platformMetricsDaily)).map((r) => r.day);
    expect(days).toContain("2026-11-20");
    expect(days).not.toContain("2026-11-21");
    // The next slot 0 pass the same day finds yesterday stored and writes nothing.
    at("2026-11-21T02:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect(await stored()).toBe(first);
    // The next day rolls the new yesterday.
    at("2026-11-22T00:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect((await ctx.db.select({ day: platformMetricsDaily.day }).from(platformMetricsDaily)).map((r) => r.day)).toContain("2026-11-21");
  }, 120_000);

  it("writes nothing while optional writes are paused", async () => {
    const analytics = (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 90_000 }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { ctx, at, stored } = await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, { fetch: analytics });
    expect(ctx.deps.log).toBeDefined();
    const warn = vi.spyOn(ctx.deps.log!, "warn");
    at("2026-11-21T01:05:00Z");
    await runMaintenance(ctx.deps, { rotate: true });
    expect(await stored()).toBe(0);
    expect(warn.mock.calls.map((c) => c[0])).toContain("metrics.rollup_skipped");
  }, 120_000);
});
