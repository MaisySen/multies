import { describe, expect, it } from "vitest";
import { barOutsideSide } from "@/web/pages/app/work/timeline";
import { gapGeometry, gapPill, gapTitle } from "@/web/pages/app/work/timeline-gaps-r39";
import { daysOffText, toggleDayOff } from "@/web/pages/app/work/schedule-days-off-r39";

/** R39 timeline polish: outside label side, the lead and lag drawn on the chart, and the days off picker's rules. */
describe("outside bar label side", () => {
  it("stays on the right when the whole name fits before the chart's right edge", () => {
    expect(barOutsideSide(100, 136, 200, 1000)).toEqual({ side: "right" });
  });
  it("flips to the left when the right would run past the chart's edge", () => {
    // bar ends at 900, label 300 wide, chart 1000 wide: 900 + 10 + 300 > 992
    expect(barOutsideSide(864, 900, 300, 1000)).toEqual({ side: "left" });
  });
  it("wraps on the roomier side when neither side holds it on one line (never past an edge)", () => {
    expect(barOutsideSide(200, 236, 900, 1000)).toEqual({ side: "right", max: 746 });
    expect(barOutsideSide(700, 736, 900, 1000)).toEqual({ side: "left", max: 682 });
    expect(barOutsideSide(10, 46, 900, 100).max).toBe(80); // a floor so the text stays readable
  });
});

describe("lead and lag on the chart", () => {
  it("draws a lag over the real gap in the waiting task's row", () => {
    expect(gapGeometry(3, 136, { left: 244, top: 48, height: 24 }, 36)).toEqual({ kind: "lag", left: 136, width: 108, top: 48, height: 24 });
  });
  it("uses the real gap when days off make it wider than the lag", () => {
    expect(gapGeometry(2, 100, { left: 244, top: 8, height: 24 }, 36)?.width).toBe(144);
  });
  it("shows the wait the task should have had when a clash leaves no room", () => {
    expect(gapGeometry(2, 300, { left: 250, top: 8, height: 24 }, 36)).toEqual({ kind: "lag", left: 300, width: 72, top: 8, height: 24 });
  });
  it("draws a lead as a slim bracket over the overlap, above the bar", () => {
    expect(gapGeometry(-1, 200, { left: 164, top: 48, height: 24 }, 36)).toEqual({ kind: "lead", left: 164, width: 36, top: 41, height: 5 });
  });
  it("draws nothing for no gap", () => {
    expect(gapGeometry(0, 200, { left: 200, top: 8, height: 24 }, 36)).toBeNull();
  });
  it("labels the pill and the hover words in plain words", () => {
    expect(gapPill(3)).toBe("+3d");
    expect(gapPill(-1)).toBe("1d early");
    expect(gapTitle(3, "WEB-1")).toBe("Waits 3 days after WEB-1 ends");
    expect(gapTitle(1, "WEB-1", true)).toBe("Waits 1 working day after WEB-1 ends");
    expect(gapTitle(-2, "WEB-1")).toBe("Starts 2 days early, before WEB-1 ends");
    for (const s of [gapTitle(3, "A-1"), gapTitle(-2, "A-1", true)]) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("days off picker", () => {
  it("toggles a day and keeps the list sorted and unique", () => {
    expect(toggleDayOff([0, 6], 5)).toEqual([0, 5, 6]);
    expect(toggleDayOff([0, 5, 6], 0)).toEqual([5, 6]);
    expect(toggleDayOff([], 3)).toEqual([3]);
  });
  it("never leaves a week with no working day", () => {
    expect(toggleDayOff([0, 1, 2, 3, 4, 5], 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(toggleDayOff([0, 1, 2, 3, 4, 5], 5)).toEqual([0, 1, 2, 3, 4]);
  });
  it("names the days off Monday first", () => {
    expect(daysOffText([0, 6])).toBe("Sat, Sun");
    expect(daysOffText([6, 0, 5])).toBe("Fri, Sat, Sun");
    expect(daysOffText([])).toBe("No days off");
  });
});
