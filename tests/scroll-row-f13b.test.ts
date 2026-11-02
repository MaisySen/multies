import { describe, expect, it } from "vitest";
import { rowMask, scrollDelta } from "@/web/components/ui/scroll-row";

describe("F13b scroll row for tab rows at 390", () => {
  it("fades only the edges that have more", () => {
    expect(rowMask(false, false)).toBe("none");
    expect(rowMask(false, true)).toMatch(/^linear-gradient\(to right, #000 0, #000 calc\(100% - 28px\), transparent 100%\)$/);
    expect(rowMask(true, false)).toMatch(/transparent 0, #000 28px, #000 100%/);
    expect(rowMask(true, true)).toMatch(/transparent 0, #000 28px, #000 calc\(100% - 28px\), transparent 100%/);
  });
  it("scrolls an active tab fully into view past the fade, and leaves a visible one alone", () => {
    const row = { left: 16, right: 374 };
    expect(scrollDelta(row, { left: 100, right: 180 })).toBe(0);
    expect(scrollDelta(row, { left: 400, right: 480 })).toBe(480 - 374 + 28);
    expect(scrollDelta(row, { left: -60, right: 20 })).toBe(-60 - 16 - 28);
    expect(scrollDelta(row, { left: 360, right: 372 }, 0)).toBe(0);
  });
});
