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
    title: "Fix a PDF, codes on a PDF and everyday utilities",
    body: "Tools, Fix a PDF repairs a damaged PDF, makes it open fast on the web, or locks it with a password. You can also put a QR code or barcode on any page, read every comment and highlight in a PDF, and use quick utilities for JSON, YAML and CSV, Base64, hashes, UUIDs, colours, units, timestamps, text diff and regex. All of it runs on your device.",
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
    id: "2026-10-31-automation-flows",
    date: "2026-10-31",
    title: "Flows: automations you can see",
    body: "Automations has a new home under Agents, where you build a flow on a canvas from a trigger, conditions with yes and no paths, waits, an approval step and actions. Flows can watch a web page or a news feed, gather items into a morning digest, or send signed events to a webhook. Every run shows each step with what went in and what came out, and a failed run can be tried again from that step.",
  },
  {
    id: "2026-10-31-docs-visual",
    date: "2026-10-31",
    title: "Whiteboards, diagrams, mind maps and slides in Docs",
    body: "Start a whiteboard from Docs and draw on it together, with everyone's cursor showing, or add one inside any doc with /whiteboard. Type /flowchart for a diagram drawn from text, flip a doc to Mind map to see and edit it as a tree, and press Present to show it as slides with speaker notes and a timer.",
  },
  {
    id: "2026-10-31-links",
    date: "2026-10-31",
    title: "Short links, QR codes and a link in bio page",
    body: "Tools, Links turns a long address into a short link with a QR code in your brand colour, an end date, a password or a click limit, and shows clicks by day, country and device with bots left out. Each person and the workspace can have a bio page, and go links like go/onboarding open a doc, task or project for your team.",
  },
  {
    id: "2026-10-31-secure-share",
    date: "2026-10-31",
    title: "Ask for files, and send secrets that delete themselves",
    body: "In Tools, Secure share lets clients upload big files to you through a request link, no account needed. Secret links lock a password or a small file on your device and delete it once opened, and Send securely in a new email does it in one step. Share links now show views as well as downloads.",
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
