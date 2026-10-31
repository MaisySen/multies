/**
 * The notifications inbox: mentions, assignments, comments, approvals, due-soon items, chat and
 * mail, in one place per person. Each person chooses per category whether it shows in the inbox
 * and whether it buzzes their phone. A push carries only an event type and an id.
 */
import { and, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { notificationPrefs, notifications, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { sortableId } from "./common";
import { pushToUsers } from "./push";
import { inChunks, inIds } from "../../lib/sql-chunks";
import { alertAllowed, applyDeliveryPatch, nextDigestAt, readDelivery, type Delivery, type DeliveryPatch } from "../../../shared/notification-centre"; // R97
import { deferrableWrite } from "../write-priority";
import { inboxWhere, VIEW_ORDER, viewCountsFor, viewWhere, type TriageView } from "./notify-triage"; // R31 triage

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
  "call.started": "chat",
  "task.email_reply": "email",
  "automation.email": "email",
  "message.received": "email",
  "automation.status": "status",
  "goal.updated": "status",
  "task.recurred": "status",
  "thread_mention": "mention",
  "task.watch_comment": "comment", // R27: watchers
  "task.watch_status": "status", // R27: watchers
};
export const categoryOf = (type: string): Category => TYPE_CATEGORY[type] ?? "status";
const typesOf = (c: Category) => Object.entries(TYPE_CATEGORY).filter(([, v]) => v === c).map(([k]) => k);

export type ChannelPrefs = { inApp: boolean; push: boolean; /** R97: mail (as it happens or in the digest). Off by default. */ mail: boolean };
export type Prefs = Record<Category, ChannelPrefs>;
export const DEFAULT_PREFS: Prefs = Object.fromEntries(CATEGORIES.map((c) => [c, { inApp: true, push: c !== "status" && c !== "email", mail: false }])) as Prefs;

/** Saved settings JSON merged over the defaults. */
export function mergePrefs(raw: string | null | undefined): Prefs {
  let saved: Partial<Prefs> = {};
  try { saved = raw ? (JSON.parse(raw) as Partial<Prefs>) : {}; } catch { /* a broken row reads as defaults */ }
  const out = {} as Prefs;
  for (const c of CATEGORIES) out[c] = { ...DEFAULT_PREFS[c], ...(saved[c] ?? {}) };
  return out;
}

async function prefRow(deps: Deps, orgId: string, userId: string) {
  return deps.db.select({ settings: notificationPrefs.settings, delivery: notificationPrefs.delivery }).from(notificationPrefs)
    .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.orgId, orgId))).get();
}

export async function getPrefs(deps: Deps, orgId: string, userId: string): Promise<Prefs> {
  return mergePrefs((await prefRow(deps, orgId, userId))?.settings);
}

const centreOn = (deps: Deps) => deps.config.notificationCentre !== false;

export async function setPrefs(deps: Deps, orgId: string, userId: string, patch: Partial<Record<string, { inApp?: boolean; push?: boolean; mail?: boolean }>>) {
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

/** R97: the person's delivery settings (time zone, quiet hours, digest, pause), filled from their profile zone. */
export async function getDelivery(deps: Deps, orgId: string, userId: string): Promise<Delivery> {
  const [row, user] = await Promise.all([
    prefRow(deps, orgId, userId),
    deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)).get(),
  ]);
  return readDelivery(row?.delivery, user?.tz);
}

/** R97: saves a delivery patch and moves the digest clock to the next digest moment in the person's zone. */
export async function setDelivery(deps: Deps, orgId: string, userId: string, patch: DeliveryPatch): Promise<Delivery> {
  const now = deps.now();
  const next = applyDeliveryPatch(await getDelivery(deps, orgId, userId), patch, now);
  const due = nextDigestAt(now, next);
  const json = JSON.stringify(next);
  // The first digest lists items from now on, not the whole history.
  await deps.db.insert(notificationPrefs).values({ userId, orgId, settings: "{}", delivery: json, digestDueAt: due, digestLastAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.orgId], set: { delivery: json, digestDueAt: due, updatedAt: now } });
  return next;
}

