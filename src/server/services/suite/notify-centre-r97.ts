/**
 * R97 notification centre: mail as it happens (a job, so callers never wait) and the daily or weekly digest (a cron
 * pass that reads only rows whose digest is due, 50 a run). Digests list unread Inbox items newer than the last
 * digest, for the categories the person turned Mail on for. Nothing new means no mail.
 */
import { and, asc, desc, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import type { Deps } from "../../context";
import { notificationPrefs, notifications, users } from "../../db/schema";
import { registerJob } from "../jobs";
import { sendSystemEmail } from "../system-mail";
import { CATEGORIES, categoryOf, linkFor, LOST_MAIL_TITLE, lostMailNotifications, mergePrefs, type Category } from "./notify";
import { inboxWhere } from "./notify-triage";
import { DIGEST_MAX_ITEMS, nextDigestAt, readDelivery } from "../../../shared/notification-centre";

export const CATEGORY_TITLES: Record<Category, string> = {
  mention: "Mentions", assignment: "Assigned to you", comment: "Comments", approval: "Approvals",
  due_soon: "Due soon", chat: "Chat", email: "Mail", status: "Status updates",
};
/** Digest rows handled per cron run. */
export const DIGEST_BATCH = 50;
/** Rows read per person to build one digest. */
const DIGEST_SCAN = 200;

const absolute = (deps: Deps, path: string) => `${deps.config.appUrl.replace(/\/$/, "")}${path}`;

interface MailJob { orgId: string; userId: string; type: string; entityType: string; entityId: string; title: string; actorName: string | null }

registerJob("notify.mail", async (deps, payload) => {
  const p = payload as MailJob;
  const user = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, p.userId)).get();
  if (!user?.email) return;
  const label = CATEGORY_TITLES[categoryOf(p.type)];
  const who = p.actorName ? `${p.actorName}: ` : "";
  await sendSystemEmail(deps, {
    to: user.email, orgId: p.orgId,
    subject: `${label}: ${p.title}`.slice(0, 160),
    text: `${who}${p.title}\n\nYou get this because Mail is on for ${label.toLowerCase()} in your notification settings.`,
    action: { label: "Open", url: absolute(deps, linkFor(p)) },
  });
});

export function digestText(groups: { category: Category; items: { title: string; actorName: string | null }[]; more: number }[], frequency: "daily" | "weekly") {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`${CATEGORY_TITLES[g.category]} (${g.items.length + g.more})`);
    for (const i of g.items) lines.push(`  ${i.actorName ? `${i.actorName}: ` : ""}${i.title}`);
    if (g.more) lines.push(`  and ${g.more} more`);
    lines.push("");
  }
  lines.push(`This is your ${frequency} notification digest. Change it in Settings, Notifications.`);
  return lines.join("\n");
}

/** Builds and sends one person's digest. Returns how many items it listed (0 = no mail). */
export async function sendDigest(deps: Deps, row: { userId: string; orgId: string; settings: string; delivery: string; digestLastAt: Date | null }, now: Date) {
  const delivery = readDelivery(row.delivery);
  if (delivery.digest.frequency === "off") return 0;
  const prefs = mergePrefs(row.settings);
  const wanted = new Set(CATEGORIES.filter((c) => prefs[c].mail));
  if (!wanted.size) return 0;
  const since = row.digestLastAt ?? new Date(now.getTime() - (delivery.digest.frequency === "weekly" ? 7 : 1) * 86_400_000);
  const rows = await deps.db.select({ id: notifications.id, type: notifications.type, title: notifications.title, actorName: notifications.actorName, entityType: notifications.entityType, entityId: notifications.entityId }).from(notifications)
    .where(and(eq(notifications.orgId, row.orgId), eq(notifications.userId, row.userId), isNull(notifications.readAt), inboxWhere(now), gt(notifications.createdAt, since)))
    .orderBy(desc(notifications.createdAt)).limit(DIGEST_SCAN);
  const lost = await lostMailNotifications(deps, row.orgId, row.userId, rows); // PRIV1b (P61): one check for the digest
  const by = new Map<Category, { title: string; actorName: string | null }[]>();
  for (const r of rows) {
    const c = categoryOf(r.type);
    if (wanted.has(c)) by.set(c, [...(by.get(c) ?? []), { title: lost.has(r.id) ? LOST_MAIL_TITLE : r.title, actorName: r.actorName }]);
  }
  const total = [...by.values()].reduce((s, l) => s + l.length, 0);
  if (!total) return 0;
  const user = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, row.userId)).get();
  if (!user?.email) return 0;
  let budget = DIGEST_MAX_ITEMS;
  const groups = CATEGORIES.filter((c) => by.has(c)).map((c) => {
    const all = by.get(c)!;
    const items = all.slice(0, Math.max(0, budget));
    budget -= items.length;
    return { category: c, items, more: all.length - items.length };
  });
  const freq = delivery.digest.frequency;
  await sendSystemEmail(deps, {
    to: user.email, orgId: row.orgId,
    subject: `${total} new notification${total === 1 ? "" : "s"} in your ${freq} digest`,
    text: digestText(groups, freq),
    action: { label: "Open notifications", url: absolute(deps, "/app/notifications") },
  });
  return total;
}

/** The cron pass: due digests only (index on digest_due_at), then each row's clock moves to its next moment. */
export async function runNotificationDigests(deps: Deps, limit = DIGEST_BATCH) {
  if (deps.config.notificationCentre === false) return { due: 0, sent: 0 };
  const now = deps.now();
  const due = await deps.db.select({ userId: notificationPrefs.userId, orgId: notificationPrefs.orgId, settings: notificationPrefs.settings, delivery: notificationPrefs.delivery, digestLastAt: notificationPrefs.digestLastAt })
    .from(notificationPrefs).where(and(isNotNull(notificationPrefs.digestDueAt), lte(notificationPrefs.digestDueAt, now)))
    .orderBy(asc(notificationPrefs.digestDueAt)).limit(limit);
  let sent = 0;
  for (const row of due) {
    let listed = 0;
    try { listed = await sendDigest(deps, row, now); } catch (err) { deps.reportError?.(err, { where: "notify.digest" }); }
    if (listed) sent++;
    // Move the clock whatever happened, so one bad row never blocks the queue; an empty digest keeps its window open.
    await deps.db.update(notificationPrefs)
      .set({ digestDueAt: nextDigestAt(now, readDelivery(row.delivery)), ...(listed ? { digestLastAt: now } : {}) })
      .where(and(eq(notificationPrefs.userId, row.userId), eq(notificationPrefs.orgId, row.orgId)));
  }
  return { due: due.length, sent };
}
