/**
 * F13b (MB-294, MB-310, MB-319): one pattern for a row of tabs that can be wider than a phone. The row scrolls
 * sideways inside itself (the page never scrolls sideways), each edge fades while there is more that way, every tab
 * stays a normal focusable control, and the active tab is scrolled into view when it changes.
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { cn } from "@/web/lib/cn";

const FADE = 28;

/** The mask for a row that has more to the left, the right, both or neither. */
export function rowMask(left: boolean, right: boolean): string {
  if (!left && !right) return "none";
  const a = left ? `transparent 0, #000 ${FADE}px` : "#000 0";
  const b = right ? `#000 calc(100% - ${FADE}px), transparent 100%` : "#000 100%";
  return `linear-gradient(to right, ${a}, ${b})`;
}

/** How far to scroll a row so an item is fully in view with room for the fade (0 when it already is). */
export function scrollDelta(row: { left: number; right: number }, item: { left: number; right: number }, pad = FADE): number {
  if (item.left < row.left + pad) return item.left - row.left - pad;
  if (item.right > row.right - pad) return item.right - row.right + pad;
  return 0;
}

const ACTIVE = '[aria-selected="true"],[aria-current="page"],[aria-current="true"]';

type Props = HTMLAttributes<HTMLDivElement> & { as?: "div" | "nav"; activeKey?: unknown; outerClassName?: string };

export const ScrollRow = forwardRef<HTMLDivElement, Props>(function ScrollRow({ as = "div", activeKey, className, outerClassName, style, children, ...rest }, fwd) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = max > 1 && el.scrollLeft < max - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener("scroll", measure); };
  }, [measure]);
  useEffect(() => {
    const el = ref.current;
    const item = el?.querySelector<HTMLElement>(ACTIVE);
    if (!el || !item || el.scrollWidth <= el.clientWidth) return;
    const d = scrollDelta(el.getBoundingClientRect(), item.getBoundingClientRect());
    if (d) el.scrollLeft += d;
    measure();
  }, [activeKey, measure]);
  const Tag = as;
  return (
    <div className={cn("relative min-w-0 max-w-full", outerClassName)}>
      <Tag
        ref={(el: HTMLDivElement | null) => { ref.current = el; if (typeof fwd === "function") fwd(el); else if (fwd) fwd.current = el; }}
        className={cn("no-scrollbar overflow-x-auto overscroll-x-contain [mask-image:var(--row-mask)] [-webkit-mask-image:var(--row-mask)]", className)}
        style={{ ...style, ["--row-mask" as string]: rowMask(edges.left, edges.right) }}
        data-overflow={edges.left || edges.right ? "" : undefined}
        {...rest}>
        {children}
      </Tag>
    </div>
  );
});
