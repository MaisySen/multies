/**
 * R31: notification triage and catch-up over MCP, for the person who made the key (workspace keys only).
 * notification_list, notification_done, notification_undone, notification_snooze, catchup_get.
 * Same services as /api/v1/notifications and /api/v1/catchup.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { listNotifications } from "../services/suite/notify";
import { markDone, markManyDone, markUndone, snooze, SNOOZE_PRESETS, TRIAGE_VIEWS, type SnoozePreset, type TriageView } from "../services/suite/notify-triage";
import { CATCHUP_TYPES, getCatchup, type CatchupType } from "../services/suite/catchup";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const CATEGORY = z.enum(["mention", "assignment", "comment", "approval", "due_soon", "chat", "email", "status"]);

export function registerTriageR31Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const person = () => {
    if (a.agentId || !a.userId) throw new HttpError(403, "workspace_key_only", "Agent keys have no notifications inbox. Use a workspace key.");
    return a.userId;
  };

  server.registerTool("notification_list", {
    title: "List notifications by view", annotations: ro,
    description: "Your notifications in a view: inbox (default: not done, not snoozed), later (snoozed) or done. Each item has doneAt and snoozedUntil; the answer has viewCounts { inbox, later, done } and unread (Inbox only).",
    inputSchema: { view: z.enum(TRIAGE_VIEWS).optional(), unread: z.boolean().optional(), category: CATEGORY.optional(), limit: z.number().int().min(1).max(200).optional(), before: z.string().optional() },
  }, tool(async (x: { view?: TriageView; unread?: boolean; category?: string; limit?: number; before?: string }) =>
    listNotifications(deps, a.orgId, person(), { view: x.view, unread: x.unread, category: x.category, limit: x.limit ?? 50, before: x.before })) as never);

  server.registerTool("notification_done", {
    title: "Mark notifications done", annotations: rw,
    description: "Moves one notification (id) or many (ids, up to 500) out of the Inbox to Done and marks them read.",
    inputSchema: { id: z.string().optional(), ids: z.array(z.string()).max(500).optional() },
  }, tool(async (x: { id?: string; ids?: string[] }) => {
    writable();
    const userId = person();
    if (x.id) return markDone(deps, a.orgId, userId, x.id);
    if (x.ids?.length) return markManyDone(deps, a.orgId, userId, x.ids);
    throw new HttpError(422, "validation_failed", "Send id or ids.");
  }) as never);

  server.registerTool("notification_undone", {
    title: "Move a notification back to the Inbox", annotations: rw,
    description: "Clears done and any snooze on one notification.",
    inputSchema: { id: z.string().min(1) },
  }, tool(async (x: { id: string }) => { writable(); return markUndone(deps, a.orgId, person(), x.id); }) as never);

  server.registerTool("notification_snooze", {
    title: "Snooze a notification", annotations: rw,
    description: "Moves a notification to Later until a time: until (ISO, in the future, at most 90 days ahead) or preset later_today, tomorrow or next_week in your time zone. It comes back to the top of the Inbox, unread.",
    inputSchema: { id: z.string().min(1), until: z.string().optional(), preset: z.enum(SNOOZE_PRESETS).optional() },
  }, tool(async (x: { id: string; until?: string; preset?: SnoozePreset }) => { writable(); return snooze(deps, a.orgId, person(), x.id, { until: x.until, preset: x.preset }); }) as never);

  server.registerTool("catchup_get", {
    title: "What did I miss", annotations: ro,
    description: "A digest of a chat channel, task or doc since your last visit: counts (messages, replies, comments, edits, status and assignee changes, mentions of you), who did it, latest decisions and the newest items. Set markVisited to record this visit.",
    inputSchema: { type: z.enum(CATCHUP_TYPES), id: z.string().min(1), markVisited: z.boolean().optional() },
  }, tool(async (x: { type: CatchupType; id: string; markVisited?: boolean }) => {
    person();
    if (x.markVisited) writable();
    return { catchup: await getCatchup(deps, a, x.type, x.id, { visit: !!x.markVisited }) };
  }) as never);
}
