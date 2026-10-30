import { describe, expect, it } from "vitest";
import { hasScheme, isHexColour, isIsoDate, isMimeType, isSafeToken, looksLikeEmail } from "../src/server/lib/input-checks";

describe("input checks", () => {
  it("accepts the shapes it should and rejects the rest", () => {
    expect(isHexColour("#14b8a6")).toBe(true); expect(isHexColour("#14b8a")).toBe(false); expect(isHexColour("14b8a6a")).toBe(false); expect(isHexColour(undefined)).toBe(false);
    expect(isIsoDate("2026-10-23")).toBe(true); expect(isIsoDate("2026-02-30")).toBe(false); expect(isIsoDate("2026-1-23")).toBe(false);
    expect(hasScheme("https://x.au")).toBe(true); expect(hasScheme("mailto:a@b.au")).toBe(true); expect(hasScheme("example.com.au")).toBe(false); expect(hasScheme("1http://x")).toBe(false);
    expect(isSafeToken("fld_abc-1")).toBe(true); expect(isSafeToken("a b")).toBe(false); expect(isSafeToken("x".repeat(19), 20, 100)).toBe(false);
    expect(looksLikeEmail("maria@blueharbor.co")).toBe(true); expect(looksLikeEmail("maria@blueharbor")).toBe(false); expect(looksLikeEmail("a b@c.au")).toBe(false); expect(looksLikeEmail("a@b@c.au")).toBe(false);
    expect(isMimeType("application/pdf")).toBe(true); expect(isMimeType("image/svg+xml")).toBe(true); expect(isMimeType("text/html; x")).toBe(false); expect(isMimeType("a/b/c")).toBe(false);
  });
  it("stays fast on long hostile input", () => {
    const evil = "a".repeat(200_000) + "@";
    const t = performance.now();
    looksLikeEmail(evil); isSafeToken(evil, 1, 1_000_000); isMimeType(evil); hasScheme(evil);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
