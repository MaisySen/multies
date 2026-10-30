/**
 * R39 page history for docs, in the web app (cookie session) and the public API (v1):
 *   GET    /docs/:id/versions                     the saved versions, newest first, and the page now
 *   POST   /docs/:id/versions                     save the page as it is now as a named version
 *   GET    /docs/:id/versions/:versionId          one version with content, and lines added and removed since (?diff=1 adds the line diff)
 *   PATCH  /docs/:id/versions/:versionId          name or rename a version (null clears)
 *   POST   /docs/:id/versions/:versionId/restore  bring it back (the page as it is now is saved first)
 * Reads work with read only keys (docs:read); saving, naming and restoring need docs:write. Mounted before the docs
 * routes. Same service as the MCP tools (mcp-r39-doc-versions.ts).
 */
import { Hono } from "hono";
import { createRoute, z as oz, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { idempotentCreate } from "../lib/idempotency"; // R54 (MB-239)
import type { SuiteActor } from "../services/suite/common";
import { getDocVersion, listDocVersions, renameDocVersion, restoreDocVersion, saveDocVersion, VERSION_NAME_MAX } from "../services/suite/doc-versions-r39";

export const VersionSave = z.object({ name: z.string().max(VERSION_NAME_MAX).nullable().optional() });
export const VersionRename = z.object({ name: z.string().max(VERSION_NAME_MAX).nullable() });
export const VersionRestore = z.object({ ifVersion: z.number().int().positive().optional() });

const wantsDiff = (v: string | undefined) => v === "1" || v === "true";

export function docVersionRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:id/versions", async (c) => c.json(await listDocVersions(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/versions", async (c) => c.json(await saveDocVersion(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, VersionSave)), 201))
    .get("/:id/versions/:versionId", async (c) => c.json(await getDocVersion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("versionId"), { diff: wantsDiff(c.req.query("diff")) })))
    .patch("/:id/versions/:versionId", async (c) => c.json(await renameDocVersion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("versionId"), await parseBody(c, VersionRename))))
    .post("/:id/versions/:versionId/restore", async (c) => {
      const b = await c.req.json().catch(() => ({}));
      const r = VersionRestore.safeParse(b ?? {});
      if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the body.", r.error.issues);
      return c.json(await restoreDocVersion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("versionId"), r.data));
    });
}

// ------------------------------------------------------------------------------------------------ v1

const ErrorSchema = oz.object({ error: oz.object({ code: oz.string(), message: oz.string(), details: oz.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: oz.record(oz.string(), oz.unknown()) } } });
const Ids = oz.object({
  id: oz.string().min(1).openapi({ param: { name: "id", in: "path" } }),
  versionId: oz.string().min(1).openapi({ param: { name: "versionId", in: "path" } }),
});
const Id = oz.object({ id: oz.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
const secured = [{ bearerAuth: [] }];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyBody = (required: boolean) => ({ body: { required, content: { "application/json": { schema: oz.object({}).passthrough() as any } } } });
const parse = async <T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> => {
  const r = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the body.", r.error.issues);
  return r.data;
};

export function registerDocVersionV1Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/docs/{id}/versions", tags: ["Docs"], summary: "A doc's page history", security: secured,
    description: "Saved versions of a doc, newest first: id, docVersion, title, name (a named version is kept for good), reason (edit: the page before someone's editing session; restore: the page just before a restore), words, author and savedAt. Also the page now (doc.version, words, editedBy). A version is kept when a new editing session starts (10 minutes after the last save, or a different person or agent), when someone saves one, and before every restore. The newest 50 unnamed versions per doc are kept.",
    request: { params: Id },
    responses: { 200: json("The versions."), 401: err("Missing or invalid API key."), 404: err("Not found.") },
  }), async (c) => send(c, await listDocVersions(c.var.deps, actor(c), c.req.param("id") ?? "")));

  api.openapi(createRoute({
    method: "post", path: "/docs/{id}/versions", tags: ["Docs"], summary: "Save the page as a named version", security: secured,
    description: `Keeps the doc as it is now under a name (up to ${VERSION_NAME_MAX} characters; left out: "Version N"). Named versions are never pruned. One row written.`,
    request: { params: Id, ...anyBody(false) },
    responses: { 201: json("The saved version."), 401: err("Missing or invalid API key."), 403: err("A read only key."), 404: err("Not found."), 422: err("Validation failed.") },
  }), async (c) => send(c, await saveDocVersion(c.var.deps, actor(c), c.req.param("id") ?? "", await parse(c, VersionSave), await idempotentCreate(c.req.raw, "dver")), 201));

  api.openapi(createRoute({
    method: "get", path: "/docs/{id}/versions/{versionId}", tags: ["Docs"], summary: "Read one version", security: secured,
    description: "The version with its Tiptap content and plain text, the page now (version, title), and sinceThen { added, removed, titleChanged }: the lines added and removed between this version and the page now. diff=1 adds the line by line diff (type same, add or del), at most 2,000 lines.",
    request: { params: Ids, query: oz.object({ diff: oz.enum(["0", "1", "true", "false"]).optional() }) },
    responses: { 200: json("The version."), 401: err("Missing or invalid API key."), 404: err("Not found.") },
  }), async (c) => send(c, await getDocVersion(c.var.deps, actor(c), c.req.param("id") ?? "", c.req.param("versionId") ?? "", { diff: wantsDiff(c.req.query("diff")) })));

  api.openapi(createRoute({
    method: "patch", path: "/docs/{id}/versions/{versionId}", tags: ["Docs"], summary: "Name or rename a version", security: secured,
    description: "Body: name (text, or null to clear it; an unnamed version can be pruned again). One row written.",
    request: { params: Ids, ...anyBody(true) },
    responses: { 200: json("The version."), 401: err("Missing or invalid API key."), 403: err("A read only key."), 404: err("Not found."), 422: err("Validation failed.") },
  }), async (c) => send(c, await renameDocVersion(c.var.deps, actor(c), c.req.param("id") ?? "", c.req.param("versionId") ?? "", await parse(c, VersionRename))));

  api.openapi(createRoute({
    method: "post", path: "/docs/{id}/versions/{versionId}/restore", tags: ["Docs"], summary: "Restore a version", security: secured,
    description: "Saves the page as it is now as a version (reason restore, so this can be undone), then writes the version's title and content as the doc's next version. ifVersion (the doc version you read) makes it a 409 with details.currentVersion if the doc changed since. Two rows written.",
    request: { params: Ids, ...anyBody(false) },
    responses: { 200: json("The doc as it is now, restoredFrom and savedCurrentAs."), 401: err("Missing or invalid API key."), 403: err("A read only key."), 404: err("Not found."), 409: err("The doc changed since you read it."), 422: err("Validation failed.") },
  }), async (c) => send(c, await restoreDocVersion(c.var.deps, actor(c), c.req.param("id") ?? "", c.req.param("versionId") ?? "", await parse(c, VersionRestore))));
}
