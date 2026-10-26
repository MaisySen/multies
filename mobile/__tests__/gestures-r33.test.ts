import { DEFAULT_PREFS, parsePrefs } from "@/lib/prefs";
import { hapticsAllowed } from "@/lib/haptics";
import { SWIPE, stageKey, swipeStage } from "@/lib/swipe";

describe("R33 haptic map", () => {
  it("plays only on a phone, without Reduce Motion, with the Settings switch on", () => {
    expect(hapticsAllowed({ platform: "ios", reduce: false, enabled: true })).toBe(true);
    expect(hapticsAllowed({ platform: "web", reduce: false, enabled: true })).toBe(false);
    expect(hapticsAllowed({ platform: "ios", reduce: true, enabled: true })).toBe(false);
    expect(hapticsAllowed({ platform: "android", reduce: false, enabled: false })).toBe(false);
  });
});

describe("R33 swipe choices", () => {
  it("keeps defaults for missing or unknown saved values", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    const p = parsePrefs(JSON.stringify({ haptics: false, mailSwipes: { rightShort: "delete", leftLong: "explode" }, taskSwipes: { leftShort: "none" } }));
    expect(p.haptics).toBe(false);
    expect(p.mailSwipes).toEqual({ ...DEFAULT_PREFS.mailSwipes, rightShort: "delete" });
    expect(p.taskSwipes.leftShort).toBe("none");
  });
  it("arms the long action past the long line only when the side has one", () => {
    const w = 400, en = { right: true, left: true };
    expect(swipeStage(10, w, en, { right: true, left: true })).toBeNull();
    expect(swipeStage(w * SWIPE.commitRatio + 1, w, en, { right: true, left: true })).toEqual({ side: "right", long: false });
    expect(swipeStage(w * SWIPE.longRatio + 1, w, en, { right: true, left: false })).toEqual({ side: "right", long: true });
    expect(swipeStage(-(w * SWIPE.longRatio + 1), w, en, { right: true, left: false })).toEqual({ side: "left", long: false });
    expect(stageKey({ side: "left", long: true })).toBe("left:long");
  });
});
