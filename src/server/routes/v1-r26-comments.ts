/**
 * R26 (MB-77, found by Haajir) in the public API (v1): read back, edit and delete task comments and
 * chat messages. Before this, a typo in a release note could only be fixed with a second
 * "Correction" post. Read only keys can read; writes need a full key. Only the author edits (an
 * agent key edits what its agent wrote); the author, an owner or an admin deletes. Another
 * workspace's ids answer 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { deleteTaskComment, editTaskComment, getTaskComment, listTaskComments } from "../services/suite/comments-r26";
import { deleteMessage, editMessage, getMessage } from "../services/suite/chat";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
export const EditBody = z.object({ body: z.string().min(1).max(20_000) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";
const edit = async (c: Context<AppEnv>) => EditBody.parse(await c.req.json().catch(() => ({}))).body;

export function registerR26CommentRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "patch" | "delete", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/tasks/{id}/comments", "Tasks", "List a task's comments", "Oldest first. The id can be a task id or a reference like MB-12. Each comment: { id, taskId, body, author: { type, id, name }, editedAt (null until edited), createdAt }.", { request: { params: Id } }),
    async (c) => send(c, await listTaskComments(c.var.deps, actor(c), pid(c))));
  api.openapi(route("get", "/comments/{id}", "Tasks", "Read one task comment", "The comment as listed by GET /tasks/{id}/comments.", { request: { params: Id } }),
    async (c) => send(c, { comment: await getTaskComment(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("patch", "/comments/{id}", "Tasks", "Edit a task comment", "Body: { body }. Only the author (an agent key edits what its agent wrote). The comment then carries editedAt.", { request: { params: Id, ...body(EditBody) } }),
    async (c) => send(c, { comment: await editTaskComment(c.var.deps, actor(c), pid(c), await edit(c)) }));
  api.openapi(route("delete", "/comments/{id}", "Tasks", "Delete a task comment", "The author, an owner or an admin.", { request: { params: Id } }),
    async (c) => send(c, await deleteTaskComment(c.var.deps, actor(c), pid(c))));

  api.openapi(route("get", "/chat/messages/{id}", "Chat", "Read one chat message", "The message (body, author, mentions, links, attachments, reactions, editedAt) and its channel. Private channels and DMs answer 404 to keys.", { request: { params: Id } }),
    async (c) => send(c, await getMessage(c.var.deps, actor(c), pid(c))));
  api.openapi(route("patch", "/chat/messages/{id}", "Chat", "Edit a chat message", "Body: { body } with the same markup as posting. Only the author (an agent key edits what its agent posted). The message then carries editedAt and the channel sees the change on its next read.", { request: { params: Id, ...body(EditBody) } }),
    async (c) => send(c, { message: await editMessage(c.var.deps, actor(c), pid(c), await edit(c)) }));
  api.openapi(route("delete", "/chat/messages/{id}", "Chat", "Delete a chat message", "The author, an owner or an admin. The message stays as a deleted placeholder so replies keep their place.", { request: { params: Id } }),
    async (c) => send(c, await deleteMessage(c.var.deps, actor(c), pid(c))));
}
