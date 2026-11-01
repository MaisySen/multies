/**
 * W1: earlier live features for the public What's new page, below the in-app list (whats-new.ts, capped at 14 and
 * kept by each round). Newest first. Only features live on multies.si. Plain words, no dashes.
 */
import type { WhatsNewEntry } from "./whats-new";

export const WHATS_NEW_EARLIER: readonly WhatsNewEntry[] = [
  { id: "2026-11-01-search", date: "2026-11-01", title: "Search that forgives typos", body: "Search finds what you meant with typos and words in any order, filters by type, and only ever shows what you can open." },
  { id: "2026-11-01-dashboards", date: "2026-11-01", title: "Dashboards you can share", body: "Share a dashboard by link, get it by email on a schedule, and set an alert when a number moves." },
  { id: "2026-11-01-clear-errors", date: "2026-11-01", title: "Clear errors with Retry", body: "If a page cannot load, you see a plain message and a Retry button instead of endless loading, and anything already on screen stays." },
  { id: "2026-11-01-faster-search", date: "2026-11-01", title: "Faster search", body: "Search across mail, tasks, docs and files stays quick when the whole team is busy." },
  { id: "2026-11-01-office-files", date: "2026-11-01", title: "Office files in the browser", body: "Edit Word files and Excel sheets with working formulas right in Files, save each change as a version, and view slides." },
  { id: "2026-11-01-social-inbox", date: "2026-11-01", title: "Social inbox and post results", body: "Answer comments and messages from your connected accounts in one inbox, and see how each post did." },
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
