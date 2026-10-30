/**
 * R24.4 Automation recipes in the public API (v1): GET /automations/recipes (read only keys can
 * call it) and POST /automations/recipes/{key}/enable (a full workspace key; agent keys and read
 * only keys are refused). Blanks must name this workspace's channels, projects and members.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { enableRecipe, listRecipes } from "../services/suite/automation-recipes";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export function registerAutomationRecipeRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/automations/recipes", tags: ["Automations"], summary: "List automation recipes", security: [{ bearerAuth: [] }],
    description: "Ready made rules grouped by category (Tasks, Mail, Chat, Meetings, Sprints). Each recipe: key, category, name, description, icon (a Lucide name), rules (trigger, conditions, action, actionConfig), blanks (what to fill in: key, kind channel | project | member | members | text, label), added, on and automationIds (the rules it made here). Writes nothing.",
    responses: { 200: json("The recipes."), 401: err("Missing or invalid API key.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await listRecipes(c.var.deps, actor(c)) as any, 200) as any);

  api.openapi(createRoute({
    method: "post", path: "/automations/recipes/{key}/enable", tags: ["Automations"], summary: "Turn on an automation recipe", security: [{ bearerAuth: [] }],
    description: "Makes the recipe's rules (normal automations) with the blanks filled in, or switches them back on when the recipe was added before. Body: { blanks: { channelId?, projectId?, memberIds?, from?, keyword? } } as the recipe's blanks list. A channel must be a public channel of this workspace; projects and members must be this workspace's. Each run of a rule counts against the plan's monthly automation runs.",
    request: {
      params: z.object({ key: z.string().min(1).max(60) }),
      body: { required: false, content: { "application/json": { schema: z.object({ blanks: z.record(z.string(), z.unknown()).optional() }) } } },
    },
    responses: { 200: json("The rules made or switched on."), 401: err("Missing or invalid API key."), 403: err("A read only key, or an agent key."), 404: err("No such recipe."), 422: err("A blank is missing or names something outside this workspace.") },
  }),
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { blanks?: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(await enableRecipe(c.var.deps, actor(c), c.req.param("key"), body?.blanks ?? {}) as any, 200) as any;
  });
}
