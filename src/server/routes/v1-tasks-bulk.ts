/**
 * Round 21 (R21.2) in the public API (v1): change or delete many tasks in one call.
 * POST /tasks/bulk { ids, patch } and POST /tasks/bulk-delete { ids }. Workspace keys and agent
 * keys both work; read only keys get 403. At most 500 tasks a call (413 above that).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { bulkDeleteTasks, bulkUpdateTasks } from "../services/suite/bulk";
import { BulkDeleteBody, BulkUpdateBody } from "./tasks-bulk";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { safeParse: (v: unknown) => any }, hint: string) => {
  const r = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) throw new HttpError(422, "validation_failed", hint, r.error.issues);
  return r.data;
};

export function registerTaskBulkRoutes(api: OpenAPIHono<AppEnv>) {
  const responses = { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can only read, or a person must do this (person_only): moving tasks from a project with Triage off into one with Triage on, or deleting tasks that wait in Triage."), 404: err("A task is not in this workspace; nothing was changed."), 413: err("More than 500 tasks."), 422: err("Validation failed."), 503: err("Paused: the daily write budget is nearly used.") };
  api.openapi(createRoute({ method: "post", path: "/tasks/bulk", tags: ["Tasks"], summary: "Change many tasks at once", security: [{ bearerAuth: [] }], request: body(BulkUpdateBody), responses,
    description: "Body: { ids, patch }. ids are task ids or references like OPS-12 (at most 500). patch takes any of status (todo, doing, done), statusId, assignee (member:<id>, agent:<id> or null), priority, dueAt and startAt (null clears), addLabels, removeLabels and projectId (moves the tasks; each status maps to the same group in the new project). One patch for every task, written in one batch. If any id is not in this workspace nothing is changed. A key can't move tasks from a project with Triage off into one with Triage on (403 person_only, nothing changed) unless they wait in Triage or a person accepted them there. Answers { updated, unchanged, ids, tasks }." }),
  async (c) => { const b = await jsonBody(c, BulkUpdateBody, "Send ids (task ids or references) and a patch."); return send(c, await bulkUpdateTasks(c.var.deps, actor(c), b.ids, b.patch)); });
  api.openapi(createRoute({ method: "post", path: "/tasks/bulk-delete", tags: ["Tasks"], summary: "Delete many tasks at once", security: [{ bearerAuth: [] }], request: body(BulkDeleteBody), responses,
    description: "Body: { ids }. Deletes the tasks and their subtasks (at most 500 a call). If any id is not in this workspace nothing is deleted. A key can't delete tasks that wait in Triage, or whose subtasks wait there (403 person_only, nothing deleted): a person decides those. Answers { deleted, ids }." }),
  async (c) => { const b = await jsonBody(c, BulkDeleteBody, "Send ids (task ids or references)."); return send(c, await bulkDeleteTasks(c.var.deps, actor(c), b.ids)); });
}
