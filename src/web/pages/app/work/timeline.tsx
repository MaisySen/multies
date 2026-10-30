import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Gantt, Willow, WillowDark } from "@svar-ui/react-gantt";
import { useAppearance } from "@/web/components/theme";
import "@svar-ui/react-gantt/style.css";
import type { Task } from "./data";
import { TodayLine } from "./schedule-r38"; // R38: Today line
import { barSel, LagGaps, LEAD_PILL_ROOM, type GapLink } from "./timeline-gaps-r39"; // R39: lead and lag drawn on the chart

const DAY = 86_400_000;
const fmtMonth = (d: Date) => d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
const fmtDay = (d: Date) => String(d.getDate());

/* R38 labels: the task column width is remembered per device and changed by dragging the divider. */
export const GRID_KEY = "multies-timeline-grid-w";
export const GRID_DEFAULT = 340;
export const clampGrid = (w: number) => Math.min(720, Math.max(220, Math.round(w)));
function savedGrid(): number {
  try { const v = Number(localStorage.getItem(GRID_KEY)); return v ? clampGrid(v) : GRID_DEFAULT; } catch { return GRID_DEFAULT; }
}

/** Which label goes inside a bar: the whole name if it fits, else the key alone if that fits, else nothing. Never an ellipsis.
 * Widths are measured with the label's own 8 px side padding; `pad` is the extra room kept free. */
export function barLabelMode(barWidth: number, fullWidth: number, keyWidth: number, pad = 4): "full" | "key" | "none" {
  if (fullWidth + pad <= barWidth) return "full";
  if (keyWidth + pad <= barWidth) return "key";
  return "none";
}

/** R39: which side of its bar an outside label goes. Right when the whole name fits before the chart's right edge, else
 * left when it fits after the chart's left edge. When neither side holds it on one line, the roomier side, wrapping to
 * that room (`max`), so it never runs past either edge and never gets an ellipsis. Pixels are chart content pixels. */
export function barOutsideSide(barLeft: number, barRight: number, labelWidth: number, chartWidth: number, gap = 10, edge = 8, leftLimit?: number): { side: "right" | "left"; max?: number; shift?: number } {
  const rightRoom = chartWidth - edge - (barRight + gap);
  // R40: a wait band or an "early" pill in the same row sits just left of the bar; a left label moves past it
  // (`shift` pixels further left) and only has the room before it.
  const shift = leftLimit != null && leftLimit < barLeft ? Math.ceil(barLeft - leftLimit) : 0;
  const leftRoom = barLeft - shift - gap - edge;
  const left = (max?: number) => ({ side: "left" as const, ...(max ? { max } : {}), ...(shift ? { shift } : {}) });
  if (labelWidth <= rightRoom) return { side: "right" };
  if (labelWidth <= leftRoom) return left();
  return rightRoom >= leftRoom ? { side: "right", max: Math.max(80, Math.floor(rightRoom)) } : left(Math.max(80, Math.floor(leftRoom)));
}

/** R40: the box an outside label takes, in chart content pixels, for the collision checks. */
export function outsideLabelBox(barLeft: number, barRight: number, labelWidth: number, place: { side: "right" | "left"; max?: number; shift?: number }, gap = 10) {
  // The label has 6 px of padding each side, pulled out by a 6 px negative margin, so its ink starts `gap` from the bar.
  const w = place.max ? Math.min(labelWidth, place.max) : labelWidth;
  const end = barLeft - (place.shift ?? 0) - gap + 6;
  return place.side === "right" ? { left: barRight + gap - 6, right: barRight + gap - 6 + w + 12 } : { left: end - w - 12, right: end };
}

/**
 * R40: the left edge of whatever the chart draws just left of a bar in its own row: a wait band starts where its
 * blocker ends, and an "early" pill takes LEAD_PILL_ROOM pixels before the bar. Undefined when nothing is there.
 */
export function rowLeftLimit(barLeft: number, incoming: { lag: number; srcRight: number | null }[], cellWidth = 36): number | undefined {
  let limit: number | undefined;
  for (const l of incoming) {
    // A wait band runs from the blocker's end to the bar; with the blocker off screen it is lag days wide.
    const x = l.lag > 0 ? (l.srcRight != null && l.srcRight < barLeft ? l.srcRight : barLeft - l.lag * cellWidth) : barLeft - LEAD_PILL_ROOM;
    if (x < barLeft) limit = limit == null ? x : Math.min(limit, x);
  }
  return limit;
}

/** Incoming lead or lag links per waiting task, so a bar's label can keep clear of what is drawn in its row. */
const IncomingGaps = createContext<Map<string, { from: string; lag: number }[]>>(new Map());

type BarRow = { id: string | number; ref?: string; title?: string; text?: string; $w?: number; $x?: number };
/** Bar content: what fits goes inside, the rest of the name sits beside the bar in normal text colour: on the right,
 * or (R39) on the left when the right would run past the chart's edge. */
