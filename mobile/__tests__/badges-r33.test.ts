import { appBadgeTotal, taskBadgeCount } from "@/lib/badges";
import { pendingTask } from "@/lib/pending";

describe("R33 badges", () => {
  it("counts my open tasks due today or overdue", () => {
    const now = new Date("2026-10-26T09:00:00");
    const t = (due: string | null, status: "todo" | "done" = "todo") => ({ ...pendingTask({ title: "x" }), due, status });
    expect(taskBadgeCount([t("2026-10-25"), t("2026-10-26"), t("2026-10-27"), t(null), t("2026-10-20", "done")], now)).toBe(2);
    expect(taskBadgeCount(undefined)).toBe(0);
  });
  it("adds the icon badge parts", () => {
    expect(appBadgeTotal({ inbox: 3, activity: 2, chat: 1, approvals: 4 })).toBe(10);
    expect(appBadgeTotal({})).toBe(0);
  });
});
