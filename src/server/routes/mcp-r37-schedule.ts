/**
 * R37: dependencies that plan for you, over MCP. check_task_schedule lists date clashes along "blocks" links;
 * reschedule_task moves a task and shifts the tasks that wait on it (same services as GET
 * /api/v1/tasks/dependencies/check and POST /api/v1/tasks/{id}/reschedule, services/suite/dependency-schedule-r37.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { rescheduleTask, scheduleCheck } from "../services/suite/dependency-schedule-r37";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export function registerScheduleR37Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("check_task_schedule", {
    title: "Check dates along dependencies", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Lists clashes along \"blocked by\" links: a task that starts on or before the last day of a task blocking it. Each clash names both tasks, how many days they overlap and fix { taskId, start, due } (pass those to reschedule_task to clear it). Optional projectId. Done tasks never clash.",
    inputSchema: { projectId: z.string().optional() },
  }, tool(async (x: { projectId?: string }) => {
    const r = await scheduleCheck(deps, a.orgId, x.projectId);
    return { links: r.links.length, conflicts: r.conflicts.map((c) => ({ blocker: c.blocker, blocked: c.blocked, overlapDays: c.overlapDays, fix: c.fix })) };
  }) as never);

  server.registerTool("reschedule_task", {
    title: "Move a task and the tasks that wait on it", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Sets a task's start and/or due (YYYY-MM-DD; null clears). Unless moveDependents is false, every task waiting on it that would now start on or before a blocker's last day shifts later by just enough, keeping its length. Moving earlier never pulls later tasks. preview: true returns the plan and changes nothing. At most 50 tasks move at once.",
    inputSchema: { taskId: z.string().min(1), start: Day.nullable().optional(), due: Day.nullable().optional(), moveDependents: z.boolean().optional(), preview: z.boolean().optional() },
  }, tool(async (x: { taskId: string; start?: string | null; due?: string | null; moveDependents?: boolean; preview?: boolean }) => {
    if (!x.preview) writable();
    const r = await rescheduleTask(deps, a, x.taskId, x);
    const t = r.task as { ref?: string; title?: string; start?: string | null; due?: string | null; to?: { start: string | null; due: string | null } };
    return { preview: r.preview, task: { ref: t.ref, title: t.title, start: t.to?.start ?? t.start ?? null, due: t.to?.due ?? t.due ?? null }, moved: r.moved.map((m) => ({ ref: m.ref, title: m.title, from: m.from, to: m.to, days: m.days })) };
  }) as never);
}
