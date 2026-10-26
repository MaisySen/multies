import { describe, it, expect } from "vitest";
import { backLabel, dayLabel, groupByDay, moveOut, nextFocus, pickedDateIso, triageActionFor, TRIAGE_KEYS } from "../src/web/lib/triage";
import { catchupHeadline, type CatchupDigest } from "../src/web/lib/catchup";

/** R31 web: triage list helpers and the catch-up headline. */
const item = (id: string, createdAt: string, extra: Partial<{ read: boolean; doneAt: string | null; snoozedUntil: string | null }> = {}) => ({ id, createdAt, read: false, doneAt: null, snoozedUntil: null, ...extra });

describe("triage keys", () => {
  it("maps J/K, Enter/O, E, Shift E, H and U; lets modifiers and other keys through", () => {
    expect(triageActionFor({ key: "j" })).toBe("next");
    expect(triageActionFor({ key: "K" })).toBe("prev");
    expect(triageActionFor({ key: "Enter" })).toBe("open");
    expect(triageActionFor({ key: "o" })).toBe("open");
    expect(triageActionFor({ key: "e" })).toBe("done");
    expect(triageActionFor({ key: "E", shiftKey: true })).toBe("undo");
    expect(triageActionFor({ key: "h" })).toBe("snooze");
    expect(triageActionFor({ key: "u" })).toBe("toggle-read");
    expect(triageActionFor({ key: "e", metaKey: true })).toBeNull();
    expect(triageActionFor({ key: "x" })).toBeNull();
    expect(triageActionFor({ key: "J", shiftKey: true })).toBeNull();
    expect(TRIAGE_KEYS.map((k) => k.key)).toEqual(["J", "K", "Enter or O", "E", "Shift E", "H", "U"]);
  });
});

describe("day groups", () => {
  const now = new Date(2026, 9, 26, 15, 0, 0);
  it("labels Today, Yesterday, weekdays and dates", () => {
    expect(dayLabel(new Date(2026, 9, 26, 9).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 25, 9).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1, 9).toISOString(), now)).not.toMatch(/Today|Yesterday/);
    expect(backLabel(new Date(2026, 9, 26, 18).toISOString(), now)).toBe("Back today");
    expect(backLabel(new Date(2026, 9, 27, 9).toISOString(), now)).toBe("Back tomorrow");
  });
  it("groups in list order; Later groups by when items come back", () => {
    const a = item("a", new Date(2026, 9, 26, 10).toISOString());
    const b = item("b", new Date(2026, 9, 26, 9).toISOString());
    const c = item("c", new Date(2026, 9, 25, 9).toISOString());
    expect(groupByDay([a, b, c], "inbox", now).map((g) => [g.label, g.items.map((x) => x.id)])).toEqual([["Today", ["a", "b"]], ["Yesterday", ["c"]]]);
    const s = item("s", c.createdAt, { snoozedUntil: new Date(2026, 9, 27, 9).toISOString() });
    expect(groupByDay([s], "later", now)[0].label).toBe("Back tomorrow");
  });
});

describe("optimistic moves", () => {
  it("moves one item out with counts and the unread badge", () => {
    const page = { notifications: [item("a", "2026-10-26T00:00:00Z"), item("b", "2026-10-26T00:00:00Z", { read: true })], viewCounts: { inbox: 2, later: 0, done: 4 }, unread: 1, extra: 1 };
    const after = moveOut(page, "inbox", "a", "done");
    expect(after.notifications.map((n) => n.id)).toEqual(["b"]);
    expect(after.viewCounts).toEqual({ inbox: 1, later: 0, done: 5 });
    expect(after.unread).toBe(0);
    expect(after.extra).toBe(1);
    expect(moveOut(page, "inbox", "b", "later").unread).toBe(1);
    expect(moveOut(page, "inbox", "zzz", "done")).toBe(page);
  });
  it("focus goes to the next row, else the previous", () => {
    expect(nextFocus(["a", "b", "c"], "b")).toBe("c");
    expect(nextFocus(["a", "b", "c"], "c")).toBe("b");
    expect(nextFocus(["a"], "a")).toBeNull();
  });
  it("a picked date snoozes until 9 am local", () => {
    const iso = pickedDateIso("2026-11-03")!;
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 3, 9]);
    expect(pickedDateIso("soon")).toBeNull();
  });
});

describe("catch-up headline", () => {
  const base: CatchupDigest = { type: "channel", id: "c", since: null, hasNew: true, mode: "digest", counts: { messages: 0, replies: 0, comments: 0, edits: 0, statusChanges: 0, assigneeChanges: 0, mentions: 0 }, actors: [], decisions: [], latest: [], canSummarise: false };
  it("counts and names who", () => {
    expect(catchupHeadline({ ...base, counts: { ...base.counts, messages: 1 }, actors: [{ name: "Sam", count: 1 }] })).toBe("1 new message from Sam");
    expect(catchupHeadline({ ...base, counts: { ...base.counts, messages: 3, mentions: 2 }, actors: [{ name: "Sam", count: 2 }, { name: "Ana", count: 1 }] })).toBe("3 new messages, 2 mentions of you from Sam and Ana");
    expect(catchupHeadline({ ...base, counts: { ...base.counts, comments: 1 }, actors: [{ name: "A", count: 1 }, { name: "B", count: 1 }, { name: "C", count: 1 }] })).toBe("1 comment from A, B and others");
    expect(catchupHeadline(base)).toBe("Nothing new");
  });
});
