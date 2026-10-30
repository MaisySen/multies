/**
 * Round 21 (R21.1) in the public API (v1): sprints per project. Write calls need a key that can write.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { idempotentCreate } from "../lib/idempotency"; // R52 (MB-239)
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import {
  addToSprint, backlog, completeSprint, createSprint, deleteSprint, getSprint, listSprints, removeFromSprint, startSprint, updateSprint,
} from "../services/suite/sprints";
import { updateTask } from "../services/suite/tasks";
import { SprintComplete, SprintCreate, SprintPatch, SprintTasks } from "./sprints";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
const withUrl = (c: Context<AppEnv>, data: unknown): unknown => {
  // MB-62: every sprint object carries url, the page that opens that sprint.
  const app = c.var.deps.config.appUrl.replace(/\/$/, "");
  const fix = (s: unknown) => (s && typeof s === "object" && typeof (s as { path?: unknown }).path === "string" ? { ...(s as object), url: app + (s as { path: string }).path } : s);
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = { ...d };
  if (d.sprint) out.sprint = fix(d.sprint);
  if (Array.isArray(d.sprints)) out.sprints = d.sprints.map(fix);
  if ((d as { id?: unknown }).id && typeof d.id === "string" && d.id.startsWith("spr_")) return fix(out);
  return out;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(withUrl(c, data) as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";
const SprintCreateV1 = SprintCreate.omit({ projectId: true });
const Points = z.object({ points: z.number().min(0).max(1000).nullable() });

export function registerSprintRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "put" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Sprints"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Conflict."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/projects/{id}/sprints", "List a project's sprints", "Planned, active and completed sprints, oldest first, with task and point counts, and the project's estimate unit (points or hours).", { request: { params: Id } }),
    async (c) => send(c, await listSprints(c.var.deps, actor(c), pid(c))));
  api.openapi(route("get", "/projects/{id}/backlog", "A project's backlog", "Unfinished tasks of the project that are in no sprint.", { request: { params: Id } }),
    async (c) => send(c, { tasks: await backlog(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("post", "/projects/{id}/sprints", "Plan a sprint", "Defaults: named Sprint N, starting the day after the last sprint ends (or today), two weeks long. Dates are ISO instants or YYYY-MM-DD.", { request: { params: Id, ...body(SprintCreateV1) } }),
    async (c) => send(c, { sprint: await createSprint(c.var.deps, actor(c), pid(c), await jsonBody(c, SprintCreateV1), await idempotentCreate(c.req.raw, "spr")) }, 201));
  api.openapi(route("get", "/sprints/{id}", "Get a sprint with its tasks and burndown", "The burndown has one entry per day of the sprint in the person's or workspace's time zone (or timeZone): remaining points (or tasks when nothing is estimated) at the end of that day, and the ideal line.", { request: { params: Id, query: z.object({ timeZone: z.string().max(64).optional() }) } }),
    async (c) => send(c, await getSprint(c.var.deps, actor(c), pid(c), { timeZone: c.req.query("timeZone") })));
  api.openapi(route("patch", "/sprints/{id}", "Update a sprint", "Name, goal, start and end. A sprint has to end after it starts.", { request: { params: Id, ...body(SprintPatch) } }),
    async (c) => send(c, { sprint: await updateSprint(c.var.deps, actor(c), pid(c), await jsonBody(c, SprintPatch)) }));
  api.openapi(route("delete", "/sprints/{id}", "Delete a planned sprint", "Its tasks go back to the backlog. Active and completed sprints can't be deleted.", { request: { params: Id } }),
    async (c) => send(c, await deleteSprint(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/sprints/{id}/start", "Start a sprint", "One active sprint per project: complete the running one first. The scope at start is kept for the burndown.", { request: { params: Id } }),
    async (c) => send(c, { sprint: await startSprint(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("post", "/sprints/{id}/complete", "Complete a sprint", "Unfinished tasks carry over: carry_over next (the next planned sprint, made if there is none) or backlog. Finished tasks stay in the sprint.", { request: { params: Id, ...body(SprintComplete) } }),
    async (c) => {
      const b = await jsonBody(c, SprintComplete);
      return send(c, await completeSprint(c.var.deps, actor(c), pid(c), { carryOver: b.carry_over ?? b.carryOver, timeZone: b.timeZone }));
    });
  api.openapi(route("post", "/sprints/{id}/tasks", "Add tasks to a sprint", "Up to 500 task ids or references (OPS-12) of the sprint's project, in one write batch. Tasks in another sprint move here.", { request: { params: Id, ...body(SprintTasks) } }),
    async (c) => send(c, await addToSprint(c.var.deps, actor(c), pid(c), (await jsonBody(c, SprintTasks)).taskIds)));
  api.openapi(route("post", "/sprints/{id}/tasks/remove", "Remove tasks from a sprint", "Up to 500 task ids or references; they go back to the backlog.", { request: { params: Id, ...body(SprintTasks) } }),
    async (c) => send(c, await removeFromSprint(c.var.deps, actor(c), pid(c), (await jsonBody(c, SprintTasks)).taskIds)));
  api.openapi(route("put", "/tasks/{id}/points", "Set a task's estimate", "Points or hours, per the project's unit; null clears it. PATCH /tasks/{id} takes points and sprintId too.", { request: { params: Id, ...body(Points) } }),
    async (c) => send(c, { task: await updateTask(c.var.deps, actor(c), pid(c), { points: (await jsonBody(c, Points)).points }) }));
}
