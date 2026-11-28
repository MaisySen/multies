import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers";
import { claimCronLease, releaseCronLease } from "@/server/services/cron-steps";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;

beforeEach(async () => {
  ctx = await makeTestApp();
});

describe("cross-tick cron lease (MPLAT-96 / 0180)", () => {
  it("claims once, rejects overlapping holder until released or expired, and prevents wrong-holder release", async () => {
    const t0 = 1_700_000_000_000;
    const ttl = 12 * 60_000;

    expect(await claimCronLease(ctx.deps, "scheduled_tick", "holder-a", ttl, t0)).toBe(true);
    expect(await claimCronLease(ctx.deps, "scheduled_tick", "holder-b", ttl, t0 + 60_000)).toBe(false);

    // Wrong holder cannot release holder-a's lease.
    expect(await releaseCronLease(ctx.deps, "scheduled_tick", "holder-b")).toBe(false);
    expect(await claimCronLease(ctx.deps, "scheduled_tick", "holder-b", ttl, t0 + 120_000)).toBe(false);

    // Expired lease can be reclaimed by a new holder.
    expect(await claimCronLease(ctx.deps, "scheduled_tick", "holder-b", ttl, t0 + ttl)).toBe(true);

    // Right holder releases cleanly so subsequent tick claims immediately.
    expect(await releaseCronLease(ctx.deps, "scheduled_tick", "holder-b")).toBe(true);
    expect(await claimCronLease(ctx.deps, "scheduled_tick", "holder-c", ttl, t0 + ttl + 1)).toBe(true);
  });

  it("allows only one winner when 10 concurrent claimers race", async () => {
    const t0 = 1_700_000_000_000;
    const winners = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimCronLease(ctx.deps, "scheduled_tick", `worker-${i}`, 60_000, t0)),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
  });
});
