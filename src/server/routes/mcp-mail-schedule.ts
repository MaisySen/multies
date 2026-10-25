/**
 * Round 20 (R20.3): snooze, send later and the Scheduled list on MCP. Read only keys can list but not
 * change anything. A scheduled send goes out as an agent inbox when due, through the same requestSend
 * as send_email, so the agent's allowed recipients, daily cap and approval rules all still apply.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import { cancelSchedule, listSchedules, scheduleSend, snoozeThread } from "../services/mail/schedules";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const whenSchema = {
  preset: z.enum(["later_today", "tomorrow", "next_week"]).optional().describe("later_today: three hours on; tomorrow and next_week: 8:00 in the person's own time zone."),
  at: z.string().max(40).optional().describe("An exact time, ISO 8601 with a zone, e.g. 2026-11-02T09:00:00+11:00."),
  local: z.string().max(20).optional().describe("A wall clock time in the key owner's own time zone, e.g. 2026-11-02T09:00."),
};

export function registerMailScheduleTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, agentFor: (agentId?: string) => Promise<{ id: string; inboxId: string }>, tool: Tool) {
  server.registerTool("snooze_thread", {
    title: "Snooze a thread", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Hide a thread from Inbox until a time; it comes back to the top of Inbox then. A new reply wakes it early.",
    inputSchema: { threadId: z.string().min(1), ...whenSchema },
  }, tool(async (a: { threadId: string; preset?: "later_today" | "tomorrow" | "next_week"; at?: string; local?: string }) => {
    writable();
    return snoozeThread(deps, actor, { threadId: a.threadId }, a);
  }) as never);

  server.registerTool("schedule_send", {
    title: "Send an email later", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Schedule a new email from an agent inbox for a later time. When due it is sent exactly like send_email: allowed recipients, daily cap and approval rules apply then. Cancel with cancel_scheduled.",
    inputSchema: {
      agentId: z.string().optional().describe("Which agent sends. Not needed with an agent key."),
      to: z.array(z.string().email()).min(1).max(50),
      cc: z.array(z.string().email()).max(50).optional(),
      subject: z.string().max(998),
      text: z.string().min(1).max(200_000).describe("Plain text body."),
      ...whenSchema,
    },
  }, tool(async (a: { agentId?: string; to: string[]; cc?: string[]; subject: string; text: string; preset?: "later_today" | "tomorrow" | "next_week"; at?: string; local?: string }) => {
    writable();
    const agent = await agentFor(a.agentId);
    const message = { mailboxId: agent.inboxId, to: a.to.map((x) => x.toLowerCase()), cc: a.cc?.map((x) => x.toLowerCase()), subject: a.subject, text: a.text };
    return scheduleSend(deps, { ...actor, agentId: actor.agentId ?? null }, message, a, { agentId: agent.id });
  }) as never);

  server.registerTool("list_scheduled", {
    title: "List snoozed and scheduled mail", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Snoozed threads, scheduled sends and reminders waiting for a reply, in the mailboxes this key can read.",
    inputSchema: { view: z.enum(["snoozed", "scheduled"]).default("scheduled") },
  }, tool(async (a: { view: "snoozed" | "scheduled" }) => ({ items: await listSchedules(deps, actor, { view: a.view }) })) as never);

  server.registerTool("cancel_scheduled", {
    title: "Cancel a scheduled send or snooze", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Cancel a scheduled send or reminder, or unsnooze a thread, by the id list_scheduled gave.",
    inputSchema: { id: z.string().min(1) },
  }, tool(async (a: { id: string }) => {
    writable();
    if (!a.id.startsWith("msch_")) throw new HttpError(404, "not_found", "Scheduled item not found.");
    return cancelSchedule(deps, actor, a.id);
  }) as never);
}
