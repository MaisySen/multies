/**
 * R24.1 Formula and rollup fields in the public API (v1). Both are reads, so read only keys can
 * call them; a key sees only its own workspace (another workspace's ids are 404).
 *   GET /projects/{id}/rollups   project level rollups
 *   GET /tasks/{id}/computed     a task's formula and rollup values
 * Defining a field is the existing POST /projects/{id}/fields with type formula or rollup.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { projectRollups, taskComputed } from "../services/suite/computed";
import { getTask } from "../services/suite/tasks";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });

export function registerFormulaRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/projects/{id}/rollups", tags: ["Custom fields"], summary: "Project rollups", security: [{ bearerAuth: [] }],
    description: "Project level rollup fields (custom fields of type rollup with source project) worked out over the project's live tasks, epics left out: rollups [{ id, name, fn, field, fieldName, value, error? }], taskCount and truncated (at most 2,000 tasks are read). Computed on read; nothing is stored.",
    request: { params: Id },
    responses: { 200: json("The rollups."), 401: err("Missing or invalid API key."), 404: err("A project that is not in this workspace.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await projectRollups(c.var.deps, actor(c), c.req.valid("param").id) as any, 200) as any);

  api.openapi(createRoute({
    method: "get", path: "/tasks/{id}/computed", tags: ["Custom fields"], summary: "A task's formula and rollup values", security: [{ bearerAuth: [] }],
    description: "Each formula and rollup field on the task's project with its settings and value: computed [{ fieldId, name, type, config, value, error? }]. A value that can't be worked out is \"#ERROR\" with a plain error message. The id can be a task id or a reference like OPS-12.",
    request: { params: Id },
    responses: { 200: json("The values."), 401: err("Missing or invalid API key."), 404: err("A task that is not in this workspace.") },
  }),
  async (c) => {
    const t = await getTask(c.var.deps, actor(c), c.req.valid("param").id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(await taskComputed(c.var.deps, t, actor(c).orgId) as any, 200) as any;
  });
}
