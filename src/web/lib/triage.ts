/**
 * R31: notification triage on the web. Pure helpers for the Inbox / Later / Done list (day groups, optimistic moves,
 * the page-local keys) so they are unit tested without a browser. The page is src/web/pages/app/notifications.tsx.
 */
export type TriageView = "inbox" | "later" | "done";
export const TRIAGE_VIEWS: TriageView[] = ["inbox", "later", "done"];
export const VIEW_LABELS: Record<TriageView, string> = { inbox: "Inbox", later: "Later", done: "Done" };
export type SnoozePreset = "later_today" | "tomorrow" | "next_week";
export const SNOOZE_LABELS: Record<SnoozePreset, string> = { later_today: "Later today", tomorrow: "Tomorrow", next_week: "Next week" };

export interface TriageItem { id: string; read: boolean; createdAt: string; doneAt: string | null; snoozedUntil: string | null }
export interface ViewCounts { inbox: number; later: number; done: number }

/** The page-local keys (listed in the ? sheet by the registry at merge). */
export const TRIAGE_KEYS: { key: string; label: string }[] = [
  { key: "J", label: "Next notification" },
  { key: "K", label: "Previous notification" },
  { key: "Enter or O", label: "Open" },
  { key: "E", label: "Mark done" },
  { key: "Shift E", label: "Undo the last done" },
  { key: "H", label: "Snooze" },
  { key: "U", label: "Mark read or unread" },
];

export type TriageAction = "next" | "prev" | "open" | "done" | "undo" | "snooze" | "toggle-read";
/** Which action a key press means on the triage list, or null to let it through. */
export function triageActionFor(e: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): TriageAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey) return k === "e" ? "undo" : null;
  switch (k) {
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp": return "prev";
    case "Enter": case "o": return "open";
    case "e": return "done";
    case "h": return "snooze";
    case "u": return "toggle-read";
    default: return null;
  }
}

/** Calendar day label for a group: Today, Yesterday, a weekday this week, else a date. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** Label for when a snoozed item comes back: Back today, Back tomorrow, Back Friday, Back 3 Nov. */
export function backLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(now)) / 86_400_000);
  if (days <= 0) return "Back today";
  if (days === 1) return "Back tomorrow";
  if (days < 7) return `Back ${d.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `Back ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** When the row sorts in its view: Done by done time, Later by snooze time, Inbox by arrival. */
export function sortKeyOf(item: TriageItem, view: TriageView): string {
  if (view === "done") return item.doneAt ?? item.createdAt;
  if (view === "later") return item.snoozedUntil ?? item.createdAt;
  return item.createdAt;
}

/** Items grouped by day in list order. Later groups by when each comes back. */
export function groupByDay<T extends TriageItem>(items: T[], view: TriageView, now = new Date()): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = view === "later" ? backLabel(sortKeyOf(it, view), now) : dayLabel(sortKeyOf(it, view), now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it); else out.push({ label, items: [it] });
  }
  return out;
}

/** Optimistic: the list and counts after moving one item out of `view` to `to`. */
export function moveOut<T extends TriageItem, P extends { notifications: T[]; viewCounts: ViewCounts; unread: number }>(page: P, view: TriageView, id: string, to: TriageView): P {
  const it = page.notifications.find((n) => n.id === id);
  if (!it) return page;
  const counts = { ...page.viewCounts };
  counts[view] = Math.max(0, counts[view] - 1);
  counts[to] += 1;
  const unread = view === "inbox" && !it.read ? Math.max(0, page.unread - 1) : page.unread;
  return { ...page, notifications: page.notifications.filter((n) => n.id !== id), viewCounts: counts, unread };
}

/** The id to focus after the focused row leaves the list: the next one, else the previous. */
export function nextFocus(ids: string[], removed: string): string | null {
  const i = ids.indexOf(removed);
  if (i < 0) return ids[0] ?? null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** Local date and time from a date input (yyyy-mm-dd) at 9 am, as ISO. */
export function pickedDateIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0).toISOString();
}
