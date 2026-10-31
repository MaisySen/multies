/**
 * Round 21 (R21.2): bulk task changes for the table view (cookie session) and the public API.
 * The rules live in services/suite/bulk.ts: up to 500 tasks, one batch of writes, refused for read
 * only keys and when the daily write budget is at shed.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { bulkDeleteTasks, bulkUpdateTasks } from "../services/suite/bulk";
import { AssigneeRef, Category, Priority } from "./suite-schemas";

const label = z.string().trim().min(1).max(40);
const when = z.string().max(40).nullable().optional().openapi({ description: "ISO 8601 date or date-time; null clears.", example: "2026-11-03" });

export const BulkPatch = z.object({
  status: Category.optional(),
  statusId: z.string().max(80).optional().openapi({ description: "A status in the tasks' project (all picked tasks must share it)." }),
  assignee: AssigneeRef,
  priority: Priority.optional(),
  dueAt: when, startAt: when,
  addLabels: z.array(label).max(20).optional(), removeLabels: z.array(label).max(20).optional(),
  projectId: z.string().max(80).optional().openapi({ description: "Move the tasks to this project; each status maps to the same group there." }),
  type: z.enum(["task", "story", "bug"]).optional().openapi({ description: "Round 21: set the type. Epics are changed one at a time." }),
  addAssignees: z.array(z.string().max(80).regex(/^(member|agent):[A-Za-z0-9_-]{1,64}$/)).max(10).optional()
    .openapi({ description: "R84: people to add (member:<id> or agent:<id>); the first becomes the main assignee of a task with none." }),
  fields: z.record(z.string().max(80), z.unknown()).optional()
    .openapi({ description: "R84: custom field values by field id or workspace field key, in each task's own project; null clears." }),
}).strict().openapi("TaskBulkPatch");

// The cap (500) is the service's, so the answer above it is a plain 413 rather than a schema error.
const Ids = z.array(z.string().min(1).max(80)).min(1).max(5000).openapi({ description: "Task ids or references like OPS-12, at most 500.", example: ["OPS-12", "OPS-13"] });
export const BulkUpdateBody = z.object({ ids: Ids, patch: BulkPatch }).openapi("TaskBulkUpdate");
export const BulkDeleteBody = z.object({ ids: Ids }).openapi("TaskBulkDelete");

/** Auth once: the plain task router mounted at the same path may already have resolved it. */
const auth: MiddlewareHandler<AppEnv> = async (c, next) => (c.var.auth ? next() : requireAuth(c, next));

export function taskBulkRoutes() {
  return new Hono<AppEnv>()
    .post("/bulk", auth, async (c) => {
      const b = await parseBody(c, BulkUpdateBody);
      return c.json(await bulkUpdateTasks(c.var.deps, c.var.auth, b.ids, b.patch));
    })
    .post("/bulk-delete", auth, async (c) => {
      const b = await parseBody(c, BulkDeleteBody);
      return c.json(await bulkDeleteTasks(c.var.deps, c.var.auth, b.ids));
    });
}
