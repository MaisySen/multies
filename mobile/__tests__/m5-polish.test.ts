import { capBadge, compactCount, groupCount, statCount } from "@/lib/numbers";
import { badgeText } from "@/lib/social-inbox";
import { daySummary, topUnread } from "@/lib/today";
import type { MessageSummary } from "@/api/types";

describe("M5 numbers", () => {
  it("groups with commas", () => {
    expect(groupCount(0)).toBe("0");
    expect(groupCount(999)).toBe("999");
    expect(groupCount(15527)).toBe("15,527");
    expect(groupCount(1234567)).toBe("1,234,567");
    expect(groupCount(-3)).toBe("0");
    expect(groupCount(Number.NaN)).toBe("0");
  });
  it("compacts large counts", () => {
    expect(compactCount(9999)).toBe("9,999");
    expect(compactCount(15527)).toBe("15.5K");
    expect(compactCount(20000)).toBe("20K");
    expect(compactCount(128400)).toBe("128K");
    expect(compactCount(999_499)).toBe("999K");
    expect(compactCount(999_500)).toBe("1M");
    expect(compactCount(1_250_000)).toBe("1.3M");
  });
  it("stat tiles group up to 99,999", () => {
    expect(statCount(15527)).toBe("15,527");
    expect(statCount(99999)).toBe("99,999");
    expect(statCount(100000)).toBe("100K");
  });
  it("badges cap at 99+", () => {
    expect(capBadge(0)).toBeNull();
    expect(capBadge(undefined)).toBeNull();
    expect(capBadge(7)).toBe("7");
    expect(capBadge(99)).toBe("99");
    expect(capBadge(100)).toBe("99+");
    expect(capBadge(15527)).toBe("99+");
    expect(badgeText(15527)).toBe("99+");
  });
});

describe("M5 Today", () => {
  it("never claims unread mail is today's", () => {
    expect(daySummary(0, null)).toBe("Nothing due today.");
    expect(daySummary(1, null)).toBe("1 task needs you today.");
    expect(daySummary(1420, "Standup in 20 min")).toBe("1,420 tasks need you today. Next: Standup in 20 min.");
    expect(daySummary(3, null)).not.toMatch(/unread/);
  });
  it("lists the newest unread mail only", () => {
    const m = (id: string, isRead: boolean) => ({ id, isRead } as MessageSummary);
    expect(topUnread([m("a", true), m("b", false), m("c", false), m("d", false), m("e", false)]).map((x) => x.id)).toEqual(["b", "c", "d"]);
    expect(topUnread(undefined)).toEqual([]);
    expect(topUnread([m("b", false)], 0)).toEqual([]);
  });
});
