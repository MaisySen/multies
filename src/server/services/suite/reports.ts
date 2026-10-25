/**
 * Reports: counts and sums computed in the database (GROUP BY), so a dashboard is a handful
 * of queries sent together, whatever the size of the workspace. Money is AUD, ex GST.
 */
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, deals, projectStatuses, projects, tasks, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { DEAL_STAGES } from "./contacts";
import { secondsByProject } from "./time";

const DAY = 86_400_000;

export interface ReportQuery { projectId?: string; days?: number }

export async function dashboard(deps: Deps, actor: SuiteActor, q: ReportQuery = {}) {
  const days = Math.round(q.days ?? 30);
  if (days < 1 || days > 366) throw new HttpError(422, "validation_failed", "Pick between 1 and 366 days.");
  const now = deps.now();
  const from = new Date(now.getTime() - days * DAY);
  const org = actor.orgId;
  const base = and(eq(tasks.orgId, org), isNull(tasks.deletedAt), isNull(tasks.parentId), q.projectId ? eq(tasks.projectId, q.projectId) : undefined);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [byStatus, byAssignee, overdueRows, doneByDay, createdCount, dealRows, secs, prs] = await Promise.all([
    deps.db.select({ statusId: tasks.statusId, category: tasks.status, n: sql<number>`count(*)` }).from(tasks).where(base).groupBy(tasks.statusId, tasks.status),
    deps.db.select({ type: tasks.assigneeType, id: tasks.assigneeId, n: sql<number>`count(*)`, overdue: sql<number>`sum(case when ${tasks.dueAt} < ${todayStart.getTime()} then 1 else 0 end)` })
      .from(tasks).where(and(base, ne(tasks.status, "done"))).groupBy(tasks.assigneeType, tasks.assigneeId),
    deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, dueAt: tasks.dueAt, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId, priority: tasks.priority })
      .from(tasks).where(and(base, ne(tasks.status, "done"), lt(tasks.dueAt, todayStart))).orderBy(tasks.dueAt).limit(20),
    deps.db.select({ day: sql<string>`strftime('%Y-%m-%d', ${tasks.completedAt} / 1000, 'unixepoch')`, n: sql<number>`count(*)` })
      .from(tasks).where(and(base, eq(tasks.status, "done"), gte(tasks.completedAt, from))).groupBy(sql`1`),
    deps.db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(base, gte(tasks.createdAt, from))).get(),
    deps.db.select({ stage: deals.stage, n: sql<number>`count(*)`, cents: sql<number>`sum(${deals.valueCents})` }).from(deals).where(and(eq(deals.orgId, org), isNull(deals.deletedAt))).groupBy(deals.stage),
    secondsByProject(deps, org, from, now),
    deps.db.select({ id: projects.id, name: projects.name, key: projects.key, color: projects.color }).from(projects).where(and(eq(projects.orgId, org), isNull(projects.deletedAt))),
  ]);
  const statusIds = [...new Set(byStatus.map((s) => s.statusId))];
  const memberIds = [...new Set([...byAssignee.filter((r) => r.type === "member").map((r) => r.id), ...overdueRows.filter((r) => r.assigneeType === "member").map((r) => r.assigneeId)].filter(Boolean) as string[])];
  const agentIds = [...new Set([...byAssignee.filter((r) => r.type === "agent").map((r) => r.id), ...overdueRows.filter((r) => r.assigneeType === "agent").map((r) => r.assigneeId)].filter(Boolean) as string[])];
  const [sts, us, ags] = await Promise.all([
    statusIds.length ? deps.db.select().from(projectStatuses).where(inArray(projectStatuses.id, statusIds)) : [],
    memberIds.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, memberIds)) : [],
    agentIds.length ? deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  const sm = new Map(sts.map((s) => [s.id, s])), um = new Map(us.map((u) => [u.id, u])), am = new Map(ags.map((a) => [a.id, a])), pm = new Map(prs.map((p) => [p.id, p]));
  const nameOf = (type: string | null, id: string | null) => !type || !id ? "Unassigned" : type === "member" ? (um.get(id)?.name || um.get(id)?.email || "Former member") : (am.get(id)?.name ?? "Removed agent");

  // Statuses with the same name across projects are added together.
  const statusMap = new Map<string, { name: string; category: string; color: string; count: number }>();
  for (const s of byStatus) {
    const st = sm.get(s.statusId);
    const key = `${st?.name ?? s.category}|${s.category}`;
    const cur = statusMap.get(key) ?? { name: st?.name ?? s.category, category: s.category, color: st?.color ?? "#8a8f98", count: 0 };
    cur.count += Number(s.n);
    statusMap.set(key, cur);
  }
  const order = { todo: 0, doing: 1, done: 2 } as Record<string, number>;
  const statuses = [...statusMap.values()].sort((a, b) => order[a.category] - order[b.category] || b.count - a.count);
  const totals = { todo: 0, doing: 0, done: 0 } as Record<string, number>;
  for (const s of byStatus) totals[s.category] += Number(s.n);

  const completed: { day: string; count: number }[] = [];
  const doneMap = new Map(doneByDay.map((d) => [d.day, Number(d.n)]));
  for (let i = Math.min(days, 60) - 1; i >= 0; i--) { const d = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10); completed.push({ day: d, count: doneMap.get(d) ?? 0 }); }

  const stageRows = new Map(dealRows.map((d) => [d.stage, d]));
  const pipeline = DEAL_STAGES.map((s) => ({ stage: s.id, name: s.name, count: Number(stageRows.get(s.id as never)?.n ?? 0), value: Number(stageRows.get(s.id as never)?.cents ?? 0) / 100 }));
  const open = pipeline.filter((p) => p.stage !== "won" && p.stage !== "lost");

  const timeRows = [...secs.entries()].map(([pid, seconds]) => ({ projectId: pid || null, name: pid ? (pm.get(pid)?.name ?? "Deleted project") : "No project", color: pid ? (pm.get(pid)?.color ?? "#8a8f98") : "#8a8f98", seconds }))
    .filter((r) => !q.projectId || r.projectId === q.projectId).sort((a, b) => b.seconds - a.seconds);

  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    tasks: {
      total: totals.todo + totals.doing + totals.done, open: totals.todo + totals.doing, done: totals.done,
      overdue: byAssignee.reduce((s, r) => s + Number(r.overdue ?? 0), 0), createdInRange: Number(createdCount?.n ?? 0),
      completedInRange: completed.reduce((s, c) => s + c.count, 0),
      byCategory: totals, byStatus: statuses,
      byAssignee: byAssignee.map((r) => ({ assigneeId: r.type && r.id ? `${r.type}:${r.id}` : null, name: nameOf(r.type, r.id), open: Number(r.n), overdue: Number(r.overdue ?? 0) })).sort((a, b) => b.open - a.open),
      overdueList: overdueRows.map((t) => ({ id: t.id, ref: `${pm.get(t.projectId)?.key ?? "TSK"}-${t.number}`, title: t.title, due: t.dueAt?.toISOString() ?? null, assignee: t.assigneeId ? nameOf(t.assigneeType, t.assigneeId) : null, priority: t.priority })),
      completedByDay: completed,
    },
    time: { totalSeconds: timeRows.reduce((s, r) => s + r.seconds, 0), byProject: timeRows },
    deals: { currency: "AUD" as const, pipeline, openValue: open.reduce((s, p) => s + p.value, 0), openCount: open.reduce((s, p) => s + p.count, 0), wonValue: pipeline.find((p) => p.stage === "won")?.value ?? 0 },
  };
}
