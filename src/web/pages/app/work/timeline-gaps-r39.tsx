/**
 * R39: the lead or lag on a "blocked by" link, drawn on the timeline.
 * - A lag (the waiting task starts N days after its blocker ends) is a dashed ghost band over the gap days, in the
 *   waiting task's row, with a "+3d" pill in its middle.
 * - A lead (it starts N days before its blocker ends) is a slim bracket over the overlapping days, just above the
 *   waiting task's bar, with a "1d early" pill.
 * Drawn in our own overlay inside the chart's scrolling area (`.wx-area`), so it scrolls with the bars and the chart core
 * stays untouched. Positions come from the bars on screen; a link whose bars are not rendered is skipped.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/web/lib/cn";
import { dayWord, lagLabel } from "./schedule-r38";

export interface GapLink { from: string; to: string; lag?: number }
export interface GapBox { kind: "lag" | "lead"; left: number; width: number; top: number; height: number }

/** Where the gap goes, in chart content pixels. `srcRight` is where the blocker ends, `tgt*` is the waiting task's bar. */
export function gapGeometry(lag: number, srcRight: number, tgt: { left: number; top: number; height: number }, cellWidth: number): GapBox | null {
  if (!lag) return null;
  if (lag > 0) {
    // The real gap on screen (it can be wider than lag days when days off are skipped); a clash leaves no room, so the
    // band shows the wait it should have had, running into the bar.
    const real = tgt.left - srcRight;
    const width = real >= cellWidth / 2 ? real : lag * cellWidth;
    return { kind: "lag", left: srcRight, width, top: tgt.top, height: tgt.height };
  }
  const width = Math.abs(lag) * cellWidth;
  return { kind: "lead", left: srcRight - width, width, top: tgt.top - 7, height: 5 };
}

export const gapPill = (lag: number) => (lag > 0 ? `+${lag}d` : `${Math.abs(lag)}d early`);
export function gapTitle(lag: number, blockerRef: string, workingDays?: boolean) {
  const unit = workingDays ? (Math.abs(lag) === 1 ? "1 working day" : `${Math.abs(lag)} working days`) : dayWord(lag);
  return lag > 0 ? `Waits ${unit} after ${blockerRef} ends` : `${lagLabel(lag).replace(dayWord(lag), unit)}, before ${blockerRef} ends`;
}

const barSel = (id: string) => `.wx-bar[data-task-id=':${CSS.escape(id)}'], .wx-bar[data-task-id='${CSS.escape(id)}']`;

export function LagGaps({ root, links, refs, cellWidth, version, workingDays }: { root: React.RefObject<HTMLElement | null>; links: GapLink[]; refs: Map<string, string>; cellWidth: number; version: string; workingDays?: boolean }) {
  const [state, setState] = useState<{ host: HTMLElement; boxes: (GapBox & { key: string; lag: number; title: string })[] } | null>(null);
  const withLag = links.filter((l) => l.lag);
  const sig = withLag.map((l) => `${l.from}>${l.to}:${l.lag}`).join(",");
  useEffect(() => {
    if (!withLag.length) { setState(null); return; }
    let tries = 0, raf = 0;
    const place = () => {
      const el = root.current;
      const host = el?.querySelector<HTMLElement>(".wx-area");
      if (!el || !host) { if (tries++ < 40) raf = requestAnimationFrame(place); return; }
      const hb = host.getBoundingClientRect();
      const boxes: (GapBox & { key: string; lag: number; title: string })[] = [];
      let missing = 0;
      for (const l of withLag) {
        const src = el.querySelector<HTMLElement>(barSel(l.from));
        const tgt = el.querySelector<HTMLElement>(barSel(l.to));
        if (!src || !tgt) { missing++; continue; }
        const sb = src.getBoundingClientRect(), tb = tgt.getBoundingClientRect();
        const g = gapGeometry(l.lag!, sb.right - hb.left, { left: tb.left - hb.left, top: tb.top - hb.top, height: tb.height }, cellWidth);
        if (g) boxes.push({ ...g, key: `${l.from}>${l.to}`, lag: l.lag!, title: gapTitle(l.lag!, refs.get(l.from) ?? "the task it waits on", workingDays) });
      }
      if (missing && boxes.length === 0 && tries++ < 40) { raf = requestAnimationFrame(place); return; }
      setState({ host, boxes });
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { tries = 0; place(); }) : null;
    if (root.current && ro) ro.observe(root.current);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [root, sig, cellWidth, version, workingDays]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state || !state.boxes.length) return null;
  return createPortal(
    <div aria-hidden={false} className="pointer-events-none absolute inset-0 z-[4]" data-testid="timeline-lag-gaps">
      {state.boxes.map((b) => (
        <div key={b.key} data-testid="timeline-lag-gap" data-kind={b.kind} title={b.title} role="img" aria-label={b.title}
          className={cn("absolute motion-safe:animate-[fadeIn_180ms_ease-out]", b.kind === "lag" ? "mm-gap-lag" : "mm-gap-lead")}
          style={{ left: b.left, width: Math.max(b.width, 2), top: b.top, height: b.height }}>
          <span className="mm-gap-pill pointer-events-auto">{gapPill(b.lag)}</span>
        </div>
      ))}
    </div>,
    state.host,
  );
}
