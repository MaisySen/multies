/**
 * R32: mail_bulk_action on MCP. The same bulk actions as the web app's selection bar and POST /v1/mail/messages/bulk
 * (services/mail/bulk-r32.ts). Read only keys get 403.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { BULK_MAIL_ACTIONS, BULK_MAIL_MAX, runBulkMail, type BulkMailAction } from "../services/mail/bulk-r32";
import type { ScheduleActor } from "../services/mail/schedules";
import { BULK_JOB_ACTIONS, BULK_JOB_MAX, runBulkJob, stepBulkJob, undoBulkJob, type BulkJobAction } from "../services/mail/bulk-job-r33";
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
  // R33: "select all" as one server job.
  server.registerTool("mail_bulk_job", {
    title: "Act on every message in a folder or search", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: `Archive, move to Inbox, spam, trash (delete; Undo restores), snooze (Undo clears it), move to a synced folder (no Undo), mark read or unread, star or unstar EVERY message in a folder or search (up to ${BULK_JOB_MAX}), as one job. Give your own job_id; calling again with the same job_id continues the job until status is "done" (each call does up to 900). Mail that arrived after max_received_at is left alone (default: now). undo: true puts back exactly what the job changed (repeat until "reverted").`,
    inputSchema: {
      job_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
      action: z.enum(BULK_JOB_ACTIONS).optional().describe("Needed to start a job."),
      mailbox_id: z.string().min(1).max(64).optional().describe("Needed to start a job."),
      folder: z.enum(["inbox", "archive", "spam", "trash", "starred"]).optional(),
      query: z.string().max(200).optional().describe("A search instead of (or inside) a folder."),
      exclude_ids: z.array(z.string().min(1).max(64)).max(20000).optional(),
      to: z.string().min(1).max(520).optional().describe("move: the folder key, like \"f:Projects\"."),
      snooze_until: z.string().max(40).optional().describe("snooze: ISO time the threads come back."),
      snooze_preset: z.enum(["later_today", "tomorrow", "next_week"]).optional(),
      max_received_at: z.string().max(40).optional().describe("ISO time; later arrivals are left alone."),
      undo: z.boolean().optional(),
    },
  }, tool(async (a: { job_id: string; action?: BulkJobAction; mailbox_id?: string; folder?: "inbox" | "archive" | "spam" | "trash" | "starred"; query?: string; exclude_ids?: string[]; max_received_at?: string; undo?: boolean; to?: string; snooze_until?: string; snooze_preset?: "later_today" | "tomorrow" | "next_week" }) => {
    writable();
    const who = actor as unknown as ScheduleActor;
    if (a.undo) return undoBulkJob(deps, who, a.job_id);
    try {
      return await stepBulkJob(deps, who, a.job_id);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    if (!a.action || !a.mailbox_id) throw new Error("To start a job, give action and mailbox_id.");
    return runBulkJob(deps, who, { clientJobId: a.job_id, action: a.action, scope: { mailboxId: a.mailbox_id, folder: a.folder, q: a.query }, excludeIds: a.exclude_ids, maxReceivedAt: a.max_received_at ?? deps.now().toISOString(), to: a.to, when: { at: a.snooze_until, preset: a.snooze_preset } });
  }) as never);
}
