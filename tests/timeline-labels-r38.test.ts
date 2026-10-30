import { describe, expect, it } from "vitest";
import { barLabelMode, clampGrid, GRID_DEFAULT } from "@/web/pages/app/work/timeline";

/** R38 owner feedback "looks cut off": what goes inside a timeline bar, and the task column width bounds. */
describe("timeline labels", () => {
  it("puts the whole name inside only when it fits", () => {
    expect(barLabelMode(300, 200, 40)).toBe("full");
    expect(barLabelMode(204, 200, 40)).toBe("full");
    expect(barLabelMode(203, 200, 40)).toBe("key");
  });
  it("puts the key alone inside when only the key fits, else nothing (never an ellipsis)", () => {
    expect(barLabelMode(60, 200, 40)).toBe("key");
    expect(barLabelMode(43, 200, 40)).toBe("none");
    expect(barLabelMode(0, 200, 40)).toBe("none");
  });
  it("keeps the task column between 220 and 720 px, 340 by default", () => {
    expect(GRID_DEFAULT).toBe(340);
    expect(clampGrid(100)).toBe(220);
    expect(clampGrid(450.4)).toBe(450);
    expect(clampGrid(5000)).toBe(720);
  });
});