/** R97: what one person's settings say for one event right now. */
export function decide(prefs: Prefs, delivery: Delivery | null, category: Category, now: Date) {
  const p = prefs[category];
  const alertOk = !delivery || alertAllowed(now, delivery, category);
  const digestOn = !!delivery && delivery.digest.frequency !== "off";
  return { inApp: p.inApp, push: p.push && alertOk, mailNow: !!delivery && p.mail && !digestOn && alertOk };
}

/**
 * R97 one place: who of these people should get a phone or browser alert for this event type now. New mail follows
 * the person's New mail switch (on unless they turned it off); other types follow the category's Phone switch.
 * A pause and quiet hours hold every alert. People with nothing saved keep the alert. One bounded read.
 */
export async function alertRecipients(deps: Deps, orgId: string, userIds: string[], type: string): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (!ids.length || !centreOn(deps)) return ids;
  const cat = categoryOf(type);
  const rows = await inChunks(ids, (chunk) => deps.db.select({ userId: notificationPrefs.userId, settings: notificationPrefs.settings, delivery: notificationPrefs.delivery })
    .from(notificationPrefs).where(and(eq(notificationPrefs.orgId, orgId), inIds(notificationPrefs.userId, chunk))));
  const by = new Map(rows.map((r) => [r.userId, r]));
  const now = deps.now();
  return ids.filter((u) => {
    const r = by.get(u);
    if (!r) return true;
    const d = readDelivery(r.delivery);
    const on = type === "message.received" ? d.newMail : mergePrefs(r.settings)[cat].push;
    return on && alertAllowed(now, d, cat);
  });
}

export async function notify(deps: Deps, orgId: string, userId: string, n: { type: string; entityType: string; entityId: string; title: string; actorName?: string | null; pushMessageId?: string | null }) {
  try {
    const row = await prefRow(deps, orgId, userId);
    const cat = categoryOf(n.type);
    const now = deps.now();
    const d = decide(mergePrefs(row?.settings), centreOn(deps) ? readDelivery(row?.delivery) : null, cat, now);
    if (d.inApp) {
      await deps.db.insert(notifications).values({ id: sortableId("ntf", now.getTime()), orgId, userId, type: n.type, entityType: n.entityType, entityId: n.entityId, title: n.title.slice(0, 300), actorName: n.actorName?.slice(0, 120) ?? null, createdAt: now });
    }
    if (d.push) await pushToUsers(deps, orgId, [userId], n.pushMessageId ? { type: n.type, id: n.entityId, mid: n.pushMessageId, title: n.title } : { type: n.type, id: n.entityId, title: n.title });
    // R97: mail as it happens goes through the job queue, so the caller never waits on rendering or the provider.
    if (d.mailNow) {
      const { enqueue } = await import("../jobs");
      await enqueue(deps, "notify.mail", { orgId, userId, type: n.type, entityType: n.entityType, entityId: n.entityId, title: n.title.slice(0, 300), actorName: n.actorName ?? null }, { orgId, maxAttempts: 3 });
    }
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
    case "social_post": return n.type === "social.post_review" ? "/app/approvals" : `/app/social/posts#post-${encodeURIComponent(n.entityId)}`;
    case "message": return `/app/mail?m=${encodeURIComponent(n.entityId)}`;
    case "thread": return `/app/inbox?thread=${encodeURIComponent(n.entityId)}`;
    case "goal": return `/app/goals?goal=${encodeURIComponent(n.entityId)}`;
    case "meeting": return `/app/meetings/${encodeURIComponent(n.entityId)}`;
    case "file_request": return `/app/tools/share?tab=requests&request=${encodeURIComponent(n.entityId)}`; // R88
    case "secret": return "/app/tools/share?tab=secrets"; // R88
    case "share": return "/app/tools/share"; // R88
    case "dashboard": return `/app/dashboards/${encodeURIComponent(n.entityId)}`;
    default: return "/app/notifications";
  }
}

