/**
 * The notifications inbox: mentions, assignments, comments, approvals, due-soon items, chat and
 * mail, in one place per person. Each person chooses per category whether it shows in the inbox
 * and whether it buzzes their phone. A push carries only an event type and an id.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { notificationPrefs, notifications } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { sortableId } from "./common";
import { pushToUsers } from "./push";

export const CATEGORIES = ["mention", "assignment", "comment", "approval", "due_soon", "chat", "email", "status"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Which category each notification type belongs to. Unknown types count as status. */
export const TYPE_CATEGORY: Record<string, Category> = {
  "chat.mention": "mention",
  "task.mentioned": "mention",
  "task.assigned": "assignment",
  "thread_assigned": "assignment",
  "task.commented": "comment",
  "chat.reply": "comment",
  "approval.requested": "approval",
  "task.due_soon": "due_soon",
  "chat.dm": "chat",
  "task.email_reply": "email",
  "automation.email": "email",
  "message.received": "email",
  "automation.status": "status",
  "goal.updated": "status",
  "task.recurred": "status",
  "thread_mention": "mention",
};
export const categoryOf = (type: string): Category => TYPE_CATEGORY[type] ?? "status";
const typesOf = (c: Category) => Object.entries(TYPE_CATEGORY).filter(([, v]) => v === c).map(([k]) => k);

export type Prefs = Record<Category, { inApp: boolean; push: boolean }>;
export const DEFAULT_PREFS: Prefs = Object.fromEntries(CATEGORIES.map((c) => [c, { inApp: true, push: c !== "status" && c !== "email" }])) as Prefs;

export async function getPrefs(deps: Deps, orgId: string, userId: string): Promise<Prefs> {
  const row = await deps.db.select({ settings: notificationPrefs.settings }).from(notificationPrefs).where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.orgId, orgId))).get();
  const saved = row ? (JSON.parse(row.settings) as Partial<Prefs>) : {};
  const out = {} as Prefs;
  for (const c of CATEGORIES) out[c] = { ...DEFAULT_PREFS[c], ...(saved[c] ?? {}) };
  return out;
}

export async function setPrefs(deps: Deps, orgId: string, userId: string, patch: Partial<Record<string, { inApp?: boolean; push?: boolean }>>) {
  const cur = await getPrefs(deps, orgId, userId);
  for (const [k, v] of Object.entries(patch)) {
    if (!(CATEGORIES as readonly string[]).includes(k)) throw new HttpError(422, "validation_failed", `Unknown category: ${k}`);
    cur[k as Category] = { ...cur[k as Category], ...(v ?? {}) };
  }
  const now = deps.now();
  await deps.db.insert(notificationPrefs).values({ userId, orgId, settings: JSON.stringify(cur), updatedAt: now })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.orgId], set: { settings: JSON.stringify(cur), updatedAt: now } });
  return cur;
}

export async function notify(deps: Deps, orgId: string, userId: string, n: { type: string; entityType: string; entityId: string; title: string; actorName?: string | null }) {
  try {
    const prefs = await getPrefs(deps, orgId, userId);
    const p = prefs[categoryOf(n.type)];
    if (p.inApp) {
      await deps.db.insert(notifications).values({ id: sortableId("ntf", deps.now().getTime()), orgId, userId, type: n.type, entityType: n.entityType, entityId: n.entityId, title: n.title.slice(0, 300), actorName: n.actorName?.slice(0, 120) ?? null, createdAt: deps.now() });
    }
    if (p.push) await pushToUsers(deps, orgId, [userId], { type: n.type, id: n.entityId });
  } catch (err) {
    deps.reportError?.(err, { where: "notify", type: n.type });
  }
}

