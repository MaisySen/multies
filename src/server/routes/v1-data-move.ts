/**
 * R38 move your data in the public API (v1): the import and export history, a workspace export link (admin keys; a read
 * only key may start one, since an export only reads), imports of tasks, calendar, contacts, docs or a whole workspace,
 * and Undo. Same rules as Settings, Import and export.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { idempotentRunKeys } from "../lib/idempotency"; // R53 (MB-239)
import type { SuiteActor } from "../services/suite/common";
import { listMoves, previewMove, runMove, startExport, undoMove } from "../services/data-move/service";
import { DataMoveRun } from "./data-moves";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { safeParse: (v: unknown) => any }) => {
  const r = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) throw new HttpError(422, "validation_failed", "Send kind (tasks, calendar, contacts, docs or workspace) and content (the file's text, or zip-base64: and the zip in base64).");
  return r.data;
};
const responses = { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed."), 429: err("Too soon after the last export.") };

/** A read only key may start an export: it only reads the workspace. */
export const isDataExportStart = (method: string, path: string) => method === "POST" && /\/data-moves\/exports$/.test(path);

export function registerDataMoveRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({ method: "get", path: "/data-moves", tags: ["Import and export"], summary: "List imports and exports", description: "The last 50 imports and exports, newest first, with status, progress (done of total), what each made and whether it can be undone.", security: [{ bearerAuth: [] }], responses }),
    async (c) => send(c, await listMoves(c.var.deps, actor(c))));
  api.openapi(createRoute({ method: "post", path: "/data-moves/exports", tags: ["Import and export"], summary: "Export the whole workspace", description: "Answers downloadUrl: a ZIP of everything (JSON per table, CSV for the main tables, Markdown docs, an .ics calendar, a .vcf address book and mbox mail). The link works for 24 hours without a key. One export a workspace every 10 minutes (429 otherwise). Written to the audit log. Multies' own mail (invites, confirmations, resets) is in it with its subject and sender only.", security: [{ bearerAuth: [] }], responses }),
    async (c) => {
      const r = await startExport(c.var.deps, actor(c));
      return send(c, { ...r, downloadUrl: new URL(r.downloadPath, c.req.url).toString() });
    });
  api.openapi(createRoute({ method: "post", path: "/data-moves/imports/preview", tags: ["Import and export"], summary: "Preview an import", description: "Body: { kind, content, fileName?, mapping? }. kind is tasks (a work tool CSV, Excel, JSON or Markdown zip), calendar (.ics), contacts (.vcf or CSV), docs (Markdown or a zip of pages) or workspace (an export zip). Writes nothing.", security: [{ bearerAuth: [] }], request: body(DataMoveRun), responses }),
    async (c) => send(c, await previewMove(c.var.deps, actor(c), await jsonBody(c, DataMoveRun))));
  api.openapi(createRoute({ method: "post", path: "/data-moves/imports/run", tags: ["Import and export"], summary: "Run one step of an import", description: "Body: { kind, content, fileName?, mapping?, projectId?, projectName?, statusMap?, people?, moveId? }. Brings in about 15 seconds of items and answers move { id, status, done, total }. While status is stopped, send the same body with moveId to carry on. statusMap maps a status name in the file to a status id; people maps a person in the file to a member id, or \"\" to leave unassigned. Tasks a key brings into a project with Triage on (a new project starts with it on) wait in Triage for a person.", security: [{ bearerAuth: [] }], request: body(DataMoveRun), responses }),
    async (c) => send(c, await runMove(c.var.deps, actor(c), await jsonBody(c, DataMoveRun), await idempotentRunKeys(c.req.raw)))); // R53
  api.openapi(createRoute({ method: "post", path: "/data-moves/{id}/undo", tags: ["Import and export"], summary: "Undo an import", description: "Removes exactly what the import made: its tasks with their comments, the statuses and projects it added (when nothing else uses them), and its meetings, contacts and docs.", security: [{ bearerAuth: [] }], request: { params: z.object({ id: z.string() }) }, responses }),
    async (c) => send(c, await undoMove(c.var.deps, actor(c), c.req.param("id"))));
}
