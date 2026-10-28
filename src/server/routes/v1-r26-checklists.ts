/**
 * R26 (MB-85) in the public API (v1): checklists inside a task. Read only keys can list; writes need a full key.
 * Agent keys act as their agent. Permissions follow the task: another workspace's ids answer 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { idempotentIds, idempotentRetry } from "../lib/idempotency"; // R52 (MB-239)
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addChecklistItems, checklistItemToSubtask, deleteChecklistItem, listChecklist, reorderChecklist, updateChecklistItem } from "../services/suite/checklists";
import { addInput, ChecklistAddBody, ChecklistPatchBody, ChecklistReorderBody } from "./checklists";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

const Item = z.object({ title: z.string().min(1).max(500), done: z.boolean().optional(), assignee: z.string().nullable().optional(), due: z.string().nullable().optional(), position: z.number().optional() });

export function registerChecklistRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Tasks"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/tasks/{id}/checklist", "List a task's checklist", "The task's checklist items in order, with total and done counts. The id can be a task id or a reference like OPS-12.", { request: { params: Id } }),
    async (c) => send(c, await listChecklist(c.var.deps, actor(c), pid(c))));

  api.openapi(route("post", "/tasks/{id}/checklist", "Add checklist items", "Body: one item { title, done?, assignee? (member:<id> or agent:<id>), due? (YYYY-MM-DD), position? } or { items: [...] } (up to 200 per task). New items go to the end unless position is given.", { request: { params: Id, ...body(z.union([Item, z.object({ items: z.array(Item) })])) } }),
    async (c) => { const input = addInput(await jsonBody(c, ChecklistAddBody)); const n = Array.isArray(input) ? input.length : 1; // R52 (MB-239): stable ids on a retry
      return send(c, { items: await addChecklistItems(c.var.deps, actor(c), pid(c), input, { ids: await idempotentIds(c.req.raw, "chk", Math.min(n, 200)), retry: idempotentRetry(c.req.raw) }) }, 201); });

  api.openapi(route("post", "/tasks/{id}/checklist/reorder", "Reorder a checklist", "Body: { ids } with every item id of the task's checklist once, in the new order. Only items that move are written.", { request: { params: Id, ...body(z.object({ ids: z.array(z.string()) })) } }),
    async (c) => send(c, await reorderChecklist(c.var.deps, actor(c), pid(c), (await jsonBody(c, ChecklistReorderBody)).ids)));

  api.openapi(route("patch", "/checklist-items/{id}", "Update a checklist item", "Body: any of { title, done, assignee, due, position }. A patch that changes nothing writes nothing.", { request: { params: Id, ...body(Item.partial()) } }),
    async (c) => send(c, { item: await updateChecklistItem(c.var.deps, actor(c), pid(c), await jsonBody(c, ChecklistPatchBody)) }));

  api.openapi(route("delete", "/checklist-items/{id}", "Delete a checklist item", "Removes the item from its task's checklist.", { request: { params: Id } }),
    async (c) => send(c, await deleteChecklistItem(c.var.deps, actor(c), pid(c))));

  api.openapi(route("post", "/checklist-items/{id}/to-subtask", "Turn a checklist item into a subtask", "Creates a subtask of the item's task with the same title, assignee and due date, and removes the item.", { request: { params: Id } }),
    async (c) => send(c, await checklistItemToSubtask(c.var.deps, actor(c), pid(c)), 201));
}
