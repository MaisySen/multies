/**
 * R26 (MB-87): share links in the public API (v1). A workspace key makes a read only link to a doc or a project
 * board, lists the active ones and revokes one. The key acts as its creator; read only keys can list but not make
 * or revoke, and agent keys are refused (routes/v1.ts). Another workspace's doc, project or link is a 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import type { SuiteActor } from "../services/suite/common";
import { createShareLink, listShareLinks, revokeShareLink } from "../services/suite/share-links";
import { ShareCreateBody, ShareListQuery } from "./share-links";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

export function registerShareLinkRoutes(api: OpenAPIHono<AppEnv>) {
  const limiter = new RateLimiter(60, 60 * 60_000);
  const responses = { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("A read only key, an agent key, or share links are off."), 404: err("Not found."), 422: err("Validation failed."), 429: err("Too many links in the last hour.") };

  api.openapi(createRoute({
    method: "get", path: "/share-links", tags: ["Docs"], summary: "List active share links", security: [{ bearerAuth: [] }],
    description: "Active read only links (not revoked, not expired), newest first, at most 200. Pass kind (doc or project_board) and targetId for one doc or project. The token is never shown again after it is made. allowShareLinks says whether an admin left share links on.",
    request: { query: z.object({ kind: z.enum(["doc", "project_board"]).optional(), targetId: z.string().optional() }) }, responses,
  }), async (c) => {
    const q = ShareListQuery.safeParse({ kind: c.req.query("kind") || undefined, targetId: c.req.query("targetId") || undefined });
    if (!q.success) throw new HttpError(422, "validation_failed", q.error.issues[0]?.message ?? "Check the query.", q.error.issues);
    return send(c, await listShareLinks(c.var.deps, actor(c), q.data));
  });

  api.openapi(createRoute({
    method: "post", path: "/share-links", tags: ["Docs"], summary: "Make a read only share link", security: [{ bearerAuth: [] }],
    description: "Body: { kind: doc | project_board, targetId, expiresInDays?: 7 | 30 (default 30), showWorkspaceName?: boolean (default true) }. null (never expires) needs a person signed in to Multies: an API key gets 403 person_only. Returns the link with its url (https://multies.si/s/<token>), shown only this once. Anyone with the url can read the doc, or the board's columns, card titles, assignee initials, due dates and labels; never notes, comments, files or custom fields. Writes one row.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { body: { required: true, content: { "application/json": { schema: z.object({}).passthrough() as any } } } }, responses,
  }), async (c) => {
    const r = ShareCreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the body.", r.error.issues);
    if (!limiter.take(actor(c).orgId)) throw tooMany("Too many share links in the last hour.");
    const { link } = await createShareLink(c.var.deps, actor(c), r.data);
    return send(c, { link }, 201);
  });

  api.openapi(createRoute({
    method: "delete", path: "/share-links/{id}", tags: ["Docs"], summary: "Revoke a share link", security: [{ bearerAuth: [] }],
    description: "The link stops working at once and its page says it is no longer active. Revoking twice is fine.", request: { params: Id }, responses,
  }), async (c) => send(c, await revokeShareLink(c.var.deps, actor(c), c.req.param("id") ?? "")));
}