/** The web path a notification opens. Phones route by entity type and id instead. */
export function linkFor(n: { entityType: string; entityId: string; type: string }, chatChannelId?: string | null) {
  switch (n.entityType) {
    case "task": return `/app/tasks?task=${encodeURIComponent(n.entityId)}`;
    case "chat_message": return chatChannelId ? `/app/chat/${encodeURIComponent(chatChannelId)}?m=${encodeURIComponent(n.entityId)}` : "/app/chat";
    case "approval": return "/app/approvals";
    case "message": return `/app/mail?m=${encodeURIComponent(n.entityId)}`;
    case "thread": return `/app/inbox?thread=${encodeURIComponent(n.entityId)}`;
    case "goal": return `/app/goals?goal=${encodeURIComponent(n.entityId)}`;
    case "meeting": return `/app/meetings/${encodeURIComponent(n.entityId)}`;
    default: return "/app/notifications";
  }
}

export async function listNotifications(deps: Deps, orgId: string, userId: string, opts: { unread?: boolean; limit?: number; category?: string; before?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let typeFilter;
  if (opts.category && opts.category !== "all") {
    if (!(CATEGORIES as readonly string[]).includes(opts.category)) throw new HttpError(422, "validation_failed", `Unknown category: ${opts.category}`);
    const c = opts.category as Category;
    // "status" also holds every type not listed anywhere else.
    typeFilter = c === "status" ? sql`${notifications.type} not in (${sql.join(Object.keys(TYPE_CATEGORY).filter((t) => TYPE_CATEGORY[t] !== "status").map((t) => sql`${t}`), sql`, `)})` : inArray(notifications.type, typesOf(c));
  }
  const base = and(eq(notifications.orgId, orgId), eq(notifications.userId, userId));
  const rows = await deps.db.select().from(notifications)
    .where(and(base, opts.unread ? isNull(notifications.readAt) : undefined, typeFilter, opts.before ? lt(notifications.id, opts.before) : undefined))
    .orderBy(desc(notifications.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const unreadRows = await deps.db.select({ type: notifications.type, n: sql<number>`count(*)` }).from(notifications).where(and(base, isNull(notifications.readAt))).groupBy(notifications.type);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let unread = 0;
  for (const r of unreadRows) { counts[categoryOf(r.type)] += Number(r.n); unread += Number(r.n); }
  // Chat links need the channel: one query for the page.
  const chatIds = page.filter((r) => r.entityType === "chat_message").map((r) => r.entityId);
  const channelOf = new Map<string, string>();
  if (chatIds.length) {
    const { chatMessages } = await import("../../db/schema");
    for (const m of await deps.db.select({ id: chatMessages.id, channelId: chatMessages.channelId }).from(chatMessages).where(inArray(chatMessages.id, chatIds))) channelOf.set(m.id, m.channelId);
  }
  return {
    notifications: page.map((r) => ({
      id: r.id, type: r.type, category: categoryOf(r.type), entityType: r.entityType, entityId: r.entityId, title: r.title,
      actor: r.actorName ? { type: "member", id: null, name: r.actorName } : null, read: !!r.readAt, createdAt: r.createdAt.toISOString(),
      link: linkFor(r, channelOf.get(r.entityId)),
    })),
    unread, counts, hasMore: rows.length > limit,
  };
}

export async function markNotificationsRead(deps: Deps, orgId: string, userId: string, ids?: string[], category?: string) {
  const now = deps.now();
  let filter;
  if (ids) filter = inArray(notifications.id, ids.length ? ids : ["-"]);
  else if (category && category !== "all") {
    if (!(CATEGORIES as readonly string[]).includes(category)) throw new HttpError(422, "validation_failed", `Unknown category: ${category}`);
    filter = inArray(notifications.type, typesOf(category as Category).length ? typesOf(category as Category) : ["-"]);
  }
  const res = await deps.db.update(notifications).set({ readAt: now })
    .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), isNull(notifications.readAt), filter))
    .returning({ id: notifications.id });
  return { ok: true, updated: res.length, marked: res.length };
}

export async function markNotificationUnread(deps: Deps, orgId: string, userId: string, id: string) {
  const res = await deps.db.update(notifications).set({ readAt: null }).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), eq(notifications.id, id))).returning({ id: notifications.id });
  if (!res.length) throw new HttpError(404, "not_found", "Notification not found.");
  return { ok: true };
}
