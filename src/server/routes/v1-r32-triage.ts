/**
 * R32 in the public API (v1): one Triage action door per task, POST /tasks/{id}/triage, with
 * accept, decline, snooze, unsnooze, duplicate and restore. GET /triage (v1-triage.ts) now takes view=snoozed.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { triageAction } from "../services/suite/triage-r32";
import { TriageActionBody, triageActionInput } from "./triage";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export function registerTriageR32Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "post", path: "/tasks/{id}/triage", tags: ["Triage"], summary: "Act on a Triage item", security: [{ bearerAuth: [] }],
    description: "Body: { action: accept | decline | snooze | unsnooze | duplicate | restore, accept?: { projectId?, assignee?, statusId?, status?, priority?, due? }, decline?: { reason?, reply?, message? }, until? (snooze: an ISO date or date-time, at most a year out), duplicateOf? (duplicate: the task id it repeats; its notes become a comment there), comment? (accept or decline: a one line comment, up to 280 characters, written with the action; the answer carries comment { id }), commentId? (restore: also removes that comment, so one undo takes back both) }. restore puts an item accepted, declined or merged in the last day back in the queue (undo). A snoozed item leaves GET /triage and its count until the time passes; GET /triage?view=snoozed lists them.",
    request: { params: Id, body: { required: true, content: { "application/json": { schema: TriageActionBody } } } },
    responses: { 200: json("The action's result, with the item as it is now."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Too late to undo, or already done."), 422: err("Validation failed.") },
  }), async (c) => {
    const b = TriageActionBody.parse(await c.req.json().catch(() => ({})));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(await triageAction(c.var.deps, actor(c), c.req.param("id") ?? "", triageActionInput(b)) as any, 200) as any;
  });
}
