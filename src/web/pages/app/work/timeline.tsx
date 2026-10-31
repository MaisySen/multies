import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gantt, Willow, WillowDark } from "@svar-ui/react-gantt";
import { useAppearance } from "@/web/components/theme";
import "@svar-ui/react-gantt/style.css";
import type { Task } from "./data";
import { TodayLine } from "./schedule-r38"; // R38: Today line
import { barSel, LagGaps, LEAD_PILL_ROOM, type GapLink } from "./timeline-gaps-r39"; // R39: lead and lag drawn on the chart

const DAY = 86_400_000;
const fmtMonth = (d: Date) => d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });

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
  const setHoverCard = useContext(HoverCtx);
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
    <div ref={root} className="mm-bar-label" data-testid="timeline-bar-label" onPointerEnter={(e) => setHoverCard({ id: String(data.id).replace(/^:/, ""), rect: (e.currentTarget.closest(".wx-bar") ?? e.currentTarget).getBoundingClientRect() })} onPointerLeave={() => setHoverCard(null)} onPointerDown={() => setHoverCard(null)} data-mode={mode} data-name={name} data-side={outside ? place.side : undefined}>
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

/* ---------------------------------------------------------------- R75: zoom, range, colours, hover card */

export type Zoom = "day" | "week" | "month";
/** Pixels per day at each zoom. */
export const ZOOM_PX: Record<Zoom, number> = { day: 44, week: 20, month: 6 };
export const ZOOM_KEY = "multies-timeline-zoom";
export const ZOOM_LABEL: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month" };
/** Week for anything up to about four months, month beyond that. */
export const defaultZoom = (spanDays: number): Zoom => (spanDays > 120 ? "month" : "week");
export function savedZoom(): Zoom | null {
  try { const v = localStorage.getItem(ZOOM_KEY); return v === "day" || v === "week" || v === "month" ? v : null; } catch { return null; }
}
export function storeZoom(z: Zoom) { try { localStorage.setItem(ZOOM_KEY, z); } catch { /* storage blocked */ } }

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
/** Sunday on or before the date (the chart core's week cells start on Sunday, so the range lines up with them). */
const startOfWeek = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };

/**
 * The chart's range: every task and today, with room either side (3 days, a week, two weeks by zoom), snapped to whole
 * weeks or months, and stretched to at least `minPx` wide so the chart never shows a ragged empty edge (and the chart
 * core never has to stretch its own cells, which would put the Today line and the wait bands off by a fraction).
 */
export function timelineRange(starts: number[], ends: number[], today: number, zoom: Zoom, minPx = 0): { start: Date; end: Date; days: number } {
  const pad = zoom === "day" ? 3 : zoom === "week" ? 7 : 14;
  const lo = Math.min(today, ...starts), hi = Math.max(today + DAY, ...ends);
  let start = startOfDay(lo - pad * DAY);
  if (zoom === "week") start = startOfWeek(start);
  if (zoom === "month") start = startOfWeek(start); // month zoom draws week columns
  let end = startOfDay(hi + pad * DAY);
  const minDays = Math.ceil(minPx / ZOOM_PX[zoom]) + 1;
  if ((end.getTime() - start.getTime()) / DAY < minDays) end = new Date(start.getTime() + minDays * DAY);
  if (zoom === "week") { end = startOfWeek(end); end.setDate(end.getDate() + 7); }
  if (zoom === "month") { end = startOfWeek(end); end.setDate(end.getDate() + 7); }
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / DAY) };
}

/** Bar colour by status, each with white text at 4.5:1 or better (WCAG AA). */
export const BAR_COLORS: Record<"todo" | "doing" | "done", string> = { todo: "#56627a", doing: "#2563eb", done: "#15803d" };
/** A task that starts before the one it waits on ends (white text 5.6:1). */
export const LATE_COLOR = "#c42b2b";
const fmtShort = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const fmtWeekday = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
/** "27 Oct to 2 Nov, 7 days" or "Mon 27 Oct, 1 day" (no dashes in copy). */
export function dateSpan(start: Date, endExclusive: Date): string {
  const days = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / DAY));
  const last = new Date(endExclusive.getTime() - DAY);
  return days === 1 ? `${fmtWeekday(start)}, 1 day` : `${fmtWeekday(start)} to ${fmtWeekday(last)}, ${days} days`;
}

