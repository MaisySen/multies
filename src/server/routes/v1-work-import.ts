/**
 * Round 20 in the public API (v1): import a Trello, Asana, ClickUp, monday, Jira, Linear or Notion
 * export into a project. Same rules as Settings, Import: preview writes nothing, a re-run of the
 * same file adds only what is new, 2,000 tasks a workspace a day, read only keys cannot import.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { previewImport, runImport } from "../services/work-import/service";
import { WorkImportFile, WorkImportRun } from "./work-imports";

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
  if (!r.success) throw new HttpError(422, "validation_failed", "Send content (the file's text) and, optionally, fileName, mapping, projectId or projectName.");
  return r.data;
};

export function registerWorkImportRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (path: string, summary: string, description: string, schema: unknown) =>
    createRoute({ method: "post", path, tags: ["Import"], summary, description, security: [{ bearerAuth: [] }], request: body(schema),
      responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });
  api.openapi(route("/work-imports/preview", "Preview a work tool export", "Body: { content, fileName?, mapping? }. content is the file's text: a Trello board JSON, or a CSV from Asana, ClickUp, monday, Jira, Linear or Notion. Answers the detected source, the column mapping (change any field and send it back), the first 20 rows and the statuses. Writes nothing.", WorkImportFile),
    async (c) => send(c, await previewImport(c.var.deps, actor(c), await jsonBody(c, WorkImportFile))));
  api.openapi(route("/work-imports/run", "Import a work tool export", "Body: { content, fileName?, mapping?, projectId?, projectName? }. Without projectId it makes a new project. Tasks already brought in from the same file are skipped, so a run that stopped (stopped: daily_cap, write_budget or time) carries on when sent again. Unknown assignees are kept as a note on the task, never added as members.", WorkImportRun),
    async (c) => send(c, await runImport(c.var.deps, actor(c), await jsonBody(c, WorkImportRun))));
}
