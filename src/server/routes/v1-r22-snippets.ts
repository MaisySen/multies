/**
 * Round 22 (R22.4b) in the public API (v1): saved replies with {{variables}}. Read only keys can list
 * and render (POST /snippets/{id}/render changes nothing); creating, editing and deleting need a full
 * key. Agent keys see shared replies and their own, and write as their agent.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createSnippet, deleteSnippet, getSnippet, listSnippets, renderSnippetFor, updateSnippet } from "../services/suite/snippets";
import { SnippetCreate, SnippetPatch, SnippetRender } from "./mail-snippets";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const Q = z.object({ q: z.string().max(200).optional().openapi({ param: { name: "q", in: "query" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

/** Read only keys may POST here: rendering reads a saved reply and a thread and writes nothing. */
export const isSnippetRender = (method: string, path: string) => method === "POST" && /\/snippets\/[^/]+\/render$/.test(path);

export function registerSnippetRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Saved replies"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Shortcut already used."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/snippets", "List saved replies", "Shared saved replies plus the caller's private ones, by name. Each: { id, name, shortcut, subject, body, shared, createdBy: { id, name }, createdAt, updatedAt, canEdit }. q filters by name, shortcut or text.", { request: { query: Q } }),
    async (c) => send(c, await listSnippets(c.var.deps, actor(c), { q: c.req.query("q") })));
  api.openapi(route("post", "/snippets", "Create a saved reply", "Body: { name (up to 80), body (plain text, up to 10,000; variables {{first_name}}, {{name}}, {{email}}, {{my_name}}, {{my_first_name}}, {{company}}, {{mailbox}}, {{date}}), subject?, shortcut? (one word, unique in the workspace), shared? (default true; false keeps it to the author) }.", { request: body(SnippetCreate) }),
    async (c) => send(c, { snippet: await createSnippet(c.var.deps, actor(c), await jsonBody(c, SnippetCreate)) }, 201));
  api.openapi(route("get", "/snippets/{id}", "Get a saved reply", "One saved reply the caller can see.", { request: { params: Id } }),
    async (c) => send(c, { snippet: await getSnippet(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("patch", "/snippets/{id}", "Edit a saved reply", "The author, or an owner, admin or workspace key. Any of { name, body, subject, shortcut, shared }.", { request: { params: Id, ...body(SnippetPatch) } }),
    async (c) => send(c, { snippet: await updateSnippet(c.var.deps, actor(c), pid(c), await jsonBody(c, SnippetPatch)) }));
  api.openapi(route("delete", "/snippets/{id}", "Delete a saved reply", "The author, or an owner, admin or workspace key.", { request: { params: Id } }),
    async (c) => send(c, await deleteSnippet(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/snippets/{id}/render", "Fill in a saved reply", "Body: { threadId?, to?, mailboxId? }. Returns { subject, body, variables } with the variables filled for that thread (its newest sender) or To address. The thread must be one the key can open. Read only keys can call this.", { request: { params: Id, ...body(SnippetRender) } }),
    async (c) => send(c, await renderSnippetFor(c.var.deps, actor(c), pid(c), await jsonBody(c, SnippetRender))));
}
