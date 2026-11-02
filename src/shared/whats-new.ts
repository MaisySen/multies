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
    id: "2026-11-02-menu",
    date: "2026-11-02",
    title: "A tidier menu",
    body: "Contacts now has its own place in the menu with People and Deals. Mailboxes, Domains and Deliverability moved to Settings, Mail setup, and Files sits in Docs. Hide what you never use from View, Customise menu, and on phones More shows every section as a tile.",
  },
  {
    id: "2026-11-02-social-more-networks",
    date: "2026-11-02",
    title: "More from Social",
    body: "Pins now take their own title, link and alt text. YouTube comments arrive in the Social inbox and you can reply there. When you schedule, Multies suggests your best times from your own results, writing help can make a post shorter, friendlier or fit each network, and you can share a post with a link to Snapchat.",
  },
  {
    id: "2026-11-02-blog",
    date: "2026-11-02",
    title: "A blog on your site",
    body: "In Sites, open the Blog tab to write posts in the Docs editor, add tags, a cover and an author, and publish now or at a set time. Visitors get tag and author pages, an RSS feed and a subscribe box, and admins can email a post to confirmed subscribers.",
  },
  {
    id: "2026-11-02-anonymous-reports",
    date: "2026-11-02",
    title: "Anonymous reports and data requests",
    body: "Give your people a page to report a concern without an account, then reply in a private two way chat with a handler, status and deadlines. In Settings, Data requests lets someone get a copy of their data or have it deleted, after they confirm their email.",
  },
  {
    id: "2026-11-02-webinars",
    date: "2026-11-02",
    title: "Webinars from any meeting",
    body: "Turn a meeting into a webinar: people register on their own page and watch while hosts and panelists speak. They ask and upvote questions, vote in polls and chat when you allow it, and you get a report of who came with a CSV download.",
  },
  {
    id: "2026-11-02-home-widgets",
    date: "2026-11-02",
    title: "Arrange your Home",
    body: "Home is now made of widgets for your tasks, meetings, inbox counts, quick links and more. Drag them into the order you like, change their size or hide them, and admins can set the layout everyone starts with.",
  },
  {
    id: "2026-11-02-courses",
    date: "2026-11-02",
    title: "Courses for staff training",
    body: "In Docs, build a course from your pages, file and video links and a quiz with a pass mark. Assign it to people with a due date and they get reminders, follow their progress in My learning and download a certificate when they finish. Admins and managers see everyone's progress and can export it as CSV.",
  },
  {
    id: "2026-11-01-sites",
    date: "2026-11-01",
    title: "Build a simple website for your team",
    body: "Start a site from the Create menu. Build pages from ready blocks with a live preview, save drafts, go back to any version and publish now or at a set time. Add your forms and booking pages, let visitors comment once you approve, and see visits with no personal data kept.",
  },
  {
    id: "2026-11-01-forms-plus",
    date: "2026-11-01",
    title: "Forms that chat, feedback boards and calls for submissions",
    body: "Forms can ask one question at a time and sit in a chat bubble on your website. Run feedback boards with votes and a roadmap, and collect entries for blind review with scores and a shortlist.",
  },
  {
    id: "2026-11-01-tables",
    date: "2026-11-01",
    title: "Tables in Docs",
    body: "Keep clients, stock or jobs in a table with typed fields, linked records, lookups and formulas. Switch between grid, kanban, calendar and form views, paste from a spreadsheet, import and export CSV, and comment on rows. Start one from Docs > New table.",
  },
  {
    id: "2026-11-01-clear-errors",
    date: "2026-11-01",
    title: "Clear errors with Retry",
    body: "If a page cannot load, you see a plain message and a Retry button instead of endless loading, and anything already on screen stays.",
  },
  {
    id: "2026-11-01-faster-search",
    date: "2026-11-01",
    title: "Faster search",
    body: "Search across mail, tasks, docs and files stays quick when the whole team is busy.",
  },
  {
    id: "2026-11-01-office-files",
    date: "2026-11-01",
    title: "Office files in the browser",
    body: "Edit Word files and Excel sheets with working formulas right in Files, save each change as a version, and view slides.",
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
