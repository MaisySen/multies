/**
 * DF-20 Saved views in MCP: list_saved_views reads (read only keys can call it); create_saved_view
 * and delete_saved_view need a full key or token. Agents use these to set up boards for people.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createView, deleteView, listViews } from "../services/suite/tasks";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency"; // R53 (MB-239)

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const VIEWS = ["board", "list", "calendar", "timeline", "sprints", "workload"] as const;
type ViewInput = { projectId?: string | null; name: string; view: (typeof VIEWS)[number]; filters?: Record<string, string>; shared?: boolean };

export function registerSavedViewTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_saved_views", {
    title: "List saved views", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Saved views you can open (shared ones and your own), optionally for one project: id, name, view type and filters.",
    inputSchema: { projectId: z.string().max(64).optional() },
  }, tool(async (x: { projectId?: string }) => ({ views: await listViews(deps, a, x.projectId) })) as never);
  server.registerTool("create_saved_view", {
    title: "Create a saved view", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Save a view of tasks for people to open: view board, list, calendar, timeline, sprints or workload, an optional projectId, and filters (assignee, status, priority, label, type, due, q). Shared with the workspace unless shared is false; a view made by a key with no person behind it is always shared.",
    inputSchema: {
      name: z.string().trim().min(1).max(60), view: z.enum(VIEWS), projectId: z.string().max(64).nullable().optional(),
      filters: z.record(z.string(), z.string().max(200)).optional(), shared: z.boolean().optional(),
    },
  }, tool(async (x: ViewInput) => {
    writable();
    return { view: await createView(deps, a, { projectId: x.projectId ?? null, name: x.name, view: x.view, filters: x.filters ?? {}, shared: x.shared ?? true }, await mcpCreate("viw")) };
  }) as never);
  server.registerTool("delete_saved_view", {
    title: "Delete a saved view", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Remove a saved view by id. Tasks are not touched.",
    inputSchema: { viewId: z.string().min(1).max(64) },
  }, tool(async (x: { viewId: string }) => { writable(); return deleteView(deps, a, x.viewId); }) as never);
}
