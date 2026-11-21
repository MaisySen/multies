/**
 * OPS1 Trends: the console's recharts charts (TrendLine, TrendBars), after pages/app/work/dashboard-widgets-r38.tsx.
 * Quiet on purpose: thin lines, light horizontal gridlines, round y ticks from zero, a tooltip with the full date and
 * exact value, a legend only when there are two series. Colours come from the theme tokens, so light, dark and brand
 * themes all work. A day whose value is null is "no data": the line breaks there and no bar is drawn; a zero is drawn
 * as zero (a short stub on the baseline for bars).
 *
 * This module pulls in recharts, so load it lazily: use LazyTrendLine and LazyTrendBars from ./kpi (inside a
 * ChartCard), or `lazyPage(() => import("./charts"), "TrendLine")`. The light pieces (helpers,
 * KpiTile, Sparkline, RangePicker, ChartCard) are re-exported here for convenience but live in ./kpi.
 */
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/web/lib/cn";
import { CHART_KEY as KEY, describeTrend, formatCompact, formatDay, formatNumber, mergeSeries, niceTicks, TONE_COLOR, type ChartRow, type SeriesTone, type TrendSeries } from "./kpi";

export {
  ChartCard, dataBounds, deltaTone, describeTrend, fillDays, formatCompact, formatDay, formatDelta, formatNumber, hasData, KpiTile,
  mergeSeries, niceTicks, rangeStart, RangePicker, Sparkline,
} from "./kpi";
export type { ChartRow, Delta, DeltaDirection, DeltaTone, KpiTileProps, RangeDays, SeriesTone, TrendPoint, TrendSeries } from "./kpi";

export interface TrendChartProps {
  /** What the chart shows, for the screen reader summary ("Deliveries"). */
  label: string;
  /** One series, or two for a comparison (sent and failed). More than two are ignored. */
  series: readonly TrendSeries[];
  /** Chart height in px (default 200, the same as ChartCard's skeleton). */
  height?: number;
  /** How values are written in the tooltip and summary (default: exact, 1,234). Axis ticks always use formatCompact. */
  format?: (n: number) => string;
  /** Whole numbers only on the y axis (counts). Default true. */
  integer?: boolean;
  /** Replaces the generated screen reader summary. */
  summary?: string;
  className?: string;
  testId?: string;
}

const toneOf = (s: TrendSeries, i: number): SeriesTone => s.tone ?? (i === 0 ? "brand" : "neutral");
const TICK = { fill: "var(--color-muted)", fontSize: 11 } as const;

function useChart(series: readonly TrendSeries[], integer: boolean, label: string, format: (n: number) => string, summary?: string) {
  return useMemo(() => {
    const list = series.slice(0, 2);
    const data = mergeSeries(list);
    const nums = data.flatMap((r) => list.map((_, i) => r[KEY(i)])).filter((v): v is number => typeof v === "number");
    const ticks = niceTicks(nums.length ? Math.min(...nums) : 0, nums.length ? Math.max(...nums) : 0, 4, integer);
    // Room for the longest tick label (about 6.5 px a character at 11 px) so labels are never clipped.
    const yWidth = Math.max(24, Math.max(...ticks.map((t) => formatCompact(t).length)) * 6.5 + 10);
    const text = summary ?? (list.length === 1
      ? describeTrend(label, list[0].rows, format)
      : `${label}. ${list.map((s) => describeTrend(s.label, s.rows, format)).join(" ")}`);
    return { list, data, ticks, yWidth, text };
  }, [series, integer, label, format, summary]);
}

/** Two series get a small legend with the line style; one series gets none (the card title names it). */
function SeriesLegend({ list, kind }: { list: readonly TrendSeries[]; kind: "line" | "bar" }) {
  if (list.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted" aria-hidden>
      {list.map((s, i) => {
        const color = TONE_COLOR[toneOf(s, i)];
        return (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            {kind === "line"
              ? <svg width="16" height="6" aria-hidden><line x1="1" y1="3" x2="15" y2="3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={dashed(s, i) ? "3 3" : undefined} /></svg>
              : <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />}
            {s.label}
          </span>
        );
      })}
    </div>
  );
}
/** A grey second series is dashed, so the two lines differ by more than colour. */
const dashed = (s: TrendSeries, i: number) => i > 0 && toneOf(s, i) === "neutral";

