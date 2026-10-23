/** In-app notifications for people, mirrored to their phones as push (an event type and an id only). */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { notifications } from "../../db/schema";
import { sortableId } from "./common";
import { pushToUsers } from "./push";

export async function notify(deps: Deps, orgId: string, userId: string, n: { type: string; entityType: string; entityId: string; title: string }) {
  try {
    await deps.db.insert(notifications).values({ id: sortableId("ntf", deps.now().getTime()), orgId, userId, type: n.type, entityType: n.entityType, entityId: n.entityId, title: n.title.slice(0, 300), createdAt: deps.now() });
    await pushToUsers(deps, orgId, [userId], { type: n.type, id: n.entityId });
  } catch (err) {
    deps.reportError?.(err, { where: "notify", type: n.type });
  }
}

export async function listNotifications(deps: Deps, orgId: string, userId: string, opts: { unread?: boolean; limit?: number } = {}) {
  const rows = await deps.db.select().from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), opts.unread ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt)).limit(Math.min(opts.limit ?? 50, 200));
  return rows.map((r) => ({ id: r.id, type: r.type, entityType: r.entityType, entityId: r.entityId, title: r.title, read: !!r.readAt, createdAt: r.createdAt.toISOString() }));
}

export async function markNotificationsRead(deps: Deps, orgId: string, userId: string, ids?: string[]) {
  const rows = await deps.db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), isNull(notifications.readAt)));
  const target = ids ? rows.filter((r) => ids.includes(r.id)) : rows;
  for (const r of target) await deps.db.update(notifications).set({ readAt: deps.now() }).where(eq(notifications.id, r.id));
  return { marked: target.length };
}
