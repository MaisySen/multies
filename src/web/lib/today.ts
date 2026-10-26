/** R35: the pure parts of the Today home (src/web/pages/app/my-work.tsx), unit tested in tests/today-r35.test.ts. */
import type { MyWork, MyWorkItem } from "./search";

export const JOIN_WINDOW_MS = 10 * 60_000;

/** The next meeting that has not ended, and whether its Join button shows (from 10 minutes before). */
export function nextMeeting(meetings: MyWorkItem[], now = Date.now()): { item: MyWorkItem; joinable: boolean } | null {
  const timed = meetings.filter((m) => m.at).map((m) => ({ m, t: Date.parse(m.at!) })).filter((x) => !Number.isNaN(x.t));
  const upcoming = timed.filter((x) => x.t > now - 60 * 60_000).sort((a, b) => a.t - b.t)[0];
  if (!upcoming) return meetings[0] ? { item: meetings[0], joinable: false } : null;
  return { item: upcoming.m, joinable: upcoming.t - now <= JOIN_WINDOW_MS };
}

/** The top five things to do now: overdue first, then due today, mentions, approvals and mail on tasks. */
export function focusItems(w: MyWork, n = 5): (MyWorkItem & { kind: "overdue" | "due" | "mention" | "approval" | "mail" })[] {
  const tag = <K extends string>(items: MyWorkItem[] | null | undefined, kind: K) => (items ?? []).map((i) => ({ ...i, kind }));
  return [...tag(w.overdue, "overdue" as const), ...tag(w.dueToday, "due" as const), ...tag(w.mentions, "mention" as const), ...tag(w.approvals, "approval" as const), ...tag(w.threads, "mail" as const)].slice(0, n);
}

