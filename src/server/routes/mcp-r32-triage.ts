/**
 * R32: task Triage on MCP. task_triage_list reads the queue (or the snoozed items); task_triage_action
 * accepts, declines, snoozes, unsnoozes, marks a duplicate or restores (undo). Same services as the app
 * and POST /api/v1/tasks/{id}/triage. AIS1 (audit row 66): over MCP only snooze and unsnooze work; the
 * decisions answer person_only.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { parseAssignee } from "../services/suite/tasks";
import { listTriage } from "../services/suite/triage";
import { TRIAGE_ACTIONS, triageAction, type TriageAction } from "../services/suite/triage-r32";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerTriageR32Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;

  server.registerTool("task_triage_list", {
    title: "List task Triage", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Tasks waiting in Triage (from mail, forms, the API and agents), newest first, with the count. view: pending (default) or snoozed. Each item has triage { state, source, from, snoozedUntil }.",
    inputSchema: { projectId: z.string().optional(), view: z.enum(["pending", "snoozed"]).optional(), limit: z.number().int().min(1).max(500).optional() },
  }, tool(async (x: { projectId?: string; view?: "pending" | "snoozed"; limit?: number }) => listTriage(deps, a, x)) as never);

  server.registerTool("task_triage_action", {
    title: "Act on a task in Triage", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "action: accept (optional statusId, status, projectId, assignee member:<id> or agent:<id>), decline (optional reason), snooze (until: ISO date or date-time, a key or an AI app may snooze only until 7 days after the item came in, a person up to a year), unsnooze, duplicate (duplicateOf: the task id it repeats) or restore (undo an accept, decline or duplicate from the last day). comment: a one line note written with an accept or decline (the answer carries comment.id); pass that as commentId with restore to remove it in the same undo. Only a person signed in to Multies accepts, declines, marks a duplicate or restores: an API key or a connected AI app gets person_only and may snooze or unsnooze.",
    inputSchema: {
      id: z.string(), action: z.enum(TRIAGE_ACTIONS),
      statusId: z.string().optional(), status: z.enum(["todo", "doing", "done"]).optional(), projectId: z.string().optional(), assignee: z.string().nullable().optional(),
      reason: z.string().max(500).optional(), until: z.string().max(40).optional(), duplicateOf: z.string().optional(),
      comment: z.string().max(2000).optional(), commentId: z.string().max(64).optional(),
    },
  }, tool(async (x: { id: string; action: TriageAction; statusId?: string; status?: "todo" | "doing" | "done"; projectId?: string; assignee?: string | null; reason?: string; until?: string; duplicateOf?: string; comment?: string; commentId?: string }) => {
    writable();
    return triageAction(deps, a, x.id, {
      action: x.action, until: x.until, duplicateOf: x.duplicateOf, comment: x.comment, commentId: x.commentId,
      accept: { statusId: x.statusId, status: x.status, projectId: x.projectId, ...(x.assignee !== undefined ? { assignee: parseAssignee(x.assignee) } : {}) },
      decline: { reason: x.reason },
    });
  }) as never);
}
