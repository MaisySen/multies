/**
 * Round 22 (R22.2) in the public API (v1): internal notes on a mail thread. Read only keys can list;
 * writes need a full key. Agent keys write as their agent. Notes are team only: they are never part
 * of GET /threads/{id} or any message that is sent.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addComment, deleteComment, editComment, listComments } from "../services/mail/thread-comments";
import { CommentBody } from "./thread-comments";
import { idempotentCreate } from "../lib/idempotency"; // R55 (MB-239): same id on a 5xx retry

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const CommentId = Id.extend({ commentId: z.string().min(1).openapi({ param: { name: "commentId", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>, k = "id") => c.req.param(k) ?? "";

export function registerThreadCommentRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Thread notes"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/threads/{id}/comments", "List a thread's internal notes", "Team only notes on the thread, oldest first, and the people who can be mentioned. Each note: { id, author: { type, id, name }, body, mentions: [{ userId, name }], editedAt, createdAt }. Notes are never sent outside the team.", { request: { params: Id } }),
    async (c) => send(c, await listComments(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/threads/{id}/comments", "Add an internal note", "Body: { body (up to 4,000 characters; \"@Full Name\" or \"@email\" mentions a teammate), mentions? (user ids or emails) }. Mentioned people who can open the thread get a notification. Agent keys write as the agent.", { request: { params: Id, ...body(CommentBody) } }),
    async (c) => send(c, { comment: await addComment(c.var.deps, actor(c), pid(c), await jsonBody(c, CommentBody), await idempotentCreate(c.req.raw, "tcm")) }, 201));
  api.openapi(route("patch", "/threads/{id}/comments/{commentId}", "Edit an internal note", "Only the author, within 24 hours. Body: { body, mentions? }. Only newly mentioned people are notified.", { request: { params: CommentId, ...body(CommentBody) } }),
    async (c) => send(c, { comment: await editComment(c.var.deps, actor(c), pid(c), pid(c, "commentId"), await jsonBody(c, CommentBody)) }));
  api.openapi(route("delete", "/threads/{id}/comments/{commentId}", "Delete an internal note", "The author, or a workspace key, owner or admin.", { request: { params: CommentId } }),
    async (c) => send(c, await deleteComment(c.var.deps, actor(c), pid(c), pid(c, "commentId"))));
}
