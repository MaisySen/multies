import { describe, expect, it } from "vitest";
import {
  buildTree, clampBlock, clashOf, csvCell, describeRule, dropStopAt, fitBlock, fromZoned, idleAway, isEveryWeekday, nextInRotation,
  nextOccurrence, nthWeekdayOf, planTomorrow, previewDates, repeatBase, ruleProblem, sheetStep, weekStartOf, wouldCycle, zonedParts, cleanTags, addDays,
} from "@/shared/tasks-plus-r95";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("R95 repeat: old rules unchanged", () => {
  it("daily, weekly, monthly short month, yearly leap day", () => {
    expect(iso(nextOccurrence({ freq: "daily", interval: 2 }, new Date("2026-01-30T09:00:00Z")))).toBe("2026-02-01T09:00:00.000Z");
    expect(iso(nextOccurrence({ freq: "weekly", weekdays: [1, 3] }, new Date("2026-11-02T09:00:00Z")))).toBe("2026-11-04T09:00:00.000Z");
    expect(iso(nextOccurrence({ freq: "monthly", monthDay: 31 }, new Date("2026-01-31T09:00:00Z")))).toBe("2026-02-28T09:00:00.000Z");
    expect(iso(nextOccurrence({ freq: "yearly" }, new Date("2028-02-29T09:00:00Z")))).toBe("2029-02-28T09:00:00.000Z");
    expect(nextOccurrence({ freq: "daily", until: "2026-01-01" }, new Date("2026-01-01T09:00:00Z"))).toBeNull();
  });
});

describe("R95 repeat: every weekday", () => {
  it("Friday goes to Monday, and the preset reads plainly", () => {
    const r = { freq: "weekly" as const, weekdays: [1, 2, 3, 4, 5] };
    expect(iso(nextOccurrence(r, new Date("2026-11-06T09:00:00Z")))).toBe("2026-11-09T09:00:00.000Z");
    expect(iso(nextOccurrence(r, new Date("2026-11-02T09:00:00Z")))).toBe("2026-11-03T09:00:00.000Z");
    expect(isEveryWeekday(r)).toBe(true);
    expect(describeRule(r)).toBe("Every weekday");
  });
});

describe("R95 repeat: nth weekday of the month", () => {
  it("finds the 2nd Tuesday and the last Friday", () => {
    expect(nthWeekdayOf(2026, 10, 2, 2)).toBe(10); // Nov 2026: Tuesdays 3, 10
    expect(nthWeekdayOf(2026, 10, 5, -1)).toBe(27);
  });
  it("a 5th the month lacks falls back to the last", () => {
    expect(nthWeekdayOf(2026, 1, 1, 5)).toBe(23); // Feb 2026 has four Mondays: 2, 9, 16, 23
    expect(nthWeekdayOf(2026, 2, 1, 5)).toBe(30); // March 2026 has five: 30
  });
  it("moves month to month keeping the time", () => {
    const r = { freq: "monthly" as const, nth: 2, nthWeekday: 2 };
    expect(iso(nextOccurrence(r, new Date("2026-11-10T14:30:00Z")))).toBe("2026-12-08T14:30:00.000Z");
    expect(iso(nextOccurrence({ ...r, interval: 3 }, new Date("2026-11-10T14:30:00Z")))).toBe("2027-02-09T14:30:00.000Z");
    expect(describeRule({ freq: "monthly", nth: -1, nthWeekday: 5 })).toBe("Every month on the last Fri");
  });
  it("year end and 31 Dec work", () => {
    expect(iso(nextOccurrence({ freq: "monthly", nth: 1, nthWeekday: 1 }, new Date("2026-12-07T09:00:00Z")))).toBe("2027-01-04T09:00:00.000Z");
  });
});