function BarLabel({ data }: { data: BarRow }) {
  const root = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLSpanElement>(null);
  const key = useRef<HTMLSpanElement>(null);
  const outMeasure = useRef<HTMLSpanElement>(null);
  const ref = data.ref ?? "";
  const title = data.title ?? data.text ?? "";
  const name = ref ? `${ref} ${title}` : title;
  const w = data.$w ?? 0;
  const [mode, setMode] = useState<"full" | "key" | "none">("none");
  const [place, setPlace] = useState<{ side: "right" | "left"; max?: number; shift?: number }>({ side: "right" });
  const incoming = useContext(IncomingGaps).get(String(data.id).replace(/^:/, ""));
  useLayoutEffect(() => {
    setMode(barLabelMode(w, full.current?.offsetWidth ?? Infinity, ref ? key.current?.offsetWidth ?? Infinity : Infinity));
  }, [w, name, ref]);
  const outside = mode === "full" ? "" : mode === "key" ? title : name;
  useLayoutEffect(() => {
    const el = root.current;
    const bar = el?.closest<HTMLElement>(".wx-bar");
    const area = el?.closest<HTMLElement>(".wx-area");
    if (!outside || !bar || !area || !outMeasure.current) return;
    const srcRight = (id: string) => { const b = area.querySelector<HTMLElement>(barSel(id)); return b ? b.offsetLeft + b.offsetWidth : null; };
    const limit = incoming?.length ? rowLeftLimit(bar.offsetLeft, incoming.map((l) => ({ lag: l.lag, srcRight: srcRight(l.from) }))) : undefined;
    const next = barOutsideSide(bar.offsetLeft, bar.offsetLeft + bar.offsetWidth, outMeasure.current.offsetWidth, area.scrollWidth || area.offsetWidth, 10, 8, limit);
    setPlace((p) => (p.side === next.side && p.max === next.max && p.shift === next.shift ? p : next));
  }, [outside, w, data.$x, incoming]);
  return (
    <div ref={root} className="mm-bar-label" data-testid="timeline-bar-label" data-mode={mode} data-name={name} data-side={outside ? place.side : undefined}>
      {mode !== "none" && <span className="mm-bar-in">{mode === "full" ? name : ref}</span>}
      {outside && <span className="mm-bar-out" data-testid="timeline-bar-out" data-wrap={place.max ? "" : undefined} data-shift={place.shift || undefined}
        style={place.max || place.shift ? { ...(place.max ? { maxWidth: place.max, width: "max-content" } : {}), ...(place.shift && place.side === "left" ? { right: `calc(100% + ${10 + place.shift}px)` } : {}) } : undefined}>{outside}</span>}
      <span aria-hidden className="mm-bar-in mm-bar-measure" ref={full}>{name}</span>
      <span aria-hidden className="mm-bar-in mm-bar-measure" ref={key}>{ref}</span>
      {outside && <span aria-hidden className="mm-bar-out mm-bar-measure" ref={outMeasure}>{outside}</span>}
    </div>
  );
}

/** Task column cell: key and name, wrapping to 2 lines before it truncates; full name on hover or long press. */
function NameCell({ row }: { row: BarRow }) {
  const [tip, setTip] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const name = row.ref ? `${row.ref} ${row.title ?? ""}` : row.title ?? row.text ?? "";
  return (
    <div
      className="mm-name-cell" title={name} data-testid="timeline-name-cell"
      onPointerDown={(e) => { if (e.pointerType !== "mouse") { timer.current = window.setTimeout(() => setTip(true), 450); } }}
      onPointerUp={() => { window.clearTimeout(timer.current); }}
      onPointerLeave={() => { window.clearTimeout(timer.current); setTip(false); }}
    >
      <span className="mm-name-text">{row.ref && <span className="mm-name-key">{row.ref}</span>}{row.title ?? row.text}</span>
      {tip && <span role="tooltip" className="mm-name-tip" onClick={() => setTip(false)}>{name}</span>}
    </div>
  );
}

/**
 * Timeline (SVAR React Gantt core, MIT). A bar runs from start to due; a task with only a
 * due date shows as one day. Dragging or resizing a bar saves the new dates. Arrows show
 * dependencies (blocked by); dragging from the end of one bar to another adds one.
 * R37: `late` (task ids) draws clashing bars in red; timeline-plan-r37.tsx wraps this with the schedule bar and sheets.
 * R38: a Today line (our own overlay: the chart core ignores its markers setting).
 */
