/**
 * Round 11 in the public API (v1): the integrations catalogue and connections, and incoming webhooks.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { CATALOGUE, connectIntegration, createIncomingHook, deleteIncomingHook, getIncomingHook, listIncomingHooks, listIntegrations, updateIncomingHook } from "../services/suite/integrations";
import { ConnectBody, HookCreate, HookPatch } from "./suite-r11";

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

export function registerSuiteR11Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "put" | "delete", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  // ---------------------------------------------------------------- integrations
  api.openapi(route("get", "/integrations/catalogue", "Integrations", "List the connector catalogue", "No-cost targets: Slack, Discord, Microsoft Teams, Zapier, Make, n8n, Google Sheets (Apps Script) and any URL. Each entry has its payload format (slack, discord, teams or json) and the events it suits."),
    async (c) => send(c, { catalogue: CATALOGUE }));
  api.openapi(route("get", "/integrations", "Integrations", "List connections", "The catalogue plus the workspace's connected integrations (outgoing webhook endpoints made from the catalogue)."),
    async (c) => send(c, await listIntegrations(c.var.deps, actor(c).orgId)));
  api.openapi(route("post", "/integrations", "Integrations", "Connect an integration", "Body: { connector, url, events?, name? }. JSON targets get a signing secret in the answer, shown once.", { request: body(ConnectBody) }),
    async (c) => send(c, await connectIntegration(c.var.deps, actor(c), await jsonBody(c, ConnectBody)), 201));

  // ---------------------------------------------------------------- incoming hooks
  api.openapi(route("get", "/incoming-hooks", "Incoming webhooks", "List incoming webhooks", "Each hook with its action, field mapping, call count and its last 20 calls."),
    async (c) => send(c, { hooks: await listIncomingHooks(c.var.deps, actor(c).orgId) }));
  api.openapi(route("post", "/incoming-hooks", "Incoming webhooks", "Create an incoming webhook", "Body: { name, action: task | chat | contact, config?: { projectId?, channelId? (required for chat), mapping?: { target: sourceField } } }. The answer carries the secret URL once: POST JSON or a form to it.", { request: body(HookCreate) }),
    async (c) => send(c, await createIncomingHook(c.var.deps, actor(c), await jsonBody(c, HookCreate)), 201));
  api.openapi(route("get", "/incoming-hooks/{id}", "Incoming webhooks", "Read an incoming webhook", "The hook and its recent calls.", { request: { params: Id } }),
    async (c) => send(c, { hook: await getIncomingHook(c.var.deps, actor(c).orgId, pid(c)) }));
  api.openapi(route("patch", "/incoming-hooks/{id}", "Incoming webhooks", "Update an incoming webhook", "Any of name, enabled, config.", { request: { params: Id, ...body(HookPatch) } }),
    async (c) => send(c, { hook: await updateIncomingHook(c.var.deps, actor(c), pid(c), await jsonBody(c, HookPatch)) }));
  api.openapi(route("delete", "/incoming-hooks/{id}", "Incoming webhooks", "Delete an incoming webhook", "Revokes the URL at once.", { request: { params: Id } }),
    async (c) => send(c, await deleteIncomingHook(c.var.deps, actor(c), pid(c))));

}
