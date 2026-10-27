import { describe, expect, it } from "vitest";
import { barOutsideSide, outsideLabelBox, rowLeftLimit } from "@/web/pages/app/work/timeline";
import { gapGeometry, leadPillBox, LEAD_PILL_ROOM } from "@/web/pages/app/work/timeline-gaps-r39";

type Box = { left: number; right: number; top?: number; bottom?: number };
const overlapX = (a: Box, b: Box) => a.left < b.right && b.left < a.right;

// Demo like geometry: 36 px days, 40 px rows with a 24 px bar 8 px down, the chart 1,400 px wide.
const CELL = 36, ROW = 40, BAR_TOP = 8, BAR_H = 24, CHART = 1400;
const row = (i: number) => ({ top: i * ROW + BAR_TOP, height: BAR_H, rowTop: i * ROW, rowBottom: (i + 1) * ROW });

describe("R40 timeline labels never collide", () => {
  it("a flipped name label keeps clear of the wait band in its row", () => {
    // NW-7 ends at 1,000; NW-8 waits 3 days, then runs to near the chart end, so its label must go left.
    const srcRight = 1000, lag = 3;
    const tgt = { left: srcRight + lag * CELL, ...row(4) };
    const barRight = 1330, labelWidth = 240;
    const band = gapGeometry(lag, srcRight, tgt, CELL)!;
    const limit = rowLeftLimit(tgt.left, [{ lag, srcRight }]);
    expect(limit).toBe(srcRight);
    const place = barOutsideSide(tgt.left, barRight, labelWidth, CHART, 10, 8, limit);
    expect(place.side).toBe("left");
    const label = outsideLabelBox(tgt.left, barRight, labelWidth, place);
    expect(overlapX(label, { left: band.left, right: band.left + band.width })).toBe(false);
    // Without the R40 limit the same label sat right on top of the band.
    const old = outsideLabelBox(tgt.left, barRight, labelWidth, barOutsideSide(tgt.left, barRight, labelWidth, CHART));
    expect(overlapX(old, { left: band.left, right: band.left + band.width })).toBe(true);
  });

  it("the early pill stays inside its own row and clear of a flipped label", () => {
    // NW-5 ends at 900; NW-6 starts one day early.
    const srcRight = 900, lag = -1;
    const r = row(2);
    const tgt = { left: srcRight - CELL, top: r.top, height: r.height };
    const g = gapGeometry(lag, srcRight, tgt, CELL)!;
    expect(g.top).toBeGreaterThanOrEqual(r.rowTop);
    const pill = leadPillBox(g);
    expect(pill.top).toBeGreaterThanOrEqual(r.rowTop);
    expect(pill.bottom).toBeLessThanOrEqual(r.rowBottom);
    const barRight = 1340, labelWidth = 200;
    const limit = rowLeftLimit(tgt.left, [{ lag, srcRight }]);
    expect(limit).toBe(tgt.left - LEAD_PILL_ROOM);
    const place = barOutsideSide(tgt.left, barRight, labelWidth, CHART, 10, 8, limit);
    const label = outsideLabelBox(tgt.left, barRight, labelWidth, place);
    expect(overlapX(label, pill)).toBe(false);
  });

  it("a right side label is untouched by the row limit, and a squeezed one wraps to the roomier side", () => {
    expect(barOutsideSide(200, 300, 120, CHART, 10, 8, 150)).toEqual({ side: "right" });
    // Band from 100, bar at 300 near the right edge with a long name: right has 92 px, left only 82 px past the band.
    const p = barOutsideSide(300, 1290, 400, CHART, 10, 8, 100);
    expect(p.side).toBe("right");
    expect(p.max).toBeGreaterThanOrEqual(80);
  });

  it("a blocker off screen still reserves lag days of room", () => {
    expect(rowLeftLimit(500, [{ lag: 2, srcRight: null }])).toBe(500 - 2 * CELL);
    expect(rowLeftLimit(500, [])).toBeUndefined();
  });
});
