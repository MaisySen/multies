import { describe, expect, it } from "vitest";
import { activePhoneTab, badgeText, tasksTabHref } from "../src/web/components/phone-tab-bar";
import { allClear } from "../src/web/lib/today";

describe("R46 mobile web: phone tab bar", () => {
  it("lights the tab a route belongs to", () => {
    expect(activePhoneTab("/app/my-work", "")).toBe("home");
    expect(activePhoneTab("/app", "")).toBe("home");
    expect(activePhoneTab("/app/mail", "?mailbox=x")).toBe("mail");
    expect(activePhoneTab("/app/mail/thread/1", "")).toBe("mail");
    expect(activePhoneTab("/app/tasks", "?view=board")).toBe("tasks");
    expect(activePhoneTab("/app/tasks", "?view=calendar")).toBe("calendar");
    expect(activePhoneTab("/app/docs", "")).toBe("more");
    expect(activePhoneTab("/app/settings/account", "")).toBe("more");
    expect(activePhoneTab("/app/mailboxes", "")).toBe("more");
  });
  it("Tasks opens the last task view but never the calendar", () => {
    expect(tasksTabHref(null)).toBe("/app/tasks");
    expect(tasksTabHref("board")).toBe("/app/tasks?view=board");
    expect(tasksTabHref("calendar")).toBe("/app/tasks");
  });
  it("badges like the system: none at 0, 99+ past 99", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(7)).toBe("7");
    expect(badgeText(120)).toBe("99+");
  });
});

describe("R46 mobile web: My Work all clear", () => {
  const zero = { unread: 0, due: 0, overdue: 0, mentions: 0, approvals: 0, meeting: false };
  it("is clear only when every count is zero and no meeting is coming", () => {
    expect(allClear(zero)).toBe(true);
    expect(allClear({ ...zero, unread: null })).toBe(true);
    expect(allClear({ ...zero, unread: 3 })).toBe(false);
    expect(allClear({ ...zero, overdue: 1 })).toBe(false);
    expect(allClear({ ...zero, approvals: 2 })).toBe(false);
    expect(allClear({ ...zero, meeting: true })).toBe(false);
  });
});
