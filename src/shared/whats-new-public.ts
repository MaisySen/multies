/**
 * W1: earlier live features for the public What's new page, below the in-app list (whats-new.ts, capped at 14 and
 * kept by each round). Newest first. Only features live on multies.si. Plain words, no dashes.
 */
import { WHATS_NEW, type WhatsNewEntry } from "./whats-new";

export const WHATS_NEW_EARLIER: readonly WhatsNewEntry[] = [
  { id: "2026-11-01-ask-workspace", date: "2026-11-01", title: "Ask your workspace", body: "Open Tools, then Ask your workspace (or type a question in the command menu and pick Ask AI). Answers come only from items you can open, with the sources listed. Save an answer to a doc, find old questions in your history, and approve any change it suggests: nothing changes until you click Apply." },
  { id: "2026-11-01-contracts", date: "2026-11-01", title: "Contract templates, and signing with an email code", body: "Tools, Templates, Contracts has plain words templates for a service agreement, an NDA, a contractor agreement, quote terms and a privacy notice: answer a few questions, check the preview, then save a Doc, download a PDF or Word file, add renewal reminders as tasks, or send it to sign. Admins keep the workspace's own versions and a clause library with versions. Signing emails each signer a one time code and keeps a full signing record that anyone can check on the public check page." },
  { id: "2026-11-01-tasks-plus", date: "2026-11-01", title: "My Day, time blocking and a task mind map", body: "Plan today from My Work and drag tasks onto your day to block time. Repeat tasks every weekday, on the second Tuesday, or after they are done, and take turns between people. Tag time, see a day view, submit your week for approval, and rearrange a project as a mind map." },
  { id: "2026-11-01-newsletters", date: "2026-11-01", title: "Newsletters and welcome emails in Merge", body: "Tools > Merge now has Newsletters, Lists and Journeys: build a list with each person's consent, write from blocks with merge fields and a live preview, then send, schedule or start a welcome series. Every email has a one click unsubscribe that works across all your lists." },
  { id: "2026-11-01-files-plus", date: "2026-11-01", title: "Folders, versions and a brand library in Files", body: "Files now has Team files, My files, Shared with me, Starred, Recent and Trash: drag files in, make folders, preview images, PDFs, video and audio, and share your own files with a teammate. Every file keeps up to 20 versions you can restore, deleted files wait 30 days in Trash, and you can move or download many at once as a zip. The Brand library keeps logos and templates with tags for everyone to use, and only admins can change it, and Documents reads your bills, receipts and tax papers, finds the dates, amounts and GST, and rules tag and file them, with Unpaid bills and Tax documents one tap away." },
  { id: "2026-11-01-maps-visits", date: "2026-11-01", title: "Addresses, maps and a day of visits", body: "Contacts, companies and your booking page can now hold an address: start typing and pick a match to pin it on a map, with directions in one tap. Contacts has a Visits tab: add the people you are seeing today, put them in the shortest order with one tap and open the whole route in your maps app." },
  { id: "2026-11-01-docs-plus", date: "2026-11-01", title: "Link library, saved pages, comments on docs and spelling", body: "Docs has a Link library: keep links with tags, or save a public page as a clean doc you can read later, share or download as a PDF. Comment on any doc, and let people with a shared link comment too, after your review. Check spelling in docs and mail in 20 languages." },
  { id: "2026-11-01-dav-sync", date: "2026-11-01", title: "Your calendar and contacts on your phone", body: "In Settings, Calendar, Sync with your phone: make an app password for each device and your meetings, task due dates, bookings and workspace contacts show up in the calendar and contacts apps on your phone and computer. Edits on the phone come back to Multies, and you can stop any device at once." },
  { id: "2026-11-01-chat-plus", date: "2026-11-01", title: "Topics, announcements and votes in Chat", body: "Channels can have topics: pick one from the bar under the channel name to see just that conversation, with its own unread count, and mark it resolved with a tick when it is done. Admins can post announcements that are pinned and show who has seen them, all in one Announcements list. Use Add next to the message box for a poll, a decision (agree, abstain, disagree or block, with the outcome posted when it closes), live questions with upvotes, or a word cloud; during a call, the Live panel runs the same polls and questions." },
  { id: "2026-11-01-search", date: "2026-11-01", title: "Search that forgives typos", body: "Search finds what you meant with typos and words in any order, filters by type, and only ever shows what you can open." },
  { id: "2026-11-01-dashboards", date: "2026-11-01", title: "Dashboards you can share", body: "Share a dashboard by link, get it by email on a schedule, and set an alert when a number moves." },
  { id: "2026-11-01-social-inbox", date: "2026-11-01", title: "Social inbox and post results", body: "Answer comments and messages from your connected accounts in one inbox, and see how each post did." },
  { id: "2026-11-01-mail-archive", date: "2026-11-01", title: "Archive and retention for mail", body: "Admins can keep mail for a set number of years or forever, and see how many messages a policy would remove before turning it on. Legal holds keep a person's or a mailbox's mail from being deleted, and you can search the archive and export a case. Nothing is removed unless an admin turns a policy on." },
  { id: "2026-11-01-client-portals", date: "2026-11-01", title: "Client portals for the people you work with", body: "In Contacts, Client portals gives each client a private space they open from an email link, no password needed. Share files, docs and task updates, ask them for files, and message back and forth. Each client only ever sees their own space." },
  { id: "2026-10-31-notifications", date: "2026-10-31", title: "Notifications your way", body: "Pick per category what reaches you by mail, get a daily or weekly digest, set quiet hours, or pause everything." },
  { id: "2026-10-31-help-center", date: "2026-10-31", title: "A public help center", body: "Publish a knowledge base and questions and answers for your customers, written in Docs." },
  { id: "2026-10-31-esign", date: "2026-10-31", title: "Signing with a sealed record", body: "Signers confirm a code sent by email, and every signed document gets a sealed record and a page to check it." },
  { id: "2026-10-31-secure-share", date: "2026-10-31", title: "Secure sharing", body: "File request links, shares that expire with a view log, secret links that open once, and Send securely in Mail." },
  { id: "2026-10-31-tools", date: "2026-10-31", title: "PDF and office tools", body: "Open and convert office files, compress, repair and edit PDFs, read text from scans, and add QR codes." },
  { id: "2026-10-31-crm-timeline", date: "2026-10-31", title: "A timeline for every contact", body: "One activity stream per contact and company, with notes, private notes and filters." },
  { id: "2026-10-31-social-planner", date: "2026-10-31", title: "Social planner and approvals", body: "Plan posts on a calendar, keep drafts, get approval before posting, and keep images in a media library." },
  { id: "2026-10-31-automations", date: "2026-10-31", title: "Automation builder", body: "Build flows on a canvas, watch every run in the log, and send outgoing webhooks." },
  { id: "2026-10-31-docs-visual", date: "2026-10-31", title: "Diagrams and whiteboards in Docs", body: "Draw diagrams, mind maps and whiteboards inside a doc, and present it full screen." },
  { id: "2026-10-31-helpdesk", date: "2026-10-31", title: "Helpdesk mode and website chat", body: "Turn the shared inbox into tickets, and add a chat box to your website that lands in the same inbox." },
  { id: "2026-10-31-links", date: "2026-10-31", title: "Short links and link pages", body: "Make short links on your domain and a simple page of your links." },
];

/**
 * W1B: the public What's new list. The in-app list first, then earlier entries it does not already hold, ordered
 * newest first by date. Same day entries keep the order they are written in (the in-app list before the earlier one),
 * so the newest of a day goes at the top of the in-app list.
 */
export function publicWhatsNew(inApp: readonly WhatsNewEntry[] = WHATS_NEW, earlier: readonly WhatsNewEntry[] = WHATS_NEW_EARLIER): WhatsNewEntry[] {
  const ids = new Set(inApp.map((e) => e.id));
  const all = [...inApp, ...earlier.filter((e) => !ids.has(e.id))];
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || a.i - b.i)
    .map(({ e }) => e);
}
