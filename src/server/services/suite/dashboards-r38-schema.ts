/**
 * R38 dashboard widgets, the shape only (no imports from dashboards.ts, so either file can load first).
 * Seven widget types the big work apps' dashboards are built from and Multies lacked: a calculation
 * number with a goal and a trend, a battery bar by status, a pivot (X by Y) table, created vs
 * completed over time, a task list, time tracked and a note. Their settings live in the widget JSON.
 */
import { z } from "zod";

export const R38_WIDGET_TYPES = ["calculation", "battery", "pivot", "created_completed", "task_list", "time_tracked", "note"] as const;
export type R38WidgetType = (typeof R38_WIDGET_TYPES)[number];
/** The date range a time based widget covers, ending today. */
export const RANGES = ["7d", "30d", "90d", "180d"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90, "180d": 180 };
/** What a calculation adds up: tasks done, tasks created, points done or hours tracked in the range. */
export const METRICS = ["done", "created", "points", "hours"] as const;
export type Metric = (typeof METRICS)[number];
/** sum: the total for the range; avg: the total per day. */
export const OPS = ["sum", "avg"] as const;
/** The axes a pivot can use for its rows and its columns. */
export const PIVOT_AXES = ["status", "assignee", "priority", "project", "type"] as const;
export type PivotAxis = (typeof PIVOT_AXES)[number];
export const LIST_SORTS = ["due", "priority", "updated"] as const;
export const NOTE_MAX = 2000;
/** A pivot shows at most this many rows and columns; the rest are added up in "Other". */
export const PIVOT_ROWS = 20;
export const PIVOT_COLS = 8;

/** The R38 settings a widget may carry; each is kept only on the types that use it. */
export const R38WidgetFields = {
  range: z.enum(RANGES).optional(),
  metric: z.enum(METRICS).optional(),
  op: z.enum(OPS).optional(),
  goal: z.number().min(0).max(1_000_000).nullable().optional(),
  columnBy: z.enum(PIVOT_AXES).optional(),
  sort: z.enum(LIST_SORTS).optional(),
  text: z.string().max(NOTE_MAX).optional(),
};
export interface R38WidgetSettings {
  range?: Range; metric?: Metric; op?: (typeof OPS)[number]; goal?: number | null; columnBy?: PivotAxis; sort?: (typeof LIST_SORTS)[number]; text?: string;
}

const METRIC_TITLE: Record<Metric, string> = { done: "Tasks done", created: "Tasks created", points: "Points done", hours: "Hours tracked" };
const AXIS_TITLE: Record<PivotAxis, string> = { status: "status", assignee: "person", priority: "priority", project: "project", type: "type" };

export function r38DefaultTitle(type: R38WidgetType, w: { groupBy?: string | null } & R38WidgetSettings): string {
  switch (type) {
    case "calculation": return METRIC_TITLE[w.metric ?? "done"];
    case "battery": return "Progress";
    case "pivot": return `Tasks by ${AXIS_TITLE[(w.groupBy as PivotAxis) ?? "assignee"] ?? "person"} and ${AXIS_TITLE[w.columnBy ?? "status"]}`;
    case "created_completed": return "Created vs completed";
    case "task_list": return "Tasks";
    case "time_tracked": return "Time tracked";
    case "note": return "Note";
  }
}

/** Keeps only the settings a type uses, with defaults filled in, so the saved JSON stays small. */
export function r38Settings(type: string, w: R38WidgetSettings & { groupBy?: string | null }): { groupBy?: PivotAxis } & R38WidgetSettings {
  switch (type) {
    case "calculation": return { metric: w.metric ?? "done", op: w.op ?? "sum", range: w.range ?? "30d", goal: w.goal ?? null };
    case "pivot": {
      const rows = (PIVOT_AXES as readonly string[]).includes(w.groupBy ?? "") ? (w.groupBy as PivotAxis) : "assignee";
      let cols = w.columnBy ?? "status";
      if (cols === rows) cols = rows === "status" ? "priority" : "status";
      return { groupBy: rows, columnBy: cols };
    }
    case "created_completed": return { range: w.range ?? "30d" };
    case "time_tracked": return { range: w.range ?? "30d" };
    case "task_list": return { sort: w.sort ?? "due" };
    case "note": return { text: (w.text ?? "").trim() };
    default: return {};
  }
}
