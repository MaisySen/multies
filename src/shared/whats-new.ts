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
    body: "Files now has Team files, My files, Shared with me, Starred, Recent and Trash: drag files in, make folders, preview images, PDFs, video and audio, and share your own files with a teammate. Every file keeps up to 20 versions you can restore, deleted files wait 30 days in Trash, and you can move or download many at once as a zip. The Brand library keeps logos and templates with tags for everyone to use, and only admins can change it.",
  },
  {
    id: "2026-11-01-maps-visits",
    date: "2026-11-01",
    title: "Addresses, maps and a day of visits",
    body: "Contacts, companies and your booking page can now hold an address: start typing and pick a match to pin it on a map, with directions in one tap. Contacts has a Visits tab: add the people you are seeing today, put them in the shortest order with one tap and open the whole route in your maps app.",
  },
  {
    id: "2026-11-01-mail-archive",
    date: "2026-11-01",
    title: "Archive and retention for mail",
    body: "Admins can keep mail for a set number of years or forever, and see how many messages a policy would remove before turning it on. Legal holds keep a person's or a mailbox's mail from being deleted, and you can search the archive and export a case. Nothing is removed unless an admin turns a policy on.",
  },
  {
    id: "2026-11-01-docs-plus",
    date: "2026-11-01",
    title: "Link library, saved pages, comments on docs and spelling",
    body: "Docs has a Link library: keep links with tags, or save a public page as a clean doc you can read later, share or download as a PDF. Comment on any doc, and let people with a shared link comment too, after your review. Check spelling in docs and mail in 20 languages.",
  },
  {
    id: "2026-11-01-dav-sync",
    date: "2026-11-01",
    title: "Your calendar and contacts on your phone",
    body: "In Settings, Calendar, Sync with your phone: make an app password for each device and your meetings, task due dates, bookings and workspace contacts show up in the calendar and contacts apps on your phone and computer. Edits on the phone come back to Multies, and you can stop any device at once.",
  },
  {
    id: "2026-11-01-chat-plus",
    date: "2026-11-01",
    title: "Topics, announcements and votes in Chat",
    body: "Channels can have topics: pick one from the bar under the channel name to see just that conversation, with its own unread count, and mark it resolved with a tick when it is done. Admins can post announcements that are pinned and show who has seen them, all in one Announcements list. Use Add next to the message box for a poll, a decision (agree, abstain, disagree or block, with the outcome posted when it closes), live questions with upvotes, or a word cloud; during a call, the Live panel runs the same polls and questions.",
  },
  {
    id: "2026-11-01-client-portals",
    date: "2026-11-01",
    title: "Client portals for the people you work with",
    body: "In Contacts, Client portals gives each client a private space they open from an email link, no password needed. Share files, docs and task updates, ask them for files, and message back and forth. Each client only ever sees their own space.",
  },
  {
    id: "2026-11-01-dashboards-plus",
    date: "2026-11-01",
    title: "Share dashboards, email reports, ask your own questions",
    body: "Share a dashboard by link, with an expiry and an optional password, so clients see the numbers without an account. Email it daily, weekly or monthly with a PDF. Build your own card from tasks, deals, form responses, bookings, time, mail or a CSV, and get an alert once when a number crosses a line.",
  },
  {
    id: "2026-11-01-notification-centre",
    date: "2026-11-01",
    title: "Quiet hours, digests and mail for notifications",
    body: "In Settings, Notifications, choose mail as well as the inbox and your phone for each kind of notification, and get it as it happens or in one daily or weekly digest. Set quiet hours in your own time zone, or pause alerts for a while from the Notifications page.",
  },
  {
    id: "2026-11-01-help-center",
    date: "2026-11-01",
    title: "A public help center for your customers",
    body: "Docs, Help center publishes chosen docs as articles with categories and search, lets visitors ask questions that you approve and answer, and turns a solved ticket into a public answer with the customer's details taken out.",
  },
  {
    id: "2026-10-31-esign-v2",
    date: "2026-10-31",
    title: "Signing with an email code, templates and a check page",
    body: "Tools, Sign now emails each signer a one time code and asks them to agree to sign electronically, and keeps a full signing record with time, time zone, device and document fingerprints that you can download. Save a request as a template and send it again, or send a one signer template to a list of up to 50 people. Anyone can check a signed copy on the public check page, which reads only the file's fingerprint.",
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
