import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * R43 (MB-210): a small windowing hook for long lists. A list below `minCount` rows renders every row (nothing
 * changes for normal lists). From there on only the rows on screen plus `overscan` above and below are in the DOM;
 * spacer rows keep the scroll height, so the scrollbar, sticky headers and the page around the list behave as before.
 *
 * Works with an explicit scroll box (`scrollRef`) or finds the nearest scrolling ancestor, else the window. Row
 * height starts at `estimate` and follows the average of the rendered rows, so card rows of a few heights work too.
 */
export const WINDOW_FROM = 150;

export interface WindowedList {
  windowed: boolean;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  rowHeight: number;
  /** Brings row `index` into view (rendering it first when it is outside the window). */
  scrollToIndex: (index: number) => void;
}

interface Options {
  count: number;
  estimate: number;
  listRef: RefObject<HTMLElement | null>;
  scrollRef?: RefObject<HTMLElement | null>;
  overscan?: number;
  minCount?: number;
}

const isScroller = (el: HTMLElement) => {
  const o = getComputedStyle(el).overflowY;
  return (o === "auto" || o === "scroll" || o === "overlay") && el.scrollHeight > el.clientHeight + 1;
};

export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) if (isScroller(p)) return p;
  return null;
}

/** Pure range math, exported for tests: which rows cover `offset` to `offset + viewport`, plus overscan. */
export function windowRange(count: number, rowHeight: number, offset: number, viewport: number, overscan: number): [number, number] {
  const h = Math.max(1, rowHeight);
  const first = Math.min(count, Math.max(0, Math.floor(offset / h) - overscan));
  const last = Math.min(count, Math.max(first, Math.ceil((offset + Math.max(0, viewport)) / h) + overscan));
  return [first, last];
}

export function useWindowedList({ count, estimate, listRef, scrollRef, overscan = 8, minCount = WINDOW_FROM }: Options): WindowedList {
  const windowed = count >= minCount;
  const [rowHeight, setRowHeight] = useState(estimate);
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(count, 40)]);
  const hRef = useRef(rowHeight);
  hRef.current = rowHeight;

  const scroller = useCallback(() => scrollRef?.current ?? findScrollParent(listRef.current), [listRef, scrollRef]);

  const compute = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const sc = scroller();
    const listTop = list.getBoundingClientRect().top;
    const viewTop = sc ? sc.getBoundingClientRect().top : 0;
    const viewH = sc ? sc.clientHeight : window.innerHeight;
    const next = windowRange(count, hRef.current, viewTop - listTop, viewH, overscan);
    setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : next));
  }, [count, overscan, listRef, scroller]);

  // Follow scrolling and resizing, one update per frame.
  useEffect(() => {
    if (!windowed) return;
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; compute(); }); };
    const sc = scroller();
    const target: HTMLElement | Window = sc ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // Scrolls of an outer box (the page) move the list too.
    if (sc) window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    compute();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (sc) window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [windowed, compute, scroller]);

  // Measure the rendered rows; their average height drives the spacers. Runs after every render on purpose; the
  // half pixel guard stops it from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!windowed) return;
    const list = listRef.current;
    if (!list) return;
    const rows = list.querySelectorAll<HTMLElement>(":scope > [data-win-row]");
    let sum = 0;
    for (const r of rows) sum += r.offsetHeight;
    const avg = rows.length ? sum / rows.length : 0;
    if (avg > 0 && Math.abs(avg - hRef.current) > 0.5) setRowHeight(avg);
  });

  useLayoutEffect(() => { if (windowed) compute(); }, [windowed, count, rowHeight, compute]);

  const scrollToIndex = useCallback((index: number) => {
    const list = listRef.current;
    if (!list || index < 0 || index >= count) return;
    const el = list.querySelector<HTMLElement>(`:scope > [data-win-row="${index}"]`);
    if (el) { el.scrollIntoView({ block: "nearest" }); return; }
    const sc = scroller();
    const h = hRef.current;
    if (sc) {
      const top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTop = Math.max(0, top + index * h - sc.clientHeight / 2);
    } else {
      const top = list.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, top + index * h - window.innerHeight / 2) });
    }
    compute();
  }, [count, listRef, scroller, compute]);

  if (!windowed) return { windowed, start: 0, end: count, padTop: 0, padBottom: 0, rowHeight, scrollToIndex };
  const start = Math.min(range[0], count);
  const end = Math.min(Math.max(range[1], start), count);
  return { windowed, start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight, rowHeight, scrollToIndex };
}

/** Asks a windowed list to bring a row into view (J and K over a long list); lists listen for it. */
export const REVEAL_EVENT = "multies:reveal-row";
export function requestReveal(id: string) { window.dispatchEvent(new CustomEvent<string>(REVEAL_EVENT, { detail: id })); }
export function useRevealRow(ids: string[], win: WindowedList, listRef: RefObject<HTMLElement | null>) {
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const scrollRef = useRef(win.scrollToIndex);
  scrollRef.current = win.scrollToIndex;
  const on = win.windowed;
  useEffect(() => {
    if (!on) return;
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const i = idsRef.current.indexOf(id);
      if (i < 0) return;
      scrollRef.current(i);
      // Once the row is rendered, give it the keyboard ring the focus hook would have set.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = listRef.current?.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
        if (el) { el.setAttribute("data-kb-focus", ""); el.scrollIntoView({ block: "nearest" }); }
      }));
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [on, listRef]);
}
