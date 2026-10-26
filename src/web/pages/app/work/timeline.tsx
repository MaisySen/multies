import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Gantt, Willow, WillowDark } from "@svar-ui/react-gantt";
import { useAppearance } from "@/web/components/theme";
import "@svar-ui/react-gantt/style.css";
import type { Task } from "./data";
import { TodayLine } from "./schedule-r38"; // R38: Today line

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

type BarRow = { id: string | number; ref?: string; title?: string; text?: string; $w?: number };
/** Bar content: what fits goes inside, the rest of the name sits to the right of the bar in normal text colour. */
function BarLabel({ data }: { data: BarRow }) {
  const full = useRef<HTMLSpanElement>(null);
  const key = useRef<HTMLSpanElement>(null);
  const ref = data.ref ?? "";
  const title = data.title ?? data.text ?? "";
  const name = ref ? `${ref} ${title}` : title;
  const w = data.$w ?? 0;
  const [mode, setMode] = useState<"full" | "key" | "none">("none");
  useLayoutEffect(() => {
    setMode(barLabelMode(w, full.current?.offsetWidth ?? Infinity, ref ? key.current?.offsetWidth ?? Infinity : Infinity));
  }, [w, name, ref]);
  const outside = mode === "full" ? "" : mode === "key" ? title : name;
  return (
    <div className="mm-bar-label" data-testid="timeline-bar-label" data-mode={mode} data-name={name}>
      {mode !== "none" && <span className="mm-bar-in">{mode === "full" ? name : ref}</span>}
      {outside && <span className="mm-bar-out" data-testid="timeline-bar-out">{outside}</span>}
      <span aria-hidden className="mm-bar-in mm-bar-measure" ref={full}>{name}</span>
      <span aria-hidden className="mm-bar-in mm-bar-measure" ref={key}>{ref}</span>
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
export function TaskTimeline({ tasks, links = [], late, onOpen, onDates, onLink }: { tasks: Task[]; links?: { from: string; to: string }[]; late?: Set<string>; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void; onLink?: (blocker: string, blocked: string) => void }) {
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
  const todayKey = rows.map((r) => `${r.id}:${r.start.getTime()}`).join(",") + resolved;
  if (!rows.length) return <p className="rounded-xl border border-line bg-surface p-6 text-[13px] text-muted" data-testid="task-timeline">No tasks have dates yet. Give a task a start or due date and it shows on the timeline.</p>;
  return (
    <div ref={box} className="mm-gantt h-[calc(100dvh-230px)] min-h-[360px] overflow-hidden rounded-xl border border-line" data-testid="task-timeline">
      <TodayLine root={box} anchor={rows[0] ? { id: rows[0].id, start: rows[0].start } : undefined} cellWidth={36} version={todayKey} />
      {lateCss && <style data-testid="timeline-late-style">{lateCss}</style>}
      <Theme fonts={false}>
        <Gantt
          tasks={rows} links={arrows as never} start={min} end={max} cellWidth={36} cellHeight={40} scaleHeight={30}
          taskTemplate={BarLabel as never} gridWidth={gridWidth}
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
    </div>
  );
}
