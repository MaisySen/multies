/**
 * R24.1 Formula and rollup fields in the web app (cookie session). Reads only; defining a field
 * is the normal field create or update (POST /api/fields with type formula or rollup).
 *   GET  /api/computed/projects/:id/rollups   project level rollups
 *   GET  /api/computed/tasks/:id              a task's formula and rollup values
 *   GET  /api/computed/preview?projectId&expression&taskId   live preview, saves nothing (a GET, so
 *        no write of any kind happens, not even the rate counter a POST takes)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseQuery, requireAuth } from "../middleware";
import { previewForProject, projectRollups, taskComputed } from "../services/suite/computed";
import { getTask } from "../services/suite/tasks";

export const PreviewBody = z.object({ projectId: z.string().min(1).max(64), expression: z.string().max(500), taskId: z.string().min(1).max(64).optional() });

export function computedRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/projects/:id/rollups", async (c) => c.json(await projectRollups(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/tasks/:id", async (c) => {
      const t = await getTask(c.var.deps, c.var.auth, c.req.param("id"));
      return c.json(await taskComputed(c.var.deps, t, c.var.auth.orgId));
    })
    .get("/preview", async (c) => {
      const b = parseQuery(c, PreviewBody);
      return c.json(await previewForProject(c.var.deps, c.var.auth, b.projectId, b.expression, b.taskId));
    });
}
