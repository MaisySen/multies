import { describe, expect, it } from "vitest";
import {
  dataBounds, deltaTone, describeTrend, fillDays, formatCompact, formatDay, formatDelta, formatNumber, hasData, mergeSeries, niceTicks, rangeStart,
} from "@/web/pages/console/components/kpi";

const M = "−";

describe("fillDays", () => {
  it("fills every day in the range with null where there are no rows", () => {
    const out = fillDays("2026-11-01", "2026-11-04", [{ day: "2026-11-02", value: 5 }, { day: "2026-11-04", value: 0 }]);
    expect(out).toEqual([
      { day: "2026-11-01", value: null },
      { day: "2026-11-02", value: 5 },
      { day: "2026-11-03", value: null },
      { day: "2026-11-04", value: 0 },
    ]);
  });
  it("keeps zero as zero and turns non numbers into null", () => {
    const out = fillDays("2026-01-01", "2026-01-02", [{ day: "2026-01-01", value: 0 }, { day: "2026-01-02", value: Number.NaN }]);
    expect(out.map((r) => r.value)).toEqual([0, null]);
  });
  it("drops rows outside the range and keeps the last of a repeated day", () => {
    const out = fillDays("2026-03-01", "2026-03-01", [{ day: "2026-02-28", value: 9 }, { day: "2026-03-01", value: 1 }, { day: "2026-03-01", value: 2 }]);
    expect(out).toEqual([{ day: "2026-03-01", value: 2 }]);
  });
  it("crosses month, year and daylight saving boundaries one day at a time", () => {
    expect(fillDays("2026-12-30", "2027-01-02", []).map((r) => r.day)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(fillDays("2026-03-28", "2026-03-31", [])).toHaveLength(4);
    expect(fillDays("2028-02-28", "2028-03-01", []).map((r) => r.day)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });
  it("gives an empty list for a reversed or bad range and caps runaway ranges", () => {
    expect(fillDays("2026-11-05", "2026-11-01", [])).toEqual([]);
    expect(fillDays("nope", "2026-11-01", [])).toEqual([]);
    expect(fillDays("1900-01-01", "2100-01-01", []).length).toBe(3660);
  });
  it("rangeStart counts the end day in", () => {
    expect(rangeStart("2026-11-21", 7)).toBe("2026-11-15");
    expect(rangeStart("2026-11-21", 1)).toBe("2026-11-21");
    expect(fillDays(rangeStart("2026-11-21", 30), "2026-11-21", [])).toHaveLength(30);
  });
});

describe("hasData and dataBounds", () => {
  it("counts zero as data and null as none", () => {
    expect(hasData([{ day: "2026-01-01", value: null }])).toBe(false);
    expect(hasData([{ day: "2026-01-01", value: 0 }])).toBe(true);
    expect(hasData([{ label: "A", rows: [] }, { label: "B", rows: [{ day: "2026-01-01", value: 3 }] }])).toBe(true);
    expect(hasData([])).toBe(false);
  });
  it("finds the first and last days with data", () => {
    const rows = [{ day: "a", value: null }, { day: "b", value: 2 }, { day: "c", value: 0 }, { day: "d", value: null }];
    expect(dataBounds(rows)).toEqual({ first: { day: "b", value: 2 }, last: { day: "c", value: 0 } });
    expect(dataBounds([{ day: "a", value: null }])).toBeNull();
  });
});

describe("formatCompact and formatNumber", () => {
  it("writes short numbers", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(7)).toBe("7");
    expect(formatCompact(2.456)).toBe("2.46");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1234)).toBe("1.2K");
    expect(formatCompact(12_345)).toBe("12.3K");
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
    expect(formatCompact(-1500)).toBe(`${M}1.5K`);
  });
  it("says No data for null, undefined and NaN", () => {
    expect(formatCompact(null)).toBe("No data");
    expect(formatCompact(undefined)).toBe("No data");
    expect(formatCompact(Number.NaN)).toBe("No data");
    expect(formatNumber(null)).toBe("No data");
  });
  it("writes exact numbers with separators", () => {
    expect(formatNumber(1_234_567)).toBe("1,234,567");
    expect(formatNumber(-42)).toBe(`${M}42`);
    expect(formatNumber(0.125)).toBe("0.13");
  });
});

