/**
 * OPS1 Trends: reads for the console's trend views (GET /api/console/metrics, /registry, /workspaces/:id), the range
 * kept in the address (?range=7|30|90), and small pure helpers that turn the API's aligned arrays into chart points
 * and tile numbers. A null value is "no data" everywhere and never becomes a zero.
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { consoleGet, listQuery } from "@/web/lib/console-api";
import { rangeStart, type RangeDays, type TrendPoint } from "./components/kpi";

export interface MetricsRead {
  from: string;
  to: string;
  liveDay: string | null;
  days: string[];
  series: Record<string, (number | null)[]>;
  firstDay: Record<string, string | null>;
}

export interface MetricInfo {
  key: string; label: string; kind: "flow" | "stock"; unit: string; description: string; retentionDays: number | null;
}
export interface MetricsRegistry { metrics: MetricInfo[]; ranges: number[]; maxBackfillDays: number }

export interface WorkspaceTrends {
  from: string;
  to: string;
  days: string[];
  series: Record<string, (number | null)[]>;
  ai: { historyDays: number | null; from: string | null; partial: boolean };
}

export interface RunSummary { ok: true; skipped: string | null; days: number; from: string | null; to: string | null; rows: number }

const RANGES: readonly RangeDays[] = [7, 30, 90];
export const DEFAULT_RANGE: RangeDays = 30;

export const trendsKeys = {
  registry: ["console", "metrics", "registry"] as const,
  read: (q: Record<string, string>) => ["console", "metrics", "read", q] as const,
  workspace: (id: string, days: RangeDays) => ["console", "metrics", "workspace", id, days] as const,
};

export const trendsApi = {
  // Reads through consoleGet: one request, the server's own message on an error, no silent retries.
  registry: () => consoleGet<MetricsRegistry>("/console/metrics/registry"),
  read: (q: Record<string, string>) => consoleGet<MetricsRead>(`/console/metrics${listQuery(q)}`),
  workspace: (id: string, days: RangeDays) => consoleGet<WorkspaceTrends>(`/console/metrics/workspaces/${encodeURIComponent(id)}${listQuery({ days: String(days) })}`),
  backfill: (body: { days: number; reason: string }) => api.post<RunSummary>("/console/metrics/backfill", body),
};

/** The range in the address (?range=7|30|90), 30 days when missing or unknown. */
export function parseRange(v: string | null | undefined): RangeDays {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as RangeDays) : DEFAULT_RANGE;
}

/** The trends range kept in the address so a link opens the same view. */
export function useTrendRange(): [RangeDays, (d: RangeDays) => void] {
  const [params, setParams] = useSearchParams();
  const days = parseRange(params.get("range"));
  const set = useCallback((d: RangeDays) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (d === DEFAULT_RANGE) next.delete("range"); else next.set("range", String(d));
      return next;
    }, { replace: true });
  }, [setParams]);
  return [days, set];
}

/** The previous period of the same length, ending the day before `from`. */
export function previousRange(from: string, days: number): { from: string; to: string } {
  const to = rangeStart(from, 2);
  return { from: rangeStart(to, days), to };
}

/** One series as chart points (aligned with `days`); a missing series is all null. */
export function pointsOf(read: { days: string[]; series: Record<string, (number | null)[]> } | undefined, key: string): TrendPoint[] {
  if (!read) return [];
  const s = read.series[key];
  return read.days.map((day, i) => ({ day, value: typeof s?.[i] === "number" ? s[i] : null }));
}

/** A flow metric's total over the points, or null when no day has data. */
export function sumOf(points: readonly TrendPoint[]): number | null {
  let total: number | null = null;
  for (const p of points) if (typeof p.value === "number") total = (total ?? 0) + p.value;
  return total;
}

/** A stock metric's latest value in the points, or null when no day has data. */
export function lastOf(points: readonly TrendPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].value;
    if (typeof v === "number") return v;
  }
  return null;
}

/**
 * The "since" day for a stock metric: the first stored day when its history starts inside the range, or today when
 * nothing is stored yet but today's live value is there. null when the history covers the whole range.
 */
export function sinceOf(read: MetricsRead | undefined, keys: readonly string[]): string | null {
  if (!read) return null;
  const firsts = keys.map((k) => read.firstDay[k]).filter((d): d is string => !!d).sort();
  const first = firsts[0] ?? null;
  if (first) return first > read.from ? first : null;
  return read.liveDay && keys.some((k) => typeof read.series[k]?.[read.days.indexOf(read.liveDay!)] === "number") ? read.liveDay : null;
}

/** True when none of these metrics has a stored day (only today's live values, if any). */
export function noStoredDays(read: MetricsRead | undefined, keys: readonly string[]): boolean {
  return !!read && keys.every((k) => !read.firstDay[k]);
}

export function useMetricsRegistry() {
  return useQuery({ queryKey: trendsKeys.registry, queryFn: trendsApi.registry, staleTime: 10 * 60_000 });
}

export function useMetricsRead(q: Record<string, string> | null) {
  return useQuery({
    queryKey: trendsKeys.read(q ?? {}),
    queryFn: () => trendsApi.read(q!),
    enabled: !!q,
    staleTime: 60_000,
  });
}

export function useWorkspaceTrends(orgId: string, days: RangeDays) {
  return useQuery({ queryKey: trendsKeys.workspace(orgId, days), queryFn: () => trendsApi.workspace(orgId, days), staleTime: 60_000 });
}

/**
 * Plain names for the per workspace daily usage counters (usage_counters metrics kept by day), in the order the
 * Trends tab offers them: rows written first (it drives the workspace write budget), then the rest by usefulness.
 */
const COUNTER_LABELS: Record<string, string> = {
  d1_rows: "Rows written",
  chat_in: "Chat messages received",
  automation_runs: "Automation runs",
  work_import_tasks: "Tasks imported",
  meeting_participant_minutes: "Meeting minutes",
};

export function counterLabel(metric: string): string {
  if (COUNTER_LABELS[metric]) return COUNTER_LABELS[metric];
  const words = metric.replace(/[_:.-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : metric;
}

const COUNTER_ORDER = Object.keys(COUNTER_LABELS);

/**
 * The usage counter series keys ("usage:<metric>") as chips in a fixed order: known counters in COUNTER_LABELS order,
 * then any other counter by its label. Never depends on the order the API's object keys arrive in.
 */
export function orderCounters(keys: readonly string[]): { id: string; label: string }[] {
  const rank = (metric: string) => { const i = COUNTER_ORDER.indexOf(metric); return i === -1 ? COUNTER_ORDER.length : i; };
  return keys
    .filter((k) => k.startsWith("usage:"))
    .map((k) => { const metric = k.slice("usage:".length); return { id: k, metric, label: counterLabel(metric) }; })
    .sort((a, b) => rank(a.metric) - rank(b.metric) || a.label.localeCompare(b.label, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, label }) => ({ id, label }));
}
