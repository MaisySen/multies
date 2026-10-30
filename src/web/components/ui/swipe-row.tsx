/**
 * R35 Premium pass 2: swipe actions on a list row, on phones only (touch, under 768 px). The row follows the
 * finger; the action shows underneath from the reveal point; a long swipe or a quick flick commits; a short one
 * leaves the action button showing until the next tap. Mouse, pen and keyboard use are untouched, so the existing
 * shortcuts and selection mode keep working. The maths is in lib/swipe.ts.
 */
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import type { IconComponent } from "@/web/components/ui/icon";
import { crossedCommit, swipeAxis, swipeOffset, swipeOutcome } from "@/web/lib/swipe";

export type SwipeAction = { label: string; icon: IconComponent; tone: "blue" | "orange" | "green" | "grey" | "red"; onCommit: () => void };

const TONE: Record<SwipeAction["tone"], string> = { blue: "#0071E3", orange: "#C25E00", green: "#1E7B34", grey: "#636366", red: "#D70015" };

function phoneTouch(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches;
}

/** The gesture as a hook, so a div row and a table row share it. */
export function useSwipe<T extends HTMLElement>({ left, right, disabled }: { left?: SwipeAction; right?: SwipeAction; disabled?: boolean }) {
  const [x, setX] = useState(0);
  const [settling, setSettling] = useState(false);
  const [bump, setBump] = useState(false);
  const ref = useRef<T>(null);
  const g = useRef<{ id: number; sx: number; sy: number; axis: "x" | "y" | null; last: number; lt: number; v: number; base: number } | null>(null);
  const sides = { left: !!left, right: !!right };
  const on = !disabled && !!(left || right);

  // A tap anywhere else closes an open row.
  useEffect(() => {
    if (x === 0 || g.current) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) { setSettling(true); setX(0); } };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [x]);

  const width = () => ref.current?.getBoundingClientRect().width ?? 390;
  const commit = (a: SwipeAction, dir: "left" | "right") => {
    setSettling(true);
    setX(dir === "left" ? -width() : width());
    window.setTimeout(() => { a.onCommit(); setSettling(false); setX(0); }, 200);
  };
  const handlers: HTMLAttributes<T> = on ? {
    onPointerDown: (e) => {
      if (e.pointerType !== "touch" || !phoneTouch()) return;
      g.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, axis: null, last: e.clientX, lt: e.timeStamp, v: 0, base: x };
      setSettling(false);
    },
    onPointerMove: (e) => {
      const s = g.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.sx;
      if (!s.axis) s.axis = swipeAxis(dx, e.clientY - s.sy);
      if (s.axis !== "x") return;
      const dt = Math.max(1, e.timeStamp - s.lt);
      s.v = (e.clientX - s.last) / dt;
      s.last = e.clientX; s.lt = e.timeStamp;
      const w = width();
      const next = swipeOffset(s.base + dx, w, sides);
      if (crossedCommit(x, next, w)) { setBump(true); window.setTimeout(() => setBump(false), 260); }
      setX(next);
    },
    onPointerUp: () => {
      const s = g.current;
      g.current = null;
      if (!s || s.axis !== "x") return;
      const out = swipeOutcome(x, width(), s.v, sides);
      setSettling(true);
      if (out.kind === "commit") { const a = out.direction === "left" ? left : right; if (a) commit(a, out.direction); return; }
      if (out.kind === "reveal") { setX(out.direction === "left" ? -88 : 88); return; }
      setX(0);
    },
    onPointerCancel: () => { g.current = null; setSettling(true); setX(0); },
    onClickCapture: (e) => { if (x !== 0) { e.preventDefault(); e.stopPropagation(); setSettling(true); setX(0); } },
  } : {};
  const showing = x < 0 ? left : x > 0 ? right : undefined;
  const moving: CSSProperties = x ? { transform: `translate3d(${x}px,0,0)` } : {};
  return { ref, x, on, showing, bump, settling, handlers, moving, commit, width };
}

function ActionFace({ a, bump, onPress }: { a: SwipeAction; bump: boolean; onPress: () => void }) {
  return (
    <button type="button" className="flex flex-col items-center gap-0.5 text-white" data-commit={bump || undefined}
      onClick={(e) => { e.stopPropagation(); onPress(); }} aria-label={a.label}>
      <a.icon size={22} filled className={bump ? "animate-bump" : undefined} />
      <span className="text-[12px] font-semibold">{a.label}</span>
    </button>
  );
}

export function SwipeRow({ left, right, disabled, children, testId }: {
  /** Swipe to the left (the action shows on the right edge). */
  left?: SwipeAction;
  /** Swipe to the right (the action shows on the left edge). */
  right?: SwipeAction;
  /** Selection mode and similar: no swiping. */
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const s = useSwipe<HTMLDivElement>({ left, right, disabled });
  if (!s.on) return <>{children}</>;
  return (
    <div ref={s.ref} className="swipe-row" data-testid={testId} {...s.handlers}>
      {s.showing && (
        <div className="swipe-row__action" style={{ background: TONE[s.showing.tone], justifyContent: s.x < 0 ? "flex-end" : "flex-start" }}>
          <ActionFace a={s.showing} bump={s.bump} onPress={() => s.commit(s.showing!, s.x < 0 ? "left" : "right")} />
        </div>
      )}
      <div className="swipe-row__content" data-settling={s.settling || undefined} style={s.moving}>{children}</div>
    </div>
  );
}

/**
 * The action strip for a table row that uses useSwipe: put it inside the row's first cell (position: relative).
 * It sits just outside the row on the side being revealed and moves in with the row.
 */
export function SwipeEdge({ s }: { s: ReturnType<typeof useSwipe<HTMLTableRowElement>> }) {
  if (!s.showing || !s.x) return null;
  const w = Math.abs(s.x);
  const style: CSSProperties = s.x > 0
    ? { right: "100%", width: w, background: TONE[s.showing.tone], justifyContent: "flex-start" }
    : { left: s.width(), width: w, background: TONE[s.showing.tone], justifyContent: "flex-end" };
  return (
    <span className="swipe-row__action" style={{ ...style, inset: undefined, top: 0, bottom: 0 }}>
      <ActionFace a={s.showing} bump={s.bump} onPress={() => s.commit(s.showing!, s.x < 0 ? "left" : "right")} />
    </span>
  );
}

/** A table row with the same gesture (task list on phones). `edge` renders the row's cells; put its argument in the first cell. */
export function SwipeTr({ left, right, disabled, edge, style, ...rest }: Omit<HTMLAttributes<HTMLTableRowElement>, "children"> & {
  left?: SwipeAction; right?: SwipeAction; disabled?: boolean; edge: (edge: ReactNode) => ReactNode; [data: `data-${string}`]: string | undefined;
}) {
  const s = useSwipe<HTMLTableRowElement>({ left, right, disabled });
  const motion: CSSProperties = s.on ? { ...s.moving, touchAction: "pan-y", transition: s.settling ? "transform var(--duration-slow) var(--ease-spring)" : undefined } : {};
  return <tr ref={s.ref} {...rest} {...s.handlers} style={{ ...style, ...motion }}>{edge(s.on ? <SwipeEdge s={s} /> : null)}</tr>;
}
