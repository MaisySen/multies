/**
 * R53 (MB-133): the "What's new" list, newest first. One place feeds the public /changelog page and the
 * account menu's unread dot. Plain user words: no dashes, no other product names, nothing a person cannot notice.
 * Add a new entry at the top with a new id; the dot shows for everyone whose browser has not opened the newest id.
 * R55: the list keeps the changes people can see and use, at most 14; work behind the scenes stays in CHANGELOG.md.
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
    id: "2026-10-28-rule-choices-fix",
    date: "2026-10-28",
    title: "Rule settings ask before saving",
    body: "A new rule that sets a priority or assigns the task now asks you to pick one, instead of showing a choice it did not save.",
  },
  {
    id: "2026-10-28-more-command-words",
    date: "2026-10-28",
    title: "More words the command menu understands",
    body: "Change a status (\"mark MB-12 in progress\"), add or remove labels (\"MB-12 +urgent -later\") or move a task to another project (\"move MB-12 to project Website\"). You see the change before you press Enter, and Undo puts it back.",
  },
  {
    id: "2026-10-28-rules-do-more",
    date: "2026-10-28",
    title: "One rule, several actions",
    body: "A task rule in Automations can now do up to five things in order. For example, when a bug is made, set it to high, add the label triage and notify the assignee.",
  },
  {
    id: "2026-10-28-command-menu-actions",
    date: "2026-10-28",
    title: "Tell the command menu what to do",
    body: "Type what you want in the command menu, like \"assign MB-12 to Asha due Friday\", check the preview, press Enter, and Undo if you change your mind.",
  },
  {
    id: "2026-10-28-easier-to-read-phone",
    date: "2026-10-28",
    title: "Easier to read on phones",
    body: "The unread count on the phone tab bar is a deeper red, so the number is easier to read. Screen readers now name the workspace, account and mail buttons with the words you see on them.",
  },
  {
    id: "2026-10-28-whats-new",
    date: "2026-10-28",
    title: "What's new, in the app",
    body: "The account menu has a What's new item, with a small dot when something new has shipped since you last looked. The same list is on the public changelog page.",
  },
  {
    id: "2026-10-28-delete-meetings",
    date: "2026-10-28",
    title: "Delete a meeting",
    body: "Meetings can now be deleted, from the app or through the API.",
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
