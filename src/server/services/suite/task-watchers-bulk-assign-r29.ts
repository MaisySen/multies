/**
 * R29: a bulk reassign adds the new member assignee as a watcher of each task, the way a single reassign does
 * (task-watchers-r27 autoWatch). One read over the task ids (chunked) tells which tasks already have that person
 * and how many watchers each has; the new rows go in a single batch, 18 rows to an INSERT (5 bound variables a row
 * stays under D1's 100). A task already at WATCHERS_MAX is skipped, like autoWatch. Never throws into the write.
 */
import { sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { taskWatchers } from "../../db/schema";
import { inChunks, inIds } from "../../lib/sql-chunks";
import { WATCHERS_MAX } from "./task-watchers-r27";

/** Rows per INSERT: 5 bound variables a row. */
export const WATCH_ROWS_PER_INSERT = 18;

export async function autoWatchBulk(deps: Deps, orgId: string, taskIds: string[], userId: string | null | undefined): Promise<{ added: number }> {
  try {
    const ids = [...new Set(taskIds)];
    if (!userId || !ids.length) return { added: 0 };
    const counts = await inChunks(ids, (chunk) => deps.db.select({
      taskId: taskWatchers.taskId,
      n: sql<number>`count(*)`,
      has: sql<number>`max(case when ${taskWatchers.userId} = ${userId} then 1 else 0 end)`,
    }).from(taskWatchers).where(inIds(taskWatchers.taskId, chunk)).groupBy(taskWatchers.taskId));
    const byTask = new Map(counts.map((c) => [c.taskId, c]));
    const now = deps.now();
    const values = ids.filter((id) => {
      const c = byTask.get(id);
      return !c || (!Number(c.has) && Number(c.n) < WATCHERS_MAX);
    }).map((taskId) => ({ taskId, userId, orgId, source: "auto" as const, createdAt: now }));
    if (!values.length) return { added: 0 };
    const stmts: PromiseLike<unknown>[] = [];
    for (let i = 0; i < values.length; i += WATCH_ROWS_PER_INSERT) stmts.push(deps.db.insert(taskWatchers).values(values.slice(i, i + WATCH_ROWS_PER_INSERT)).onConflictDoNothing());
    const { runBatch } = await import("../../db");
    await runBatch(deps.db, stmts);
    return { added: values.length };
  } catch (err) {
    deps.reportError?.(err, { where: "autoWatchBulk" });
    return { added: 0 };
  }
}
