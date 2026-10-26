/**
 * R34 (MB-186): board swimlanes and WIP limits in the public API (v1): GET and PUT /projects/{id}/board.
 * Read only keys can read; a change needs a full key. One row written per change.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getBoardSettings, setBoardSettings } from "../services/suite/board-settings";
import { BoardPatchSchema } from "./board-schema-r34";
import { HttpError } from "../lib/errors";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export function registerBoardRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/projects/{id}/board", tags: ["Projects"], summary: "Get a board's swimlanes and column limits", security: [{ bearerAuth: [] }],
    description: "Answers { board: { projectId, swimlanes (none, assignee, epic, priority or project), limits: { [statusId]: { max?, min? } } } }. A board never saved answers swimlanes none and no limits.",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json("The board settings."), 401: err("Missing or invalid API key."), 404: err("No such project.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json({ board: await getBoardSettings(c.var.deps, actor(c).orgId, c.req.param("id")) } as any, 200) as any);

  api.openapi(createRoute({
    method: "put", path: "/projects/{id}/board", tags: ["Projects"], summary: "Change a board's swimlanes or column limits", security: [{ bearerAuth: [] }],
    description: "Body: { swimlanes?, limits? (the whole map, replaces it), column? ({ id, max?, min? }, null clears one side) }. Limits are whole numbers 1 to 999 and min is not above max. A card can still go into a full column; the board shows it as over the limit. One row written.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({}).passthrough() as any } } } },
    responses: { 200: json("The board settings."), 401: err("Missing or invalid API key."), 403: err("Read only key."), 404: err("No such project."), 422: err("Validation failed.") },
  }),
  async (c) => {
    const parsed = BoardPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(422, "validation_failed", parsed.error.issues[0]?.message ?? "Check the board settings.", parsed.error.issues);
    const board = await setBoardSettings(c.var.deps, actor(c), c.req.param("id"), parsed.data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json({ board } as any, 200) as any;
  });
}
