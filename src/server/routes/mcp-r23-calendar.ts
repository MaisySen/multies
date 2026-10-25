/**
 * Round 23 (R23.4): calendar over MCP. list_calendar_events returns meetings and task due dates in a
 * window; with a person's own OAuth sign in it also returns their other calendars (read only).
 * API keys see the workspace's meetings and due dates only.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listCalendarEvents } from "../services/suite/calendar-sync";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerCalendarTools(server: McpServer, deps: Deps, actor: Scoped, _writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_calendar_events", {
    title: "List calendar events", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Meetings (weekly series expanded) and task due dates between from and to, at most 100 days. Signed in as a person: your meetings, the due dates of tasks assigned to you, and your other calendars (kind external, read only, with sourceName). With an API key: every meeting and due date in the workspace. Each event: { id, kind, title, start, end, allDay, url }.",
    inputSchema: {
      from: z.string().max(40).optional().describe("Start, e.g. 2026-11-01 or an ISO instant. Default: a week ago."),
      to: z.string().max(40).optional().describe("End (exclusive). Default: 5 weeks after from."),
    },
  }, tool(async (x: { from?: string; to?: string }) => listCalendarEvents(deps, a, { from: x.from, to: x.to })) as never);
}
