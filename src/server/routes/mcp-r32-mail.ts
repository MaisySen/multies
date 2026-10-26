/**
 * R32: mail_bulk_action on MCP. The same bulk actions as the web app's selection bar and POST /v1/mail/messages/bulk
 * (services/mail/bulk-r32.ts). Read only keys get 403.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { BULK_MAIL_ACTIONS, BULK_MAIL_MAX, runBulkMail, type BulkMailAction } from "../services/mail/bulk-r32";
import type { ScheduleActor } from "../services/mail/schedules";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerMailR32Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  server.registerTool("mail_bulk_action", {
    title: "Act on many messages at once", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: `Archive, snooze, move, mark read or unread, star, trash or delete up to ${BULK_MAIL_MAX} messages in one call. Each inverse undoes its action: inbox undoes archive or trash, unread undoes read, unsnooze undoes snooze. delete is forever. move needs to (a connected mailbox's folder key, "f:<path>"); snooze needs until (ISO time) or preset. Ids the key can't open are skipped.`,
    inputSchema: {
      ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_MAIL_MAX),
      action: z.enum(BULK_MAIL_ACTIONS),
      to: z.string().min(1).max(520).optional().describe("For move: the folder key."),
      until: z.string().max(40).optional().describe("For snooze: when it comes back, ISO 8601 with a zone."),
      preset: z.enum(["later_today", "tomorrow", "next_week"]).optional().describe("For snooze instead of until."),
    },
  }, tool(async (a: { ids: string[]; action: BulkMailAction; to?: string; until?: string; preset?: "later_today" | "tomorrow" | "next_week" }) => {
    writable();
    return runBulkMail(deps, actor as unknown as ScheduleActor, { ids: a.ids, action: a.action, to: a.to, at: a.until, preset: a.preset });
  }) as never);
}
