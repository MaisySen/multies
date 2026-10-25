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

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const widget = {
  type: z.enum(WIDGET_TYPES).describe("count (a number), breakdown (tasks grouped by groupBy), due (due this week and overdue), completed (per week, last 8 weeks), burndown (the project's active sprint), goals, reply_times, mail_volume (per day, 14 days), workload (per person, 4 weeks)."),
  title: z.string().max(80).optional(),
  groupBy: z.enum([...GROUP_BYS, "mailbox", "person"]).optional().describe("breakdown: status, assignee, priority, project, sprint, type or label. reply_times: mailbox or person."),
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
type W = { type: WidgetInput["type"]; title?: string; groupBy?: WidgetInput["groupBy"]; chart?: WidgetInput["chart"]; size?: 1 | 2; savedViewId?: string; projectId?: string; mailboxId?: string; filters?: Record<string, string> };
const toInput = (w: W): WidgetInput => ({
  type: w.type, title: w.title, groupBy: w.groupBy, chart: w.chart, size: w.size,
  source: { savedViewId: w.savedViewId, projectId: w.projectId, mailboxId: w.mailboxId, filters: w.filters as never },
});

export function registerDashboardTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_dashboards", {
    title: "List dashboards", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Dashboards you can open (shared ones and your own), with their widget counts.",
    inputSchema: {},
  }, tool(async () => ({ dashboards: await listDashboards(deps, a) })) as never);
  server.registerTool("get_dashboard_data", {
    title: "Dashboard data", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Every widget's numbers for one dashboard in one call, computed now (counts, groups, due and overdue tasks, completed per week, sprint burndown, goal progress, reply times, mail per day, workload). Writes nothing.",
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
