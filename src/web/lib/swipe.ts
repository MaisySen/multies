/**
 * R35 Premium pass 2: the gesture maths behind swipe actions on list rows (mobile web, touch only, under 768 px).
 * Pure functions so the thresholds are unit tested (tests/swipe-r35.test.ts). Numbers follow the system mail app
 * feel: a 10 px slop before the row moves, the action shows from 72 px, a long swipe (60 % of the row, at least
 * 180 px) or a quick flick past the reveal point commits, and the row resists past 85 % of its width.
 */
export const SWIPE = {
  /** Movement before we decide the finger is swiping sideways or scrolling. */
  slop: 10,
  /** Sideways must beat vertical by this ratio (about 30 degrees) to count as a swipe. */
  axisRatio: 1.7,
  /** Past this the action shows and a release leaves the row open on its button. */
  reveal: 72,
  /** Share of the row width that commits on release. */
  commitRatio: 0.6,
  /** Commit never needs less than this many pixels, so narrow rows still need a real swipe. */
  commitMin: 180,
  /** A flick at or above this speed (px per ms) past the reveal point commits. */
  flickVelocity: 0.65,
  /** Rubber band starts at this share of the width. */
  resistFrom: 0.85,
} as const;

export type SwipeDirection = "left" | "right";
export type SwipeOutcome = { kind: "none" } | { kind: "reveal" | "commit"; direction: SwipeDirection };

/** Whether a gesture so far is a sideways swipe ("x"), a scroll ("y"), or not decided yet (null). */
export function swipeAxis(dx: number, dy: number, s = SWIPE): "x" | "y" | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < s.slop && ay < s.slop) return null;
  return ax >= ay * s.axisRatio ? "x" : "y";
}

/** The pixels at which a release commits for a row this wide. */
export function commitDistance(width: number, s = SWIPE): number {
  return Math.max(s.commitMin, Math.round(width * s.commitRatio));
}

/** Where the row is drawn for a finger offset: 1:1, then a rubber band; 0 on a side with no action. */
export function swipeOffset(dx: number, width: number, sides: { left: boolean; right: boolean }, s = SWIPE): number {
  // dx < 0 is a swipe to the left, which draws the "left" action from the right edge.
  if ((dx < 0 && !sides.left) || (dx > 0 && !sides.right)) return 0;
  const limit = width * s.resistFrom;
  const ax = Math.abs(dx);
  if (ax <= limit) return dx;
  const extra = ax - limit;
  return Math.sign(dx) * (limit + extra / (1 + extra / 60));
}

/** What a release does, from the drawn offset, the row width and the speed of the last move (px per ms). */
export function swipeOutcome(offset: number, width: number, velocity: number, sides: { left: boolean; right: boolean }, s = SWIPE): SwipeOutcome {
  if (offset === 0) return { kind: "none" };
  const direction: SwipeDirection = offset < 0 ? "left" : "right";
  if ((direction === "left" && !sides.left) || (direction === "right" && !sides.right)) return { kind: "none" };
  const ax = Math.abs(offset);
  const sameWay = Math.sign(velocity) === Math.sign(offset);
  if (ax >= commitDistance(width, s)) return { kind: "commit", direction };
  if (ax >= s.reveal && sameWay && Math.abs(velocity) >= s.flickVelocity) return { kind: "commit", direction };
  if (ax >= s.reveal) return { kind: "reveal", direction };
  return { kind: "none" };
}

/** True when this crossing of the commit line is new, so the action icon bumps once (the haptic-like cue). */
export function crossedCommit(prev: number, next: number, width: number, s = SWIPE): boolean {
  const d = commitDistance(width, s);
  return Math.abs(prev) < d && Math.abs(next) >= d;
}
