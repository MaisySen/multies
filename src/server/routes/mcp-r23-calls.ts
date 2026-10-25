/**
 * Round 23 (R23.3) MCP tools: who is in a chat call right now. Read only. Agents can't start
 * calls (people do, from chat); they can schedule meetings with create_meeting.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import { channelCallStatus, meetingCallStatus } from "../services/suite/calls";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerCallTools(server: McpServer, deps: Deps, actor: Scoped, _writable: () => void, tool: Tool) {
  server.registerTool("get_call_status", {
    title: "Who is in a call now", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Live status of calls: pass channelId for the calls started in a channel in the last 6 hours (live, waiting or ended, with who is in each), or meetingId for one meeting. enabled is false when video is off for the workspace. Keys can't open DMs or private channels.",
    inputSchema: { channelId: z.string().min(1).optional(), meetingId: z.string().min(1).optional() },
  }, tool(async (x: { channelId?: string; meetingId?: string }) => {
    if (x.meetingId) return meetingCallStatus(deps, actor, x.meetingId);
    if (x.channelId) return channelCallStatus(deps, actor, x.channelId);
    throw new HttpError(422, "validation_failed", "Pass channelId or meetingId.");
  }) as never);
}
