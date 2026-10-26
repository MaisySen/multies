/** R34 (MB-186): the body of a board settings change (session API, v1 and MCP share it). */
import { z } from "zod";
import { SWIMLANES } from "../../shared/board-lanes";

const Lim = z.number().int().min(0).max(999).nullable().optional();
export const BoardPatchSchema = z.object({
  swimlanes: z.enum(SWIMLANES).optional(),
  /** The whole map: { [columnId]: { max?, min? } }. Replaces what was there. */
  limits: z.record(z.string().min(1).max(64), z.object({ max: Lim, min: Lim }).nullable()).optional(),
  /** One column's limit; null clears that side. */
  column: z.object({ id: z.string().min(1).max(64), max: Lim, min: Lim }).optional(),
});