describe("R95 repeat: time zones and daylight saving", () => {
  it("9 am Sydney stays 9 am when daylight saving starts", () => {
    // Sydney moves to AEDT on 4 Oct 2026: 9 am AEST = 23:00Z, 9 am AEDT = 22:00Z.
    const r = { freq: "daily" as const, tz: "Australia/Sydney" };
    const before = fromZoned(2026, 9, 3, 9, 0, "Australia/Sydney");
    expect(before.toISOString()).toBe("2026-10-02T23:00:00.000Z");
    const next = nextOccurrence(r, before)!;
    expect(next.toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(zonedParts(next, "Australia/Sydney").h).toBe(9);
  });
  it("New York weekly across the November change", () => {
    const r = { freq: "weekly" as const, tz: "America/New_York" };
    const from = fromZoned(2026, 9, 30, 8, 0, "America/New_York");
    expect(zonedParts(nextOccurrence(r, from)!, "America/New_York")).toMatchObject({ d: 6, h: 8, mi: 0 });
  });
  it("monthly on the 31st in a zone keeps the local date", () => {
    const r = { freq: "monthly" as const, monthDay: 31, tz: "Pacific/Auckland" };
    const from = fromZoned(2027, 0, 31, 7, 0, "Pacific/Auckland");
    expect(zonedParts(nextOccurrence(r, from)!, "Pacific/Auckland")).toMatchObject({ m: 1, d: 28, h: 7 });
  });
  it("a bad zone is refused and an unset zone means UTC", () => {
    expect(ruleProblem({ freq: "daily", tz: "Mars/Base" })).toMatch(/time zone/);
    expect(ruleProblem({ freq: "daily", tz: "Australia/Sydney" })).toBeNull();
  });
});

describe("R95 repeat: after done", () => {
  it("counts from when the task was finished, keeping the due time", () => {
    const r = { freq: "daily" as const, interval: 3, basis: "done" as const };
    const base = repeatBase(r, new Date("2026-11-01T09:00:00Z"), new Date("2026-11-05T17:20:00Z"));
    expect(base.toISOString()).toBe("2026-11-05T09:00:00.000Z");
    expect(iso(nextOccurrence(r, base))).toBe("2026-11-08T09:00:00.000Z");
    expect(describeRule(r)).toBe("Every 3 days after done");
  });
  it("due based rules ignore the finish time", () => {
    expect(repeatBase({ freq: "daily" }, new Date("2026-11-01T09:00:00Z"), new Date("2026-11-05T17:20:00Z")).toISOString()).toBe("2026-11-01T09:00:00.000Z");
  });
  it("previews the next dates", () => {
    expect(previewDates({ freq: "weekly", weekdays: [1, 2, 3, 4, 5] }, new Date("2026-11-06T09:00:00Z")).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
  });
});

describe("R95 repeat: rotation and checks", () => {
  it("rotates in order and wraps", () => {
    const list = ["member:a", "member:b", "member:c"];
    expect(nextInRotation(list, "member:a")).toBe("member:b");
    expect(nextInRotation(list, "member:c")).toBe("member:a");
    expect(nextInRotation(list, "member:zz")).toBe("member:a");
    expect(nextInRotation(list, null)).toBe("member:a");
    expect(nextInRotation([], "member:a")).toBeNull();
  });
  it("refuses bad shapes", () => {
    expect(ruleProblem({ freq: "weekly", nth: 2, nthWeekday: 1 })).toMatch(/monthly/);
    expect(ruleProblem({ freq: "monthly", nth: 6, nthWeekday: 1 })).toMatch(/1 to 5/);
    expect(ruleProblem({ freq: "monthly", nth: 1, nthWeekday: 9 })).toMatch(/nthWeekday/);
    expect(ruleProblem({ freq: "daily", rotate: ["agent:x"] })).toMatch(/member/);
    expect(ruleProblem({ freq: "daily", basis: "later" as never })).toMatch(/basis/);
  });
});

describe("R95 My Day blocks", () => {
  it("snaps to 15 minutes and stays inside the day", () => {
    expect(clampBlock(547, 40)).toEqual({ start: 540, minutes: 45 });
    expect(clampBlock(1430, 60)).toEqual({ start: 1380, minutes: 60 });
    expect(clampBlock(-30, 5)).toEqual({ start: 0, minutes: 15 });
    expect(clampBlock(0, 2000).minutes).toBe(720);
  });
  it("finds clashes but never with itself", () => {
    const blocks = [{ id: "a", start: 540, minutes: 60 }, { id: "b", start: 660, minutes: 30 }];
    expect(clashOf(blocks, { id: "x", start: 570, minutes: 30 })?.id).toBe("a");
    expect(clashOf(blocks, { id: "a", start: 550, minutes: 60 })).toBeNull();
    expect(clashOf(blocks, { id: "x", start: 600, minutes: 60 })).toBeNull(); // touching edges is fine
  });
  it("fits a drop into the nearest free slot", () => {
    const blocks = [{ id: "a", start: 540, minutes: 60 }, { id: "b", start: 600, minutes: 30 }];
    expect(fitBlock(blocks, { id: "x", start: 595, minutes: 30 })).toBe(630);
    expect(fitBlock(blocks, { id: "x", start: 555, minutes: 30 })).toBe(510);
    expect(fitBlock(blocks, { id: "x", start: 540, minutes: 30 })).toBe(510);
    const full = [{ id: "a", start: 0, minutes: 720 }, { id: "b", start: 720, minutes: 720 }];
    expect(fitBlock(full, { id: "x", start: 500, minutes: 15 })).toBeNull();
  });
  it("plan tomorrow keeps free times, lists clashes and skips done and doubles", () => {
    const today = [
      { id: "1", taskId: "t1", start: 540, minutes: 60, done: false },
      { id: "2", taskId: "t2", start: 600, minutes: 30, done: false },
      { id: "3", taskId: "t3", start: null, minutes: 30, done: false },
      { id: "4", taskId: "t4", start: 700, minutes: 30, done: true },
      { id: "5", taskId: "t5", start: 800, minutes: 30, done: false },
    ];
    const tomorrow = [{ id: "9", taskId: "t9", start: 600, minutes: 60, done: false }, { id: "8", taskId: "t5", start: null, minutes: 30, done: false }];
    const r = planTomorrow(today, tomorrow);
    expect(r.moves).toEqual([{ id: "1", start: 540 }, { id: "2", start: null }, { id: "3", start: null }]);
    expect(r.drops).toEqual(["5"]);
  });
  it("adds days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("R95 idle prompt", () => {
  const start = Date.parse("2026-11-01T09:00:00Z");
  it("asks only after the threshold and only while a timer runs", () => {
    expect(idleAway(start + 60_000, start + 5 * 60_000, { running: true, timerStartMs: start })).toBe(0);
    expect(idleAway(start + 60_000, start + 16 * 60_000, { running: true, timerStartMs: start })).toBe(900);
    expect(idleAway(start + 60_000, start + 16 * 60_000, { running: false, timerStartMs: start })).toBe(0);
  });
  it("counts from the timer start when activity was before it", () => {
    expect(idleAway(start - 3600_000, start + 11 * 60_000, { running: true, timerStartMs: start })).toBe(660);
    expect(dropStopAt(start - 3600_000, start).getTime()).toBe(start);
    expect(dropStopAt(start + 120_000, start).getTime()).toBe(start + 120_000);
  });
});

describe("R95 timesheet steps", () => {
  const me = { self: true, admin: false }, admin = { self: false, admin: true };
  it("member submits and takes back; admin approves or returns", () => {
    expect(sheetStep("open", "submit", me)).toEqual({ ok: true, status: "submitted" });
    expect(sheetStep("submitted", "withdraw", me)).toEqual({ ok: true, status: "open" });
    expect(sheetStep("submitted", "approve", admin)).toEqual({ ok: true, status: "approved" });
    expect(sheetStep("submitted", "return", admin)).toEqual({ ok: true, status: "returned" });
    expect(sheetStep("approved", "return", admin)).toEqual({ ok: true, status: "returned" });
    expect(sheetStep("returned", "submit", me)).toEqual({ ok: true, status: "submitted" });
  });
  it("refuses the wrong person and the wrong order", () => {
    expect(sheetStep("submitted", "approve", me)).toMatchObject({ ok: false, status: 403, code: "admin_only" });
    expect(sheetStep("open", "submit", admin)).toMatchObject({ ok: false, status: 403 });
    expect(sheetStep("approved", "submit", me)).toMatchObject({ ok: false, status: 409 });
    expect(sheetStep("open", "approve", admin)).toMatchObject({ ok: false, status: 409 });
    expect(sheetStep("approved", "withdraw", me)).toMatchObject({ ok: false, status: 409 });
  });
  it("weeks start on Monday", () => {
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // a Sunday
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02");
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28");
  });
});

describe("R95 mind map and CSV", () => {
  it("refuses a move under itself or its own child", () => {
    const parentOf = new Map<string, string | null>([["a", null], ["b", "a"], ["c", "b"]]);
    expect(wouldCycle(parentOf, "a", "c")).toBe(true);
    expect(wouldCycle(parentOf, "a", "a")).toBe(true);
    expect(wouldCycle(parentOf, "c", "a")).toBe(false);
    expect(wouldCycle(parentOf, "b", null)).toBe(false);
  });
  it("builds a tree and puts orphans at the top", () => {
    const t = buildTree([{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "gone" }]);
    expect(t.map((n) => n.item.id)).toEqual(["a", "c"]);
    expect(t[0].children.map((n) => n.item.id)).toEqual(["b"]);
  });
  it("survives a cycle already in the data", () => {
    const t = buildTree([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }]);
    expect(t.length).toBeGreaterThan(0);
  });
  it("quotes and defuses cells", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe("");
    expect(cleanTags([" Client A ", "client a", "", "x".repeat(40)])).toEqual(["client a", "x".repeat(32)]);
  });
});
