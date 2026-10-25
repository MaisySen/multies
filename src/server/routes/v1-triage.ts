/**
 * Round 21 (R21.3) in the public API (v1): the Triage queue. Read only keys can list; writes need a
 * full key. Items are tasks waiting for someone to accept, decline or merge them.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { acceptTriage, bulkTriage, createTriageItem, declineTriage, getTriageItem, listTriage, mergeTriage, triageCount } from "../services/suite/triage";
import { acceptInput, TriageAccept, TriageBulk, TriageCreate, TriageDecline, TriageMerge, TriageQuery } from "./triage";

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

export function registerTriageRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Triage"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/triage", "List the Triage queue", "Items waiting in Triage, newest first, and the total count. Query: projectId, limit (up to 500). Each item is a task with triage: { state, source, from }."),
    async (c) => send(c, await listTriage(c.var.deps, actor(c), TriageQuery.parse(c.req.query()))));
  api.openapi(route("get", "/triage/count", "Count the Triage queue", "How many items wait in Triage."),
    async (c) => send(c, { count: await triageCount(c.var.deps, actor(c)) }));
  api.openapi(route("post", "/triage", "Create a Triage item", "Body: { title, notes?, source? (mail, form, api or chat; api by default), from? (an email address or \"Name <address>\" to reply to), projectId? (the default project when left out) }.", { request: body(TriageCreate) }),
    async (c) => send(c, { item: await createTriageItem(c.var.deps, actor(c), await jsonBody(c, TriageCreate)) }, 201));
  api.openapi(route("post", "/triage/bulk", "Accept or decline several items", "Body: { ids (up to 100), action: accept | decline, accept?: { projectId?, assignee?, statusId?, status?, priority?, due? }, decline?: { reason?, reply?, message? } }. Each id reports ok or its error.", { request: body(TriageBulk) }),
    async (c) => { const b = await jsonBody(c, TriageBulk); return send(c, await bulkTriage(c.var.deps, actor(c), { ...b, accept: b.accept ? acceptInput(b.accept) : undefined })); });
  api.openapi(route("get", "/triage/{id}", "Read a Triage item", "The item as a task.", { request: { params: Id } }),
    async (c) => send(c, { item: await getTriageItem(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("post", "/triage/{id}/accept", "Accept a Triage item", "Makes it a normal task. Body (all optional): { projectId, assignee (member:<id>, agent:<id> or null), statusId, status, priority, due }. The task keeps its number unless it moves project.", { request: { params: Id, ...body(TriageAccept) } }),
    async (c) => send(c, { task: await acceptTriage(c.var.deps, actor(c), pid(c), acceptInput(await jsonBody(c, TriageAccept))) }));
  api.openapi(route("post", "/triage/{id}/decline", "Decline a Triage item", "Deletes the item with an optional reason. reply: true sends the sender a short polite email (never to no-reply addresses); message replaces the default text.", { request: { params: Id, ...body(TriageDecline) } }),
    async (c) => send(c, await declineTriage(c.var.deps, actor(c), pid(c), await jsonBody(c, TriageDecline))));
  api.openapi(route("post", "/triage/{id}/merge", "Merge a Triage item into a task", "Body: { targetId }. The item's notes become a comment on the target, its mail thread moves to the target when the target has none, and the item is deleted.", { request: { params: Id, ...body(TriageMerge) } }),
    async (c) => send(c, await mergeTriage(c.var.deps, actor(c), pid(c), (await jsonBody(c, TriageMerge)).targetId)));
}
