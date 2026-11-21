/**
 * OPS1 feature flags: /api/account/me carries `flags`, only the /api/config flags whose value for the person's
 * workspace differs from the platform wide value, and the web app's useConfig merges them over /api/config.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Client, makeTestApp } from "./helpers";
import { invalidateFlagOverrides, setFlagOverride } from "@/server/services/console/flags";
import { meFlagsFrom, mergeConfigFlags, qk } from "@/web/lib/queries";
import type { Me, PublicConfig } from "@/web/lib/types";

afterEach(() => invalidateFlagOverrides());

describe("/api/account/me flags", () => {
  it("is empty with no overrides, and lists only this workspace's differences", async () => {
    const ctx = await makeTestApp({ CRM_TIMELINE: "on" });
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    await a.signup("flags-a@example.com", "Ada", "Flags A");
    await b.signup("flags-b@example.com", "Bea", "Flags B");
    const orgA = (await a.get("/api/account/me")).body.organization.id as string;
    expect((await a.get("/api/account/me")).body.flags).toEqual({});

    await setFlagOverride(ctx.deps, { key: "crmTimeline", scopeId: orgA, value: false, updatedBy: null });
    await setFlagOverride(ctx.deps, { key: "searchR98", scopeId: orgA, value: true, updatedBy: null });
    // A workspace row equal to the platform wide value is no difference.
    await setFlagOverride(ctx.deps, { key: "flows", scopeId: orgA, value: true, updatedBy: null });
    expect((await a.get("/api/account/me")).body.flags).toEqual({ crmTimeline: false, searchR98: true });
    expect((await b.get("/api/account/me")).body.flags).toEqual({});
    // /api/config stays the platform wide value.
    const cfg = (await a.get("/api/config")).body as Record<string, unknown>;
    expect([cfg.crmTimeline, cfg.searchR98]).toEqual([true, false]);
  }, 120_000);
});

describe("useConfig merge", () => {
  const config = { crmTimeline: true, searchR98: false, appName: "Multies" } as unknown as PublicConfig;

  it("puts the workspace's flags over the config and keeps the same object without any", () => {
    expect(mergeConfigFlags(config, undefined)).toBe(config);
    expect(mergeConfigFlags(undefined, { crmTimeline: false })).toBeUndefined();
    const merged = mergeConfigFlags(config, { crmTimeline: false, searchR98: true }) as unknown as Record<string, unknown>;
    expect(merged).toEqual({ crmTimeline: false, searchR98: true, appName: "Multies" });
  });

  it("reads flags from a fetched /me only (signed out: none; a saved copy painted first: none)", () => {
    const qc = new QueryClient();
    expect(meFlagsFrom(qc)).toBeUndefined(); // signed out page: no /me query at all
    const me = { user: { id: "u" }, organization: null, flags: { crmTimeline: false } } as unknown as Me;
    // The saved copy useMe paints first (initialData with updatedAt 0) may be another workspace's: not used.
    qc.getQueryCache().build(qc, { queryKey: qk.me, initialData: me, initialDataUpdatedAt: 0 });
    expect(meFlagsFrom(qc)).toBeUndefined();
    qc.setQueryData(qk.me, me);
    expect(meFlagsFrom(qc)).toEqual({ crmTimeline: false });
    qc.setQueryData(qk.me, { ...me, flags: {} });
    expect(meFlagsFrom(qc)).toBeUndefined();
    // A workspace switch clears the cache (layouts/app.tsx), so nothing of the old workspace is merged.
    qc.setQueryData(qk.me, me);
    qc.clear();
    expect(meFlagsFrom(qc)).toBeUndefined();
  });
});
