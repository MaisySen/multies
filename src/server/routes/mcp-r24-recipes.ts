/**
 * R24.4 Automation recipes in MCP: list_automation_recipes (read) and enable_automation_recipe
 * (write: a full workspace key; read only keys and agent keys are refused).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { enableRecipe, listRecipes } from "../services/suite/automation-recipes";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerRecipeTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_automation_recipes", {
    title: "List automation recipes", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Ready made automation rules by category (Tasks, Mail, Chat, Meetings, Sprints): key, name, description, the rules each makes, the blanks to fill (channel, project, member, members or text) and whether it is on in this workspace. Pass category to narrow the list.",
    inputSchema: { category: z.enum(["Tasks", "Mail", "Chat", "Meetings", "Sprints"]).optional() },
  }, tool(async (x: { category?: string }) => {
    const r = await listRecipes(deps, a);
    return { ...r, recipes: r.recipes.filter((p) => !x.category || p.category === x.category) };
  }) as never);

  server.registerTool("enable_automation_recipe", {
    title: "Turn on an automation recipe", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Turns a recipe on: makes its rules as normal automations with the blanks filled in (for example { channelId } for a recipe that posts in a channel, or { projectId, memberIds } for sharing tasks in turn). Channels must be public channels of this workspace. Answers the rules made or switched on.",
    inputSchema: { key: z.string().min(1).max(60), blanks: z.record(z.string(), z.unknown()).default({}) },
  }, tool(async (x: { key: string; blanks: Record<string, unknown> }) => {
    writable();
    return enableRecipe(deps, a, x.key, x.blanks);
  }) as never);
}
