/**
 * R39: the widget catalog. Every dashboard widget type with what it shows, the charts it can use, its default chart and
 * size, and each setting it reads (allowed values and the default), so an agent or a script can build a dashboard
 * without guessing. Built from the same constants the widget schema uses, so it cannot drift: a test checks that every
 * type in WIDGET_TYPES is here. Read only; it touches no data.
 */
import { CHARTS, DEFAULT_CHART, GROUP_BYS, MAX_WIDGETS, WIDGET_TYPES, type WidgetType } from "./dashboards";
import { LIST_SORTS, METRICS, NOTE_MAX, OPS, PIVOT_AXES, PIVOT_COLS, PIVOT_ROWS, RANGES } from "./dashboards-r38-schema";

export interface WidgetOption { name: string; what: string; values?: readonly string[]; default?: string | number | null; max?: number }
export interface WidgetTypeInfo {
  type: WidgetType; label: string; group: "Tasks" | "Progress" | "Time" | "Mail" | "Text" | "Custom"; what: string;
  data: "tasks" | "mail" | "goals" | "time" | "none" | "custom";
  charts: readonly string[]; defaultChart: string; defaultSize: 1 | 2; options: WidgetOption[]; source: string[];
}

const TASK_SOURCE = ["savedViewId", "projectId", "filters"];
const groupBy: WidgetOption = { name: "groupBy", what: "What the tasks are grouped by.", values: GROUP_BYS, default: "status" };
const range: WidgetOption = { name: "range", what: "The days ending today.", values: RANGES, default: "30d" };

const INFO: Record<WidgetType, Omit<WidgetTypeInfo, "type" | "defaultChart">> = {
  question: { label: "Question", group: "Custom", what: "Your own question over tasks, deals, forms, bookings, time, mail or a data source (DASHBOARDS_PLUS).", data: "custom", charts: ["number", "bar", "line", "donut", "table"], defaultSize: 1, options: [], source: [] },
  count: { label: "Count", group: "Tasks", what: "How many tasks match the source.", data: "tasks", charts: ["number"], defaultSize: 1, options: [], source: TASK_SOURCE },
  breakdown: { label: "Breakdown", group: "Tasks", what: "Tasks grouped by one field, up to 20 groups.", data: "tasks", charts: ["bar", "donut", "table"], defaultSize: 1, options: [groupBy], source: TASK_SOURCE },
  due: { label: "Due soon", group: "Tasks", what: "Tasks due this week and overdue.", data: "tasks", charts: ["table"], defaultSize: 1, options: [], source: TASK_SOURCE },
  completed: { label: "Completed per week", group: "Progress", what: "Tasks completed per week for the last 8 weeks.", data: "tasks", charts: ["line", "bar"], defaultSize: 2, options: [], source: TASK_SOURCE },
  burndown: { label: "Sprint burndown", group: "Progress", what: "The project's active sprint: points or tasks left per day against the ideal line.", data: "tasks", charts: ["line"], defaultSize: 2, options: [], source: ["projectId"] },
  goals: { label: "Goal progress", group: "Progress", what: "Each goal with its progress in percent.", data: "goals", charts: ["table"], defaultSize: 1, options: [], source: [] },
  reply_times: { label: "Reply times", group: "Mail", what: "Median and slowest first reply times.", data: "mail", charts: ["table", "bar"], defaultSize: 1, options: [{ name: "groupBy", what: "Group by mailbox or person.", values: ["mailbox", "person"], default: "mailbox" }], source: ["mailboxId"] },
  mail_volume: { label: "Mail per day", group: "Mail", what: "Mail received and sent per day for 14 days.", data: "mail", charts: ["line", "bar"], defaultSize: 2, options: [], source: ["mailboxId"] },
  workload: { label: "Workload", group: "Tasks", what: "Open tasks per person for the next 4 weeks.", data: "tasks", charts: ["bar", "table"], defaultSize: 2, options: [], source: TASK_SOURCE },
  calculation: {
    label: "Calculation", group: "Progress", what: "One number for the range with the change against the range before, and progress to a goal.", data: "tasks", charts: ["number"], defaultSize: 1, source: TASK_SOURCE,
    options: [
      { name: "metric", what: "What is added up: tasks done, tasks created, points done or hours tracked.", values: METRICS, default: "done" },
      { name: "op", what: "sum for the range, or avg per day.", values: OPS, default: "sum" },
      range,
      { name: "goal", what: "A target; the data carries progress in percent. Leave it out for none.", default: null, max: 1_000_000 },
    ],
  },
  battery: { label: "Battery", group: "Progress", what: "To do, in progress and done as one bar, with the done percent.", data: "tasks", charts: ["bar"], defaultSize: 1, options: [], source: TASK_SOURCE },
  pivot: {
    label: "Pivot table", group: "Tasks", what: `Counts by one field down and another across (up to ${PIVOT_ROWS} rows and ${PIVOT_COLS} columns, the rest in Other).`, data: "tasks", charts: ["table"], defaultSize: 2, source: TASK_SOURCE,
    options: [
      { name: "groupBy", what: "The rows.", values: PIVOT_AXES, default: "assignee" },
      { name: "columnBy", what: "The columns; never the same as the rows.", values: PIVOT_AXES, default: "status" },
    ],
  },
  created_completed: { label: "Created vs completed", group: "Progress", what: "Tasks created and completed per day or week in the range.", data: "tasks", charts: ["bar", "line"], defaultSize: 2, options: [range], source: TASK_SOURCE },
  task_list: { label: "Task list", group: "Tasks", what: "Up to 10 tasks from the source.", data: "tasks", charts: ["table"], defaultSize: 1, options: [{ name: "sort", what: "The order.", values: LIST_SORTS, default: "due" }], source: TASK_SOURCE },
  time_tracked: { label: "Time tracked", group: "Time", what: "Hours tracked per day or week in the range, and the top 5 people.", data: "time", charts: ["bar", "line"], defaultSize: 2, options: [range], source: TASK_SOURCE },
  note: { label: "Note", group: "Text", what: "Text you write, for context beside the numbers.", data: "none", charts: ["table"], defaultSize: 1, options: [{ name: "text", what: "The text to show.", max: NOTE_MAX }], source: [] },
};

/** Every widget type, in the order the add widget sheet shows them, with options and defaults. */
export function widgetCatalog() {
  const types: WidgetTypeInfo[] = WIDGET_TYPES.map((type) => {
    const i = INFO[type];
    const defaultChart = DEFAULT_CHART[type];
    return { type, ...i, charts: i.charts.includes(defaultChart) ? i.charts : [defaultChart, ...i.charts], defaultChart };
  });
  return {
    types,
    common: [
      { name: "title", what: "Shown on the widget; a default is made from the type and settings.", max: 80 },
      { name: "chart", what: "How it is drawn; each type lists the charts it can use.", values: CHARTS },
      { name: "size", what: "1 or 2 columns wide.", values: ["1", "2"] },
      { name: "source", what: "Which tasks: savedViewId (a saved view's filters and project), or projectId with filters { assignee, status, priority, label, type, q, due }; mail widgets take mailboxId." },
    ] as WidgetOption[],
    maxWidgets: MAX_WIDGETS,
  };
}
