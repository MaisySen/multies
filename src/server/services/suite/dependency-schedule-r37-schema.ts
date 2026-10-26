import { z } from "zod";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a date like 2026-11-03.");
/** R37: body of POST /tasks/:id/reschedule (app API, /api/v1 and the reschedule_task MCP tool). */
export const RescheduleBody = z.object({
  start: Day.nullable().optional(),
  due: Day.nullable().optional(),
  moveDependents: z.boolean().optional(),
  preview: z.boolean().optional(),
});
