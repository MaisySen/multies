/**
 * R24.3 Dashboards in the web app (cookie session): list, create (or the starter in one click), read,
 * save (name, share and the whole widget list in one row write), add a widget, remove, and
 * GET /api/dashboards/:id/data for every widget's numbers in one request (writes nothing).
 * Guests have no session here, so they are refused.
 */
import { widgetCatalog } from "../services/suite/dashboard-widget-catalog-r39";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { addWidget, createDashboard, dashboardData, deleteDashboard, getDashboard, listDashboards, MAX_WIDGETS, updateDashboard, WidgetInput } from "../services/suite/dashboards";

export const DashboardCreate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  starter: z.enum(["team"]).optional(),
  widgets: z.array(WidgetInput).max(MAX_WIDGETS).optional(),
});
export const DashboardPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  widgets: z.array(WidgetInput).max(MAX_WIDGETS).optional(),
  version: z.number().int().optional(),
});

/** Parses a body with a schema; a bad body is a 422 with the first issue in plain words. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const max = r.error.issues.find((i) => i.code === "too_big" && i.path[0] === "widgets" && i.path.length === 1);
    if (max) throw new HttpError(422, "too_many_widgets", `A dashboard holds up to ${MAX_WIDGETS} widgets.`);
    throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the request.", r.error.issues);
  }
  return r.data;
}
const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

export function savedDashboardRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ dashboards: await listDashboards(c.var.deps, c.var.auth) }))
    .get("/widget-types", (c) => c.json(widgetCatalog())) // R39: before /:id
    .post("/", async (c) => c.json({ dashboard: await createDashboard(c.var.deps, c.var.auth, parseBody(DashboardCreate, await body(c))) }, 201))
    .get("/:id", async (c) => c.json({ dashboard: await getDashboard(c.var.deps, c.var.auth, c.req.param("id")) }))
    .get("/:id/data", async (c) => c.json(await dashboardData(c.var.deps, c.var.auth, c.req.param("id"), { tz: c.req.query("tz") })))
    .patch("/:id", async (c) => c.json({ dashboard: await updateDashboard(c.var.deps, c.var.auth, c.req.param("id"), parseBody(DashboardPatch, await body(c))) }))
    .post("/:id/widgets", async (c) => c.json({ dashboard: await addWidget(c.var.deps, c.var.auth, c.req.param("id"), parseBody(WidgetInput, await body(c))) }, 201))
    .delete("/:id", async (c) => c.json(await deleteDashboard(c.var.deps, c.var.auth, c.req.param("id"))));
}
