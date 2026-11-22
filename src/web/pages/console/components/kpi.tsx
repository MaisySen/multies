/**
 * OPS1 Trends: the light half of the console charts. Pure helpers (day filling, number and date wording, chart
 * summaries), the KPI tile, an SVG sparkline, the range chips and the chart card. Nothing here imports recharts, so
 * the console shell and the Overview can import this module statically; the recharts charts live in ./charts and load
 * on demand through LazyTrendLine and LazyTrendBars below (made with lazyPage, like every lazily loaded module).
 *
 * Data shape everywhere: `{ day: "YYYY-MM-DD", value: number | null }[]`. A null value means "no data for that day"
 * and is never drawn as zero: lines break, bars are left out, sparklines skip it.
 *
 * Usage:
 *   const rows = fillDays(rangeStart(today, 30), today, apiRows);
 *   <KpiTile label="Sign ups" value={412} previous={380} trend={rows} periodLabel="vs previous 30 days" to="/console/users" />
 *   <ChartCard title="Deliveries" description="Sent and failed per day" loading={q.isPending} error={q.error} empty={!hasData(rows)}
 *     action={<RangePicker value={days} onChange={setDays} />}>
 *     <LazyTrendLine label="Deliveries" series={[{ label: "Sent", rows: sent }, { label: "Failed", rows: failed, tone: "bad" }]} />
 *   </ChartCard>
 */
import { Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import { IconAlertCircle, IconArrowDown, IconArrowUp, IconMinus } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { lazyPage } from "@/web/components/lazy-page";
import { LOCALE } from "@/shared/locale";
import { formatDay as formatCalendarDay } from "./format";

// ---------------------------------------------------------------- types

export interface TrendPoint { day: string; value: number | null }
export type RangeDays = 7 | 30 | 90;
/** The colour of a series: the brand blue, the error red (for failures next to a total), or a quiet grey. */
export type SeriesTone = "brand" | "bad" | "neutral";
export interface TrendSeries { label: string; rows: readonly TrendPoint[]; tone?: SeriesTone }

export const TONE_COLOR: Record<SeriesTone, string> = {
  brand: "var(--color-brand)",
  bad: "var(--color-bad)",
  neutral: "var(--color-subtle)",
};

// ---------------------------------------------------------------- days

const DAY_MS = 86_400_000;
const MAX_DAYS = 3660;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (day: string) => (DAY_RE.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first day of a range of `days` days that ends on `to` (inclusive): rangeStart("2026-11-21", 7) is "2026-11-15". */
export function rangeStart(to: string, days: number): string {
  const end = dayMs(to);
  if (Number.isNaN(end)) return to;
  return isoDay(end - (Math.max(1, Math.floor(days)) - 1) * DAY_MS);
}

/**
 * Every day from `from` to `to` (both inclusive, UTC days), with the value from `rows` or null where `rows` has none.
 * Rows outside the range are dropped; a repeated day keeps the last row; non numbers become null. An empty or
 * reversed range gives []. Capped at about ten years so a bad date cannot build a huge array.
 */
export function fillDays(from: string, to: string, rows: readonly TrendPoint[]): TrendPoint[] {
  const start = dayMs(from);
  const end = dayMs(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const byDay = new Map<string, number | null>();
  for (const r of rows) byDay.set(r.day, typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null);
  const out: TrendPoint[] = [];
  for (let t = start, i = 0; t <= end && i < MAX_DAYS; t += DAY_MS, i++) {
    const day = isoDay(t);
    out.push({ day, value: byDay.get(day) ?? null });
  }
  return out;
}

/** True when at least one day has a number (zero counts as data). */
export function hasData(rows: readonly TrendPoint[] | readonly TrendSeries[]): boolean {
  return rows.some((r) => ("rows" in r ? hasData(r.rows) : typeof r.value === "number"));
}

/** The first and last days that have a number, or null when there are none. */
export function dataBounds(rows: readonly TrendPoint[]): { first: TrendPoint & { value: number }; last: TrendPoint & { value: number } } | null {
  const withData = rows.filter((r): r is TrendPoint & { value: number } => typeof r.value === "number");
  return withData.length ? { first: withData[0], last: withData[withData.length - 1] } : null;
}

export type ChartRow = { day: string } & Record<`v${number}`, number | null>;
export const CHART_KEY = (i: number) => `v${i}` as const;
const KEY = CHART_KEY;

/** One row per day across the series (union of days, sorted), with v0, v1 holding each series' value or null. */
export function mergeSeries(series: readonly TrendSeries[]): ChartRow[] {
  const days = new Map<string, ChartRow>();
  series.forEach((s, i) => {
    for (const p of s.rows) {
      const row = days.get(p.day) ?? ({ day: p.day } as ChartRow);
      row[KEY(i)] = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null;
      days.set(p.day, row);
    }
  });
  return [...days.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => { const out = { ...r }; series.forEach((_, i) => { out[KEY(i)] ??= null; }); return out; });
}

// ---------------------------------------------------------------- words for numbers and dates

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
/** U+2212, the typographic minus: lines up with the plus sign in tabular figures. */
const MINUS = "−";

/** Short numbers for tiles and axes: 950, 1.2K, 3.4M. Null or not a number gives "No data". */
export function formatCompact(n: number | null | undefined, locale = "en-US"): string {
  if (!isNum(n)) return "No data";
  const abs = Math.abs(n);
  const s = abs < 1000
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: abs < 10 ? 2 : 1 }).format(abs)
    : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(abs);
  return n < 0 ? `${MINUS}${s}` : s;
}

/** Exact numbers for tooltips and screen readers: 1,234,567. */
export function formatNumber(n: number | null | undefined, locale = "en-US"): string {
  if (!isNum(n)) return "No data";
  const s = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Math.abs(n));
  return n < 0 ? `${MINUS}${s}` : s;
}