export async function listNotifications(deps: Deps, orgId: string, userId: string, opts: { unread?: boolean; limit?: number; category?: string; before?: string; view?: TriageView } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let typeFilter;
  if (opts.category && opts.category !== "all") {
    if (!(CATEGORIES as readonly string[]).includes(opts.category)) throw new HttpError(422, "validation_failed", `Unknown category: ${opts.category}`);
    const c = opts.category as Category;
    // "status" also holds every type not listed anywhere else.
    typeFilter = c === "status" ? sql`${notifications.type} not in (${sql.join(Object.keys(TYPE_CATEGORY).filter((t) => TYPE_CATEGORY[t] !== "status").map((t) => sql`${t}`), sql`, `)})` : inIds(notifications.type, typesOf(c));
  }
  const base = and(eq(notifications.orgId, orgId), eq(notifications.userId, userId));
  // R31: Inbox (default), Later or Done. A snooze that has passed is back in the Inbox, ordered by when it came back.
  const view: TriageView = opts.view ?? "inbox";
  const now = deps.now();
  const rows = await deps.db.select().from(notifications)
    .where(and(base, viewWhere(view, now, !!opts.before), opts.unread ? isNull(notifications.readAt) : undefined, typeFilter, opts.before ? lt(notifications.id, opts.before) : undefined))
    .orderBy(...VIEW_ORDER[view]).limit(limit + 1);
  const page = rows.slice(0, limit);
  // The unread count (sidebar badge, category chips) counts the Inbox only.
  const [unreadRows, viewCounts] = await Promise.all([
    deps.db.select({ type: notifications.type, n: sql<number>`count(*)` }).from(notifications).where(and(base, isNull(notifications.readAt), inboxWhere(now))).groupBy(notifications.type),
    viewCountsFor(deps, orgId, userId, now),
  ]);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let unread = 0;
  for (const r of unreadRows) { counts[categoryOf(r.type)] += Number(r.n); unread += Number(r.n); }
  // Chat links need the channel: one query for the page.
  const chatIds = page.filter((r) => r.entityType === "chat_message").map((r) => r.entityId);
  const channelOf = new Map<string, string>();
  if (chatIds.length) {
    const { chatMessages } = await import("../../db/schema");
    for (const m of await deps.db.select({ id: chatMessages.id, channelId: chatMessages.channelId }).from(chatMessages).where(inIds(chatMessages.id, chatIds))) channelOf.set(m.id, m.channelId);
  }
  return {
    notifications: page.map((r) => ({
      id: r.id, type: r.type, category: categoryOf(r.type), entityType: r.entityType, entityId: r.entityId, title: r.title,
      actor: r.actorName ? { type: "member", id: null, name: r.actorName } : null, read: !!r.readAt, createdAt: r.createdAt.toISOString(),
      link: linkFor(r, channelOf.get(r.entityId)),
      doneAt: r.doneAt ? r.doneAt.toISOString() : null, snoozedUntil: r.snoozedUntil && r.snoozedUntil > now ? r.snoozedUntil.toISOString() : null,
    })),
    unread, counts, hasMore: rows.length > limit, view, viewCounts,
  };
}

export async function markNotificationsRead(deps: Deps, orgId: string, userId: string, ids?: string[], category?: string) {
  const now = deps.now();
  let filter: SQL | undefined;
  if (ids) filter = inIds(notifications.id, ids);
  else if (category && category !== "all") {
    if (!(CATEGORIES as readonly string[]).includes(category)) throw new HttpError(422, "validation_failed", `Unknown category: ${category}`);
    filter = inIds(notifications.type, typesOf(category as Category).length ? typesOf(category as Category) : ["-"]);
  }
  let res: { id: string }[] = [];
  // R32: read marks are deferrable (services/write-priority.ts): coalesced near the daily D1 budget, skipped at shed.
  await deferrableWrite(deps, "notification_read", `${userId}:${ids ? ids.join(",") : category ?? "all"}`, async () => {
    res = await deps.db.update(notifications).set({ readAt: now })
      .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), isNull(notifications.readAt), filter))
      .returning({ id: notifications.id });
  });
  return { ok: true, updated: res.length, marked: res.length };
}

export async function markNotificationUnread(deps: Deps, orgId: string, userId: string, id: string) {
  const res = await deps.db.update(notifications).set({ readAt: null }).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), eq(notifications.id, id))).returning({ id: notifications.id });
  if (!res.length) throw new HttpError(404, "not_found", "Notification not found.");
  return { ok: true };
}
