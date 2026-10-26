/**
 * R27 (teardown) in the public API (v1): task watchers and duplicate. Read only keys can list watchers; watching,
 * unwatching and duplicating need a full key. Agent keys act as their agent and name the member they add or remove
 * (userId). Permissions follow the task: another workspace's ids answer 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listWatchers, unwatchTask, watchTask } from "../services/suite/task-watchers-r27";
import { duplicateTask } from "../services/suite/task-duplicate-r27";
import { DuplicateBody, WatchBody } from "./task-teardown-r27";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: false, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const IdUser = Id.extend({ userId: z.string().min(1).openapi({ param: { name: "userId", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));

const Duplicate = z.object({
  title: z.string().min(1).max(500).optional(), projectId: z.string().optional(),
  subtasks: z.boolean().optional(), checklist: z.boolean().optional(), assignee: z.boolean().optional(), dependencies: z.boolean().optional(),
});

export function registerTeardownR27Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Tasks"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/tasks/{id}/watchers", "List a task's watchers", "Who watches the task (userId, name, email, source manual or auto, since), the count, and whether the key's member watches it. Watchers hear about new comments and status changes. The id can be a task id or a reference like OPS-12.", { request: { params: Id } }),
    async (c) => send(c, await listWatchers(c.var.deps, actor(c), c.req.param("id") ?? "")));

  api.openapi(route("post", "/tasks/{id}/watchers", "Watch a task", "Body: { userId? }. Without userId the key's member starts watching; an agent key names the member. Watching twice changes nothing. Up to 200 watchers per task.", { request: { params: Id, ...body(z.object({ userId: z.string().optional() })) } }),
    async (c) => send(c, await watchTask(c.var.deps, actor(c), c.req.param("id") ?? "", (await jsonBody(c, WatchBody)).userId)));

  api.openapi(route("delete", "/tasks/{id}/watchers/{userId}", "Stop watching a task", "Removes a watcher. userId \"me\" is the key's member. Not watching is fine. Commenting on the task later starts watching again.", { request: { params: IdUser } }),
    async (c) => send(c, await unwatchTask(c.var.deps, actor(c), c.req.param("id") ?? "", c.req.param("userId") ?? "")));

  api.openapi(route("post", "/tasks/{id}/duplicate", "Duplicate a task", "Copies a task with a new number into the project's first to-do status. Keeps notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom field values. Body (all optional): { title (default \"<title> (copy)\"), projectId (another project; drops sprint and custom fields), subtasks (default true, up to 3 levels and 200 tasks), checklist (default true, items unticked), assignee (default true), dependencies (default false: copy \"blocked by\" links) }. Comments, time, files and history stay with the original. Returns { task, from, copied }.", { request: { params: Id, ...body(Duplicate) } }),
    async (c) => send(c, await duplicateTask(c.var.deps, actor(c), c.req.param("id") ?? "", await jsonBody(c, DuplicateBody)), 201));
}
