/**
 * R118: Social P2b. What each network lets Multies do, the inbox (comments, messages and mentions from every account
 * in one list), the 24 hour reply window on Meta messages, results per post and account, the best time to post, and
 * the staging only test network. Pure: shared by the server, the web app and the tests.
 */
import { networkLabel } from "./social-p2";

/* ---------------------------------------------------------------- what each network allows */

export interface NetworkCaps { posts: boolean; comments: boolean; messages: boolean; mentions: boolean; analytics: boolean; note: string | null }

const caps = (c: Partial<NetworkCaps>): NetworkCaps => ({ posts: true, comments: false, messages: false, mentions: false, analytics: false, note: null, ...c });

/** Through each network's official API (layout plan section 8). LinkedIn is posting only until its review for pages. */
export const NETWORK_CAPS: Record<string, NetworkCaps> = {
  facebook: caps({ comments: true, messages: true, analytics: true }),
  instagram: caps({ comments: true, messages: true, mentions: true, analytics: true }),
  linkedin: caps({ note: "Posting only. LinkedIn shares comments and results only with apps it has reviewed for company pages." }),
  pinterest: caps({ analytics: true }),
  reddit: caps({ comments: true, messages: true, mentions: true }),
  threads: caps({ analytics: true, note: "Replies come once Threads approves reply access for Multies." }),
  tiktok: caps({ note: "Videos are posted from the TikTok card. Comments and results are not shared with Multies yet." }),
  twitter: caps({ note: "Posting only." }),
  testnet: caps({ comments: true, messages: true, mentions: true, analytics: true }),
};

export function capsOf(app: string): NetworkCaps { return NETWORK_CAPS[app] ?? caps({ note: "Posting only." }); }

/** "Posts, Comments, Messages, Analytics" style list for an account row. */
export function capList(app: string): string[] {
  const c = capsOf(app);
  return [c.posts && "Posts", c.comments && "Comments", c.messages && "Messages", c.mentions && "Mentions", c.analytics && "Analytics"].filter((x): x is string => !!x);
}

export const hasInbox = (app: string) => { const c = capsOf(app); return c.comments || c.messages || c.mentions; };
export const ANALYTICS_APPS = Object.keys(NETWORK_CAPS).filter((a) => NETWORK_CAPS[a]!.analytics);

/* ---------------------------------------------------------------- the inbox */

