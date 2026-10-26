/**
 * R34: old task refs keep working everywhere. A ref (OPS-12) resolves, in order, by the project's key now, by a key
 * the project used before a key edit (project_key_aliases, R33), and by the ref a task had before it MOVED to another
 * project. A moved task's old ref is kept in entity_links as { from_type "task_ref", from_id "OPS-12" } -> task (one
 * row per move, found by the primary key's prefix): the existing link mechanism, no new table.
 *
 * Used by GET /tasks/{ref} (resolveTaskId), bulk edits by refs (loadTasks), search, and the query language (a plain
 * ref, and project:OLDKEY).
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { entityLinks, projectKeyAliases, projects, tasks } from "../../db/schema";
import { chunkIds as chunk } from "../../lib/sql-chunks";

export const TASK_REF_RE = /^([A-Za-z0-9]{1,6})-(\d+)$/;
export const MOVED_REF = "task_ref";

export function parseRef(x: string): { key: string; number: number; ref: string } | null {
  const m = TASK_REF_RE.exec(x.trim());
  return m ? { key: m[1].toUpperCase(), number: Number(m[2]), ref: `${m[1].toUpperCase()}-${m[2]}` } : null;
}

/**
 * Keeps the ref a task leaves behind when it moves to another project. Essential write (one row per move; a move is
 * already a write of the task row), idempotent.
 */
export async function rememberMovedRef(deps: Deps, orgId: string, oldRef: string, taskId: string) {
  await deps.db.insert(entityLinks).values({ orgId, fromType: MOVED_REF, fromId: oldRef.toUpperCase(), toType: "task", toId: taskId, relation: "moved_from", createdAt: deps.now() })
    .onConflictDoNothing();
}

/**
 * Bulk moves: the inserts that keep the old refs of many tasks, for the caller's one batch. One read for the old keys,
 * then one insert per 14 rows (7 values each, under D1's 100).
 */
export async function movedRefStatements(deps: Deps, orgId: string, moved: { taskId: string; projectId: string; number: number }[]): Promise<PromiseLike<unknown>[]> {
  if (!moved.length) return [];
  const ids = [...new Set(moved.map((m) => m.projectId))];
  const keyOf = new Map<string, string>();
  for (const part of chunk(ids, 90)) {
    for (const p of await deps.db.select({ id: projects.id, key: projects.key }).from(projects).where(and(eq(projects.orgId, orgId), inArray(projects.id, part)))) keyOf.set(p.id, p.key.toUpperCase()); // D1: part of chunk(..., 90)
  }
  const now = deps.now();
  const rows = moved.filter((m) => keyOf.get(m.projectId)).map((m) => ({ orgId, fromType: MOVED_REF, fromId: `${keyOf.get(m.projectId)}-${m.number}`, toType: "task", toId: m.taskId, relation: "moved_from", createdAt: now }));
  return chunk(rows, 14).map((part) => deps.db.insert(entityLinks).values(part).onConflictDoNothing());
}

/**
 * Refs to task ids for refs the current keys did not find (a miss path: callers try the plain key first). Two reads
 * per 90 refs at most: aliases, then moved refs (for the ref as typed and for the alias's current key).
 */
export async function resolveOldRefs(deps: Deps, orgId: string, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const parsed = [...new Set(refs.map((r) => parseRef(r)?.ref).filter((r): r is string => !!r))].map((r) => parseRef(r)!);
  if (!parsed.length) return out;
  // 1. A key the project used before (OPS-12 after OPS became OPR).
  const keys = [...new Set(parsed.map((p) => p.key))];
  const aliasOf = new Map<string, { projectId: string; key: string }>();
  for (const part of chunk(keys, 90)) {
    const rows = await deps.db.select({ old: projectKeyAliases.key, projectId: projectKeyAliases.projectId, key: projects.key }).from(projectKeyAliases)
      .innerJoin(projects, eq(projects.id, projectKeyAliases.projectId))
      .where(and(eq(projectKeyAliases.orgId, orgId), inArray(projectKeyAliases.key, part), isNull(projects.deletedAt))); // D1: part of chunk(..., 90)
    for (const r of rows) aliasOf.set(r.old, { projectId: r.projectId, key: r.key.toUpperCase() });
  }
  const byProject = new Map<string, number[]>();
  for (const p of parsed) { const a = aliasOf.get(p.key); if (a) byProject.set(a.projectId, [...(byProject.get(a.projectId) ?? []), p.number]); }
  for (const [projectId, nums] of byProject) {
    for (const part of chunk(nums, 90)) {
      const rows = await deps.db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.projectId, projectId), inArray(tasks.number, part), isNull(tasks.deletedAt))); // D1: part of chunk(..., 90)
      for (const r of rows) for (const p of parsed) if (aliasOf.get(p.key)?.projectId === projectId && p.number === r.number) out.set(p.ref, r.id);
    }
  }
  // 2. The ref a task had before it moved (as typed, or under its project's current key when typed with an old key).
  const left = parsed.filter((p) => !out.has(p.ref));
  const asKept = new Map<string, string>(); // kept ref -> ref as typed
  for (const p of left) {
    asKept.set(p.ref, p.ref);
    const a = aliasOf.get(p.key);
    if (a) asKept.set(`${a.key}-${p.number}`, p.ref);
  }
  for (const part of chunk([...asKept.keys()], 90)) {
    const rows = await deps.db.select({ fromId: entityLinks.fromId, toId: entityLinks.toId }).from(entityLinks).innerJoin(tasks, eq(tasks.id, entityLinks.toId))
      .where(and(eq(entityLinks.fromType, MOVED_REF), inArray(entityLinks.fromId, part), eq(entityLinks.orgId, orgId), isNull(tasks.deletedAt))); // D1: part of chunk(..., 90)
    for (const r of rows) { const typed = asKept.get(r.fromId); if (typed && !out.has(typed)) out.set(typed, r.toId); }
  }
  return out;
}

/** SQL for "this task has the ref": its key now, a key its project used before, or a ref it had before a move. */
export function refCond(orgId: string, ref: string): SQL {
  const p = parseRef(ref)!;
  return sql`((${tasks.number} = ${p.number} and ${tasks.projectId} in (select pr.id from projects pr where pr.org_id = ${orgId} and upper(pr.key) = ${p.key} union all select ka.project_id from project_key_aliases ka where ka.org_id = ${orgId} and ka.key = ${p.key}))
    or ${tasks.id} in (select el.to_id from entity_links el where el.from_type = ${MOVED_REF} and el.from_id = ${p.ref} and el.org_id = ${orgId}))`;
}