export type DeltaDirection = "up" | "down" | "flat" | "none";
export interface Delta {
  direction: DeltaDirection;
  /** What the tile shows: "+12%", "−8%", "+40" (when the previous value was 0), "No change", "No earlier data". */
  text: string;
  /** The change as a fraction (0.12 for 12%), or null when there is no percentage (previous was 0 or missing). */
  pct: number | null;
  /** current minus previous, or null when either is missing. */
  diff: number | null;
}

function pctText(p: number): string {
  const abs = Math.abs(p) * 100;
  if (abs > 0 && abs < 0.1) return "<0.1%";
  const r = abs < 10 ? Math.round(abs * 10) / 10 : Math.round(abs);
  return `${r}%`;
}

/** The change from the previous period to this one. */
export function formatDelta(current: number | null | undefined, previous: number | null | undefined, locale = "en-US"): Delta {
  if (!isNum(current) || !isNum(previous)) return { direction: "none", text: "No earlier data", pct: null, diff: null };
  const diff = current - previous;
  if (diff === 0) return { direction: "flat", text: "No change", pct: 0, diff: 0 };
  const direction = diff > 0 ? "up" : "down";
  const sign = diff > 0 ? "+" : MINUS;
  if (previous === 0) return { direction, text: `${sign}${formatCompact(Math.abs(diff), locale)}`, pct: null, diff };
  const pct = diff / Math.abs(previous);
  return { direction, text: `${sign}${pctText(pct)}`, pct, diff };
}

export type DeltaTone = "good" | "bad" | "neutral";
/** Whether a change is good news: up is good when higher is better, down is good when lower is better; null means neither. */
export function deltaTone(direction: DeltaDirection, higherIsBetter: boolean | null = true): DeltaTone {
  if (higherIsBetter === null || direction === "flat" || direction === "none") return "neutral";
  return (direction === "up") === higherIsBetter ? "good" : "bad";
}

