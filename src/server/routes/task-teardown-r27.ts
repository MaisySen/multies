/**
 * R27 (teardown): task watchers and duplicate in the app (cookie session). The same services back REST
 * (v1-r27-teardown.ts) and MCP (mcp-r27-teardown.ts).
 *   GET    /api/tasks/:id/watchers            who watches, and whether I do
 *   POST   /api/tasks/:id/watchers            { userId? } watch (me, or another member)
 *   DELETE /api/tasks/:id/watchers/:userId    stop watching ("me" for myself)
 *   POST   /api/tasks/:id/duplicate           { title?, projectId?, subtasks?, checklist?, assignee?, dependencies? }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { listWatchers, unwatchTask, watchTask } from "../services/suite/task-watchers-r27";
import { duplicateTask } from "../services/suite/task-duplicate-r27";

export const WatchBody = z.object({ userId: z.string().min(1).max(120).optional() });
export const DuplicateBody = z.object({
  title: z.string().min(1).max(500).optional(),
  projectId: z.string().min(1).max(80).optional(),
  subtasks: z.boolean().optional(),
  checklist: z.boolean().optional(),
  assignee: z.boolean().optional(),
  dependencies: z.boolean().optional(),
}).strict();

/** /api/tasks/:id/watchers and /api/tasks/:id/duplicate (mounted before taskRoutes). */
export function taskTeardownRoutes() {
  return new Hono<AppEnv>()
    .use("/:id/watchers", requireAuth)
    .use("/:id/watchers/*", requireAuth)
    .use("/:id/duplicate", requireAuth)
    .get("/:id/watchers", async (c) => c.json(await listWatchers(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/watchers", async (c) => {
      const b = await parseBody(c, WatchBody);
      return c.json(await watchTask(c.var.deps, c.var.auth, c.req.param("id"), b.userId));
    })
    .delete("/:id/watchers/:userId", async (c) => c.json(await unwatchTask(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("userId"))))
    .post("/:id/duplicate", async (c) => c.json(await duplicateTask(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DuplicateBody)), 201));
}
