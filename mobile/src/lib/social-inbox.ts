import { capBadge } from "./numbers";
/**
 * 1.10.8: the Social inbox and account health on the phone, the same as the web's Social inbox (server R118).
 * Types and rules mirror the server's shared module (src/shared/social-p2b.ts in the web app), so the phone shows the
 * same words. The server enforces every rule; the phone only hides what would be refused.
 */

export interface NetworkCaps { posts: boolean; comments: boolean; messages: boolean; mentions: boolean; analytics: boolean; note: string | null }
const caps = (c: Partial<NetworkCaps>): NetworkCaps => ({ posts: true, comments: false, messages: false, mentions: false, analytics: false, note: null, ...c });

/** What each network shares with Multies (the web's list, word for word). */
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

/** "Posts, Comments, Messages, Analytics" for an account row. */
export function capList(app: string): string[] {
  const c = capsOf(app);
  return [c.posts && "Posts", c.comments && "Comments", c.messages && "Messages", c.mentions && "Mentions", c.analytics && "Analytics"].filter((x): x is string => !!x);
}

/** The capabilities line under an account: "Posting only" for networks that share nothing back. */
export function capLine(app: string): string {
  const list = capList(app);
  return list.length <= 1 ? "Posting only" : list.join(", ");
}

export const hasInbox = (app: string) => { const c = capsOf(app); return c.comments || c.messages || c.mentions; };

export type InboxKind = "comment" | "message" | "mention" | "reply";
export const INBOX_KIND_LABEL: Record<InboxKind, string> = { comment: "Comment", message: "Message", mention: "Mention", reply: "Reply" };
export type InboxStatus = "open" | "done";

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
export interface InboxPatch { status?: InboxStatus; assigneeId?: string | null }

export const REPLY_MAX = 2000;
export const NOTE_MAX = 2000;
/** The inbox asks the server to pull again when it opens and the last pull is older than this (as the web does). */
export const INBOX_STALE_MS = 5 * 60_000;

/** The four filters, the same as the web's: open for everyone, mine, nobody's, done. */
export type InboxFilter = "all" | "mine" | "unassigned" | "done";
export const INBOX_FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "Open" }, { id: "mine", label: "Mine" }, { id: "unassigned", label: "Unassigned" }, { id: "done", label: "Done" },
];
/** The query the server reads (status, view). */
export function inboxQuery(f: InboxFilter): string {
  if (f === "done") return "?status=done";
  if (f === "mine") return "?status=open&view=mine";
  if (f === "unassigned") return "?status=open&view=unassigned";
  return "?status=open";
}
export function filterCount(c: InboxCounts | undefined, f: InboxFilter): number | undefined {
  if (!c) return undefined;
  return f === "all" ? c.open : f === "mine" ? c.mine : f === "unassigned" ? c.unassigned : c.done;
}

/* ---------------------------------------------------------------- the reply window */

/** Meta takes a reply to a Page or Instagram message only within 24 hours of the person's last message. */
export const META_REPLY_WINDOW_MS = 24 * 3_600_000;
const WINDOW_APPS = new Set(["facebook", "instagram", "testnet"]);
const NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", reddit: "Reddit", testnet: "Test network", threads: "Threads", tiktok: "TikTok", pinterest: "Pinterest", twitter: "X" };
export const networkLabel = (app: string) => NAMES[app] ?? app.charAt(0).toUpperCase() + app.slice(1);

export type ReplyWindow = { state: "none" } | { state: "open"; leftMs: number; text: string; soon: boolean } | { state: "closed"; text: string };

