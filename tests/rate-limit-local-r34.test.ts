import { describe, expect, it } from "vitest";
import { ADDRESSLESS_KEY, instanceRateLimitStore } from "../src/server/auth/session";
import { ConfigError, localRateKeys } from "../src/server/config";
import { requestIp } from "../src/server/app";

const rule = { window: 60, max: 5 };
const addressless = `${ADDRESSLESS_KEY}|/sign-up/email`;

async function run(store: ReturnType<typeof instanceRateLimitStore>, key: string, n: number) {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push((await store.consume(key, rule)).allowed);
  return out;
}

describe("R34 local sign-up rate limit", () => {
  it("still limits addressless sign-ups by default (production behaviour)", async () => {
    const allowed = await run(instanceRateLimitStore(), addressless, 7);
    expect(allowed.filter(Boolean)).toHaveLength(5);
    expect(allowed.slice(5)).toEqual([false, false]);
  });

  it("local E2E servers do not share one counter for addressless requests", async () => {
    const allowed = await run(instanceRateLimitStore(10_000, { localAddresslessUnlimited: true }), addressless, 50);
    expect(allowed.every(Boolean)).toBe(true);
  });

  it("requests with a real address are limited even with the local flag on", async () => {
    const allowed = await run(instanceRateLimitStore(10_000, { localAddresslessUnlimited: true }), "203.0.113.9|/sign-up/email", 7);
    expect(allowed.filter(Boolean)).toHaveLength(5);
  });

  it("app level limits: addressless requests get their own key only on local E2E servers", () => {
    expect(requestIp("unknown")).toBe("unknown");
    expect(requestIp("unknown", false)).toBe("unknown");
    expect(requestIp("203.0.113.9", true)).toBe("203.0.113.9");
    const a = requestIp("unknown", true);
    expect(a).toMatch(/^unknown:/);
    expect(requestIp("unknown", true)).not.toBe(a);
  });

  it("the flag is off unless set, and refused in production", () => {
    expect(localRateKeys(undefined, "development")).toBe(false);
    expect(localRateKeys("0", "production")).toBe(false);
    expect(localRateKeys("1", "development")).toBe(true);
    expect(() => localRateKeys("1", "production")).toThrow(ConfigError);
  });
});
