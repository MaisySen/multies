import { describe, expect, it } from "vitest";
import { nextTabKey } from "../src/web/lib/tab-keys";

/** R115 (R99 low): the sync setup guide tabs follow the tabs keyboard pattern, Home and End included. */
describe("R115 tabs keyboard pattern", () => {
  const guides = ["iphone", "mac", "android", "outlook"] as const;
  it("arrows move and wrap", () => {
    expect(nextTabKey(guides, "iphone", "ArrowRight")).toBe("mac");
    expect(nextTabKey(guides, "outlook", "ArrowRight")).toBe("iphone");
    expect(nextTabKey(guides, "iphone", "ArrowLeft")).toBe("outlook");
    expect(nextTabKey(guides, "android", "ArrowLeft")).toBe("mac");
  });
  it("Home goes to the first tab and End to the last", () => {
    expect(nextTabKey(guides, "android", "Home")).toBe("iphone");
    expect(nextTabKey(guides, "mac", "End")).toBe("outlook");
    expect(nextTabKey(guides, "outlook", "End")).toBe("outlook");
  });
  it("other keys do nothing", () => {
    expect(nextTabKey(guides, "mac", "Enter")).toBeNull();
    expect(nextTabKey(guides, "mac", "ArrowDown")).toBeNull();
    expect(nextTabKey([], "mac", "Home")).toBeNull();
  });
  it("the calendar settings guides use it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/web/pages/app/calendar-settings.tsx", import.meta.url), "utf8");
    expect(src).toContain("nextTabKey(GUIDES, tab, e.key)");
    expect(src).toMatch(/readOnly autoFocus value=\{made\.password\}/);
  });
});
