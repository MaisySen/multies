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
import { setScheduleSettings } from "../services/suite/schedule-settings-r38";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export function registerScheduleR37Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("check_task_schedule", {
    title: "Check dates along dependencies", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Lists clashes along \"blocked by\" links: a task that starts before the last day of a task blocking it plus the link's lagDays (a negative lagDays is a lead). Each clash names both tasks, lagDays, how many days it must move and fix { taskId, start, due } (pass those to reschedule_task to clear it). With projectId the answer also has the project's schedule rules (workingDaysOnly, daysOff, strict). Done tasks never clash.",
    inputSchema: { projectId: z.string().optional() },
  }, tool(async (x: { projectId?: string }) => {
    const r = await scheduleCheck(deps, a.orgId, x.projectId);
    return { links: r.links.length, conflicts: r.conflicts.map((c) => ({ blocker: c.blocker, blocked: c.blocked, lagDays: c.lag, overlapDays: c.overlapDays, fix: c.fix })), ...(r.settings ? { schedule: r.settings } : {}) };
  }) as never);

  server.registerTool("reschedule_task", {
    title: "Move a task and the tasks that wait on it", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Sets a task's start and/or due (YYYY-MM-DD; null clears). Unless moveDependents is false, the tasks waiting on it move too. Flexible (default): a waiting task that would now start too early (before a blocker's last day plus the link's lag) shifts later by just enough, keeping its length; moving earlier never pulls later tasks. Strict (the project's setting, or strict: true for this move): every waiting task moves by the same number of days, earlier or later. With working days only on, days off are skipped. preview: true returns the plan and changes nothing. At most 50 tasks move at once.",
    inputSchema: { taskId: z.string().min(1), start: Day.nullable().optional(), due: Day.nullable().optional(), moveDependents: z.boolean().optional(), preview: z.boolean().optional(), strict: z.boolean().optional() },
  }, tool(async (x: { taskId: string; start?: string | null; due?: string | null; moveDependents?: boolean; preview?: boolean; strict?: boolean }) => {
    if (!x.preview) writable();
    const r = await rescheduleTask(deps, a, x.taskId, x);
    const t = r.task as { ref?: string; title?: string; start?: string | null; due?: string | null; to?: { start: string | null; due: string | null } };
    return { preview: r.preview, mode: r.mode, workingDaysOnly: r.workingDaysOnly, task: { ref: t.ref, title: t.title, start: t.to?.start ?? t.start ?? null, due: t.to?.due ?? t.due ?? null }, moved: r.moved.map((m) => ({ ref: m.ref, title: m.title, from: m.from, to: m.to, days: m.days })) };
  }) as never);

  // R38: a project's rules for dependency dates.
  server.registerTool("set_project_schedule", {
    title: "Set a project's rules for dependency dates", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "workingDaysOnly: lead, lag and shifts count working days and a moved task never starts or ends on a day off (daysOff: week days 0 Sunday to 6 Saturday, default Saturday and Sunday). strict: moving a task by N days moves every task that waits on it by the same N days, earlier or later; off is the flexible rule (later only, just enough). Fields left out keep their value. check_task_schedule with projectId reads them.",
    inputSchema: { projectId: z.string().min(1), workingDaysOnly: z.boolean().optional(), daysOff: z.array(z.number().int().min(0).max(6)).max(6).optional(), strict: z.boolean().optional() },
  }, tool(async (x: { projectId: string; workingDaysOnly?: boolean; daysOff?: number[]; strict?: boolean }) => {
    writable();
    return { schedule: await setScheduleSettings(deps, a, x.projectId, x) };
  }) as never);
}
