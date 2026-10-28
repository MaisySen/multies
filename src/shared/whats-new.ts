/**
 * R53 (MB-133): the "What's new" list, newest first. One place feeds the public /changelog page and the
 * account menu's unread dot. Plain user words: no dashes, no other product names, nothing a person cannot notice.
 * Add a new entry at the top with a new id; the dot shows for everyone whose browser has not opened the newest id.
 */
export interface WhatsNewEntry {
  /** Stable and unique: the date plus a short slug. Never reuse or edit an id once shipped. */
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  title: string;
  /** One to three short sentences. */
  body: string;
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-28-lighter-mail-sync",
    date: "2026-10-28",
    title: "Lighter mail sync",
    body: "Mail that has not changed is no longer downloaded twice, and only flags that changed are read. Connected mailboxes stay in step with less work on every pass.",
  },
  {
    id: "2026-10-28-delete-meetings",
    date: "2026-10-28",
    title: "Delete a meeting",
    body: "Meetings can now be deleted, from the app or through the API.",
  },
  {
    id: "2026-10-28-safe-retries",
    date: "2026-10-28",
    title: "No doubles when an app retries",
    body: "If an app or agent that uses your workspace retries after an error, you get one item, not two. This now covers forms, goals, time entries, chat channels, saved replies, custom fields, checklists and sprints.",
  },
  {
    id: "2026-10-28-quicker-task-lists",
    date: "2026-10-28",
    title: "Quicker task lists",
    body: "Task lists take less work to prepare on our side, so they come back sooner.",
  },
  {
    id: "2026-10-27-webhook-events",
    date: "2026-10-27",
    title: "More webhook events",
    body: "Webhooks now tell you when a project, doc or comment is deleted, and when a comment is added or edited.",
  },
  {
    id: "2026-10-27-mail-to-task-phone",
    date: "2026-10-27",
    title: "Turn an email into a task on your phone",
    body: "An open email has a task button in the bar at the bottom. One tap makes a task, and if the thread already has one, the same tap opens it. Back from the task takes you to the email.",
  },
  {
    id: "2026-10-27-steadier-my-work",
    date: "2026-10-27",
    title: "Steadier My Work",
    body: "My Work, the Home tab on phones, skips empty sections in a single check, so it loads with fewer steps and holds up on busy days.",
  },
  {
    id: "2026-10-27-workspace-switching",
    date: "2026-10-27",
    title: "Switching workspaces sticks",
    body: "If your account is in several workspaces, switching from the workspace menu now lands on every device and stays put after a reload. If a switch cannot finish, the menu says so and keeps you where you were.",
  },
  {
    id: "2026-10-27-every-task-on-boards",
    date: "2026-10-27",
    title: "Big projects show every task",
    body: "Board, list and backlog now load every task, page by page, so column counts and point totals cover the whole project. The notice about showing only the first 500 is gone.",
  },
  {
    id: "2026-10-27-boards-stay-current",
    date: "2026-10-27",
    title: "Boards stay current",
    body: "Open boards and backlogs check for changes every 20 seconds and fetch only what changed. Moving a task between sprints now shows on other people's backlogs too.",
  },
  {
    id: "2026-10-27-smoother-boards",
    date: "2026-10-27",
    title: "Smoother boards and a faster backlog",
    body: "Long columns scroll smoothly even when you fling them. In the backlog, Shift with arrows selects a run of tasks and M opens Move to sprint.",
  },
];

/** The newest entry's id, or null when the list is empty. */
export const latestWhatsNewId = (entries: readonly WhatsNewEntry[] = WHATS_NEW): string | null => entries[0]?.id ?? null;

/** True when there is an entry newer than the one this browser last opened (or it never opened any). */
export function hasUnreadWhatsNew(lastSeenId: string | null | undefined, entries: readonly WhatsNewEntry[] = WHATS_NEW): boolean {
  const latest = latestWhatsNewId(entries);
  return latest !== null && latest !== lastSeenId;
}

/** "28 Oct 2026" from an ISO date, read as a calendar day (no time zone shift). */
export function formatWhatsNewDate(date: string, locale?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
