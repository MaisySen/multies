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
    id: "2026-11-03-nepali-hindi",
    date: "2026-11-03",
    title: "Multies in Nepali and Hindi",
    body: "Pick English, नेपाली or हिन्दी in Settings, Appearance and the app changes straight away, with dates and numbers written the way your language writes them. Sign in pages follow your browser's language, and workspace admins can suggest a better wording.",
  },
  {
    id: "2026-11-03-phone-parity",
    date: "2026-11-03",
    title: "Everything on your phone, and the iPhone beta",
    body: "Every action from a computer is now in reach on a phone: row actions show without hovering, docs keep less used actions under More, and the task list can be sorted. Saved call videos show their length, and anyone can join the iPhone beta from the home page.",
  },
  {
    id: "2026-11-03-translate-read-aloud",
    date: "2026-11-03",
    title: "Translate and read aloud",
    body: "Translate a mail, a doc or a chat message into English, Nepali, Hindi and nine more languages, then switch back to the original with one tap. Read aloud uses your device's own voices, with pause, stop and speed.",
  },
  {
    id: "2026-11-03-polish-phone-themes",
    date: "2026-11-03",
    title: "Easier to tap, clearer in every theme",
    body: "Buttons, tabs and filters are easier to tap on phones, colours follow your theme in light, dark and Forest, and big numbers read with commas, like 1,500 due today. Rows you add to a table take your typing straight away.",
  },
  {
    id: "2026-11-03-video-recording-plus",
    date: "2026-11-03",
    title: "Pause, speaker view and safer call videos",
    body: "Pause and resume a call video while everyone sees it is paused, and switch between speaker and gallery view as you record. The chat and transcript save next to the video, and if the tab crashes, Recover last recording brings it back from this device.",
  },
  {
    id: "2026-11-03-video-recording",
    date: "2026-11-03",
    title: "Save a video of your calls",
    body: "Owners and admins can save a video of the whole call, with every camera, shared screen and voice, straight to their own device. Nothing is uploaded, and everyone in the call sees a Recording banner.",
  },
  {
    id: "2026-11-03-polish-devices",
    date: "2026-11-03",
    title: "Devices, clearer errors and quicker search",
    body: "Account and security lists every device you are signed in on, even hours after you sign in. Notifications, Billing and Meetings say when they could not load and offer Retry, and Ctrl K finds your contacts by name or email.",
  },
  {
    id: "2026-11-03-several-pages",
    date: "2026-11-03",
    title: "Several Facebook Pages and LinkedIn accounts",
    body: "Choose which of your Facebook Pages to post to in Social, Accounts, and connect more than one LinkedIn account. Pick each Page or account when you write, and your last choice is remembered.",
  },
  {
    id: "2026-11-03-new-look-passkeys",
    date: "2026-11-03",
    title: "A fresh look, and passkeys",
    body: "The app has a calmer, layered look with clearer navigation in light and dark. Add a passkey in Account and security, then sign in with Face ID, your fingerprint or your device PIN.",
  },
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
