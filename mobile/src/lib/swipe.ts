/**
 * R31: the rules behind swipe actions on list rows, kept apart from the gesture code so they can be
 * tested. A swipe commits when it travels far enough or is flicked fast enough in one direction;
 * crossing the line is the moment for a light haptic tick.
 */
export type SwipeSide = "right" | "left";

export const SWIPE = {
  /** Share of the row width that commits a slow swipe. */
  commitRatio: 0.35,
  /** Minimum travel in points before a flick counts. */
  flickDistance: 48,
  /** Release speed in points per millisecond that counts as a flick. */
  flickVelocity: 0.6,
  /** A horizontal move must beat the vertical one by this factor to start a swipe (so lists still scroll). */
  axisBias: 1.5,
  /** Travel before the row starts to follow the finger. */
  slop: 10,
} as const;

/** Whether a move should be taken over by the row instead of the list scroll. */
export function shouldCaptureSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > SWIPE.slop && Math.abs(dx) > Math.abs(dy) * SWIPE.axisBias;
}

/** Which side (if any) is armed at this travel. Right is a positive dx. */
export function armedSide(dx: number, width: number, enabled: { right: boolean; left: boolean }): SwipeSide | null {
  const line = Math.max(width, 1) * SWIPE.commitRatio;
  if (dx >= line && enabled.right) return "right";
  if (dx <= -line && enabled.left) return "left";
  return null;
}

/** What a release does: commit one side, or spring back (null). */
export function releaseSide(dx: number, vx: number, width: number, enabled: { right: boolean; left: boolean }): SwipeSide | null {
  const armed = armedSide(dx, width, enabled);
  if (armed) return armed;
  if (Math.abs(dx) >= SWIPE.flickDistance && Math.abs(vx) >= SWIPE.flickVelocity && Math.sign(dx) === Math.sign(vx)) {
    if (dx > 0 && enabled.right) return "right";
    if (dx < 0 && enabled.left) return "left";
  }
  return null;
}

/** Travel the row shows: free toward an enabled side, a short rubber band toward a disabled one. */
export function clampTravel(dx: number, enabled: { right: boolean; left: boolean }): number {
  if (dx > 0 && !enabled.right) return Math.min(dx * 0.15, 16);
  if (dx < 0 && !enabled.left) return Math.max(dx * 0.15, -16);
  return dx;
}

// ---------------------------------------------------------------- undo queue

/**
 * Rows swiped away hide at once and the action runs after the undo window, unless Undo is tapped.
 * This reducer is that queue: the list hides every id in `pending`, the toast shows the newest.
 */
export interface PendingAction { key: string; rowId: string; label: string; at: number }
export interface UndoState { pending: PendingAction[] }
export type UndoEvent =
  | { type: "add"; action: PendingAction }
  | { type: "undo"; key: string }
  | { type: "commit"; key: string };

export const UNDO_WINDOW_MS = 5000;
export const emptyUndo: UndoState = { pending: [] };

export function undoReducer(state: UndoState, e: UndoEvent): UndoState {
  switch (e.type) {
    case "add":
      // A second action on the same row replaces the first one (only the newest runs).
      return { pending: [...state.pending.filter((p) => p.rowId !== e.action.rowId), e.action] };
    case "undo":
    case "commit":
      return { pending: state.pending.filter((p) => p.key !== e.key) };
  }
}

export function hiddenIds(state: UndoState): Set<string> {
  return new Set(state.pending.map((p) => p.rowId));
}

export function newestPending(state: UndoState): PendingAction | null {
  return state.pending.length ? state.pending[state.pending.length - 1] : null;
}
