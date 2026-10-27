import { z } from "zod";
import { HttpError } from "../lib/errors";

/** R46 (MB-234): paging and change refresh parameters on the session task lists (not on the public API). */
export const PageQuery = {
  paged: z.enum(["1"]).optional(), cursor: z.string().max(400).optional(),
  ids: z.string().max(4000).regex(/^[A-Za-z0-9_,-]*$/).optional(),
};
export function splitIds(ids: string | undefined) {
  if (ids === undefined) return undefined;
  const list = [...new Set(ids.split(",").filter(Boolean))];
  if (list.length > 100) throw new HttpError(400, "too_many_ids", "Ask for at most 100 tasks at once.");
  return list;
}
