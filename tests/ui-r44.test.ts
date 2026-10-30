import { describe, it, expect } from "vitest";
import { rowOffsets, windowRangeVar } from "@/web/lib/use-windowed-list";

/** R44 (MB-210 follow up): windowing for rows of different heights (board cards). */
describe("R44 variable height windowing", () => {
  it("rowOffsets sums measured heights and uses the fallback for rows not measured yet", () => {
    const o = rowOffsets(["a", "b", "c", "d"], new Map([["a", 100], ["c", 50]]), 80);
    expect(Array.from(o)).toEqual([0, 100, 180, 230, 310]);
  });

  it("windowRangeVar covers the viewport plus overscan and clamps at both ends", () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `k${i}`);
    // Every even row is 60 px, every odd row 140 px: pairs of 200 px.
    const sizes = new Map(keys.map((k, i) => [k, i % 2 ? 140 : 60] as [string, number]));
    const o = rowOffsets(keys, sizes, 100);
    expect(o[5000]).toBe(500_000);
    expect(windowRangeVar(o, 0, 600, 2)).toEqual([0, 9]);
    const [a, b] = windowRangeVar(o, 200_000, 600, 2);
    expect(a).toBe(1998);
    expect(b).toBe(2009);
    expect(windowRangeVar(o, 499_800, 600, 2)).toEqual([4996, 5000]);
    expect(windowRangeVar(o, -50, 0, 0)).toEqual([0, 1]);
  });

  it("an empty list gives an empty range", () => {
    expect(windowRangeVar(rowOffsets([], new Map(), 10), 0, 500, 4)).toEqual([0, 0]);
  });
});
