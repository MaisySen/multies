/**
 * R24.5 Docs tree and backlinks in the public API (v1): GET /docs/tree, PATCH /docs/{id}/move,
 * GET /docs/{id}/backlinks, GET /tasks/{id}/backlinks. Reads work with read only keys; a move needs a
 * full key. Registered before the docs routes so "tree" is not read as a doc id.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { getBacklinks, getDocTree, MAX_DEPTH, moveDoc } from "../services/suite/doc-tree";
import { resolveTaskId } from "../services/suite/tasks";
import { DocMove } from "./doc-tree";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

export function registerR24DocRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/docs/tree", tags: ["Docs"], summary: "The docs page tree", security: [{ bearerAuth: [] }],
    description: `Every doc as a tree: id, title, parentId, position (order among siblings), projectId, updatedAt, depth and children. Pages nest at most ${MAX_DEPTH} levels deep. At most 2,000 docs; truncated: true says the answer was cut.`,
    responses: { 200: json("The tree."), 401: err("Missing or invalid API key.") },
  }), async (c) => send(c, await getDocTree(c.var.deps, { orgId: actor(c).orgId })));

  api.openapi(createRoute({
    method: "patch", path: "/docs/{id}/move", tags: ["Docs"], summary: "Move a doc in the page tree", security: [{ bearerAuth: [] }],
    description: `Body: parentId (a page, or null for the top level), and beforeId or afterId (a sibling under that parent) or position (a number). With none of them the page goes last. A page can't go under itself or its own sub pages, and pages nest at most ${MAX_DEPTH} levels deep. Writes one row.`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { params: Id, body: { required: true, content: { "application/json": { schema: z.object({}).passthrough() as any } } } },
    responses: { 200: json("Where the page is now."), 401: err("Missing or invalid API key."), 403: err("A read only key."), 404: err("A page that is not in this workspace."), 422: err("A loop, too deep, or validation failed.") },
  }), async (c) => {
    const r = DocMove.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the body.", r.error.issues);
    return send(c, await moveDoc(c.var.deps, actor(c), pid(c), r.data));
  });

  api.openapi(createRoute({
    method: "get", path: "/docs/{id}/backlinks", tags: ["Docs"], summary: "Docs that link to a doc", security: [{ bearerAuth: [] }],
    description: "Docs whose body links to this doc (a link to /app/docs/{id} or a page link), newest first, each with id, title and a short snippet of the text around the link.",
    request: { params: Id }, responses: { 200: json("The backlinks."), 401: err("Missing or invalid API key."), 404: err("A doc that is not in this workspace.") },
  }), async (c) => send(c, await getBacklinks(c.var.deps, { orgId: actor(c).orgId }, { type: "doc", id: pid(c) })));

  api.openapi(createRoute({
    method: "get", path: "/tasks/{id}/backlinks", tags: ["Tasks"], summary: "Docs that link to a task", security: [{ bearerAuth: [] }],
    description: "Docs whose body links to this task (by id or ref like OPS-12), newest first, each with id, title and a short snippet.",
    request: { params: Id }, responses: { 200: json("The backlinks."), 401: err("Missing or invalid API key."), 404: err("A task that is not in this workspace.") },
  }), async (c) => {
    const orgId = actor(c).orgId;
    return send(c, await getBacklinks(c.var.deps, { orgId }, { type: "task", id: await resolveTaskId(c.var.deps, orgId, pid(c)) }));
  });
}
