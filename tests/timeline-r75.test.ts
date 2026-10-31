import { describe, expect, it } from "vitest";
import { defaultZoom, timelineRange, weekGroups, ZOOM_PX } from "../src/web/pages/app/work/timeline";
import { spanOf } from "../src/web/pages/app/work/timeline-plan-r37";

describe("R75 timeline", () => {
  it("picks Week for short plans and Month for long ones", () => {
    expect(defaultZoom(30)).toBe("week");
    expect(defaultZoom(121)).toBe("month");
  });
  it("zoom widths shrink from day to month", () => {
    expect(ZOOM_PX.day).toBeGreaterThan(ZOOM_PX.week);
    expect(ZOOM_PX.week).toBeGreaterThan(ZOOM_PX.month);
  });
  it("measures the plan span in days", () => {
    expect(spanOf([{ start: "2026-10-26", due: "2026-10-30" }, { start: null, due: "2026-11-04" }] as never)).toBe(10);
    expect(spanOf([])).toBe(0);
  });
  it("groups tasks under the Sunday of the week they start in", () => {
    const g = weekGroups([{ start: new Date(2026, 10, 3) }, { start: new Date(2026, 9, 26) }, { start: new Date(2026, 9, 27) }]);
    expect(g.map((x) => x.week.getDate())).toEqual([25, 1]);
    expect(g[0].items).toHaveLength(2);
  });
  it("fits the range to the tasks with room on both sides", () => {
    const r = timelineRange([new Date(2026, 9, 26).getTime()], [new Date(2026, 10, 24).getTime()], new Date(2026, 9, 31).getTime(), "week");
    expect(r.start.getTime()).toBeLessThanOrEqual(new Date(2026, 9, 26).getTime());
    expect(r.end.getTime()).toBeGreaterThan(new Date(2026, 10, 24).getTime());
    expect(r.start.getDay()).toBe(0);
  });
});
