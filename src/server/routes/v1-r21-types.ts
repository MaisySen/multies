/**
 * Round 21 (R21.4) in the public API (v1): epics with their progress. Workspace keys, agent member
 * keys and agent keys can read; read only keys can't add or remove items. Task types themselves
 * ride POST and PATCH /tasks (type) and the list filter GET /tasks?type=bug.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addToEpic, getEpic, listEpics, MAX_EPIC_BATCH, removeFromEpic } from "../services/suite/task-types";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } as const;
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const secured = [{ bearerAuth: [] }];
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "OPS-7" }) });
const Query = z.object({ project: z.string().max(64).optional().openapi({ description: "Only epics in this project (its id)." }) });
const Items = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_EPIC_BATCH).openapi({ description: "Task ids or references (OPS-12), up to 100." }) }).openapi("EpicItems");

export function registerEpicRoutes(api: OpenAPIHono<AppEnv>) {
  const tags = ["Epics"];
  api.openapi(createRoute({ method: "get", path: "/epics", tags, summary: "List epics with progress", security: secured,
    description: "Epics in the workspace, or in one project with ?project=<id>. Each has progress: done and total over its items and their subtasks, percent, points when tasks carry points, and the date span of its items (start, end).",
    request: { query: Query }, responses: { 200: json("{ epics }"), 401: errors[401] } }),
  async (c) => send(c, { epics: await listEpics(c.var.deps, actor(c), { projectId: c.req.valid("query").project }) }));

  api.openapi(createRoute({ method: "get", path: "/epics/{id}", tags, summary: "Get an epic with its items", security: secured,
    description: "One epic by id or reference, with progress, and its items (each with its own subtask counts).",
    request: { params: Id }, responses: { 200: json("{ epic, items }"), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await getEpic(c.var.deps, actor(c), c.req.valid("param").id)));

  api.openapi(createRoute({ method: "post", path: "/epics/{id}/items", tags, summary: "Add items to an epic", security: secured,
    description: "Puts tasks, stories or bugs in the epic (sets their parent). An item already in another epic moves. Epics can't go in an epic. One batch: each item costs its own row write.",
    request: { params: Id, body: { required: true, content: { "application/json": { schema: Items } } } },
    responses: { 200: json("{ epic, items, moved }"), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, await addToEpic(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json").ids)));

  api.openapi(createRoute({ method: "delete", path: "/epics/{id}/items", tags, summary: "Take items out of an epic", security: secured,
    description: "Clears the parent of these items when it is this epic. Items in another epic are left alone.",
    request: { params: Id, body: { required: true, content: { "application/json": { schema: Items } } } },
    responses: { 200: json("{ epic, items, moved }"), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, await removeFromEpic(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json").ids)));
}
