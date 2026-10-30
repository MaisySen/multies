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
    id: "2026-10-30-clearer-legal",
    date: "2026-10-30",
    title: "Clearer privacy and terms",
    body: "The privacy policy, terms and trust page now say plainly what we do today, with one contact address: contact@fintex.au. Every backup is encrypted and deleted after 30 days.",
  },
  {
    id: "2026-10-30-older-mail-headers",
    date: "2026-10-30",
    title: "Older mail shows its sender and subject",
    body: "Some older emails copied from a connected mailbox showed as unknown@invalid with no subject. They now load their real sender, subject, date and preview, and stay out of your list until they do.",
  },
  {
    id: "2026-10-29-workspace-tabs",
    date: "2026-10-29",
    title: "Other tabs follow your workspace",
    body: "Switch workspace in one tab and your other tabs ask you to reload, so nothing saves in the wrong place.",
  },
  {
    id: "2026-10-29-guest-link",
    date: "2026-10-29",
    title: "Share a guest invite yourself",
    body: "When an invite email doesn't reach a guest, copy their invite link and send it your own way. Get link on a waiting guest makes a fresh one.",
  },
  {
    id: "2026-10-29-move-ref",
    date: "2026-10-29",
    title: "Moves say when a number changes",
    body: "The command menu tells you when moving a task to another project gives it a new number, and checks before it makes a new label.",
  },
  {
    id: "2026-10-29-free-and-switch",
    date: "2026-10-29",
    title: "Free for a small team, and easy to move in",
    body: "See what Free includes on one page, and move your work over from eight tools, with a sample file to try first.",
  },
  {
    id: "2026-10-29-full-mailbox-sync",
    date: "2026-10-29",
    title: "Your whole mailbox syncs by itself",
    body: "A connected mailbox now keeps copying older mail on its own until all of it is in, and shows how far it has got.",
  },
  {
    id: "2026-10-29-inbox-reply",
    date: "2026-10-29",
    title: "Reply straight from the shared inbox",
    body: "Open a thread in the shared inbox and press Reply or Reply all to answer the customer right there. Replies now save as a draft while you type, so a reload keeps them.",
  },
  {
    id: "2026-10-29-names-from-you",
    date: "2026-10-29",
    title: "Set up uses your name",
    body: "A new workspace is named after the name you give at Welcome, and the free address we suggest starts with your first name, never your sign in email.",
  },
  {
    id: "2026-10-28-startup-templates",
    date: "2026-10-28",
    title: "Four new starter templates",
    body: "Templates now has a two week sprint, hiring, a product launch and a support desk, each with its statuses, fields and first tasks ready to go.",
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
    id: "2026-10-28-whats-new",
    date: "2026-10-28",
    title: "What's new, in the app",
    body: "The account menu has a What's new item, with a small dot when something new has shipped since you last looked. The same list is on the public changelog page.",
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
