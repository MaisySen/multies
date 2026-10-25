/**
 * R24.4 Automation recipes in the web app (cookie session): GET /api/automations/recipes lists them
 * with their on state; POST /api/automations/recipes/:key/enable turns one on with its blanks
 * (admins only, like every automation change). The same service backs /api/v1 and MCP.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { enableRecipe, listRecipes } from "../services/suite/automation-recipes";

export const RecipeEnable = z.object({ blanks: z.record(z.string(), z.unknown()).default({}) });

export function automationRecipeRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listRecipes(c.var.deps, c.var.auth)))
    .post("/:key/enable", requireAdmin, async (c) => c.json(await enableRecipe(c.var.deps, c.var.auth, c.req.param("key"), (await parseBody(c, RecipeEnable)).blanks), 200));
}
