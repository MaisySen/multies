/**
 * R29: the long press then drag gesture behind the checklist's grip, as plain JavaScript so it ships
 * over the air (no native gesture library) and can be tested without a phone. A finger resting on
 * the grip for `liftMs` lifts the row; moving more than `slop` points before that cancels the lift
 * so the page can scroll. Wire the returned handlers into PanResponder.create.
 */
export interface LiftCallbacks { onStart: () => void; onMove: (dy: number) => void; onEnd: (dy: number | null) => void }

export function liftGesture(callbacks: LiftCallbacks | (() => LiftCallbacks), liftMs = 200, slop = 10) {
  const cb = () => (typeof callbacks === "function" ? callbacks() : callbacks);
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const finish = (dy: number | null) => {
    clear();
    const was = active;
    active = false;
    if (was) cb().onEnd(dy);
  };
  return {
    isActive: () => active,
    dispose: clear,
    handlers: {
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => active,
      onPanResponderGrant: () => {
        clear();
        timer = setTimeout(() => { timer = null; active = true; cb().onStart(); }, liftMs);
      },
      onPanResponderMove: (_e: unknown, g: { dx: number; dy: number }) => {
        if (active) cb().onMove(g.dy);
        else if (Math.abs(g.dy) > slop || Math.abs(g.dx) > slop) clear();
      },
      onPanResponderTerminationRequest: () => !active,
      onPanResponderRelease: (_e: unknown, g: { dy: number }) => finish(g.dy),
      onPanResponderTerminate: () => finish(null),
      onShouldBlockNativeResponder: () => true,
    },
  };
}
