import { calFmt } from "./mpar3";
import type { Meeting, MessageSummary, Task } from "@/api/types";
import { groupCount } from "./numbers";
import { tr } from "@/i18n";
import { LOCALE } from "./format";

/** R34: "Good morning" before noon, "Good afternoon" to 6 pm, then "Good evening". */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? tr("m.today.good_morning") : h < 18 ? tr("m.today.good_afternoon") : tr("m.today.good_evening");
}

/** The next meeting that has not ended yet, soonest first, or null. */
export function nextMeeting(meetings: readonly Meeting[] | undefined, now = new Date()): Meeting | null {
  if (!meetings?.length) return null;
  const t = now.getTime();
  const open = meetings.filter((m) => m.status !== "cancelled" && m.status !== "ended" && new Date(m.endsAt ?? m.startsAt).getTime() > t);
  open.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return open[0] ?? null;
}

/** "Now", "in 25 min", "at 3:30 pm" or "Tue 9:00 am" for a meeting start. */
export function whenLabel(startsAt: string, now = new Date()): string {
  const s = new Date(startsAt);
  const diff = s.getTime() - now.getTime();
  if (diff <= 0) return tr("m.today.now");
  if (diff < 60 * 60_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  const time = s.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = s.toDateString() === now.toDateString();
  return sameDay ? `at ${time}` : `${calFmt(s, { weekday: "short" })} ${time}`;
}

/** Open tasks of mine due today, then overdue ones, at most `limit`. */
export function focusTasks(tasks: readonly Task[] | undefined, today: string, limit = 3): Task[] {
  return (tasks ?? []).filter((t) => t.status !== "done" && !!t.due && t.due.slice(0, 10) <= today)
    .sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0)).slice(0, limit);
}

/** The newest unread mail, up to `limit`. Exported for tests. */
export function topUnread(list: readonly MessageSummary[] | undefined, limit = 3): MessageSummary[] {
  return (list ?? []).filter((m) => !m.isRead).slice(0, limit);
}

/**
 * The hero line: what the day holds, in plain words. Unread mail lives in its tile, not here (1.10.12 said
 * "15527 unread today", which was all unread, not today's). Exported for tests.
 */
export function daySummary(due: number, next: string | null): string {
  const head = due ? tr("m.today.tasks_need_you_today", { count: due, n: groupCount(due) }) : tr("m.today.nothing_due_today_2");
  return next ? tr("m.today.head_next_next", { head: head, next: next }) : head;
}