function scalesFor(zoom: Zoom) {
  if (zoom === "day") return [{ unit: "month", step: 1, format: fmtMonth }, { unit: "day", step: 1, format: (d: Date) => `${DAY_LETTER[d.getDay()]} ${d.getDate()}` }];
  if (zoom === "week") return [{ unit: "week", step: 1, format: (d: Date) => fmtShort(d) }, { unit: "day", step: 1, format: (d: Date) => DAY_LETTER[d.getDay()] }];
  return [{ unit: "month", step: 1, format: fmtMonth }, { unit: "week", step: 1, format: (d: Date) => String(d.getDate()) }];
}

type Info = { ref: string; title: string; status: "todo" | "doing" | "done"; statusName: string; who: string | null; start: Date; end: Date; progress: number; late: boolean };
const InfoCtx = createContext<Map<string, Info>>(new Map());
const HoverCtx = createContext<(h: { id: string; rect: DOMRect } | null) => void>(() => {});

function Initials({ name, className }: { name: string; className?: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return <span aria-hidden className={`inline-grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand-hover ${className ?? "h-6 w-6 text-[10.5px]"}`}>{letters}</span>;
}

function WhoCell({ row }: { row: BarRow }) {
  const info = useContext(InfoCtx).get(String(row.id).replace(/^:/, ""));
  if (!info?.who) return <span className="text-[12px] text-subtle" aria-label="Nobody assigned">&nbsp;</span>;
  return <span title={info.who} className="inline-flex" data-testid="timeline-who"><Initials name={info.who} /><span className="sr-only">{info.who}</span></span>;
}
function WhenCell({ row }: { row: BarRow }) {
  const info = useContext(InfoCtx).get(String(row.id).replace(/^:/, ""));
  if (!info) return null;
  const last = new Date(info.end.getTime() - DAY);
  const same = last.getTime() <= info.start.getTime();
  return <span className="text-[12px] tabular-nums text-muted">{same ? fmtShort(info.start) : `${fmtShort(info.start)} to ${fmtShort(last)}`}</span>;
}

/** R75: the card shown while the pointer rests on a bar: name, status, dates, who, progress. */
function HoverCard({ hover }: { hover: { id: string; rect: DOMRect } | null }) {
  const info = useContext(InfoCtx).get(hover?.id ?? "");
  if (!hover || !info) return null;
  const W = 280;
  const left = Math.min(Math.max(8, hover.rect.left), window.innerWidth - W - 8);
  const below = hover.rect.bottom + 8 + 150 < window.innerHeight;
  const style = { left, width: W, ...(below ? { top: hover.rect.bottom + 8 } : { bottom: window.innerHeight - hover.rect.top + 8 }) };
  return createPortal(
    <div role="tooltip" data-testid="timeline-hover-card" style={style}
      className="pointer-events-none fixed z-[60] rounded-[var(--radius-r14)] border border-line bg-elevated p-3 text-[13px] shadow-pop motion-safe:animate-[fadeIn_120ms_ease-out]">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: info.late ? LATE_COLOR : BAR_COLORS[info.status] }} aria-hidden />
        <p className="min-w-0 font-medium leading-5 text-fg"><span className="mr-1.5 text-[12px] font-semibold text-subtle">{info.ref}</span>{info.title}</p>
      </div>
      <p className="mt-2 text-[12.5px] text-muted">{dateSpan(info.start, info.end)}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">{info.who ? <><Initials name={info.who} className="h-5 w-5 text-[9.5px]" /><span className="truncate">{info.who}</span></> : "Nobody assigned"}</span>
        <span className={info.late ? "font-medium text-bad" : "text-muted"}>{info.late ? "Date clash" : info.statusName}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full bg-brand" style={{ width: `${info.progress}%` }} /></span>
        <span className="text-[11.5px] tabular-nums text-subtle">{info.progress}%</span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Timeline (SVAR React Gantt core, MIT). A bar runs from start to due; a task with only a
 * due date shows as one day. Dragging or resizing a bar saves the new dates. Arrows show
 * dependencies (blocked by); dragging from the end of one bar to another adds one.
 * R37: `late` (task ids) draws clashing bars in red; timeline-plan-r37.tsx wraps this with the schedule bar and sheets.
 * R38: a Today line (our own overlay: the chart core ignores its markers setting).
 * R75: Day, Week and Month zoom; the range fits the tasks (and today) and the chart is only as tall as its rows; bars
 * coloured by status; a hover card; the row under the pointer lit across both panes; assignee and dates columns;
 * weekends shaded; a Today button (`todaySignal`) scrolls today into view.
 */
export function TaskTimeline({ tasks, links = [], late, daysOff, zoom = "week", todaySignal = 0, showDates = false, onOpen, onDates, onLink, onAdd }: { tasks: Task[]; links?: GapLink[]; late?: Set<string>; /** R39: shaded on the chart (pass only when working days only is on). */ daysOff?: number[]; zoom?: Zoom; todaySignal?: number; showDates?: boolean; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void; onLink?: (blocker: string, blocked: string) => void; onAdd?: () => void }) {
  const dated = tasks.filter((t) => t.due || t.start).sort((a, b) => (a.start ?? a.due ?? "").localeCompare(b.start ?? b.due ?? ""));
  const undated = tasks.length - dated.length;
  const { resolved } = useAppearance();
  const box = useRef<HTMLDivElement>(null);
  const Theme = resolved === "dark" ? WillowDark : Willow;
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const px = ZOOM_PX[zoom];
  const CELL_H = 40, SCALE_H = 28;
  const rows = useMemo(() => dated.map((t) => {
    const end = new Date(t.due ?? t.start!);
    const start = new Date(t.start ?? t.due!);
    // Dates are whole days: drawn from local midnight so bars line up with the day columns.
    const s = startOfDay(start.getTime());
    const e = new Date(startOfDay(Math.max(end.getTime(), start.getTime())).getTime() + DAY);
    return { id: t.id, text: `${t.ref} ${t.title}`, ref: t.ref, title: t.title, start: s, end: e, progress: t.status === "done" ? 100 : t.subtasks.total ? Math.round((t.subtasks.done / t.subtasks.total) * 100) : 0, type: "task" };
  }), [dated]);
  const info = useMemo(() => new Map<string, Info>(dated.map((t, i) => [t.id, { ref: t.ref, title: t.title, status: t.status, statusName: t.statusName, who: t.assignee?.name ?? null, start: rows[i]!.start, end: rows[i]!.end, progress: rows[i]!.progress, late: !!late?.has(t.id) }])), [dated, rows, late]);
  // "Blocked by" drawn as finish-to-start arrows: the blocker ends, then the blocked task starts.
  const shown = new Set(rows.map((r) => r.id));
  const arrows = useMemo(() => links.filter((l) => shown.has(l.from) && shown.has(l.to)).map((l, i) => ({ id: i + 1, source: l.from, target: l.to, type: "e2s" })), [links, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // The chart's own width (the box less the task column) decides how far the range must reach.
  const [boxW, setBoxW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setBoxW(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [rows.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const [gridWidth, setGridWidth] = useState(savedGrid);
  const colsW = narrow ? 0 : gridWidth;
  const range = useMemo(() => timelineRange(rows.map((r) => r.start.getTime()), rows.map((r) => r.end.getTime()), startOfDay(Date.now()).getTime(), zoom, Math.max(0, boxW - colsW) + px * 2),
    [rows, zoom, boxW, colsW, px]);
  const cellWidth = zoom === "month" ? px * 7 : px;
  // R37: tasks that start before a task they wait on ends are drawn in red (the chart prefixes string ids with ":").
  const sel = (id: string) => `.mm-gantt .wx-bar[data-task-id=':${CSS.escape(id)}'],.mm-gantt .wx-bar[data-task-id='${CSS.escape(id)}']`;
  const lateCss = late?.size ? [...late].map(sel).join(",") + "{--mm-bar:#c42b2b;background:#c42b2b!important;border-color:#c42b2b!important;box-shadow:0 0 0 3px var(--color-bad-soft)}" : "";
  // R75: one colour per status (todo, doing, done).
  const statusCss = (["todo", "doing", "done"] as const).map((k) => {
    const ids = dated.filter((t) => t.status === k && !late?.has(t.id)).map((t) => sel(t.id));
    return ids.length ? `${ids.join(",")}{--mm-bar:${BAR_COLORS[k]}}` : "";
  }).join("");
  const todayKey = rows.map((r) => `${r.id}:${r.start.getTime()}:${r.end.getTime()}`).join(",") + resolved + zoom + range.start.getTime();
  const refs = useMemo(() => new Map(dated.map((t) => [t.id, t.ref])), [dated]);
  const offKey = (daysOff ?? []).join(",");
  const incoming = useMemo(() => {
    const m = new Map<string, { from: string; lag: number }[]>();
    for (const l of links) if (l.lag) m.set(l.to, [...(m.get(l.to) ?? []), { from: l.from, lag: l.lag }]);
    return m;
  }, [links]);
  // R39 days off, R75 weekends: shaded with the chart core's own weekend class (the colours follow the theme).
  const shade = daysOff?.length ? daysOff : [0, 6];
  const highlight = useCallback((d: Date, unit: "day" | "hour") => (unit === "day" && shade.includes(d.getDay()) ? "wx-weekend" : ""), [offKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [phoneChart, setPhoneChart] = useState(false);
  const apiRef = useRef<unknown>(null);
  // R75: the row under the pointer, lit across the task column and the chart.
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const onMove = (e: React.PointerEvent) => {
    const area = box.current?.querySelector<HTMLElement>(".wx-area");
    if (!area) return;
    const idx = Math.floor((e.clientY - area.getBoundingClientRect().top) / CELL_H);
    setHoverRow(idx >= 0 && idx < rows.length ? idx : null);
  };
  // R75: Today scrolls today to a quarter of the way into the chart.
  useEffect(() => {
    if (!todaySignal) return;
    const chart = box.current?.querySelector<HTMLElement>(".wx-chart");
    if (!chart) return;
    const x = ((startOfDay(Date.now()).getTime() - range.start.getTime()) / DAY) * px;
    const left = Math.max(0, Math.round(x - chart.clientWidth / 4));
    // The chart core keeps its own scroll position; ask it first, then make sure the element follows.
    try { (apiRef.current as { exec?: (a: string, p: object) => void } | null)?.exec?.("scroll-chart", { left }); } catch { /* older core */ }
    chart.scrollLeft = left;
  }, [todaySignal]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface p-6" data-testid="task-timeline">
      <p className="text-[14px] font-medium text-fg">Nothing on the timeline yet</p>
      <p className="text-[13px] text-muted">Give a task a start or due date and it shows here as a bar you can drag.</p>
      {onAdd && <button type="button" onClick={onAdd} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-white hover:bg-brand-hover">Add a task</button>}
    </div>
  );
  if (narrow && !phoneChart) return (
    <div className="flex flex-col gap-3" data-testid="task-timeline" data-mode="weeks">
      <PhoneWeeks items={dated.map((t) => ({ id: t.id, ...info.get(t.id)! }))} onOpen={onOpen} />
      <div className="flex items-center justify-between px-1 text-[13px]">
        {onAdd ? <button type="button" onClick={onAdd} className="inline-flex h-11 items-center gap-1.5 font-medium text-brand-hover"><span aria-hidden className="text-[18px] leading-none">+</span>Add task</button> : <span />}
        <button type="button" onClick={() => setPhoneChart(true)} className="h-11 font-medium text-brand-hover" data-testid="timeline-show-chart">Show chart</button>
      </div>
      {undated > 0 && <p className="px-1 text-[12.5px] text-muted">{undated === 1 ? "1 task has no dates and is not shown" : `${undated} tasks have no dates and are not shown`}</p>}
    </div>
  );
  // Only as tall as its rows (the old chart filled the screen with empty grid), up to the room on screen.
  const contentH = SCALE_H * 2 + rows.length * CELL_H + 2;
  const columns = narrow ? [{ id: "text", header: "Task", flexgrow: 1, cell: NameCell }] : [
    { id: "text", header: "Task", flexgrow: 1, cell: NameCell },
    ...(showDates ? [{ id: "when", header: "Dates", width: 132, cell: WhenCell }] : []),
    { id: "who", header: "", width: 44, cell: WhoCell, align: "center" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div ref={box} onPointerMove={onMove} onPointerLeave={() => { setHoverRow(null); setHover(null); }} data-zoom={zoom}
        className="mm-gantt mm-gantt-r75 overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="task-timeline"
        style={{ height: `min(${contentH}px, max(320px, calc(100dvh - 260px)))` }}>
        <TodayLine root={box} anchor={rows[0] ? { id: rows[0].id, start: rows[0].start } : undefined} cellWidth={px} version={todayKey} />
        <LagGaps root={box} links={links} refs={refs} cellWidth={px} version={todayKey + offKey} workingDays={!!daysOff} />
        <RowBand root={box} row={hoverRow} top={SCALE_H * 2} height={CELL_H} version={todayKey} />
        <style data-testid="timeline-status-style">{statusCss}</style>
        {lateCss && <style data-testid="timeline-late-style">{lateCss}</style>}
        <InfoCtx.Provider value={info}>
        <HoverCtx.Provider value={setHover}>
        <IncomingGaps.Provider value={incoming}>
        <Theme fonts={false}>
          <Gantt
            key={zoom /* a zoom change rebuilds the scales cleanly */}
            tasks={rows} links={arrows as never} start={range.start} end={range.end} cellWidth={cellWidth} cellHeight={CELL_H} scaleHeight={SCALE_H}
            lengthUnit={"day" as never} cellBorders="full"
            taskTemplate={BarLabel as never} gridWidth={gridWidth} highlightTime={highlight}
            scales={scalesFor(zoom) as never}
            columns={columns as never} {...({ displayMode: narrow ? "chart" : "all" } as object)}
            init={(api) => {
              apiRef.current = api;
              api.on("resize-grid", (ev: { width?: number; inProgress?: boolean; section?: string }) => {
                if (ev.inProgress || ev.section === "subGrid" || !ev.width) return;
                const w = clampGrid(ev.width);
                setGridWidth(w);
                try { localStorage.setItem(GRID_KEY, String(w)); } catch { /* storage blocked */ }
              });
              api.on("update-task", (ev: { id: string | number; task: { start?: Date; end?: Date }; inProgress?: boolean }) => {
                if (ev.inProgress || !ev.task.start || !ev.task.end) return;
                setHover(null);
                const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                const start = iso(ev.task.start);
                const due = iso(new Date(ev.task.end.getTime() - DAY));
                onDates(String(ev.id), start, due < start ? start : due);
              });
              api.on("add-link", (ev) => { const l = ev.link as { source?: string | number; target?: string | number }; if (l?.source && l?.target && onLink) onLink(String(l.source), String(l.target)); });
              api.intercept("show-editor", (ev: { id?: string | number }) => { if (ev.id) onOpen(String(ev.id)); return false; });
            }}
          />
        </Theme>
        </IncomingGaps.Provider>
        <HoverCard hover={hover} />
        </HoverCtx.Provider>
        </InfoCtx.Provider>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-[12.5px] text-muted">
        {onAdd && <button type="button" onClick={onAdd} data-testid="timeline-add" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 font-medium text-fg/80 transition-colors hover:bg-hover hover:text-fg"><span aria-hidden className="text-[16px] leading-none">+</span>Add task</button>}
        <span className="inline-flex items-center gap-3" aria-label="Bar colours">
          {(["todo", "doing", "done"] as const).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: BAR_COLORS[k] }} />{k === "todo" ? "To do" : k === "doing" ? "In progress" : "Done"}</span>)}
          {!!late?.size && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: LATE_COLOR }} />Date clash</span>}
        </span>
        {undated > 0 && <span className="ml-auto" data-testid="timeline-undated">{undated === 1 ? "1 task has no dates and is not shown" : `${undated} tasks have no dates and are not shown`}</span>}
      </div>
    </div>
  );
}


/** R75: on a phone the timeline reads as a list by week (a 390 px chart shows a few days at most). Each task sits under
 * the week it starts in, with a status dot, its dates and who has it; tapping opens it. "Show chart" switches back. */
export function weekGroups<T extends { start: Date }>(items: T[]): { week: Date; items: T[] }[] {
  const m = new Map<number, T[]>();
  for (const it of [...items].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const w = startOfWeek(startOfDay(it.start.getTime())).getTime();
    m.set(w, [...(m.get(w) ?? []), it]);
  }
  return [...m.entries()].map(([w, list]) => ({ week: new Date(w), items: list }));
}
function PhoneWeeks({ items, onOpen }: { items: ({ id: string } & Info)[]; onOpen: (id: string) => void }) {
  const today = startOfDay(Date.now()).getTime();
  const thisWeek = startOfWeek(new Date(today)).getTime();
  return (
    <div className="flex flex-col gap-4" data-testid="timeline-phone-weeks">
      {weekGroups(items).map((g) => (
        <section key={g.week.getTime()} aria-label={`Week of ${fmtShort(g.week)}`}>
          <h3 className="mb-2 flex items-center gap-2 px-1 text-[13px] font-semibold text-muted">
            Week of {fmtShort(g.week)}{g.week.getTime() === thisWeek && <span className="rounded-full bg-brand-soft px-2 py-px text-[11.5px] font-medium text-brand-hover">This week</span>}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {g.items.map((it) => (
              <li key={it.id}>
                <button type="button" onClick={() => onOpen(it.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-hover">
                  <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ background: it.late ? LATE_COLOR : BAR_COLORS[it.status] }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{it.title}</span>
                    <span className="block text-[13px] text-muted">{it.ref} · {dateSpan(it.start, it.end)}{it.late ? " · Date clash" : ""}</span>
                  </span>
                  {it.who && <Initials name={it.who} />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** R75: a soft band behind the row under the pointer, across both panes (drawn inside the chart's scrolling body). */
function RowBand({ root, row, top, height, version }: { root: React.RefObject<HTMLElement | null>; row: number | null; top: number; height: number; version: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(root.current?.querySelector<HTMLElement>(".wx-gantt") ?? null); }, [root, version]);
  if (!host || row == null) return null;
  return createPortal(<div aria-hidden data-testid="timeline-row-band" className="mm-row-band" style={{ top: top + row * height, height }} />, host);
}