export function TaskTimeline({ tasks, links = [], late, daysOff, onOpen, onDates, onLink }: { tasks: Task[]; links?: GapLink[]; late?: Set<string>; /** R39: shaded on the chart (pass only when working days only is on). */ daysOff?: number[]; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void; onLink?: (blocker: string, blocked: string) => void }) {
  const dated = tasks.filter((t) => t.due || t.start).sort((a, b) => (a.start ?? a.due ?? "").localeCompare(b.start ?? b.due ?? ""));
  const { resolved } = useAppearance();
  const box = useRef<HTMLDivElement>(null);
  const Theme = resolved === "dark" ? WillowDark : Willow;
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const rows = useMemo(() => dated.map((t) => {
    const end = new Date(t.due ?? t.start!);
    const start = new Date(t.start ?? t.due!);
    return { id: t.id, text: `${t.ref} ${t.title}`, ref: t.ref, title: t.title, start, end: new Date(Math.max(end.getTime(), start.getTime()) + DAY), progress: t.status === "done" ? 100 : t.subtasks.total ? Math.round((t.subtasks.done / t.subtasks.total) * 100) : 0, type: "task" };
  }), [dated]);
  // "Blocked by" drawn as finish-to-start arrows: the blocker ends, then the blocked task starts.
  const shown = new Set(rows.map((r) => r.id));
  const arrows = useMemo(() => links.filter((l) => shown.has(l.from) && shown.has(l.to)).map((l, i) => ({ id: i + 1, source: l.from, target: l.to, type: "e2s" })), [links, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const min = rows.length ? new Date(Math.min(...rows.map((r) => r.start.getTime())) - (narrow ? 1 : 7) * DAY) : new Date(Date.now() - 7 * DAY);
  const max = rows.length ? new Date(Math.max(...rows.map((r) => r.end.getTime())) + 14 * DAY) : new Date(Date.now() + 30 * DAY);
  // R37: tasks that start before a task they wait on ends are drawn in red (the chart prefixes string ids with ":").
  const lateCss = late?.size ? [...late].map((id) => `.mm-gantt .wx-bar[data-task-id=':${CSS.escape(id)}'],.mm-gantt .wx-bar[data-task-id='${CSS.escape(id)}']`).join(",") + "{background:var(--color-bad)!important;border-color:var(--color-bad)!important;box-shadow:0 0 0 3px var(--color-bad-soft)}" : "";
  const [gridWidth] = useState(savedGrid);
  const todayKey = rows.map((r) => `${r.id}:${r.start.getTime()}:${r.end.getTime()}`).join(",") + resolved;
  const refs = useMemo(() => new Map(dated.map((t) => [t.id, t.ref])), [dated]);
  // R39: days off shaded (the chart core's own weekend cell class, so the colours follow the theme).
  const offKey = (daysOff ?? []).join(",");
  const incoming = useMemo(() => {
    const m = new Map<string, { from: string; lag: number }[]>();
    for (const l of links) if (l.lag) m.set(l.to, [...(m.get(l.to) ?? []), { from: l.from, lag: l.lag }]);
    return m;
  }, [links]);
  const highlight = useCallback((d: Date, unit: "day" | "hour") => (unit === "day" && daysOff?.includes(d.getDay()) ? "wx-weekend" : ""), [offKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return <p className="rounded-xl border border-line bg-surface p-6 text-[13px] text-muted" data-testid="task-timeline">No tasks have dates yet. Give a task a start or due date and it shows on the timeline.</p>;
  return (
    <div ref={box} className="mm-gantt h-[calc(100dvh-230px)] min-h-[360px] overflow-hidden rounded-xl border border-line" data-testid="task-timeline">
      <TodayLine root={box} anchor={rows[0] ? { id: rows[0].id, start: rows[0].start } : undefined} cellWidth={36} version={todayKey} />
      <LagGaps root={box} links={links} refs={refs} cellWidth={36} version={todayKey + offKey} workingDays={!!daysOff} />
      {lateCss && <style data-testid="timeline-late-style">{lateCss}</style>}
      <IncomingGaps.Provider value={incoming}>
      <Theme fonts={false}>
        <Gantt
          tasks={rows} links={arrows as never} start={min} end={max} cellWidth={36} cellHeight={40} scaleHeight={30}
          taskTemplate={BarLabel as never} gridWidth={gridWidth} {...(daysOff?.length ? { highlightTime: highlight } : {})}
          scales={[{ unit: "month", step: 1, format: fmtMonth }, { unit: "day", step: 1, format: fmtDay }]}
          columns={[{ id: "text", header: "Task", flexgrow: 1, cell: NameCell }] as never} {...({ displayMode: narrow ? "chart" : "all" } as object)}
          init={(api) => {
            api.on("resize-grid", (ev: { width?: number; inProgress?: boolean; section?: string }) => {
              if (ev.inProgress || ev.section === "subGrid" || !ev.width) return;
              try { localStorage.setItem(GRID_KEY, String(clampGrid(ev.width))); } catch { /* storage blocked */ }
            });
            api.on("update-task", (ev: { id: string | number; task: { start?: Date; end?: Date }; inProgress?: boolean }) => {
              if (ev.inProgress || !ev.task.start || !ev.task.end) return;
              const start = ev.task.start.toISOString().slice(0, 10);
              const due = new Date(ev.task.end.getTime() - DAY).toISOString().slice(0, 10);
              onDates(String(ev.id), start, due < start ? start : due);
            });
            api.on("add-link", (ev) => { const l = ev.link as { source?: string | number; target?: string | number }; if (l?.source && l?.target && onLink) onLink(String(l.source), String(l.target)); });
            api.intercept("show-editor", (ev: { id?: string | number }) => { if (ev.id) onOpen(String(ev.id)); return false; });
          }}
        />
      </Theme>
      </IncomingGaps.Provider>
    </div>
  );
}
