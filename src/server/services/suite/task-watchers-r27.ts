/**
 * R27 (teardown): watchers on a task, the "Watch" button every rival has (Jira watchers, Asana followers, ClickUp
 * watchers, monday.com subscribers). A watcher hears about new comments (category "comment") and status changes
 * (category "status") on the task in their notifications inbox, under their own notification settings.
 *
 * Who watches: the person who creates a task, the member it is assigned to and anyone who comments start watching on
 * their own (source "auto"). Anyone in the workspace can watch or stop watching a task, and can add or remove another
 * member (source "manual"). Stopping is remembered only as the missing row: commenting again starts watching again,
 * as in Jira and Asana. Agent keys act as their agent and name the member they add or remove.
 *
 * Storage: task_watchers, WITHOUT ROWID, keyed (task_id, user_id) and no other index: one watch or unwatch writes
 * one row, and creating a task costs one more row (the creator's watch). q=is:watching reads by that key.
 * Name lookups over watcher ids go through inChunks (D1's 100-variable limit).
 * The same service backs the app routes (task-teardown-r27.ts), REST (v1-r27-teardown.ts) and MCP (mcp-r27-teardown.ts).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { members, taskWatchers, tasks, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inChunks } from "../../lib/sql-chunks";
import { assertWritable, recordWrite, type SuiteActor } from "./common";
import { resolveTaskId } from "./tasks";

/** A task's watcher list stops growing here; auto watching quietly skips past it. */
export const WATCHERS_MAX = 200;

export interface Watcher { userId: string; name: string; email: string | null; source: "manual" | "auto"; since: string }

const bad = (message: string) => new HttpError(422, "validation_failed", message);

async function taskFor(deps: Deps, a: SuiteActor, idOrRef: string) {
  const id = await resolveTaskId(deps, a.orgId, idOrRef);
  const t = await deps.db.select({ id: tasks.id, title: tasks.title, version: tasks.version }).from(tasks)
    .where(and(eq(tasks.orgId, a.orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound("Task");
  return t;
}

/** The member a watch or unwatch is for: the given id ("me" is the caller), else the caller. */
async function memberFor(deps: Deps, a: SuiteActor, userId?: string | null) {
  const want = !userId || userId === "me" ? null : userId.replace(/^member:/, "");
  if (!want) {
    if (a.agentId || a.system || !a.userId) throw bad("An agent or system key names the member: userId.");
    return a.userId;
  }
  const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, want))).get();
  if (!m) throw new HttpError(422, "invalid_member", "That person isn't a member of this workspace.");
  return want;
}

async function watcherRows(deps: Deps, taskId: string) {
  return deps.db.select().from(taskWatchers).where(eq(taskWatchers.taskId, taskId)).orderBy(asc(taskWatchers.createdAt));
}

async function present(deps: Deps, orgId: string, rows: (typeof taskWatchers.$inferSelect)[]): Promise<Watcher[]> {
  const ids = rows.map((r) => r.userId);
  const people = await inChunks(ids, (chunk) => deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users)
    .innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, orgId))).where(inArray(users.id, chunk))); // D1: chunk of 90 from inChunks
  const byId = new Map(people.map((p) => [p.id, p]));
  // A person who left the workspace drops off the list (their row stays until the task goes).
  return rows.filter((r) => byId.has(r.userId)).map((r) => ({
    userId: r.userId, name: byId.get(r.userId)!.name, email: byId.get(r.userId)!.email ?? null, source: r.source, since: r.createdAt.toISOString(),
  }));
}

/** Who watches a task, and whether the caller does. */
export async function listWatchers(deps: Deps, a: SuiteActor, taskIdOrRef: string) {
  const t = await taskFor(deps, a, taskIdOrRef);
  const watchers = await present(deps, a.orgId, await watcherRows(deps, t.id));
  return { taskId: t.id, watching: !!a.userId && !a.agentId && watchers.some((w) => w.userId === a.userId), count: watchers.length, watchers };
}

/** Starts watching (the caller, or `userId`). Watching twice changes nothing. */
export async function watchTask(deps: Deps, a: SuiteActor, taskIdOrRef: string, userId?: string | null) {
  assertWritable(a);
  const t = await taskFor(deps, a, taskIdOrRef);
  const who = await memberFor(deps, a, userId);
  const rows = await watcherRows(deps, t.id);
  if (!rows.some((r) => r.userId === who)) {
    if (rows.length >= WATCHERS_MAX) throw bad(`A task has at most ${WATCHERS_MAX} watchers.`);
    await deps.db.insert(taskWatchers).values({ taskId: t.id, userId: who, orgId: a.orgId, source: "manual", createdAt: deps.now() }).onConflictDoNothing();
    await recordWrite(deps, a, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "task.watch_added", data: { userId: who } });
  }
  return listWatchers(deps, a, t.id);
}

/** Stops watching (the caller, or `userId`). Not watching is fine. */
export async function unwatchTask(deps: Deps, a: SuiteActor, taskIdOrRef: string, userId?: string | null) {
  assertWritable(a);
  const t = await taskFor(deps, a, taskIdOrRef);
  const who = await memberFor(deps, a, userId);
  const gone = await deps.db.delete(taskWatchers).where(and(eq(taskWatchers.taskId, t.id), eq(taskWatchers.userId, who))).returning({ userId: taskWatchers.userId });
  if (gone.length) await recordWrite(deps, a, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "task.watch_removed", data: { userId: who } });
  return listWatchers(deps, a, t.id);
}

/**
 * Adds people as automatic watchers (creator, assignee, commenter). Members only: agent and system actors are skipped
 * by the callers. Never throws into the caller's write.
 */
export async function autoWatch(deps: Deps, orgId: string, taskId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  if (!ids.length) return;
  try {
    const rows = await watcherRows(deps, taskId);
    const have = new Set(rows.map((r) => r.userId));
    let room = WATCHERS_MAX - rows.length;
    const now = deps.now();
    for (const u of ids) {
      if (have.has(u) || room <= 0) continue;
      await deps.db.insert(taskWatchers).values({ taskId, userId: u, orgId, source: "auto", createdAt: now }).onConflictDoNothing();
      room--;
    }
  } catch (err) {
    deps.reportError?.(err, { where: "autoWatch" });
  }
}

/** The member behind an actor, for auto watching: null for agents and automations. */
export const memberOf = (a: SuiteActor) => (a.agentId || a.system ? null : a.userId || null);

/**
 * Tells a task's watchers about a change, except the people in `skip` (the actor, and anyone already told by a
 * mention or an assignment). Never throws into the caller's write.
 */
export async function notifyWatchers(deps: Deps, orgId: string, taskId: string, n: { type: "task.watch_comment" | "task.watch_status"; title: string; actorName?: string | null }, skip: (string | null | undefined)[]) {
  try {
    const rows = await watcherRows(deps, taskId);
    const skipSet = new Set(skip.filter(Boolean));
    const targets = rows.map((r) => r.userId).filter((u) => !skipSet.has(u));
    if (!targets.length) return;
    // Only current members hear about it.
    const current = new Set((await inChunks(targets, (chunk) => deps.db.select({ u: members.userId }).from(members)
      .where(and(eq(members.organizationId, orgId), inArray(members.userId, chunk))))).map((m) => m.u)); // D1: chunk of 90 from inChunks
    const { notify } = await import("./notify");
    for (const u of targets) if (current.has(u)) await notify(deps, orgId, u, { type: n.type, entityType: "task", entityId: taskId, title: n.title, actorName: n.actorName ?? null });
  } catch (err) {
    deps.reportError?.(err, { where: "notifyWatchers" });
  }
}
