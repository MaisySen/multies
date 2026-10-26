import { z } from "zod";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a date like 2026-11-03.");
/** R37: body of POST /tasks/:id/reschedule (app API, /api/v1 and the reschedule_task MCP tool). */
export const RescheduleBody = z.object({
  start: Day.nullable().optional(),
  due: Day.nullable().optional(),
  moveDependents: z.boolean().optional(),
  preview: z.boolean().optional(),
  /** R38: true moves every waiting task by the same days (strict); false is the flexible rule. Default: the project's setting. */
  strict: z.boolean().optional(),
});

/** R38: lead (negative) or lag (positive) on a link, whole days. */
export const LagDays = z.number().int().min(-365).max(365);
/** R38: body of POST /tasks/:id/dependencies (blockedBy plus an optional lead or lag). */
export const DependencyAddBody = z.object({ blockedBy: z.string().min(1), lagDays: LagDays.optional() });
/** R38: body of PATCH /tasks/:id/dependencies/:blockedBy. */
export const DependencyLagBody = z.object({ lagDays: LagDays });
/** R38: body of PUT /projects/:id/schedule (each field optional; what is left out keeps its value). */
export const ScheduleSettingsBody = z.object({
  workingDaysOnly: z.boolean().optional(),
  daysOff: z.array(z.number().int().min(0).max(6)).max(6).optional(),
  strict: z.boolean().optional(),
});
