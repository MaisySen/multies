/**
 * R24.3 Dashboards in MCP: list_dashboards and get_dashboard_data read (read only keys can call
 * them); create_dashboard and add_dashboard_widget write, so they need a full key or token.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addWidget, CHARTS, createDashboard, dashboardData, GROUP_BYS, listDashboards, MAX_WIDGETS, WIDGET_TYPES, type WidgetInput } from "../services/suite/dashboards";
import type { Scoped } from "./mcp-server";
import { LIST_SORTS, METRICS, NOTE_MAX, OPS, PIVOT_AXES, RANGES } from "../services/suite/dashboards-r38-schema";
import { widgetCatalog } from "../services/suite/dashboard-widget-catalog-r39";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const widget = {
  type: z.enum(WIDGET_TYPES).describe("count (a number), breakdown (tasks grouped by groupBy), due (due this week and overdue), completed (per week, last 8 weeks), burndown (the project's active sprint), goals, reply_times, mail_volume (per day, 14 days), workload (per person, 4 weeks). R38: calculation (a number: tasks done or created, points done or hours tracked in range, sum or per day average, with a goal and the change against the previous range), battery (to do, in progress and done as one bar with the done percent), pivot (counts by groupBy rows and columnBy columns), created_completed (created vs completed per day or week in range), task_list (up to 10 tasks sorted by sort), time_tracked (hours per day or week in range and the top 5 people), note (text you write)."),
  title: z.string().max(80).optional(),
  groupBy: z.enum([...GROUP_BYS, "mailbox", "person"]).optional().describe("breakdown: status, assignee, priority, project, sprint, type or label. reply_times: mailbox or person. pivot rows: status, assignee, priority, project or type."),
  columnBy: z.enum(PIVOT_AXES).optional().describe("pivot columns (default status; never the same as the rows)."),
  range: z.enum(RANGES).optional().describe("calculation, created_completed, time_tracked: the days ending today (default 30d)."),
  metric: z.enum(METRICS).optional().describe("calculation: done, created, points or hours (default done)."),
  op: z.enum(OPS).optional().describe("calculation: sum for the range or avg per day (default sum)."),
  goal: z.number().min(0).max(1_000_000).optional().describe("calculation: a target; the data carries progress in percent."),
  sort: z.enum(LIST_SORTS).optional().describe("task_list: due, priority or updated (default due)."),
  text: z.string().max(NOTE_MAX).optional().describe("note: the text to show."),
  chart: z.enum(CHARTS).optional(),
  size: z.union([z.literal(1), z.literal(2)]).optional(),
  savedViewId: z.string().max(64).optional().describe("Apply a saved view's filters and project."),
  projectId: z.string().max(64).optional(),
  mailboxId: z.string().max(64).optional(),
  filters: z.object({
    assignee: z.string().max(80).optional().describe("member:<id>, agent:<id>, me or none."),
    status: z.enum(["todo", "doing", "done"]).optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    label: z.string().max(80).optional(),
    type: z.enum(["task", "story", "bug", "epic"]).optional(),
    q: z.string().max(200).optional(),
    due: z.enum(["overdue", "week", "none"]).optional(),
  }).optional(),
};
type W = { type: WidgetInput["type"]; title?: string; groupBy?: WidgetInput["groupBy"]; chart?: WidgetInput["chart"]; size?: 1 | 2; savedViewId?: string; projectId?: string; mailboxId?: string; filters?: Record<string, string> }
  & Pick<WidgetInput, "range" | "metric" | "op" | "goal" | "columnBy" | "sort" | "text">;
const toInput = (w: W): WidgetInput => ({
  type: w.type, title: w.title, groupBy: w.groupBy, chart: w.chart, size: w.size,
  range: w.range, metric: w.metric, op: w.op, goal: w.goal, columnBy: w.columnBy, sort: w.sort, text: w.text,
  source: { savedViewId: w.savedViewId, projectId: w.projectId, mailboxId: w.mailboxId, filters: w.filters as never },
});

export function registerDashboardTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_dashboards", {
    title: "List dashboards", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Dashboards you can open (shared ones and your own), with their widget counts.",
    inputSchema: {},
  }, tool(async () => ({ dashboards: await listDashboards(deps, a) })) as never);
  // R39: the widget catalog, so an agent can pick a type and its settings before add_dashboard_widget.
  server.registerTool("list_dashboard_widget_types", {
    title: "List dashboard widget types", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Every dashboard widget type with what it shows, its group, the charts it can use, its default chart and size, the source it reads (savedViewId, projectId with filters, or mailboxId) and each setting it takes with the allowed values and the default. Use it before create_dashboard or add_dashboard_widget. Optional type returns one. Reads no data.",
    inputSchema: { type: z.enum(WIDGET_TYPES).optional() },
  }, tool(async (x: { type?: (typeof WIDGET_TYPES)[number] }) => {
    const c = widgetCatalog();
    return x.type ? { ...c, types: c.types.filter((t) => t.type === x.type) } : c;
  }) as never);
  server.registerTool("get_dashboard_data", {
    title: "Dashboard data", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Every widget's numbers for one dashboard in one call, computed now (counts, groups, due and overdue tasks, completed per week, sprint burndown, goal progress, reply times, mail per day, workload, calculations with trend and goal, battery, pivot tables, created vs completed, task lists, time tracked, notes). Writes nothing.",
    inputSchema: { dashboardId: z.string().min(1).max(64), tz: z.string().max(64).optional() },
  }, tool(async (x: { dashboardId: string; tz?: string }) => dashboardData(deps, a, x.dashboardId, { tz: x.tz })) as never);
  server.registerTool("create_dashboard", {
    title: "Create a dashboard", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `Make a dashboard with up to ${MAX_WIDGETS} widgets, or starter "team" for Team overview (tasks by status and by person, due this week, completed per week). Private unless shared is true; a dashboard made by an agent key is always shared.`,
    inputSchema: { name: z.string().max(80).optional(), shared: z.boolean().optional(), starter: z.enum(["team"]).optional(), widgets: z.array(z.object(widget)).max(MAX_WIDGETS).optional() },
  }, tool(async (x: { name?: string; shared?: boolean; starter?: "team"; widgets?: W[] }) => {
    writable();
    return { dashboard: await createDashboard(deps, a, { name: x.name, shared: x.shared, starter: x.starter, widgets: x.widgets?.map(toInput) }) };
  }) as never);
  server.registerTool("add_dashboard_widget", {
    title: "Add a dashboard widget", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Add one widget at the end of a dashboard. Use savedViewId to reuse a saved view's filters, or projectId and filters.",
    inputSchema: { dashboardId: z.string().min(1).max(64), ...widget },
  }, tool(async (x: W & { dashboardId: string }) => {
    writable();
    return { dashboard: await addWidget(deps, a, x.dashboardId, toInput(x)) };
  }) as never);
}
