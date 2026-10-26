/**
 * R27 (DF-3 slice 2) in the public API (v1): agent runs on tasks. An AI agent member's own key starts, logs and
 * finishes its runs; a person or a full workspace key can queue a run for an agent and cancel one; every key of the
 * workspace can read them. ADR 0008, "Slice 2: agent runs".
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addRunStep, finishRun, getRun, listRuns, listTaskRuns, startRun } from "../services/suite/agent-runs";
import { RunFinishBody, RunStartBody, RunStepBody } from "./agent-runs-r27";

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

export function registerAgentRunRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Agent runs"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("A run is already in progress, or this run is finished."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/tasks/{id}/runs", "List a task's agent runs", "The task's runs, newest first, with their steps and result. The id can be a task id or a reference like OPS-12. Query: limit (1 to 200, default 50).", { request: { params: Id } }),
    async (c) => send(c, await listTaskRuns(c.var.deps, actor(c), pid(c), { limit: Number(c.req.query("limit")) || undefined })));

  api.openapi(route("post", "/tasks/{id}/runs", "Start an agent run on a task", "With an AI agent member's own key: starts its run (status running) on a task it is assigned to or mentioned on, or claims a run queued for it; otherwise 403. Body: { moveToDoing?, note? }. With a person's or a full workspace key: queues a run for an agent member, which is the explicit allowance. Body: { agentUserId }. One queued or running run per agent and task (409). Writes an audit entry.", { request: { params: Id, ...body(RunStartBody) } }),
    async (c) => send(c, { run: await startRun(c.var.deps, actor(c), pid(c), await jsonBody(c, RunStartBody)) }, 201));

  api.openapi(route("get", "/runs", "List agent runs", "Runs across the workspace, newest first, without steps. Query: agentUserId, status (queued, running, succeeded, failed, cancelled), limit (1 to 200, default 50).", {}),
    async (c) => send(c, await listRuns(c.var.deps, actor(c), { agentUserId: c.req.query("agentUserId") || undefined, status: c.req.query("status") || undefined, limit: Number(c.req.query("limit")) || undefined })));

  api.openapi(route("get", "/runs/{id}", "Get an agent run", "One run with its ordered steps and result.", { request: { params: Id } }),
    async (c) => send(c, { run: await getRun(c.var.deps, actor(c), pid(c)) }));

  api.openapi(route("post", "/runs/{id}/steps", "Add a step to a run", "The run's own agent only. Body: { kind: note | tool | comment | status_change, text } (text up to 1000 characters; a run holds up to 200 steps). A queued run becomes running on its first step.", { request: { params: Id, ...body(RunStepBody) } }),
    async (c) => send(c, await addRunStep(c.var.deps, actor(c), pid(c), await jsonBody(c, RunStepBody)), 201));

  api.openapi(route("post", "/runs/{id}/finish", "Finish a run", "Body: { status: succeeded | failed | cancelled, result?, moveTo?: done | review, comment? }. The run's own agent can finish it, move the task to done or to a status named like \"In review\", and post the result as its comment on the task. A person or a workspace key can only cancel. Writes an audit entry.", { request: { params: Id, ...body(RunFinishBody) } }),
    async (c) => send(c, await finishRun(c.var.deps, actor(c), pid(c), await jsonBody(c, RunFinishBody))));
}
