/**
 * OPS1 feature flags: an operator switch never lifts a protective control. A workspace admin's AI off (TD1) holds
 * whatever askTd1 says once an operator touches the flag; flags whose "off" would drop a security, access or
 * compliance control are set at deploy (runtime false) so the console offers no switch for them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { aiTrust } from "@/server/db/schema";
import { aiAllowed } from "@/server/services/ai-trust-td1";
import { invalidateFlagOverrides, loadFlagOverrides, setFlagOverride } from "@/server/services/console/flags";
import { flagDef } from "@/shared/feature-flags";

afterEach(() => invalidateFlagOverrides());

describe("a workspace's AI off survives the askTd1 switch", () => {
  it("off for the workspace, or off platform wide, still refuses AI where an admin turned it off", async () => {
    const ctx = await makeTestApp({ ASK_TD1: "on" });
    await ctx.db.insert(aiTrust).values({ orgId: "org_ai_off", enabled: false, updatedBy: null, updatedAt: new Date() });
    await loadFlagOverrides(ctx.deps);
    expect(await aiAllowed(ctx.deps, "org_ai_off")).toBe(false);
    await setFlagOverride(ctx.deps, { key: "askTd1", scopeId: "org_ai_off", value: false, updatedBy: null });
    await loadFlagOverrides(ctx.deps);
    expect(await aiAllowed(ctx.deps, "org_ai_off")).toBe(false);
    await setFlagOverride(ctx.deps, { key: "askTd1", scopeId: "", value: false, locked: true, updatedBy: null });
    await loadFlagOverrides(ctx.deps);
    expect(await aiAllowed(ctx.deps, "org_ai_off")).toBe(false);
    expect(await aiAllowed(ctx.deps, "org_no_row")).toBe(true);
  }, 60_000);

  it("keeps today's env-off behaviour with no override (no read, allowed)", async () => {
    const ctx = await makeTestApp();
    await ctx.db.insert(aiTrust).values({ orgId: "org_ai_off", enabled: false, updatedBy: null, updatedAt: new Date() });
    await loadFlagOverrides(ctx.deps);
    expect(await aiAllowed(ctx.deps, "org_ai_off")).toBe(true);
  }, 60_000);
});

describe("protective flags are set at deploy", () => {
  it("offers no runtime switch for e-sign codes, reporting, portal access levels, form access controls, the trash or the web link", () => {
    for (const key of ["esignV2", "reporting", "portalTd9", "formsTd7", "polishPol1", "mobileWebLink"]) {
      const def = flagDef(key)!;
      expect(def.runtime, key).toBe(false);
      expect(def.bootReason, key).toBeTruthy();
    }
  });
});
