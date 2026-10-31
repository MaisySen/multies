/**
 * R28: watchers hear about bulk status changes too (R27 told them only about one task at a time). A bulk move from
 * the web bulk bar, POST /api/v1/tasks/bulk or the bulk MCP tool gives each watcher of each moved task the same
 * "task.watch_status" notification a single move gives (not the person who made the change, one per watcher per
 * task, only current members, under each person's own notification settings).
 *
 * Cost on D1: every read goes over id lists with inChunks/inIds (one variable per list past 20 ids) and the rows
 * are inserted 9 to a statement (10 bound variables a row) in one batch. A phone push (when the person turned it on
 * for status changes) is one per watcher per bulk call, for the first task they watch, not one per task. A bulk call
 * that would write more than BULK_WATCH_ROWS_MAX rows gives each watcher one summary row instead ("12 tasks you
 * watch moved to Done"), so one click can't spend the workspace's daily write budget. Never throws into the write.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { members, notificationPrefs, notifications, taskWatchers } from "../../db/schema";
import { inChunks, inIds } from "../../lib/sql-chunks";
import { sortableId } from "./common";
import { categoryOf, DEFAULT_PREFS, type Prefs } from "./notify";

/** Past this many rows in one bulk call, each watcher gets one summary row. */
export const BULK_WATCH_ROWS_MAX = 2000;
/** Rows per INSERT: 10 bound variables a row stays under D1's 100. */
const ROWS_PER_INSERT = 9;

export interface MovedTask { taskId: string; title: string }

export async function notifyWatchersBulk(deps: Deps, orgId: string, moved: MovedTask[], n: { actorName?: string | null; statusName?: string | null }, skip: (string | null | undefined)[], opts: { max?: number } = {}): Promise<{ rows: number; summary: boolean }> {
  const type = "task.watch_status";
  try {
    if (!moved.length) return { rows: 0, summary: false };
    const order = new Map(moved.map((m, i) => [m.taskId, i]));
    const watchRows = await inChunks(moved.map((m) => m.taskId), (chunk) => deps.db.select({ taskId: taskWatchers.taskId, userId: taskWatchers.userId }).from(taskWatchers)
      .where(inIds(taskWatchers.taskId, chunk)));
    const skipSet = new Set(skip.filter(Boolean));
    const byUser = new Map<string, string[]>();
    for (const r of watchRows) {
      if (skipSet.has(r.userId)) continue;
      byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.taskId]);
    }
    if (!byUser.size) return { rows: 0, summary: false };
    // Only current members of this workspace hear about it.
    const userIds = [...byUser.keys()];
    const current = new Set((await inChunks(userIds, (chunk) => deps.db.select({ u: members.userId }).from(members)
      .where(and(eq(members.organizationId, orgId), inIds(members.userId, chunk))))).map((m) => m.u));
    for (const u of userIds) if (!current.has(u)) byUser.delete(u);
    if (!byUser.size) return { rows: 0, summary: false };
    // Each person's settings for the status category, read once for everyone.
    const saved = await inChunks([...byUser.keys()], (chunk) => deps.db.select({ userId: notificationPrefs.userId, settings: notificationPrefs.settings }).from(notificationPrefs)
      .where(and(eq(notificationPrefs.orgId, orgId), inIds(notificationPrefs.userId, chunk))));
    const savedBy = new Map(saved.map((s) => [s.userId, (JSON.parse(s.settings) as Partial<Prefs>)[categoryOf(type)] ?? {}]));
    const prefOf = (u: string) => ({ ...DEFAULT_PREFS[categoryOf(type)], ...savedBy.get(u) });

    const title = new Map(moved.map((m) => [m.taskId, m.title]));
    const now = deps.now();
    const inbox = [...byUser.entries()].filter(([u]) => prefOf(u).inApp);
    const total = inbox.reduce((sum, [, ids]) => sum + ids.length, 0);
    const summary = total > (opts.max ?? BULK_WATCH_ROWS_MAX);
    const values: (typeof notifications.$inferInsert)[] = [];
    for (const [userId, ids] of inbox) {
      const sorted = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const base = { orgId, userId, type, entityType: "task", actorName: n.actorName?.slice(0, 120) ?? null, createdAt: now };
      if (summary && sorted.length > 1) {
        values.push({ ...base, id: sortableId("ntf", now.getTime()), entityId: sorted[0], title: `${sorted.length} tasks you watch moved${n.statusName ? ` to ${n.statusName}` : ""}`.slice(0, 300) });
      } else {
        for (const taskId of sorted) values.push({ ...base, id: sortableId("ntf", now.getTime()), entityId: taskId, title: (title.get(taskId) ?? "").slice(0, 300) });
      }
    }
    if (values.length) {
      const stmts: PromiseLike<unknown>[] = [];
      for (let i = 0; i < values.length; i += ROWS_PER_INSERT) stmts.push(deps.db.insert(notifications).values(values.slice(i, i + ROWS_PER_INSERT)));
      const { runBatch } = await import("../../db");
      await runBatch(deps.db, stmts);
    }
    // Phones: one buzz per watcher for this bulk call, for the first task they watch.
    // R97 one place: pause and quiet hours hold these alerts too (same check as every other sender).
    const { alertRecipients } = await import("./notify");
    const allowed = new Set(await alertRecipients(deps, orgId, [...byUser.keys()].filter((u) => prefOf(u).push), type));
    const pushers = [...byUser.entries()].filter(([u]) => allowed.has(u));
    if (pushers.length) {
      const { pushToUsers } = await import("./push");
      const firstOf = new Map<string, string[]>();
      for (const [u, ids] of pushers) {
        const first = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
        firstOf.set(first, [...(firstOf.get(first) ?? []), u]);
      }
      for (const [taskId, users] of firstOf) await pushToUsers(deps, orgId, users, { type, id: taskId });
    }
    return { rows: values.length, summary };
  } catch (err) {
    deps.reportError?.(err, { where: "notifyWatchersBulk" });
    return { rows: 0, summary: false };
  }
}
