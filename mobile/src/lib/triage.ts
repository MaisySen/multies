import type { AppNotification, NotificationPage } from "@/api/types";
import { LOCALE } from "./format";
import { tr } from "@/i18n";

/**
 * R31: the notifications inbox as a triage list: Inbox (to deal with), Later (snoozed) and Done.
 * The server added `view` with this release. An older server ignores `view` and answers the plain
 * list: then the screen shows that list and hides Later and Done (no actions it can't keep).
 */
export type TriageView = "inbox" | "later" | "done";

export const TRIAGE_VIEWS: { id: TriageView; label: string }[] = [
  { id: "inbox", label: tr("m.inbox.inbox") },
  { id: "later", label: tr("m.inbox.later") },
  { id: "done", label: tr("m.inbox.done") },
];

/** True when the server understood `view` (it answers viewCounts). */
export function supportsTriage(page: NotificationPage | undefined | null): boolean {
  return !!page && !!page.viewCounts && typeof page.viewCounts.inbox === "number";
}

export type TriageMode = { kind: "loading" } | { kind: "legacy"; items: AppNotification[] } | { kind: "triage"; items: AppNotification[]; counts: { inbox: number; later: number; done: number } };

/** What the screen shows for a page from the server. */
export function triageMode(page: NotificationPage | undefined | null, view: TriageView): TriageMode {
  if (!page) return { kind: "loading" };
  if (!supportsTriage(page)) return { kind: "legacy", items: page.notifications };
  const items = page.notifications.filter((n) => inView(n, view));
  return { kind: "triage", items, counts: { inbox: page.viewCounts!.inbox, later: page.viewCounts!.later ?? 0, done: page.viewCounts!.done ?? 0 } };
}

/** Which view an item belongs in right now. A snooze whose time has passed is back in Inbox. */
export function viewOf(n: Pick<AppNotification, "doneAt" | "snoozedUntil">, now = Date.now()): TriageView {
  if (n.doneAt) return "done";
  if (n.snoozedUntil && Date.parse(n.snoozedUntil) > now) return "later";
  return "inbox";
}

export function inView(n: Pick<AppNotification, "doneAt" | "snoozedUntil">, view: TriageView, now = Date.now()): boolean {
  return viewOf(n, now) === view;
}

export type TriageChange = { action: "done" } | { action: "undone" } | { action: "snooze"; until: string };

/** The item after a change, as the server will have it. */
export function applyChange(n: AppNotification, c: TriageChange, now = new Date()): AppNotification {
  if (c.action === "done") return { ...n, doneAt: now.toISOString(), snoozedUntil: null, read: true };
  if (c.action === "undone") return { ...n, doneAt: null, snoozedUntil: null };
  return { ...n, snoozedUntil: c.until, doneAt: null, read: true };
}

/**
 * A cached page after a change to some ids: the items move between views at once and the counts
 * follow. The server's answer replaces it on the next fetch.
 */
export function patchPage(page: NotificationPage, ids: string[], c: TriageChange, now = new Date()): NotificationPage {
  if (!supportsTriage(page)) return page;
  const counts = { inbox: page.viewCounts!.inbox, later: page.viewCounts!.later ?? 0, done: page.viewCounts!.done ?? 0 };
  let unread = page.unread;
  const notifications = page.notifications.map((n) => {
    if (!ids.includes(n.id)) return n;
    const next = applyChange(n, c, now);
    const from = viewOf(n, now.getTime());
    const to = viewOf(next, now.getTime());
    if (from !== to) { counts[from] = Math.max(0, counts[from] - 1); counts[to] += 1; }
    if (!n.read && next.read && from === "inbox") unread = Math.max(0, unread - 1);
    return next;
  });
  return { ...page, notifications, viewCounts: counts, unread };
}

/** The tab badge: unread items in Inbox (an older server's plain unread count otherwise). */
export function badgeCount(page: Pick<NotificationPage, "unread"> | undefined | null): number {
  return page?.unread ?? 0;
}

/** "Back Tue 8:00 am" for a snoozed item (local time). */
export function backLabel(until: string): string {
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return tr("m.inbox.snoozed");
  return tr("m.inbox.back_minute", { minute: d.toLocaleString(LOCALE, { weekday: "short", hour: "numeric", minute: "2-digit" }) });
}
