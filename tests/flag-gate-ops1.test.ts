/**
 * OPS1 feature flags: flagOn, the gate that runs before requireAuth. A failed session read never opens a gate; a
 * refusal passes through as requireAuth would give it; a caller with no session gets the platform wide value, so the
 * answer (status and body) does not tell an unauthenticated caller which workspace has an override.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import { makeTestApp } from "./helpers";
import { HttpError } from "@/server/lib/errors";
import type { AppEnv } from "@/server/context";
import { invalidateFlagOverrides, loadFlagOverrides, setFlagOverride } from "@/server/services/console/flags";

const failure = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("@/server/auth/guards", async (orig) => {
  const real = await orig<typeof import("@/server/auth/guards")>();
  return {
    ...real,
    resolveAuthFor: async (...a: Parameters<typeof real.resolveAuthFor>) => {
      if (failure.next) { const e = failure.next; failure.next = null; throw e; }
      return real.resolveAuthFor(...a);
    },
  };
});
const { flagOn } = await import("@/server/services/console/flag-gate");

afterEach(() => { invalidateFlagOverrides(); failure.next = null; });

const ctxFor = (deps: AppEnv["Variables"]["deps"]) =>
  ({ var: { deps }, req: { raw: new Request("http://localhost/api/crm/segments"), method: "GET", path: "/api/crm/segments" } }) as unknown as Context<AppEnv>;

describe("flagOn before requireAuth", () => {
  it("a failed session read keeps the gate closed, even when the platform value is on", async () => {
    const t = await makeTestApp({ CRM_TIMELINE: "on" });
    await setFlagOverride(t.deps, { key: "crmTimeline", scopeId: "org_off", value: false, updatedBy: null });
    await loadFlagOverrides(t.deps);
    failure.next = new Error("database is locked");
    expect(await flagOn(ctxFor(t.deps), "crmTimeline")).toBe(false);
    // No session at all: the platform wide value.
    expect(await flagOn(ctxFor(t.deps), "crmTimeline")).toBe(true);
  }, 60_000);

  it("a refusal is passed on as it is", async () => {
    const t = await makeTestApp();
    await setFlagOverride(t.deps, { key: "crmTimeline", scopeId: "org_on", value: true, updatedBy: null });
    await loadFlagOverrides(t.deps);
    failure.next = new HttpError(403, "impersonation_blocked", "Blocked.");
    await expect(flagOn(ctxFor(t.deps), "crmTimeline")).rejects.toMatchObject({ status: 403, code: "impersonation_blocked" });
  }, 60_000);

  it("an unauthenticated caller gets the same answer whether or not some workspace has an override", async () => {
    for (const env of [{}, { CRM_TIMELINE: "on" }] as Record<string, string>[]) {
      const plain = await makeTestApp(env);
      const before = await plain.app.request("/api/crm/segments");
      const withRows = await makeTestApp(env);
      await setFlagOverride(withRows.deps, { key: "crmTimeline", scopeId: "org_x", value: !("CRM_TIMELINE" in env), updatedBy: null });
      const after = await withRows.app.request("/api/crm/segments");
      expect(after.status).toBe(before.status);
      expect(await after.text()).toBe(await before.text());
    }
  }, 60_000);
});
