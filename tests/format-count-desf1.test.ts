import { describe, expect, it } from "vitest";
import { badgeCount, formatCount } from "../src/web/lib/format-count";
import { brandCss, DEFAULT_BRAND } from "../src/shared/branding";

describe("DESF1 count formatting", () => {
  it("groups thousands in the locale's way", () => {
    expect(formatCount(15536, "en-AU")).toBe("15,536");
    expect(formatCount(15536, "en-US")).toBe("15,536");
    expect(formatCount(1234567, "en")).toBe("1,234,567");
    expect(formatCount(15536, "de-DE")).toBe("15.536");
  });
  it("keeps small numbers plain and rounds", () => {
    expect(formatCount(0, "en")).toBe("0");
    expect(formatCount(999, "en")).toBe("999");
    expect(formatCount(12.6, "en")).toBe("13");
  });
  it("reads 0 for values that are not numbers", () => {
    expect(formatCount(Number.NaN, "en")).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY, "en")).toBe("0");
  });
  it("falls back when the locale tag is broken", () => {
    expect(formatCount(15536, "not a locale!!")).toBe("15,536");
  });
  it("caps nav badges at 99+", () => {
    expect(badgeCount(1, 99, "en")).toBe("1");
    expect(badgeCount(99, 99, "en")).toBe("99");
    expect(badgeCount(100, 99, "en")).toBe("99+");
    expect(badgeCount(15536, 99, "en")).toBe("99+");
  });
});

describe("DESF1 brand sidebar ground", () => {
  it("publishes the brand sidebar colour page wide so the DES1 canvas can paint it", () => {
    const css = brandCss({ ...DEFAULT_BRAND, sidebar: "#0f172a" });
    expect(css).toContain(":root{--brand-sidebar:#0f172a}");
    expect(css).toContain(".glass-sidebar,[data-brand-sidebar]{color:#ffffff}");
  });
  it("adds nothing without a brand sidebar colour", () => {
    expect(brandCss({ ...DEFAULT_BRAND, primary: "#15803d", accent: "#65a30d" })).not.toContain("--brand-sidebar");
  });
});
