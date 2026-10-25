/**
 * DF-20 Saved views in the public API (v1): GET /views, POST /views, DELETE /views/{id}. Before
 * this only a browser session could make one; agents that set up boards for people need a key.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createView, deleteView, listViews } from "../services/suite/tasks";
import { ViewCreate } from "./suite-schemas";
import { HttpError } from "../lib/errors";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export function registerSavedViewRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/views", tags: ["Tasks"], summary: "List saved views", security: [{ bearerAuth: [] }],
    description: "Saved views the key can open: shared ones and the key owner's own. Query: projectId (optional).",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { query: z.object({ projectId: z.string().optional() }) as any },
    responses: { 200: json("The views."), 401: err("Missing or invalid API key.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json({ views: await listViews(c.var.deps, actor(c), c.req.query("projectId") || undefined) } as any, 200) as any);

  api.openapi(createRoute({
    method: "post", path: "/views", tags: ["Tasks"], summary: "Create a saved view", security: [{ bearerAuth: [] }],
    description: "Body: { name, view (board, list, calendar, timeline, sprints or workload), projectId?, filters? ({ assignee, status, priority, label, type, due, q }), shared? }. Shared with the workspace unless shared is false. One row written.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { body: { content: { "application/json": { schema: z.object({}).passthrough() as any } } } },
    responses: { 201: json("The new view."), 401: err("Missing or invalid API key."), 403: err("Read only key."), 404: err("A project not in this workspace."), 422: err("Validation failed.") },
  }),
  async (c) => {
    const parsed = ViewCreate.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(422, "validation_failed", parsed.error.issues[0]?.message ?? "Check the view.", parsed.error.issues);
    const view = await createView(c.var.deps, actor(c), { ...parsed.data, shared: parsed.data.shared ?? true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json({ view } as any, 201) as any;
  });

  api.openapi(createRoute({
    method: "delete", path: "/views/{id}", tags: ["Tasks"], summary: "Delete a saved view", security: [{ bearerAuth: [] }],
    description: "Removes the view. Tasks are not touched.",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json("Deleted."), 401: err("Missing or invalid API key."), 403: err("Read only key."), 404: err("No such view.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await deleteView(c.var.deps, actor(c), c.req.param("id")) as any, 200) as any);
}
