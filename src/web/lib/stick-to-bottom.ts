/**
 * R100b: a chat opens at its newest message and stays there while pictures, cards and previews load above it.
 * The list follows the bottom only while the reader is at (or near) the bottom; once they scroll up it stays put.
 */
import { useEffect, useMemo, useRef, type RefObject } from "react";

/** True when the scroll box shows its end (within `slack` pixels). */
export function nearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 96): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * Keeps `box` scrolled to the end while the reader is there. `resetKey` (the channel and topic) starts each view at
 * the end; `hold` (a jump to a message) leaves the scroll alone.
 */
export function useStickToBottom(box: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, resetKey: string, hold: boolean) {
  const stick = useRef(true);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  useEffect(() => { stick.current = !holdRef.current; }, [resetKey]);
  useEffect(() => {
    const el = box.current;
    const inner = content.current;
    if (!el || !inner) return;
    const toEnd = () => { if (stick.current && !holdRef.current) el.scrollTop = el.scrollHeight; };
    const onScroll = () => { stick.current = nearBottom(el); };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(toEnd);
    ro?.observe(inner);
    toEnd();
    return () => { el.removeEventListener("scroll", onScroll); ro?.disconnect(); };
  }, [box, content, resetKey]);
  // Stable across renders, so it can sit in effect dependency lists.
  return useMemo(() => ({
    /** Call before a programmatic jump to a message so the list does not snap back to the end. */
    release: () => { stick.current = false; },
    /** Call when the reader sends or a new message should bring the list to the end. */
    toEnd: () => { stick.current = true; const el = box.current; if (el) el.scrollTop = el.scrollHeight; },
  }), [box]);
}
