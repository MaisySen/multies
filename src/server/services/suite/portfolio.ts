/**
 * The portfolio: every project in one table with its owner, progress, overdue count, time
 * logged, next due date and a health flag set by hand. Four grouped queries, whatever the
 * number of projects.
 */
import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { projects, tasks, timeEntries, users } from "../../db/schema";
import { iso } from "./common";

export type Health = "on_track" | "at_risk" | "off_track";

export async function portfolio(deps: Deps, orgId: string, opts: { includeArchived?: boolean } = {}) {
  const now = deps.now();
  const [ps, counts, time, next] = await Promise.all([
    deps.db.select({ p: projects, ownerName: users.name, ownerEmail: users.email }).from(projects).leftJoin(users, eq(users.id, projects.ownerUserId))
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), opts.includeArchived ? undefined : isNull(projects.archivedAt)))
      .orderBy(asc(projects.createdAt)),
    deps.db.select({
      projectId: tasks.projectId,
      total: sql<number>`count(*)`,
      done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
      overdue: sql<number>`sum(case when ${tasks.status} <> 'done' and ${tasks.dueAt} is not null and ${tasks.dueAt} < ${now.getTime()} then 1 else 0 end)`,
    }).from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.parentId))).groupBy(tasks.projectId),
    deps.db.select({ projectId: timeEntries.projectId, seconds: sql<number>`sum(${timeEntries.seconds})` }).from(timeEntries)
      .where(and(eq(timeEntries.orgId, orgId), isNull(timeEntries.deletedAt), isNotNull(timeEntries.projectId))).groupBy(timeEntries.projectId),
    // The earliest open task due from now on, per project (one row per project via a window).
    deps.db.all<{ project_id: string; id: string; number: number; title: string; due_at: number }>(sql`
      select project_id, id, number, title, due_at from (
        select project_id, id, number, title, due_at, row_number() over (partition by project_id order by due_at asc) as rn
        from tasks where org_id = ${orgId} and deleted_at is null and status <> 'done' and due_at is not null and due_at >= ${now.getTime()}
      ) where rn = 1`),
  ]);
  const c = new Map(counts.map((r) => [r.projectId, r]));
  const t = new Map(time.map((r) => [r.projectId!, Number(r.seconds ?? 0)]));
  const n = new Map((next as { project_id: string; id: string; number: number; title: string; due_at: number }[]).map((r) => [r.project_id, r]));
  return ps.map(({ p, ownerName, ownerEmail }) => {
    const k = c.get(p.id);
    const total = Number(k?.total ?? 0), done = Number(k?.done ?? 0);
    const nd = n.get(p.id);
    return {
      id: p.id, name: p.name, key: p.key, color: p.color, archived: !!p.archivedAt,
      owner: p.ownerUserId ? { id: p.ownerUserId, name: ownerName || ownerEmail || "Former member" } : null,
      health: (p.health ?? null) as Health | null, healthNote: p.healthNote,
      progress: total ? Math.round((done / total) * 100) : 0, total, done, overdue: Number(k?.overdue ?? 0),
      timeLoggedSeconds: t.get(p.id) ?? 0,
      nextDue: nd ? iso(new Date(Number(nd.due_at))) : null,
      nextDueTask: nd ? { id: nd.id, ref: `${p.key}-${nd.number}`, title: nd.title } : null,
    };
  });
}
export type PortfolioRow = Awaited<ReturnType<typeof portfolio>>[number];