export const INBOX_KINDS = ["comment", "message", "mention", "reply"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export const INBOX_KIND_LABEL: Record<InboxKind, string> = { comment: "Comment", message: "Message", mention: "Mention", reply: "Reply" };
export type InboxStatus = "open" | "done";
export type InboxView = "all" | "mine" | "unassigned";

/** Rows one list read returns; older ones are reached with search or the network filter. */
export const INBOX_PAGE = 100;
export const INBOX_TEXT_MAX = 4000;
export const REPLY_MAX = 2000;
export const NOTE_MAX = 2000;
export const SAVED_REPLIES_MAX = 50;
export const SAVED_TITLE_MAX = 60;
/** The inbox pulls again when it is opened and the last pull is older than this. */
export const INBOX_STALE_MS = 5 * 60_000;

/** Meta takes a reply to a Page or Instagram message only within 24 hours of the person's last message. */
export const META_REPLY_WINDOW_MS = 24 * 3_600_000;
const WINDOW_APPS = new Set(["facebook", "instagram", "testnet"]);

export type ReplyWindow = { state: "none" } | { state: "open"; leftMs: number; text: string } | { state: "closed"; text: string };

export function fmtLeft(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h`;
}

export function replyWindow(app: string, kind: InboxKind, lastInboundAt: string | number | Date | null, now: number): ReplyWindow {
  if (kind !== "message" || !WINDOW_APPS.has(app) || lastInboundAt == null) return { state: "none" };
  const at = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(at)) return { state: "none" };
  const left = at + META_REPLY_WINDOW_MS - now;
  if (left <= 0) return { state: "closed", text: `Reply window closed. ${networkLabel(app)} only takes replies within 24 hours of their last message.` };
  return { state: "open", leftMs: left, text: `Reply within ${fmtLeft(left)}` };
}

export interface InboxItemView {
  id: string; accountId: string; app: string; accountLabel: string; kind: InboxKind; status: InboxStatus;
  authorName: string | null; authorHandle: string | null; text: string; postUrl: string | null; postText: string | null;
  receivedAt: string; lastInboundAt: string | null; repliedAt: string | null;
  assigneeId: string | null; assigneeName: string | null; contactId: string | null; contactName: string | null; taskId: string | null;
}
export interface InboxNoteView { id: string; kind: "note" | "reply"; text: string; authorId: string | null; authorName: string | null; status: "sent" | "failed"; error: string | null; createdAt: string }
export interface InboxSourceView { accountId: string; app: string; label: string; state: "ok" | "error" | "posting_only" | "waiting"; text: string | null; syncedAt: string | null }
export interface InboxCounts { open: number; mine: number; unassigned: number; done: number }
export interface InboxListResponse { items: InboxItemView[]; counts: InboxCounts; sources: InboxSourceView[]; syncedAt: string | null; stale: boolean; canManage: boolean; test: boolean; me: string; people: { id: string; name: string }[] }
export interface InboxThreadResponse { item: InboxItemView; notes: InboxNoteView[] }
export interface SavedReplyView { id: string; title: string; body: string }

/** The list query as the page sends it; anything unknown falls back to the default. */
export function parseInboxQuery(q: Record<string, string | undefined>) {
  const status: InboxStatus = q.status === "done" ? "done" : "open";
  const view: InboxView = q.view === "mine" || q.view === "unassigned" ? q.view : "all";
  const app = q.app && /^[a-z_]{2,30}$/.test(q.app) ? q.app : null;
  const search = (q.q ?? "").trim().slice(0, 100) || null;
  return { status, view, app, search };
}

/** Fills {name} in a saved reply with the author's first name (or drops it cleanly when there is none). */
export function fillSavedReply(body: string, authorName: string | null): string {
  const first = (authorName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? body.replace(/\{name\}/g, first) : body.replace(/\s*\{name\}/g, "").replace(/^\s*,\s*/, "").replace(/\s+([,.!?])/g, "$1");
}

/* ---------------------------------------------------------------- analytics */

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
/** Stat rows one analytics read returns at most. */
export const ANALYTICS_ROWS = 500;
/** Posts needed before best times are shown. */
export const BEST_TIME_MIN_POSTS = 5;

export interface PostStatRow { postId: string; accountId: string; app: string; label: string; text: string; url: string | null; sentAt: string; reach: number | null; engagement: number | null; clicks: number | null }
export interface AnalyticsResponse { range: number; rows: PostStatRow[]; sent: number; syncedAt: string | null; stale: boolean; accounts: { accountId: string; app: string; label: string; supported: boolean }[]; test: boolean }

export interface Totals { posts: number; reach: number; engagement: number; clicks: number; rate: number | null }

export function engagementRate(reach: number | null, engagement: number | null): number | null {
  if (!reach || reach <= 0 || engagement == null) return null;
  return engagement / reach;
}

export function totalsOf(rows: Pick<PostStatRow, "postId" | "reach" | "engagement" | "clicks">[]): Totals {
  const posts = new Set(rows.map((r) => r.postId)).size;
  let reach = 0, engagement = 0, clicks = 0;
  for (const r of rows) { reach += r.reach ?? 0; engagement += r.engagement ?? 0; clicks += r.clicks ?? 0; }
  return { posts, reach, engagement, clicks, rate: engagementRate(reach, engagement) };
}

export function byAccount(rows: PostStatRow[]): (Totals & { accountId: string; app: string; label: string })[] {
  const m = new Map<string, PostStatRow[]>();
  for (const r of rows) m.set(r.accountId, [...(m.get(r.accountId) ?? []), r]);
  return [...m.entries()].map(([accountId, list]) => ({ accountId, app: list[0]!.app, label: list[0]!.label, ...totalsOf(list) })).sort((a, b) => b.engagement - a.engagement);
}

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface BestTimes { ready: boolean; posts: number; need: number; grid: (number | null)[][]; top: { day: number; hour: number; rate: number }[] }

/**
 * Engagement rate by weekday (Monday first) and hour in the viewer's time zone, from posts that have results.
 * tzOffsetMin is Date.getTimezoneOffset() of the viewer (minutes behind UTC, so Sydney is -660).
 */
export function bestTimes(rows: Pick<PostStatRow, "sentAt" | "reach" | "engagement">[], tzOffsetMin: number): BestTimes {
  const sums: { rate: number; n: number }[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ rate: 0, n: 0 })));
  let posts = 0;
  for (const r of rows) {
    const rate = engagementRate(r.reach, r.engagement);
    const t = Date.parse(r.sentAt);
    if (rate == null || !Number.isFinite(t)) continue;
    const local = new Date(t - tzOffsetMin * 60_000);
    const day = (local.getUTCDay() + 6) % 7;
    const cell = sums[day]![local.getUTCHours()]!;
    cell.rate += rate; cell.n += 1; posts += 1;
  }
  const grid = sums.map((row) => row.map((c) => (c.n ? c.rate / c.n : null)));
  const top = grid.flatMap((row, day) => row.map((rate, hour) => ({ day, hour, rate }))).filter((c): c is { day: number; hour: number; rate: number } => c.rate != null)
    .sort((a, b) => b.rate - a.rate || a.day - b.day || a.hour - b.hour).slice(0, 3);
  return { ready: posts >= BEST_TIME_MIN_POSTS, posts, need: Math.max(0, BEST_TIME_MIN_POSTS - posts), grid, top };
}

export function fmtCount(n: number | null | undefined): string {
  if (n == null) return "No data";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
export const fmtRate = (r: number | null) => (r == null ? "No data" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
export function fmtHour(h: number): string { const am = h < 12; const v = h % 12 === 0 ? 12 : h % 12; return `${v} ${am ? "am" : "pm"}`; }

/* ---------------------------------------------------------------- the test network (staging only) */

export const TEST_NETWORK = "testnet";
export const TEST_ACCOUNT_ID = "direct:testnet";
export const TEST_NETWORK_LABEL = "Test network";

/**
 * The test network exists only where SOCIAL_TEST_NETWORK=on AND the app runs on staging or a local machine. The
 * production address refuses it whatever the switch says, so prod code paths can never reach it.
 */
export function testNetworkAllowed(env: { SOCIAL_TEST_NETWORK?: string; APP_URL?: string; SENTRY_ENVIRONMENT?: string }): boolean {
  if ((env.SOCIAL_TEST_NETWORK ?? "").trim().toLowerCase() !== "on") return false;
  if ((env.SENTRY_ENVIRONMENT ?? "").trim().toLowerCase() === "production") return false;
  let host: string;
  try { host = new URL(env.APP_URL ?? "").hostname.toLowerCase(); } catch { return false; }
  if (host === "multies.si" || host === "www.multies.si" || host === "app.multies.si") return false;
  return host === "preview.multies.si" || host === "localhost" || host === "127.0.0.1" || /^[a-z0-9-]+-staging\.[a-z0-9-]+\.workers\.dev$/.test(host);
}
