/** React side of the phone helpers (R25 wave 2): media queries that follow the screen, and a long press. */
import { useEffect, useMemo, useRef, useSyncExternalStore, type TouchEvent, type MouseEvent } from "react";
import { PHONE_QUERY, TOUCH_QUERY } from "./phone";
import { createLongPress } from "./message-actions";

function subscribe(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  };
}
const read = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** Whether a media query matches now, updated when the screen turns or the window is resized. */
export function useMediaQuery(query: string): boolean {
  const sub = useMemo(() => subscribe(query), [query]);
  return useSyncExternalStore(sub, () => read(query), () => false);
}

/** Phones (under 640 px) and touch screens with no hover: actions sit behind one button or a long press. */
export function useCompactActions(): boolean {
  const phone = useMediaQuery(PHONE_QUERY);
  const touch = useMediaQuery(TOUCH_QUERY);
  return phone || touch;
}

/** Touch handlers that call `onLongPress` after a resting press; off when `enabled` is false. */
export function useLongPress(onLongPress: () => void, enabled: boolean) {
  const cb = useRef(onLongPress);
  useEffect(() => { cb.current = onLongPress; }, [onLongPress]);
  const lp = useMemo(() => createLongPress(() => {
    cb.current();
    try { navigator.vibrate?.(10); } catch { /* not supported */ }
  }), []);
  useEffect(() => () => lp.cancel(), [lp]);
  if (!enabled) return {};
  return {
    onTouchStart: (e: TouchEvent) => {
      // A press inside an open sheet or menu (rendered within the element) is not a press on the element.
      if ((e.target as Element | null)?.closest?.("dialog, [role=menu], [role=dialog]")) { lp.cancel(); return; }
      const t = e.touches[0]; if (t) lp.start(t.clientX, t.clientY, e.touches.length);
    },
    onTouchMove: (e: TouchEvent) => { const t = e.touches[0]; if (t) lp.move(t.clientX, t.clientY); },
    onTouchEnd: () => lp.end(),
    onTouchCancel: () => lp.cancel(),
    // The phone's own long press menu (copy, look up) would cover ours.
    onContextMenu: (e: MouseEvent) => { if (lp.fired || lp.pending) e.preventDefault(); },
    onClickCapture: (e: MouseEvent) => { if (lp.consumeClick()) { e.preventDefault(); e.stopPropagation(); } },
  };
}
