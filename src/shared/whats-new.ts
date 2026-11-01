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
    id: "2026-10-31-tools-round-c",
    date: "2026-10-31",
    title: "Fix a PDF, slides, image links and everyday utilities",
    body: "Tools, Fix a PDF repairs a damaged PDF, makes it open fast on the web, or locks it with a password. You can put a QR code or barcode on any page, read every comment in a PDF, and turn slides and drawings (PPTX, PPT, ODP, ODG) into a PDF or into each other. Image links resize, crop and convert a picture from Files by its link, and the utilities cover JSON, Base64, hashes, colours, units, timestamps, regex and a link preview.",
  },
  {
    id: "2026-10-31-crm-timeline",
    date: "2026-10-31",
    title: "A timeline for every contact and company",
    body: "Each contact and company now has one timeline of email, meetings, bookings, forms, deals and tasks, and you can log a note, call or meeting and set the next step. Add companies by hand, import contacts from a CSV file without doubles, and save filters as segments. Deals show a chance to win, why they were won or lost, and a weighted forecast.",
  },
  {
    id: "2026-10-31-social-planner-library",
    date: "2026-10-31",
    title: "Social: plan, reply and see results",
    body: "Social has an Inbox for comments, messages and mentions from every account, with assigning, saved replies and notes, and Analytics with reach, clicks and your best times to post. Pick a format, give each network its own text and see a live preview before you send, now with TikTok videos and Threads posts in the same composer. The Planner has week, month and list views, weekly time slots to fill and drag to move, members can send posts for approval in Home, Approvals, and Library keeps images, captions and hashtag sets by campaign.",
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
