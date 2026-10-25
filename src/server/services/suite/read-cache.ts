/**
 * R25 API speed: memoised workspace lookups that every task list reads (custom field definitions
 * and project statuses). Both are read on each list, board, sprint and dashboard request and change
 * only when someone edits a project's fields or statuses, which call the invalidate functions here.
 */
import { and, eq, isNull } from "drizzle-orm";
import { customFields, projectStatuses } from "../../db/schema";
import { orgMemo } from "../../lib/org-memo";
import type { Deps } from "../../context";

export const READ_CACHE_TTL_MS = 10_000;

type FieldRow = typeof customFields.$inferSelect;
type StatusRow = typeof projectStatuses.$inferSelect;

const fieldDefs = orgMemo<FieldRow[]>("custom_fields", READ_CACHE_TTL_MS);
const statuses = orgMemo<StatusRow[]>("project_statuses", READ_CACHE_TTL_MS);

/** Every live custom field of the workspace (all projects). One query per TTL instead of one per list. */
export function orgFieldDefs(deps: Deps, orgId: string): Promise<FieldRow[]> {
  return fieldDefs.get(deps.db, orgId, () => deps.db.select().from(customFields).where(and(eq(customFields.orgId, orgId), isNull(customFields.deletedAt))));
}

/** Every status row of the workspace, deleted ones included (old tasks can still point at them). */
export function orgStatuses(deps: Deps, orgId: string): Promise<StatusRow[]> {
  return statuses.get(deps.db, orgId, () => deps.db.select().from(projectStatuses).where(eq(projectStatuses.orgId, orgId)));
}

export function invalidateFieldDefs(deps: Pick<Deps, "db">, orgId: string) { fieldDefs.invalidate(deps.db, orgId); }
export function invalidateStatuses(deps: Pick<Deps, "db">, orgId: string) { statuses.invalidate(deps.db, orgId); }
/** Test hooks. */
export const readCacheHas = {
  fields: (deps: Pick<Deps, "db">, orgId: string) => fieldDefs.has(deps.db, orgId),
  statuses: (deps: Pick<Deps, "db">, orgId: string) => statuses.has(deps.db, orgId),
};