interface TipProps { active?: boolean; label?: unknown; payload?: readonly { payload?: unknown }[] }
function ChartTooltip({ active, label, payload, list, data, format }: TipProps & { list: readonly TrendSeries[]; data: ChartRow[]; format: (n: number) => string }) {
  if (!active) return null;
  const row = (payload?.[0]?.payload as ChartRow | undefined) ?? data.find((r) => r.day === label);
  if (!row) return null;
  return (
    <div className="min-w-36 rounded-[10px] border border-line bg-elevated px-3 py-2 text-[12px] shadow-pop" data-testid="chart-tooltip">
      <div className="mb-1 font-medium text-fg">{formatDay(row.day, "long")}</div>
      {list.map((s, i) => {
        const v = row[KEY(i)];
        return (
          <div key={s.label} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: TONE_COLOR[toneOf(s, i)] }} aria-hidden />
              {s.label}
            </span>
            <span className={cn("tabular-nums", v === null ? "text-subtle" : "font-medium text-fg")}>{v === null ? "No data" : format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

interface DotProps { cx?: number; cy?: number; index?: number }

/** Daily values as a line (or two). Gaps where a day has no data; a day with data between two gaps shows as a dot. */
export function TrendLine({ label, series, height = 200, format = (n) => formatNumber(n), integer = true, summary, className, testId }: TrendChartProps) {
  const { list, data, ticks, yWidth, text } = useChart(series, integer, label, format, summary);
  return (
    <div role="img" aria-label={text} className={cn("min-w-0", className)} data-testid={testId ?? "trend-line"}>
      <SeriesLegend list={list} kind="line" />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 14, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            <XAxis dataKey="day" tickFormatter={(d: string) => formatDay(d)} tick={TICK} tickLine={false} axisLine={{ stroke: "var(--color-line-strong)" }}
              tickMargin={6} minTickGap={24} interval="preserveStartEnd" padding={{ left: 6, right: 6 }} />
            <YAxis width={yWidth} ticks={ticks} domain={[ticks[0], ticks[ticks.length - 1]]} tickFormatter={(n: number) => formatCompact(n)} tick={TICK}
              tickLine={false} axisLine={false} allowDecimals={!integer} />
            <Tooltip content={(p) => <ChartTooltip {...(p as TipProps)} list={list} data={data} format={format} />} filterNull={false} cursor={{ stroke: "var(--color-line-strong)" }} isAnimationActive={false} />
            {list.map((s, i) => {
              const color = TONE_COLOR[toneOf(s, i)];
              const key = KEY(i);
              const lone = (idx: number) => data[idx]?.[key] != null && data[idx - 1]?.[key] == null && data[idx + 1]?.[key] == null;
              return (
                <Line key={key} dataKey={key} name={s.label} type="linear" stroke={color} strokeWidth={1.75} strokeDasharray={dashed(s, i) ? "4 3" : undefined}
                  connectNulls={false} isAnimationActive={false} activeDot={{ r: 3.5, strokeWidth: 0, fill: color }}
                  dot={(p: DotProps) => (p.index !== undefined && p.cx != null && p.cy != null && lone(p.index)
                    ? <circle key={`${key}-${p.index}`} cx={p.cx} cy={p.cy} r={2.5} fill={color} />
                    : <g key={`${key}-${p.index}`} />)} />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface BarShapeProps { x?: number; y?: number; width?: number; height?: number; payload?: ChartRow; fill?: string; index?: number }

/** Daily values as bars (grouped when there are two series). No bar where a day has no data; a stub for zero. */
export function TrendBars({ label, series, height = 200, format = (n) => formatNumber(n), integer = true, summary, className, testId }: TrendChartProps) {
  const { list, data, ticks, yWidth, text } = useChart(series, integer, label, format, summary);
  return (
    <div role="img" aria-label={text} className={cn("min-w-0", className)} data-testid={testId ?? "trend-bars"}>
      <SeriesLegend list={list} kind="bar" />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 14, bottom: 0, left: 0 }} barGap={1} barCategoryGap="20%" accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            <XAxis dataKey="day" tickFormatter={(d: string) => formatDay(d)} tick={TICK} tickLine={false} axisLine={{ stroke: "var(--color-line-strong)" }}
              tickMargin={6} minTickGap={24} interval="preserveStartEnd" />
            <YAxis width={yWidth} ticks={ticks} domain={[ticks[0], ticks[ticks.length - 1]]} tickFormatter={(n: number) => formatCompact(n)} tick={TICK}
              tickLine={false} axisLine={false} allowDecimals={!integer} />
            <Tooltip content={(p) => <ChartTooltip {...(p as TipProps)} list={list} data={data} format={format} />} filterNull={false} cursor={{ fill: "var(--color-fill)", opacity: 0.6 }} isAnimationActive={false} />
            {list.map((s, i) => {
              const color = TONE_COLOR[toneOf(s, i)];
              const key = KEY(i);
              return (
                <Bar key={key} dataKey={key} name={s.label} fill={color} maxBarSize={18} isAnimationActive={false}
                  shape={(p: BarShapeProps) => {
                    const v = p.payload?.[key];
                    const k = `${key}-${p.index}`;
                    if (v === null || v === undefined || p.x === undefined || p.y === undefined || !p.width) return <g key={k} />;
                    if (v === 0) return <rect key={k} x={p.x} y={p.y - 1.5} width={p.width} height={1.5} fill={color} opacity={0.6} />;
                    return <Rectangle key={k} x={p.x} y={p.y} width={p.width} height={p.height} fill={color} radius={[2, 2, 0, 0]} />;
                  }} />
              );
            })}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
