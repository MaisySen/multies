/**
 * R33 (D1 write budget): the task number claim, off the projects row.
 * `UPDATE projects SET next_number = next_number + n` rewrote the wide projects row and its index entries (3 rows
 * written per claim). One UPSERT on the narrow project_counters table (WITHOUT ROWID, no other index) writes 1 row.
 * Essential write (a task needs its number). The first claim in a project seeds the counter from
 * projects.next_number, so projects created before or after migration 0073 number on from where they were.
 */
import { eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { projectCounters, projects } from "../../db/schema";

/** Claims `n` consecutive task numbers in a project and answers the first. */
export async function claimNumbers(deps: Deps, projectId: string, n = 1): Promise<number> {
  const rows = await deps.db.insert(projectCounters)
    .values({ projectId, nextNumber: sql`coalesce((select ${projects.nextNumber} from ${projects} where ${projects.id} = ${projectId}), 1) + ${n}` })
    .onConflictDoUpdate({ target: projectCounters.projectId, set: { nextNumber: sql`${projectCounters.nextNumber} + ${n}` } })
    .returning({ next: projectCounters.nextNumber });
  return Number(rows[0].next) - n;
}

/** The number the next claim would get, without claiming it (reads only). */
export async function peekNextNumber(deps: Deps, projectId: string): Promise<number> {
  const c = await deps.db.select({ n: projectCounters.nextNumber }).from(projectCounters).where(eq(projectCounters.projectId, projectId)).get();
  if (c) return Number(c.n);
  const p = await deps.db.select({ n: projects.nextNumber }).from(projects).where(eq(projects.id, projectId)).get();
  return Number(p?.n ?? 1);
}