export type DayStyle = "short" | "medium" | "long";
const DAY_FORMAT: Record<DayStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "numeric", month: "short" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { weekday: "short", day: "numeric", month: "short", year: "numeric" },
};
/**
 * Day first, like every console date: "21 Nov" (axis ticks), "21 Nov 2026" (notes, the shared formatDay), "Sat, 21 Nov
 * 2026" (tooltips). The day is read as a UTC date.
 */
export function formatDay(day: string, style: DayStyle = "short", locale: string = LOCALE): string {
  const ms = dayMs(day);
  if (Number.isNaN(ms)) return day;
  if (style === "medium") return formatCalendarDay(ms, { locale, timeZone: "UTC" });
  return new Intl.DateTimeFormat(locale, { ...DAY_FORMAT[style], timeZone: "UTC" }).format(ms);
}

/**
 * A plain sentence for screen readers: "Sent: 1,234 on 21 Nov 2026, up 12% from 1,100 on 23 Oct 2026."
 * Compares the last day with data against the first day with data in the range.
 */
export function describeTrend(label: string, rows: readonly TrendPoint[], format: (n: number) => string = (n) => formatNumber(n), locale?: string): string {
  const b = dataBounds(rows);
  if (!b) return `${label}: no data yet.`;
  const latest = `${label}: ${format(b.last.value)} on ${formatDay(b.last.day, "medium", locale)}`;
  if (b.first.day === b.last.day) return `${latest}. No other day in this range has data.`;
  const d = formatDelta(b.last.value, b.first.value);
  const change = d.direction === "flat" ? "the same as" : d.direction === "up" ? `up ${d.pct === null ? format(Math.abs(d.diff ?? 0)) : pctText(d.pct)} from` : `down ${d.pct === null ? format(Math.abs(d.diff ?? 0)) : pctText(d.pct)} from`;
  return `${latest}, ${change} ${format(b.first.value)} on ${formatDay(b.first.day, "medium", locale)}.`;
}

/**
 * Round y axis ticks from 0 (or the lowest negative value) up past the highest value: niceTicks(0, 87) is
 * [0, 25, 50, 75, 100]. `integer` keeps the step a whole number (counts). All zero data gives [0, 1].
 */
