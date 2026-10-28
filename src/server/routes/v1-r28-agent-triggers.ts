/**
 * R28 (DF-3 slice 3) in the public API (v1): triggers that queue agent runs on a schedule or from a signed webhook,
 * and GET /agents/me/runs so an agent's own key can pick up what a trigger queued. Managing triggers needs a
 * person's admin role or a full workspace key. ADR 0008, "Slice 3: triggers". The webhook itself is public:
 * POST /api/hooks/agent-runs/{id} (see docs/api.md).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createTrigger, deleteTrigger, getTrigger, listMyRuns, listTriggers, rotateTriggerSecret, runTriggerNow, triggerHistory, updateTrigger } from "../services/suite/agent-triggers";
import { TriggerCreateBody, TriggerPatchBody } from "./agent-triggers-r28";

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

export function registerAgentTriggerRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Agent runs"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("A limit or a conflict."), 422: err("Validation failed."), 429: err("The agent's queue is full.") } });

  api.openapi(route("get", "/agents/me/runs", "List my agent runs", "With an AI agent member's own key: its runs, newest first, without steps. Query: status (queued to pick up work a trigger queued; also running, succeeded, failed, cancelled), limit (1 to 200). Claim a queued run with POST /tasks/{taskId}/runs or by adding its first step.", {}),
    async (c) => send(c, await listMyRuns(c.var.deps, actor(c), { status: c.req.query("status") || undefined, limit: Number(c.req.query("limit")) || undefined })));

  api.openapi(route("get", "/agent-triggers", "List agent triggers", "The workspace's triggers (at most 20) with next run, last fired and fire count. Query: agentUserId. Admins and full workspace keys.", {}),
    async (c) => send(c, await listTriggers(c.var.deps, actor(c), { agentUserId: c.req.query("agentUserId") || undefined })));

  api.openapi(route("post", "/agent-triggers", "Create an agent trigger", "Body: { agentUserId, kind: schedule | webhook, name, taskId? | projectId? + titleTemplate?, instructions?, everyHours? (1 or more) | dailyAt? (HH:MM) + days? (sun..sat), timezone? (defaults to the workspace zone), enabled? }. A webhook trigger answers with its secret once. Writes agent_trigger.created.", { request: { ...body(TriggerCreateBody) } }),
    async (c) => send(c, await createTrigger(c.var.deps, actor(c), await jsonBody(c, TriggerCreateBody)), 201));

  api.openapi(route("get", "/agent-triggers/{id}", "Get an agent trigger", "One trigger. The secret is never shown again; rotate it to get a new one.", { request: { params: Id } }),
    async (c) => send(c, { trigger: await getTrigger(c.var.deps, actor(c), pid(c)) }));

  api.openapi(route("get", "/agent-triggers/{id}/history", "Agent trigger history", "R29: the trigger's recent fires and refusals, newest first (at most 50; query limit 1 to 50). Each entry: id, at, outcome (fired | refused), source (schedule | webhook | manual), reason and message on a refusal, run { id, taskId, taskRef } when a run was queued, actor, sampled (a webhook refusal before firing: bad signature, stale, replayed or over its rate, recorded at most once per 10 minutes). Admins and full workspace keys.", { request: { params: Id } }),
    async (c) => send(c, await triggerHistory(c.var.deps, actor(c), pid(c), { limit: Number(c.req.query("limit")) || undefined })));

  api.openapi(route("patch", "/agent-triggers/{id}", "Update an agent trigger", "Any of the create fields except kind; enabled: false turns it off (its webhook then answers 404). Writes agent_trigger.updated.", { request: { params: Id, ...body(TriggerPatchBody) } }),
    async (c) => send(c, { trigger: await updateTrigger(c.var.deps, actor(c), pid(c), await jsonBody(c, TriggerPatchBody)) }));

  api.openapi(route("delete", "/agent-triggers/{id}", "Delete an agent trigger", "Runs it already queued stay. Writes agent_trigger.deleted.", { request: { params: Id } }),
    async (c) => send(c, await deleteTrigger(c.var.deps, actor(c), pid(c))));

  api.openapi(route("post", "/agent-triggers/{id}/rotate-secret", "Rotate a webhook trigger's secret", "Returns the new secret once; the old one is refused at once. Writes agent_trigger.secret_rotated.", { request: { params: Id } }),
    async (c) => send(c, await rotateTriggerSecret(c.var.deps, actor(c), pid(c))));

  api.openapi(route("post", "/agent-triggers/{id}/run", "Fire an agent trigger now", "Queues a run as if the trigger fired. The agent and queue limits apply (409, 429). Writes agent_trigger.fired or agent_trigger.refused.", { request: { params: Id } }),
    async (c) => send(c, await runTriggerNow(c.var.deps, actor(c), pid(c)), 201));
}
