import { describe, expect, it } from "vitest";
import { focusItems, nextMeeting } from "../src/web/lib/today";
import type { MyWork } from "../src/web/lib/search";

const item = (id: string, at: string | null = null) => ({ id, title: id, subtitle: "", url: `/x/${id}`, at });
const now = Date.parse("2026-10-27T09:00:00Z");

describe("Today home (R35)", () => {
  it("shows Join from 10 minutes before the next meeting", () => {
    expect(nextMeeting([item("a", "2026-10-27T09:08:00Z")], now)).toEqual({ item: item("a", "2026-10-27T09:08:00Z"), joinable: true });
    expect(nextMeeting([item("a", "2026-10-27T09:30:00Z")], now)?.joinable).toBe(false);
  });
  it("picks the soonest meeting that has not long ended", () => {
    const r = nextMeeting([item("late", "2026-10-27T15:00:00Z"), item("old", "2026-10-27T06:00:00Z"), item("soon", "2026-10-27T10:00:00Z")], now);
    expect(r?.item.id).toBe("soon");
  });
  it("falls back to an untimed meeting without Join, and to nothing", () => {
    expect(nextMeeting([item("x")], now)).toEqual({ item: item("x"), joinable: false });
    expect(nextMeeting([], now)).toBeNull();
  });
  it("orders Focus overdue, due, mentions, approvals, mail and keeps five", () => {
    const w = { date: "2026-10-27", timeZone: "UTC", overdue: [item("o1")], dueToday: [item("d1"), item("d2")], mentions: [item("m1")], approvals: [item("a1")], threads: [item("t1")], meetings: [], snoozed: null, tookMs: 1 } as MyWork;
    const f = focusItems(w);
    expect(f.map((x) => x.id)).toEqual(["o1", "d1", "d2", "m1", "a1"]);
    expect(f[0].kind).toBe("overdue");
  });
});
