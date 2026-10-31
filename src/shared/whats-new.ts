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
    id: "2026-10-31-connections",
    date: "2026-10-31",
    title: "Connect your social accounts and post once",
    body: "Settings, Connections lists the apps your workspace can connect, with social networks first, and you can add more than one account per app. Connect Facebook Pages, Instagram, LinkedIn, Pinterest or Reddit, then write one post with an image and send it now or at a set time. Each account shows its own result.",
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
    id: "2026-10-31-tools-smoother",
    date: "2026-10-31",
    title: "Tools that tell you sooner",
    body: "A run that leaves your file unchanged no longer uses a run. Page limits show as soon as you pick a file, with Split PDF one tap away. Results show a bigger first page you can tap to see larger, and the board's Move menu now stays open.",
  },
  {
    id: "2026-10-31-compress-levels",
    date: "2026-10-31",
    title: "Pick how small, and see your result",
    body: "Compress now has Light, Balanced and Smallest, each saying what to expect. Scanned PDFs shrink a lot more than before. A finished PDF shows a picture of its first page, so you can check it before you download.",
  },
  {
    id: "2026-10-31-tools-one-look",
    date: "2026-10-31",
    title: "Every tool, one look",
    body: "Edit pages, forms, compare, share links, workflows and templates now open like every other tool: the full list stays on the left, All tools takes you back, and you always see how many runs are left. Page thumbnails are bigger on a phone.",
  },
  {
    id: "2026-10-30-tools-pages-forms",
    date: "2026-10-30",
    title: "Edit pages, fill forms and compare PDFs",
    body: "Drag to reorder, turn or delete the pages of a PDF, fill PDF forms and flatten them, and compare two versions of a PDF page by page. Tools also has a new look, with search, clear groups and progress you can follow and cancel.",
  },
  {
    id: "2026-10-30-tools-share-workflows",
    date: "2026-10-30",
    title: "Share links, workflows and templates",
    body: "Send a big file as a link that expires, with an optional password and download limit. Chain tools into a saved workflow, fill an invoice, quote or letter from a template with GST worked out, and let rules compress big PDFs as you attach them.",
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
