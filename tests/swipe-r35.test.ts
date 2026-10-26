import { describe, expect, it } from "vitest";
import { SWIPE, commitDistance, crossedCommit, swipeAxis, swipeOffset, swipeOutcome } from "../src/web/lib/swipe";

const both = { left: true, right: true };

describe("swipe gesture maths (R35)", () => {
  it("waits for the slop, then picks an axis", () => {
    expect(swipeAxis(4, 3)).toBeNull();
    expect(swipeAxis(30, 5)).toBe("x");
    expect(swipeAxis(-30, 5)).toBe("x");
    expect(swipeAxis(12, 10)).toBe("y");
    expect(swipeAxis(2, 40)).toBe("y");
  });

  it("commits at 60% of the row but never under 180 px", () => {
    expect(commitDistance(390)).toBe(234);
    expect(commitDistance(250)).toBe(SWIPE.commitMin);
  });

  it("follows the finger, resists past 85%, and stays put on a side with no action", () => {
    expect(swipeOffset(-50, 390, both)).toBe(-50);
    const far = swipeOffset(-400, 390, both);
    expect(far).toBeLessThan(0);
    expect(Math.abs(far)).toBeLessThan(400);
    expect(Math.abs(far)).toBeGreaterThan(390 * 0.85);
    expect(swipeOffset(-80, 390, { left: false, right: true })).toBe(0);
    expect(swipeOffset(80, 390, { left: true, right: false })).toBe(0);
  });

  it("does nothing under the reveal point", () => {
    expect(swipeOutcome(-40, 390, -2, both)).toEqual({ kind: "none" });
    expect(swipeOutcome(0, 390, 0, both)).toEqual({ kind: "none" });
  });

  it("reveals between the reveal point and the commit line on a slow release", () => {
    expect(swipeOutcome(-100, 390, -0.1, both)).toEqual({ kind: "reveal", direction: "left" });
    expect(swipeOutcome(100, 390, 0.1, both)).toEqual({ kind: "reveal", direction: "right" });
  });

  it("commits on a long swipe or a quick flick the same way", () => {
    expect(swipeOutcome(-240, 390, 0, both)).toEqual({ kind: "commit", direction: "left" });
    expect(swipeOutcome(90, 390, 0.9, both)).toEqual({ kind: "commit", direction: "right" });
    // A flick back towards the start does not commit.
    expect(swipeOutcome(90, 390, -0.9, both)).toEqual({ kind: "reveal", direction: "right" });
  });

  it("never commits a side with no action", () => {
    expect(swipeOutcome(-300, 390, -1, { left: false, right: true })).toEqual({ kind: "none" });
  });

  it("bumps once when the commit line is crossed", () => {
    expect(crossedCommit(-200, -240, 390)).toBe(true);
    expect(crossedCommit(-240, -260, 390)).toBe(false);
    expect(crossedCommit(-240, -200, 390)).toBe(false);
  });
});
