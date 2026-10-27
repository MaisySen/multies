import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

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
  /**
   * R44: one stable key per row (task ids). With keys, each row's measured height is cached by its key and the
   * spacers sum the real heights (unknown rows count as the average of the measured ones), so cards of very
   * different heights (a board column) scroll without jumps, and a row keeps its height when rows move.
   */
  keys?: readonly string[];
  /** R44: space between rows that offsetHeight does not include (a flex gap), added to every measured row. */
  gap?: number;
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

/** R44: prefix offsets for rows of measured heights; `offsets[i]` is the top of row i, `offsets[count]` the full height. */
export function rowOffsets(keys: readonly string[], sizes: ReadonlyMap<string, number>, fallback: number): Float64Array {
  const o = new Float64Array(keys.length + 1);
  for (let i = 0; i < keys.length; i++) o[i + 1] = o[i] + (sizes.get(keys[i]) ?? fallback);
  return o;
}

/** R44: the range math of `windowRange` for rows of different heights (binary search over the prefix offsets). */
export function windowRangeVar(offsets: Float64Array, offset: number, viewport: number, overscan: number): [number, number] {
  const count = offsets.length - 1;
  const find = (y: number) => { // first row whose bottom is below y
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const first = Math.min(count, Math.max(0, find(Math.max(0, offset)) - overscan));
  const last = Math.min(count, Math.max(first, find(offset + Math.max(0, viewport)) + 1 + overscan));
  return [first, last];
}

export function useWindowedList({ count, estimate, listRef, scrollRef, overscan = 8, minCount = WINDOW_FROM, keys, gap = 0 }: Options): WindowedList {
  const windowed = count >= minCount;
  const [rowHeight, setRowHeight] = useState(estimate);
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(count, 40)]);
  const hRef = useRef(rowHeight);
  hRef.current = rowHeight;
  // R44: measured heights by row key, and a version that changes when one of them does.
  const sizes = useRef(new Map<string, number>());
  const [sizesVersion, setSizesVersion] = useState(0);
  const variable = !!keys && keys.length === count;
  const offsets = useMemo(() => (windowed && variable ? rowOffsets(keys!, sizes.current, rowHeight) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, variable, keys, rowHeight, sizesVersion]);
  const oRef = useRef(offsets);
  oRef.current = offsets;

  const scroller = useCallback(() => scrollRef?.current ?? findScrollParent(listRef.current), [listRef, scrollRef]);

  const compute = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const sc = scroller();
    const listTop = list.getBoundingClientRect().top;
    const viewTop = sc ? sc.getBoundingClientRect().top : 0;
    const viewH = sc ? sc.clientHeight : window.innerHeight;
    // R44: when the list is its own scroll box (a board column), its box does not move; its scrollTop does.
    const offset = viewTop - listTop + (sc === list ? sc.scrollTop : 0);
    const o = oRef.current;
    const next = o ? windowRangeVar(o, offset, viewH, overscan) : windowRange(count, hRef.current, offset, viewH, overscan);
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
    let changed = false;
    for (const r of rows) {
      const h = r.offsetHeight + gap;
      sum += h;
      const k = variable ? r.dataset.winKey : undefined;
      if (k && h > gap && Math.abs((sizes.current.get(k) ?? -1) - h) > 0.5) { sizes.current.set(k, h); changed = true; }
    }
    if (changed) setSizesVersion((v) => v + 1);
    if (variable) {
      // Unknown rows count as the average of every row measured so far.
      let all = 0;
      for (const v of sizes.current.values()) all += v;
      const avg = sizes.current.size ? all / sizes.current.size : 0;
      if (avg > 0 && Math.abs(avg - hRef.current) > 0.5) setRowHeight(avg);
      return;
    }
    const avg = rows.length ? sum / rows.length : 0;
    if (avg > 0 && Math.abs(avg - hRef.current) > 0.5) setRowHeight(avg);
  });

  useLayoutEffect(() => { if (windowed) compute(); }, [windowed, count, rowHeight, offsets, compute]);

  const scrollToIndex = useCallback((index: number) => {
    const list = listRef.current;
    if (!list || index < 0 || index >= count) return;
    const el = list.querySelector<HTMLElement>(`:scope > [data-win-row="${index}"]`);
    if (el) { el.scrollIntoView({ block: "nearest" }); return; }
    const sc = scroller();
    const at = oRef.current ? oRef.current[index] : index * hRef.current;
    if (sc) {
      const top = sc === list ? 0 : list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTop = Math.max(0, top + at - sc.clientHeight / 2);
    } else {
      const top = list.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, top + at - window.innerHeight / 2) });
    }
    compute();
  }, [count, listRef, scroller, compute]);

  if (!windowed) return { windowed, start: 0, end: count, padTop: 0, padBottom: 0, rowHeight, scrollToIndex };
  const start = Math.min(range[0], count);
  const end = Math.min(Math.max(range[1], start), count);
  if (offsets) {
    // Spacers stand in for the rows and their gaps; the flex gap next to each spacer is taken off again.
    const padTop = Math.max(0, offsets[start] - (start ? gap : 0));
    const padBottom = Math.max(0, offsets[count] - offsets[end] - (end < count ? gap : 0));
    return { windowed, start, end, padTop, padBottom, rowHeight, scrollToIndex };
  }
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
