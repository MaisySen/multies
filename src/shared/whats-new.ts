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
    id: "2026-11-03-client-portal-access",
    date: "2026-11-03",
    title: "Client portals you control",
    body: "Choose what each client sees per area, from none to view or comment. Share live project pages with progress and milestones, plus invoices and forms, and leave a private comment that only one person can see.",
  },
  {
    id: "2026-11-03-crm-from-mail",
    date: "2026-11-03",
    title: "Contacts that update from your mail",
    body: "Contacts suggests new people from email signatures, last contacted dates and next steps from the mail you already sync. Nothing changes until you accept, and you can edit, discard or undo. Save analyses from templates such as pipeline by stage and share them with your workspace.",
  },
  {
    id: "2026-11-03-team-ai",
    date: "2026-11-03",
    title: "Team AI",
    body: "A visible memory for the assistant, saved instructions, routines that write drafts or chat messages, and @assistant in channels. Free built in AI with a daily limit, or your own AI key for unlimited use.",
  },
  {
    id: "2026-11-03-forms-pro",
    date: "2026-11-03",
    title: "Branded forms that open and close on time",
    body: "Give a form your colours, font and logo, close it on a date or after a number of answers, or add a password. People can save and finish later from a link, and you see views, completions and where people stop.",
  },
  {
    id: "2026-11-02-one-inbox",
    date: "2026-11-02",
    title: "One inbox",
    body: "Mail, chat, mentions, tasks and assistant replies in one list. Important first, the rest waits in Noise; move anything and we remember the sender.",
  },
  {
    id: "2026-11-02-mentions",
    date: "2026-11-02",
    title: "Mention any record",
    body: "Type @ in chat, a task, a comment or a contact note to link a task, project, doc, contact, deal, meeting, form or invoice. Every record shows what mentions it and what it mentions, and people without access see a restricted card.",
  },
  {
    id: "2026-11-02-bill-time",
    date: "2026-11-02",
    title: "Bill time",
    body: "Turn tracked hours into a draft invoice in a few clicks: pick a project and dates, set rates and rounding, and the billed time is locked so it is never billed twice. Home shows the hours still to bill.",
  },
  {
    id: "2026-11-02-meeting-tasks",
    date: "2026-11-02",
    title: "Meetings to tasks",
    body: "On a meeting page, Suggest reads the transcript, the notes or pasted text and lists the action items with who and when. Accept makes a task, Discard drops it, and Follow up email opens a ready draft for you to send."
  },
  {
    id: "2026-11-02-ai-connect",
    date: "2026-11-02",
    title: "AI that works from the start",
    body: "Built in AI works with no key needed, up to a daily limit for your workspace. Admins can also connect their own AI in Settings, AI: paste a key and the provider is found for you, pick from the live model list and test it before saving.",
  },
  {
    id: "2026-11-02-get-started",
    date: "2026-11-02",
    title: "Get started list and quick tours",
    body: "A Get started list on Home and My Work ticks itself off as you go. Quick tours show where things live, and admins can build their own tours in Settings, Tours.",
  },
  {
    id: "2026-11-02-staff",
    date: "2026-11-02",
    title: "Staff, onboarding and equipment",
    body: "Contacts has a Staff directory with an org chart and who is away. Admins build onboarding checklists that become tasks from a start date, and keep an equipment register with QR labels.",
  },
  {
    id: "2026-11-02-polish",
    date: "2026-11-02",
    title: "Smoother Courses, Tables, Vault and more",
    body: "Move a table or course to Trash in Docs and restore it within 30 days. Start a webinar straight from Meetings or Schedule, and pages like Sites, Vault and Home recover from errors with one Retry.",
  },
  {
    id: "2026-11-02-menu",
    date: "2026-11-02",
    title: "A tidier menu",
    body: "Contacts now has its own place in the menu with People and Deals. Mailboxes, Domains and Deliverability moved to Settings, Mail setup, and Files sits in Docs. Hide what you never use from View, Customise menu, and on phones More shows every section as a tile.",
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
