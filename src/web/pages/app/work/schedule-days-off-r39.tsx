/**
 * R39: the days off picker in a project's schedule rules. Seven round day toggles, Monday first; Saturday and Sunday
 * are off by default. Saved at once through PUT /api/projects/:id/schedule (daysOff, 0 Sunday to 6 Saturday). At least
 * one working day always stays: the last one cannot be turned off. Days off count only when "Working days only" is on,
 * and then they are shaded on the chart.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/web/lib/cn";
import { IconCalendar } from "@/web/components/ui/icon";

export const WEEK = [
  { d: 1, short: "Mon", letter: "M", name: "Monday" },
  { d: 2, short: "Tue", letter: "T", name: "Tuesday" },
  { d: 3, short: "Wed", letter: "W", name: "Wednesday" },
  { d: 4, short: "Thu", letter: "T", name: "Thursday" },
  { d: 5, short: "Fri", letter: "F", name: "Friday" },
  { d: 6, short: "Sat", letter: "S", name: "Saturday" },
  { d: 0, short: "Sun", letter: "S", name: "Sunday" },
] as const;

/** "Sat, Sun", "No days off", or "Fri to Sun" style text, Monday first. */
export function daysOffText(daysOff: number[]) {
  const on = WEEK.filter((w) => daysOff.includes(w.d));
  if (!on.length) return "No days off";
  return on.map((w) => w.short).join(", ");
}

/** Toggle one day; refuses to leave a week with no working day. Sorted, unique. */
export function toggleDayOff(daysOff: number[], d: number): number[] {
  const set = new Set(daysOff);
  if (set.has(d)) set.delete(d); else if (set.size < 6) set.add(d);
  return [...set].sort((a, b) => a - b);
}

export function DaysOffPicker({ daysOff, active, onChange }: { daysOff: number[]; active: boolean; onChange: (daysOff: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const full = daysOff.length >= 6;
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" data-testid="days-off-button"
        title={active ? "Days off: moves and gaps skip these days" : "Days off: used when Working days only is on"}
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none",
          open ? "border-brand/40 bg-brand-soft text-brand-hover" : "border-line bg-surface text-muted hover:text-fg", !active && !open && "opacity-75")}>
        <IconCalendar className="h-3.5 w-3.5" aria-hidden />
        <span className="max-sm:hidden">Days off:</span>
        <span className="tabular-nums text-fg">{daysOffText(daysOff)}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Days off" data-testid="days-off-picker"
          className="absolute left-0 top-[calc(100%+6px)] z-40 w-[296px] max-w-[calc(100vw-24px)] origin-top-left rounded-2xl border border-line bg-elevated p-3.5 shadow-[0_12px_32px_rgb(0_0_0/0.18)] motion-safe:animate-[popIn_160ms_var(--ease-spring,ease-out)]">
          <p className="text-[13px] font-semibold text-fg">Days off</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted">{active ? "Moves, gaps and clash checks skip these days." : "These count when Working days only is on."}</p>
          <div className="mt-3 flex items-center justify-between gap-1" role="group" aria-label="Days off in the week">
            {WEEK.map((w) => {
              const off = daysOff.includes(w.d);
              const locked = !off && full; // the last working day stays
              return (
                <button key={w.d} type="button" role="checkbox" aria-checked={off} aria-label={w.name} disabled={locked} data-testid={`day-off-${w.d}`}
                  title={locked ? "Keep at least one working day" : off ? `${w.name} is a day off` : `${w.name} is a working day`}
                  onClick={() => onChange(toggleDayOff(daysOff, w.d))}
                  className={cn("grid h-9 w-9 place-items-center rounded-full text-[13px] font-semibold transition-[background-color,color,transform,box-shadow] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100",
                    off ? "bg-brand text-white shadow-[0_2px_6px_rgb(0_113_227/0.35)]" : "bg-fill text-fg hover:bg-hover")}>
                  {w.letter}
                </button>
              );
            })}
          </div>
          <p className="mt-2.5 text-[11.5px] text-subtle">{7 - daysOff.length === 1 ? "1 working day a week" : `${7 - daysOff.length} working days a week`}</p>
        </div>
      )}
    </span>
  );
}