export function fmtLeft(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h`;
}

/** "Reply window closes in 5 h", or closed with what to do. Only messages on Facebook and Instagram have one. */
export function replyWindow(app: string, kind: InboxKind, lastInboundAt: string | number | Date | null, now: number): ReplyWindow {
  if (kind !== "message" || !WINDOW_APPS.has(app) || lastInboundAt == null) return { state: "none" };
  const at = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(at)) return { state: "none" };
  const left = at + META_REPLY_WINDOW_MS - now;
  if (left <= 0) return { state: "closed", text: `Reply window closed. ${networkLabel(app)} only takes replies within 24 hours of their last message. Reply in ${networkLabel(app)} itself, or wait for them to write again.` };
  return { state: "open", leftMs: left, text: `Reply window closes in ${fmtLeft(left)}`, soon: left < 2 * 3_600_000 };
}

/* ---------------------------------------------------------------- assigning */

/** Members take a conversation or let go of their own; owners and admins hand it to anyone (the server's rule). */
export function assignChoices(item: Pick<InboxItemView, "assigneeId">, me: string, canManage: boolean, people: { id: string; name: string }[]): { id: string | null; label: string }[] {
  if (canManage) {
    const out: { id: string | null; label: string }[] = people.map((p) => ({ id: p.id, label: p.id === me ? `${p.name} (you)` : p.name }));
    if (item.assigneeId) out.push({ id: null, label: "Nobody" });
    return out.filter((o) => o.id !== item.assigneeId);
  }
  if (item.assigneeId === me) return [{ id: null, label: "Let go" }];
  if (!item.assigneeId) return [{ id: me, label: "Take it" }];
  return [];
}

export function canAssignTo(item: Pick<InboxItemView, "assigneeId">, to: string | null, me: string, canManage: boolean): boolean {
  if (canManage) return true;
  return to === me || (to === null && item.assigneeId === me);
}

export function assigneeLine(item: Pick<InboxItemView, "assigneeId" | "assigneeName">, me: string): string {
  if (!item.assigneeId) return "Nobody yet";
  if (item.assigneeId === me) return "You";
  return item.assigneeName ?? "A teammate";
}

/* ---------------------------------------------------------------- words */

export function whoWrote(item: Pick<InboxItemView, "authorName" | "authorHandle">): string {
  return item.authorName ?? (item.authorHandle ? `@${item.authorHandle.replace(/^@/, "")}` : "Someone");
}

/** Fills {name} in a saved reply with the author's first name (the web's rule). */
export function fillSavedReply(body: string, authorName: string | null): string {
  const first = (authorName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? body.replace(/\{name\}/g, first) : body.replace(/\s*\{name\}/g, "").replace(/^\s*,\s*/, "").replace(/\s+([,.!?])/g, "$1");
}

/** Why the inbox is empty: networks still waiting on review, sign ins to renew, or simply nothing new. */
export function emptyInbox(f: InboxFilter, sources: InboxSourceView[]): { title: string; body: string } {
  if (f === "done") return { title: "Nothing done yet", body: "Conversations you mark done show here." };
  if (f === "mine") return { title: "Nothing for you", body: "Conversations you take or are given show here." };
  if (f === "unassigned") return { title: "Everything has someone", body: "Every open conversation is taken." };
  const reading = sources.filter((s) => s.state === "ok");
  const broken = sources.filter((s) => s.state === "error");
  if (broken.length) return { title: "No messages yet", body: `${broken.map((s) => s.label).join(", ")} needs signing in again before messages can come in. Open Accounts to reconnect.` };
  if (!reading.length) return { title: "No messages yet", body: "Comments and messages show here once a network that shares them is connected. Facebook and Instagram share them once their review of Multies is done. LinkedIn is posting only." };
  return { title: "No messages yet", body: "New comments, messages and mentions show here. Pull down to check again." };
}

export function sourceLine(s: InboxSourceView): string {
  if (s.state === "posting_only") return `${s.label}: posting only`;
  if (s.state === "error") return `${s.label}: ${s.text ?? "sign in needs renewing"}`;
  if (s.state === "waiting") return `${s.label}: ${s.text ?? "waiting on the network"}`;
  return s.label;
}

/** Broken accounts first (the web pins them to the top of Accounts), the rest keep their order. */
export function pinBroken<T>(list: T[], broken: (x: T) => boolean): T[] {
  return [...list.filter(broken), ...list.filter((x) => !broken(x))];
}

/** Badge text on the Social entry: open conversations, capped. */
export function badgeText(n: number | undefined): string | null {
  return capBadge(n);
}

/** A list item with the server's newer copy put in place. */
export function putItem(list: InboxItemView[], item: InboxItemView): InboxItemView[] {
  return list.map((x) => (x.id === item.id ? item : x));
}
