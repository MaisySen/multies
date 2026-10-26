/**
 * R24.3 Dashboards in the public API (v1). Reads (the list, one dashboard, its data) work with read
 * only keys; creating, saving, adding a widget and removing need a full key. A private dashboard is
 * seen only through a key its owner made.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addWidget, createDashboard, dashboardData, deleteDashboard, getDashboard, listDashboards, updateDashboard, WidgetInput } from "../services/suite/dashboards";
import { DashboardCreate, DashboardPatch, parseBody } from "./dashboards";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
const IdParam = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const anyBody = { body: { required: true, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } };
const common = { 401: err("Missing or invalid API key."), 403: err("A read only key, or not the dashboard's owner."), 404: err("A dashboard, saved view, project or mailbox that is not in this workspace or not yours."), 422: err("Validation failed, or over 24 widgets or 50 dashboards.") };
const tags = ["Dashboards"];
const security = [{ bearerAuth: [] }];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerDashboardRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({ method: "get", path: "/dashboards", tags, security, summary: "List dashboards", description: "Shared dashboards and the key owner's private ones, with their widget counts.", responses: { 200: json("The dashboards."), 401: common[401] } }),
    async (c) => c.json({ dashboards: await listDashboards(c.var.deps, actor(c)) } as any, 200) as any);
  api.openapi(createRoute({
    method: "post", path: "/dashboards", tags, security, summary: "Create a dashboard",
    description: "Body: name, shared (default false; a dashboard made by an agent key is always shared), widgets (up to 24; see GET /dashboards/{id}), or starter: \"team\" for Team overview (by status, by person, due this week, completed per week). One row write.",
    request: anyBody as any, responses: { 201: json("The dashboard."), ...common },
  }), async (c) => c.json({ dashboard: await createDashboard(c.var.deps, actor(c), parseBody(DashboardCreate, await c.req.json().catch(() => ({})))) } as any, 201) as any);
  api.openapi(createRoute({ method: "get", path: "/dashboards/{id}", tags, security, summary: "Get a dashboard", description: "The dashboard and its widgets: id, type (count, breakdown, due, completed, burndown, goals, reply_times, mail_volume, workload, and from R38 calculation, battery, pivot, created_completed, task_list, time_tracked, note), title, source ({ savedViewId } or { projectId } and inline filters { assignee, status, priority, label, type, q, due }, or { mailboxId }), groupBy, chart (number, bar, donut, line, table), size (1 or 2 columns), position, and the R38 settings: range (7d, 30d, 90d, 180d), metric (done, created, points, hours) and op (sum, avg) and goal for calculation, columnBy for pivot (status, assignee, priority, project, type), sort for task_list (due, priority, updated), text for note.", request: { params: IdParam }, responses: { 200: json("The dashboard."), ...common } }),
    async (c) => c.json({ dashboard: await getDashboard(c.var.deps, actor(c), c.req.param("id")) } as any, 200) as any);
  api.openapi(createRoute({
    method: "get", path: "/dashboards/{id}/data", tags, security, summary: "Every widget's data",
    description: "All widget data for a dashboard in one request, computed on read (it writes nothing). Each widget answers { id, type, data, error }; a widget whose saved filter was removed carries an error and the rest still answer. Query: tz (an IANA zone; default the key owner's or the workspace's).",
    request: { params: IdParam }, responses: { 200: json("The data."), ...common },
  }), async (c) => c.json(await dashboardData(c.var.deps, actor(c), c.req.param("id"), { tz: c.req.query("tz") }) as any, 200) as any);
  api.openapi(createRoute({ method: "patch", path: "/dashboards/{id}", tags, security, summary: "Save a dashboard", description: "Body: name, shared, widgets (the whole list, in order), version (optional; a stale one answers 409). One row write.", request: { params: IdParam, ...anyBody } as any, responses: { 200: json("The dashboard."), 409: err("Someone changed it first."), ...common } }),
    async (c) => c.json({ dashboard: await updateDashboard(c.var.deps, actor(c), c.req.param("id"), parseBody(DashboardPatch, await c.req.json().catch(() => ({})))) } as any, 200) as any);
  api.openapi(createRoute({ method: "post", path: "/dashboards/{id}/widgets", tags, security, summary: "Add a widget", description: "Body: one widget (type, title, source, groupBy, chart, size); it goes last. One row write.", request: { params: IdParam, ...anyBody } as any, responses: { 201: json("The dashboard."), ...common } }),
    async (c) => c.json({ dashboard: await addWidget(c.var.deps, actor(c), c.req.param("id"), parseBody(WidgetInput, await c.req.json().catch(() => ({})))) } as any, 201) as any);
  api.openapi(createRoute({ method: "delete", path: "/dashboards/{id}", tags, security, summary: "Remove a dashboard", description: "The owner, or a workspace admin for a shared one.", request: { params: IdParam }, responses: { 200: json("Removed."), ...common } }),
    async (c) => c.json(await deleteDashboard(c.var.deps, actor(c), c.req.param("id")) as any, 200) as any);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
