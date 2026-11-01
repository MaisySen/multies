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
    id: "2026-11-01-booking-plus",
    date: "2026-11-01",
    title: "Book rooms, find a time together, run free events",
    body: "In Booking, new tabs let you book rooms, desks, vehicles and equipment on a day grid, with rules your admins set and QR check in. Time polls find a time that suits a group, and people answer without an account. Free events get a page, QR tickets by email, a waitlist and check in at the door from your phone.",
  },
  {
    id: "2026-11-01-invoices",
    date: "2026-11-01",
    title: "Invoices, quotes and expenses",
    body: "Send quotes customers can accept online, turn them into invoices in one click, and send tax invoices with your ABN and GST shown, a link to the PDF and your bank details. Record payments, credit notes, repeating invoices, bills and expenses (snap or forward a receipt and it is read, checked for GST and sent for approval), and see what you are owed and the GST for your BAS. Find it all in Contacts > Invoices.",
  },
  {
    id: "2026-11-01-ask-workspace",
    date: "2026-11-01",
    title: "Ask your workspace",
    body: "Open Tools, then Ask your workspace (or type a question in the command menu and pick Ask AI). Answers come only from items you can open, with the sources listed. Save an answer to a doc, find old questions in your history, and approve any change it suggests: nothing changes until you click Apply.",
  },
  {
    id: "2026-11-01-contracts",
    date: "2026-11-01",
    title: "Contract templates, and signing with an email code",
    body: "Tools, Templates, Contracts has plain words templates for a service agreement, an NDA, a contractor agreement, quote terms and a privacy notice: answer a few questions, check the preview, then save a Doc, download a PDF or Word file, add renewal reminders as tasks, or send it to sign. Admins keep the workspace's own versions and a clause library with versions. Signing emails each signer a one time code and keeps a full signing record that anyone can check on the public check page.",
  },
  {
    id: "2026-11-01-tasks-plus",
    date: "2026-11-01",
    title: "My Day, time blocking and a task mind map",
    body: "Plan today from My Work and drag tasks onto your day to block time. Repeat tasks every weekday, on the second Tuesday, or after they are done, and take turns between people. Tag time, see a day view, submit your week for approval, and rearrange a project as a mind map.",
  },
  {
    id: "2026-11-01-newsletters",
    date: "2026-11-01",
    title: "Newsletters and welcome emails in Merge",
    body: "Tools > Merge now has Newsletters, Lists and Journeys: build a list with each person's consent, write from blocks with merge fields and a live preview, then send, schedule or start a welcome series. Every email has a one click unsubscribe that works across all your lists.",
  },
  {
    id: "2026-11-01-files-plus",
    date: "2026-11-01",
    title: "Folders, versions and a brand library in Files",
    body: "Files now has Team files, My files, Shared with me, Starred, Recent and Trash: drag files in, make folders, preview images, PDFs, video and audio, and share your own files with a teammate. Every file keeps up to 20 versions you can restore, deleted files wait 30 days in Trash, and you can move or download many at once as a zip. The Brand library keeps logos and templates with tags for everyone to use, and only admins can change it, and Documents reads your bills, receipts and tax papers, finds the dates, amounts and GST, and rules tag and file them, with Unpaid bills and Tax documents one tap away.",
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
