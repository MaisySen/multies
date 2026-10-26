/**
 * R34 (MB-186): board swimlanes and WIP limits in MCP. get_board_settings reads (read only keys can call it);
 * set_board_settings needs a full key or token. One row written per change.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getBoardSettings, setBoardSettings, type BoardPatch } from "../services/suite/board-settings";
import { SWIMLANES } from "../../shared/board-lanes";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const Lim = z.number().int().min(0).max(999).nullable().optional();

export function registerBoardTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("get_board_settings", {
    title: "Get board settings", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "A project board's swimlanes (none, assignee, epic, priority or project) and column limits: { [statusId]: { max, min } }.",
    inputSchema: { projectId: z.string().min(1).max(64) },
  }, tool(async (x: { projectId: string }) => ({ board: await getBoardSettings(deps, a.orgId, x.projectId) })) as never);
  server.registerTool("set_board_settings", {
    title: "Set board settings", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Change a project board: swimlanes, the whole limits map (replaces it), or one column's limit with column { id (a status id), max, min } where null clears. Limits are whole numbers 1 to 999. Cards can still go into a full column; the board shows it as over the limit.",
    inputSchema: {
      projectId: z.string().min(1).max(64), swimlanes: z.enum(SWIMLANES).optional(),
      limits: z.record(z.string().min(1).max(64), z.object({ max: Lim, min: Lim }).nullable()).optional(),
      column: z.object({ id: z.string().min(1).max(64), max: Lim, min: Lim }).optional(),
    },
  }, tool(async (x: BoardPatch & { projectId: string }) => {
    writable();
    const { projectId, ...patch } = x;
    return { board: await setBoardSettings(deps, a, projectId, patch) };
  }) as never);
}