describe("formatDelta and deltaTone", () => {
  it("gives a signed percentage", () => {
    expect(formatDelta(112, 100)).toMatchObject({ direction: "up", text: "+12%", diff: 12 });
    expect(formatDelta(92, 100)).toMatchObject({ direction: "down", text: `${M}8%` });
    expect(formatDelta(1034, 1000).text).toBe("+3.4%");
    expect(formatDelta(300, 100).text).toBe("+200%");
    expect(formatDelta(100_001, 100_000).text).toBe("+<0.1%");
  });
  it("handles no change, a zero start and missing values", () => {
    expect(formatDelta(5, 5)).toEqual({ direction: "flat", text: "No change", pct: 0, diff: 0 });
    expect(formatDelta(40, 0)).toEqual({ direction: "up", text: "+40", pct: null, diff: 40 });
    expect(formatDelta(0, 3)).toMatchObject({ direction: "down", text: `${M}100%` });
    expect(formatDelta(5, null)).toMatchObject({ direction: "none", text: "No earlier data" });
    expect(formatDelta(null, 5).direction).toBe("none");
  });
  it("colours by what counts as better", () => {
    expect(deltaTone("up", true)).toBe("good");
    expect(deltaTone("up", false)).toBe("bad");
    expect(deltaTone("down", false)).toBe("good");
    expect(deltaTone("down", true)).toBe("bad");
    expect(deltaTone("up", null)).toBe("neutral");
    expect(deltaTone("flat", true)).toBe("neutral");
    expect(deltaTone("none", false)).toBe("neutral");
    expect(deltaTone("up")).toBe("good");
  });
});

describe("formatDay", () => {
  it("reads the day as UTC in each style, day first like every console date", () => {
    expect(formatDay("2026-11-21")).toBe("21 Nov");
    expect(formatDay("2026-11-21", "short")).toBe("21 Nov");
    expect(formatDay("2026-11-21", "medium")).toBe("21 Nov 2026");
    expect(formatDay("2026-11-21", "long")).toBe("Sat, 21 Nov 2026");
    expect(formatDay("2026-01-01", "short", "en-GB")).toBe("1 Jan");
    // Never month first, whatever the browser's own language.
    expect(formatDay("2026-11-21", "medium")).not.toMatch(/^Nov/);
  });
  it("returns anything that is not a day unchanged", () => {
    expect(formatDay("soon")).toBe("soon");
  });
});

describe("describeTrend", () => {
  it("compares the last day with data against the first", () => {
    const rows = [{ day: "2026-11-01", value: 100 }, { day: "2026-11-02", value: null }, { day: "2026-11-03", value: 112 }, { day: "2026-11-04", value: null }];
    expect(describeTrend("Sent", rows)).toBe("Sent: 112 on 3 Nov 2026, up 12% from 100 on 1 Nov 2026.");
  });
  it("covers one day, no data and a zero start", () => {
    expect(describeTrend("Sent", [{ day: "2026-11-01", value: 4 }])).toBe("Sent: 4 on 1 Nov 2026. No other day in this range has data.");
    expect(describeTrend("Sent", [{ day: "2026-11-01", value: null }])).toBe("Sent: no data yet.");
    expect(describeTrend("Sent", [{ day: "2026-11-01", value: 0 }, { day: "2026-11-02", value: 9 }])).toBe("Sent: 9 on 2 Nov 2026, up 9 from 0 on 1 Nov 2026.");
    expect(describeTrend("Sent", [{ day: "2026-11-01", value: 3 }, { day: "2026-11-02", value: 3 }], undefined, "en-US")).toContain("the same as 3");
  });
});

describe("niceTicks", () => {
  it("starts at zero and ends past the maximum on a round step", () => {
    expect(niceTicks(0, 87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(3, 10)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(3, 10, 4, true)).toEqual([0, 3, 6, 9, 12]);
    expect(niceTicks(0, 1234)).toEqual([0, 500, 1000, 1500]);
  });
  it("gives a usable axis for all zero data and for negatives", () => {
    expect(niceTicks(0, 0, 4, true)).toEqual([0, 1]);
    expect(niceTicks(-30, 50)[0]).toBeLessThanOrEqual(-30);
    expect(niceTicks(-30, 50).at(-1)).toBeGreaterThanOrEqual(50);
  });
});

describe("mergeSeries", () => {
  it("joins two series by day and fills the missing side with null", () => {
    const out = mergeSeries([
      { label: "Sent", rows: [{ day: "2026-11-02", value: 5 }, { day: "2026-11-01", value: 4 }] },
      { label: "Failed", rows: [{ day: "2026-11-02", value: 0 }, { day: "2026-11-03", value: 1 }] },
    ]);
    expect(out).toEqual([
      { day: "2026-11-01", v0: 4, v1: null },
      { day: "2026-11-02", v0: 5, v1: 0 },
      { day: "2026-11-03", v0: null, v1: 1 },
    ]);
  });
});
