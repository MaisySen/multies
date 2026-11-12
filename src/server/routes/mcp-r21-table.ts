/**
 * Round 21 (R21.2): bulk task changes on MCP. Read only keys and read only tokens get 403.
 * Same service as the table view's bulk bar and POST /api/v1/tasks/bulk (services/suite/bulk.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { bulkUpdateTasks, type BulkPatch } from "../services/suite/bulk";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerTaskBulkTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("bulk_update_tasks", {
    title: "Change many tasks at once", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Apply one change to up to 500 tasks by id or reference (OPS-12): status (todo, doing, done) or a statusId, assignee, priority, due or start date (null clears), labels to add or remove, a type (task, story, bug), or a project to move them to. If any task is not in this workspace nothing is changed. Moving tasks from a project with Triage off into one with Triage on answers person_only and changes nothing.",
    inputSchema: {
      ids: z.array(z.string().min(1).max(80)).min(1).max(500),
      status: z.enum(["todo", "doing", "done"]).optional(), statusId: z.string().max(80).optional(),
      assignee: z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional().describe("member:<userId> or agent:<agentId>, or null for nobody."),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
      dueAt: z.string().max(40).nullable().optional().describe("ISO date, e.g. 2026-11-03. null clears."), startAt: z.string().max(40).nullable().optional(),
      addLabels: z.array(z.string().min(1).max(40)).max(20).optional(), removeLabels: z.array(z.string().min(1).max(40)).max(20).optional(),
      projectId: z.string().max(80).optional().describe("Move the tasks here; each status maps to the same group."),
      type: z.enum(["task", "story", "bug"]).optional().describe("Set the type. Epics are changed one at a time with update_task."),
    },
  }, tool(async (x: BulkPatch & { ids: string[] }) => {
    writable();
    const { ids, ...patch } = x;
    const r = await bulkUpdateTasks(deps, a, ids, patch);
    return { updated: r.updated, unchanged: r.unchanged, tasks: r.tasks.map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, statusName: t.statusName, priority: t.priority, due: t.due, assignee: t.assignee?.name ?? null, labels: t.labels, projectId: t.projectId })) };
  }) as never);
}
