import { SWIPE, armedSide, clampTravel, emptyUndo, hiddenIds, newestPending, releaseSide, shouldCaptureSwipe, undoReducer } from "@/lib/swipe";
import { SNOOZE_PRESETS, snoozeLabel, snoozeUntil } from "@/lib/snooze";

const both = { right: true, left: true };

describe("R31 swipe rules", () => {
  it("only a mostly horizontal move takes over from the list scroll", () => {
    expect(shouldCaptureSwipe(4, 0)).toBe(false);
    expect(shouldCaptureSwipe(30, 5)).toBe(true);
    expect(shouldCaptureSwipe(30, 25)).toBe(false);
    expect(shouldCaptureSwipe(-30, 2)).toBe(true);
  });

  it("arms a side past the commit line, only if that side has an action", () => {
    const w = 400, line = w * SWIPE.commitRatio;
    expect(armedSide(line - 1, w, both)).toBeNull();
    expect(armedSide(line, w, both)).toBe("right");
    expect(armedSide(-line, w, both)).toBe("left");
    expect(armedSide(-line, w, { right: true, left: false })).toBeNull();
  });

  it("a release commits past the line or on a fast flick, otherwise springs back", () => {
    expect(releaseSide(200, 0, 400, both)).toBe("right");
    expect(releaseSide(60, 1.2, 400, both)).toBe("right");
    expect(releaseSide(-60, -1.2, 400, both)).toBe("left");
    expect(releaseSide(60, -1.2, 400, both)).toBeNull(); // flicked back the other way
    expect(releaseSide(20, 2, 400, both)).toBeNull(); // too short
    expect(releaseSide(60, 0.1, 400, both)).toBeNull(); // too slow
    expect(releaseSide(-200, 0, 400, { right: true, left: false })).toBeNull();
  });

  it("a side with no action only rubber bands a little", () => {
    expect(clampTravel(100, both)).toBe(100);
    expect(clampTravel(100, { right: false, left: true })).toBeLessThanOrEqual(16);
    expect(clampTravel(-100, { right: true, left: false })).toBeGreaterThanOrEqual(-16);
  });
});

describe("R31 undo queue", () => {
  const a = (key: string, rowId: string) => ({ key, rowId, label: "Archived", at: 1 });

  it("hides rows while their action waits and shows the newest in the toast", () => {
    let s = undoReducer(emptyUndo, { type: "add", action: a("k1", "m1") });
    s = undoReducer(s, { type: "add", action: a("k2", "m2") });
    expect([...hiddenIds(s)].sort()).toEqual(["m1", "m2"]);
    expect(newestPending(s)?.key).toBe("k2");
  });

  it("undo brings the row back; commit clears it too", () => {
    let s = undoReducer(emptyUndo, { type: "add", action: a("k1", "m1") });
    s = undoReducer(s, { type: "add", action: a("k2", "m2") });
    s = undoReducer(s, { type: "undo", key: "k2" });
    expect([...hiddenIds(s)]).toEqual(["m1"]);
    s = undoReducer(s, { type: "commit", key: "k1" });
    expect(newestPending(s)).toBeNull();
  });

  it("a second action on the same row replaces the first", () => {
    let s = undoReducer(emptyUndo, { type: "add", action: a("k1", "m1") });
    s = undoReducer(s, { type: "add", action: a("k2", "m1") });
    expect(s.pending.map((p) => p.key)).toEqual(["k2"]);
  });
});

describe("R31 snooze presets", () => {
  it("has the three presets in order", () => {
    expect(SNOOZE_PRESETS.map((p) => p.label)).toEqual(["Later today", "Tomorrow", "Next week"]);
    expect(snoozeLabel("next_week")).toBe("Next week");
  });

  it("works out the wake time", () => {
    const mon10 = new Date(2026, 9, 26, 10, 15); // Monday 26 Oct 2026, 10:15
    expect(snoozeUntil("later_today", mon10)).toEqual(new Date(2026, 9, 26, 13, 0));
    expect(snoozeUntil("tomorrow", mon10)).toEqual(new Date(2026, 9, 27, 8, 0));
    expect(snoozeUntil("next_week", mon10)).toEqual(new Date(2026, 10, 2, 8, 0));
    const mon19 = new Date(2026, 9, 26, 19, 0);
    expect(snoozeUntil("later_today", mon19)).toEqual(new Date(2026, 9, 27, 8, 0));
    const sun = new Date(2026, 10, 1, 9, 0);
    expect(snoozeUntil("next_week", sun)).toEqual(new Date(2026, 10, 2, 8, 0));
  });
});