export function niceTicks(min: number, max: number, count = 4, integer = false): number[] {
  const lo = Math.min(0, isNum(min) ? min : 0);
  let hi = Math.max(0, isNum(max) ? max : 0);
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  if (integer) step = Math.max(1, Math.ceil(step));
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v < hi + step * 0.999 && ticks.length < 12; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// ---------------------------------------------------------------- sparkline (plain SVG, no recharts)

/**
 * A tiny line with no axes for tiles and table cells. Breaks at days with no data; a lone day shows as a dot; the
 * last day with data gets a slightly bigger dot. Hidden from screen readers unless `label` is given (the tile around
 * it already says the numbers).
 */
export function Sparkline({ rows, height = 28, tone = "brand", label, className }: { rows: readonly TrendPoint[]; height?: number; tone?: SeriesTone; label?: string; className?: string }) {
  const W = 100;
  const pad = 3;
  const nums = rows.map((r) => r.value).filter(isNum);
  if (!nums.length) return <div className={cn("w-full", className)} style={{ height }} aria-hidden />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const x = (i: number) => (rows.length === 1 ? W / 2 : (i / (rows.length - 1)) * W);
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
  let line = "";
  let dots = "";
  let lastIdx = -1;
  rows.forEach((r, i) => {
    if (!isNum(r.value)) return;
    const prev = i > 0 && isNum(rows[i - 1].value);
    const next = i < rows.length - 1 && isNum(rows[i + 1].value);
    const pt = `${x(i).toFixed(2)} ${y(r.value).toFixed(2)}`;
    line += prev ? ` L${pt}` : ` M${pt}`;
    if (!prev && !next) dots += ` M${pt} l0 0`;
    lastIdx = i;
  });
  const last = rows[lastIdx];
  const color = TONE_COLOR[tone];
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full overflow-visible", className)}
      style={{ height }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-testid="sparkline"
    >
      {/* Round caps on zero length segments draw true circles even when the SVG is stretched. */}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {dots && <path d={dots} stroke={color} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {last && isNum(last.value) && <path d={`M${x(lastIdx).toFixed(2)} ${y(last.value).toFixed(2)} l0 0`} stroke={color} strokeWidth={4.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

// ---------------------------------------------------------------- range chips

/** 7, 30 or 90 days as a row of chips. Pages keep the value (in the URL or state) and pass it in. */
export function RangePicker({ value, onChange, options = [7, 30, 90], label = "Time range", className }: {
  value: RangeDays; onChange: (days: RangeDays) => void; options?: RangeDays[]; label?: string; className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-fill p-0.5", className)} data-testid="range-picker">
      {options.map((d) => {
        const on = d === value;
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => { if (!on) onChange(d); }}
            className={cn(
              "h-7 rounded-md px-2.5 text-[12.5px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-10 max-sm:px-3",
              on ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
            )}
          >
            {d} days
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- chart card

function errorText(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return null;
}

/**
 * The frame every console chart sits in: a title, a one line description, an optional control on the right (usually
 * a RangePicker), and the chart, or a skeleton while loading, a "No data yet" note when empty, or the error with a
 * Retry button. Wraps the chart in Suspense, so a lazy chart shows the same skeleton while its code loads.
 */
export function ChartCard({ title, description, action, loading, error, onRetry, empty, emptyText, height = 200, headingLevel = 3, children, className, testId }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  loading?: boolean;
  /** Anything truthy shows the error state; a string or Error message is shown under the heading line. */
  error?: unknown;
  onRetry?: () => void;
  empty?: boolean;
  emptyText?: ReactNode;
  /** The chart area height in px, kept the same in every state so the page does not jump. */
  height?: number;
  headingLevel?: 2 | 3;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const skeleton = <Skeleton className="w-full rounded-lg" style={{ height }} />;
  const msg = errorText(error);
  let body: ReactNode;
  if (loading) body = skeleton;
  else if (error) {
    body = (
      <div role="alert" className="flex flex-col items-center justify-center gap-2 rounded-lg bg-bad-soft/50 px-4 text-center" style={{ minHeight: height }} data-testid="chart-error">
        <IconAlertCircle className="h-5 w-5 text-bad" aria-hidden />
        <p className="text-[13px] font-medium">Could not load this chart.</p>
        {msg && <p className="max-w-sm text-xs text-muted [overflow-wrap:anywhere]">{msg}</p>}
        {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
      </div>
    );
  } else if (empty) {
    body = (
      <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-4 text-center" style={{ minHeight: height }} data-testid="chart-empty">
        <p className="text-[13px] font-medium text-muted">No data yet</p>
        {emptyText && <p className="max-w-sm text-xs text-subtle">{emptyText}</p>}
      </div>
    );
  } else body = <Suspense fallback={skeleton}>{children}</Suspense>;
  return (
    <section className={cn("ds-card flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card", className)} aria-busy={loading || undefined} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-52">
          <H className="text-[14px] font-semibold leading-snug">{title}</H>
          {description && <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {body}
    </section>
  );
}

// ---------------------------------------------------------------- KPI tile

const DELTA_CHIP: Record<DeltaTone, string> = {
  good: "bg-ok-soft text-ok",
  bad: "bg-bad-soft text-bad",
  neutral: "bg-fill text-muted",
};

export interface KpiTileProps {
  label: string;
  /** This period's number; null shows "No data". */
  value: number | null | undefined;
  /** The same number for the previous period; leave out to hide the change. */
  previous?: number | null;
  /** true (default): up is good (green). false: down is good (failures, dead jobs). null: neither, always grey. */
  higherIsBetter?: boolean | null;
  /** How the big number is written; defaults to formatCompact. The exact number is always in the tooltip. */
  format?: (n: number) => string;
  /** What the change compares against, e.g. "vs previous 30 days". */
  periodLabel?: string;
  /** Optional daily values for a sparkline under the number. */
  trend?: readonly TrendPoint[];
  /** For numbers that only started being recorded on a day (YYYY-MM-DD): shows "Since 21 Nov 2026". */
  since?: string | null;
  /** Makes the whole tile a link (for example to the list behind the number). */
  to?: string;
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
  testId?: string;
}

export function KpiTile({ label, value, previous, higherIsBetter = true, format = (n) => formatCompact(n), periodLabel, trend, since, to, hint, loading, className, testId }: KpiTileProps) {
  const shell = cn("ds-card flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-card", className);
  if (loading) {
    return (
      <div className={shell} aria-busy data-testid={testId}>
        <span className="text-[12.5px] font-medium text-muted">{label}</span>
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }
  const has = isNum(value);
  const showDelta = previous !== undefined;
  const delta = formatDelta(value, previous);
  const tone = deltaTone(delta.direction, higherIsBetter);
  const DeltaIcon = delta.direction === "up" ? IconArrowUp : delta.direction === "down" ? IconArrowDown : IconMinus;
  const spoken = delta.direction === "none" ? "No earlier data to compare"
    : delta.direction === "flat" ? "No change"
    : `${delta.direction === "up" ? "Up" : "Down"} ${delta.text.slice(1)}`;
  const toneWord = tone === "good" ? ", better" : tone === "bad" ? ", worse" : "";
  const inner = (
    <>
      <span className="min-w-0 text-[12.5px] font-medium leading-tight text-muted [overflow-wrap:anywhere]">{label}</span>
      <div className={cn("font-semibold leading-none tracking-tight tabular-nums", has ? "text-[26px]" : "text-[17px] text-subtle")} title={has ? formatNumber(value) : undefined} data-testid="kpi-value">
        {has ? format(value) : "No data"}
      </div>
      {showDelta && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs" data-testid="kpi-delta" data-tone={tone}>
          <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium tabular-nums", DELTA_CHIP[tone])} aria-hidden>
            {delta.direction !== "none" && <DeltaIcon className="h-3 w-3" />}
            {delta.text}
          </span>
          {periodLabel && delta.direction !== "none" && <span className="text-subtle" aria-hidden>{periodLabel}</span>}
          <span className="sr-only">{`${spoken}${periodLabel && delta.direction !== "none" ? ` ${periodLabel}` : ""}${toneWord}.`}</span>
        </div>
      )}
      {trend && hasData(trend) && <Sparkline rows={trend} className="mt-1" />}
      {(since || hint) && (
        <div className="text-xs text-subtle">
          {since && <span>Since {formatDay(since, "medium")}</span>}
          {since && hint && <span aria-hidden> · </span>}
          {hint}
        </div>
      )}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cn(shell, "transition-colors hover:border-line-strong hover:bg-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand")} data-testid={testId}>
        {inner}
      </Link>
    );
  }
  return <div className={shell} data-testid={testId}>{inner}</div>;
}

// ---------------------------------------------------------------- lazy charts

/** The recharts charts, loaded on first render so recharts stays out of the console shell chunk. Put them inside a
 *  ChartCard (which supplies the Suspense skeleton) or your own Suspense. Made with lazyPage (R73: one retry, named
 *  export check); quiet, so a chart whose code could not load leaves its card empty instead of a page sized note. */
export const LazyTrendLine = lazyPage(() => import("./charts"), "TrendLine", { quiet: true });
export const LazyTrendBars = lazyPage(() => import("./charts"), "TrendBars", { quiet: true });
