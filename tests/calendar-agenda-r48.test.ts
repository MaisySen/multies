import { describe, expect, it } from "vitest";
import { agendaDays, dayLabel } from "../src/web/pages/app/work/calendar-agenda";

const t = (id: string, due: string | null, status = "todo", start: string | null = null) => ({ id, due, start, status });
const today = new Date(2026, 9, 28, 9, 30); // Wed 28 Oct 2026, local

describe("R48 phone calendar agenda", () => {
  it("puts open overdue work first, then today and each later day in order", () => {
    const days = agendaDays([t("a", "2026-10-30"), t("b", "2026-10-26"), t("c", "2026-10-28"), t("d", "2026-10-29"), t("e", "2026-10-28")], today);
    expect(days.map((d) => d.label)).toEqual(["Overdue", "Today", "Tomorrow", "Fri 30 Oct"]);
    expect(days[1].items.map((x) => x.id)).toEqual(["c", "e"]);
    expect(days[0].overdue).toBe(true);
  });
  it("leaves out done work in the past, tasks with no date, and days past the window", () => {
    const days = agendaDays([t("a", "2026-10-20", "done"), t("b", null), t("c", "2027-03-01")], today, 60);
    expect(days).toEqual([{ key: "2026-10-28", label: "Today", items: [] }]);
  });
  it("uses the start date when a task has no due date", () => {
    const days = agendaDays([t("a", null, "todo", "2026-10-29T00:00:00Z")], today);
    expect(days.map((d) => d.label)).toEqual(["Today", "Tomorrow"]);
  });
  it("labels days in plain words", () => {
    expect(dayLabel("2026-10-28", "2026-10-28")).toBe("Today");
    expect(dayLabel("2026-10-29", "2026-10-28")).toBe("Tomorrow");
    expect(dayLabel("2026-11-02", "2026-10-28")).toBe("Mon 2 Nov");
  });
});
