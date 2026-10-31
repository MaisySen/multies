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
    id: "2026-10-31-tools-round-b",
    date: "2026-10-31",
    title: "Video, sound, ebooks, archives and Edit a PDF",
    body: "Convert any file now handles videos and sound (MP4, MOV, MP3, WAV, GIF and more), EPUB and MOBI ebooks, HEIC photos in any browser, and ZIP, 7Z and TAR archives. It also makes files smaller with the size before and after, and reads scans into searchable PDFs or text. Tools, Edit a PDF adds text, a signature, black out boxes, a watermark and page numbers, all on your device.",
  },
  {
    id: "2026-10-31-social-home",
    date: "2026-10-31",
    title: "Social has its own place",
    body: "Social now sits in the left rail with a Planner calendar, Posts with how each account did, New post and Accounts. Connect Facebook Pages, Instagram, LinkedIn, Pinterest or Reddit, write one post and send it now or later; networks that can't take it are greyed out with the reason. Agents moved to the rail too, and Workspace is now called Settings, with one sidebar.",
  },
  {
    id: "2026-10-31-tasks-views-tags",
    date: "2026-10-31",
    title: "Saved views, tags and a full task page",
    body: "Save the filters, sort and grouping you use as a view, keep it for yourself or share it, and pin it as a tab above Tasks. Group the list by status, person, priority, due date, tag or any field, put several people on a task, and give tags their own colours. Every task opens as a full page too, with a description you can format and @mention people in.",
  },
  {
    id: "2026-10-31-inbox-tabs-rules",
    date: "2026-10-31",
    title: "Inbox tabs, labels and mail rules",
    body: "Pick how Inbox is sorted: Important and Other, Primary, Updates and Promotions, or one list. Drag a message onto a tab or use Move to tab and mail from that sender goes there next time. Mail rules label, sort, forward, reply, make a task or notify you as new mail arrives, and you can test a rule on recent mail before you save it.",
  },
  {
    id: "2026-10-31-tiktok-threads",
    date: "2026-10-31",
    title: "Post to TikTok and Threads",
    body: "Connect your TikTok and Threads accounts in Social, Accounts. Post a video to TikTok, choosing who can see it and whether people can comment, duet or stitch, and post text or a picture to Threads. Your latest videos and posts show right there.",
  },
  {
    id: "2026-10-31-one-place-connections",
    date: "2026-10-31",
    title: "One place for everything you connect",
    body: "Settings, Connections now holds your apps, other mail accounts and webhooks as tabs, so there is one place to look. Compose tells you before you write when a From address needs its domain verified, and every page now has its own name in the browser tab.",
  },
  {
    id: "2026-10-31-multies-everywhere",
    date: "2026-10-31",
    title: "Multies everywhere",
    body: "Every page, download, code sample and setup step now says Multies. The Email Worker setup in Settings, Mail routing shows MULTIES names, and workers you set up before keep working with no change.",
  },
  {
    id: "2026-10-31-calm-layout",
    date: "2026-10-31",
    title: "A calmer layout you can shape",
    body: "A slim icon rail and a sidebar for each area, with your favourite projects on top. Drag to size the sidebar, the Mail reading pane (right, below or off) and task details, and pick Comfortable or Compact under View. Create and search live in the top bar, and Ctrl \\ (Cmd \\ on a Mac) hides the sidebar.",
  },
  {
    id: "2026-10-31-convert-any-file",
    date: "2026-10-31",
    title: "Convert any file, most of them right on your device",
    body: "Tools, Convert any file: drop one file or fifty and pick what they should become. Photos, PDFs and spreadsheets convert in your browser with nothing uploaded, and you can download each result or all of them as one ZIP. Merge, split, rotate and number PDF pages there too.",
  },
  {
    id: "2026-10-31-workspace-brand",
    date: "2026-10-31",
    title: "Make Multies look like your company",
    body: "Owners and admins can add your logo, pick colours, corners, density and a font, or start from a ready made theme, with a live preview in Settings, Brand. Everyone can set their own accent and light or dark look in Settings, Appearance. Tools has a bigger drop zone and clearer tool cards.",
  },
  {
    id: "2026-10-31-developers-faster-pages",
    date: "2026-10-31",
    title: "A home for developers, and quicker pages",
    body: "The new Developers page gathers the API, MCP tools, agent inboxes and webhooks in one place, and the MCP tools page shows up properly in search and link previews again. Pricing, legal, status and the other public pages now appear right away on a phone, before the app finishes loading.",
  },
  {
    id: "2026-10-31-timeline-views",
    date: "2026-10-31",
    title: "A clearer timeline, and pages that use your screen",
    body: "Timeline shows Day, Week or Month, a Today button, bars coloured by status and a card with dates and owner when you point at one. It is only as tall as your tasks, and on a phone it reads as a list by week. Tasks, boards and templates now use the full width next to the sidebar.",
  },
  {
    id: "2026-10-31-split-keep-faster",
    date: "2026-10-31",
    title: "Split in one tap, and your file stays put",
    body: "Split PDF offers Every page, Every few pages or Two halves, and shows the parts before you run it. A picked file in Tools comes back after a reload, and leaving with it unsaved asks first. The app also opens faster on a slow phone signal.",
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
