import { tr } from "@/i18n";
/**
 * 1.10.5: social posting on the phone. The same contract as the web (/api/social, /api/apps, /api/direct),
 * copied here because the phone app builds on its own. Keep in step with the web's shared integrations file.
 */

export type AccountStatus = "active" | "pending" | "expired" | "failed" | "disabled";

export interface ConnectedAccountView {
  id: string;
  app: string;
  appName: string;
  logo: string | null;
  status: AccountStatus;
  label: string | null;
  createdAt: string;
}

export interface SocialNetwork {
  app: string;
  maxChars: number;
  /** "required": a post needs an image. "optional": text alone works. "none": the image is left off. */
  image: "required" | "optional" | "none";
  target: null | { kind: "page" | "board" | "subreddit"; label: string };
}

export const SOCIAL_NETWORKS: Record<string, SocialNetwork> = {
  facebook: { app: "facebook", maxChars: 63206, image: "optional", target: { kind: "page", label: "Page" } },
  instagram: { app: "instagram", maxChars: 2200, image: "required", target: null },
  linkedin: { app: "linkedin", maxChars: 3000, image: "none", target: null },
  pinterest: { app: "pinterest", maxChars: 800, image: "required", target: { kind: "board", label: "Board" } },
  reddit: { app: "reddit", maxChars: 40000, image: "none", target: { kind: "subreddit", label: "Community" } },
  twitter: { app: "twitter", maxChars: 280, image: "none", target: null },
  threads: { app: "threads", maxChars: 500, image: "optional", target: null },
};

export const canPostTo = (app: string) => app in SOCIAL_NETWORKS;

export type PostStatus = "scheduled" | "sending" | "done" | "partial" | "failed" | "canceled";
export type TargetStatus = "pending" | "sent" | "failed" | "skipped";

export interface PostTargetView {
  accountId: string;
  app: string;
  label: string | null;
  target: string | null;
  targetName: string | null;
  status: TargetStatus;
  url: string | null;
  error: string | null;
  sentAt: string | null;
  /**
   * 1.10.6: what the network said when Multies last checked (Facebook only today). "removed" means the post was
   * deleted on the network; its url then comes back null. Older servers leave these fields out.
   */
  networkState?: "live" | "removed" | null;
  checkedAt?: string | null;
  /** True where Multies can ask the network whether the post is still there (Facebook). */
  canCheck?: boolean;
  /** True where Delete in Multies also deletes the post on the network (Facebook, LinkedIn). */
  canDelete?: boolean;
}

export interface SocialPostView {
  id: string;
  text: string;
  imageUrl: string | null;
  status: PostStatus;
  runAt: string;
  createdAt: string;
  createdBy: string | null;
  targets: PostTargetView[];
}

export interface TargetOption { id: string; name: string }

export interface NewSocialPost {
  text: string;
  image?: { contentType: string; dataB64: string } | null;
  targets: { accountId: string; target?: string | null; targetName?: string | null }[];
  runAt?: string | null;
}

/** One account's check before writing (GET /api/social/health, on servers that have it). */
export interface SocialAccountHealth { accountId: string; app: string; ok: boolean; code: string | null; text: string | null }

export type DirectProvider = "tiktok" | "threads";
export interface DirectAccountView {
  provider: DirectProvider;
  available: boolean;
  testMode: boolean;
  connected: boolean;
  status: "active" | "expired" | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  connectedAt: string | null;
}
export interface DirectStatusResponse { canManage: boolean; accounts: DirectAccountView[] }
export const DIRECT_NAMES: Record<DirectProvider, string> = { tiktok: "TikTok", threads: "Threads" };

export const SOCIAL_IMAGE_MAX_BYTES = 1_000_000;
export const SOCIAL_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const SOCIAL_TEXT_MAX = 5000;

const APP_NAMES: Record<string, string> = {
  facebook: "Facebook Pages", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit",
  twitter: "X (Twitter)", threads: "Threads", tiktok: "TikTok", youtube: "YouTube",
};
export const appName = (app: string, fallback?: string | null) => APP_NAMES[app] ?? fallback ?? app;

/** Plain words for a target that did not go, keyed by the server's own error codes. */
export const SOCIAL_ERROR_COPY: Record<string, string> = {
  needs_image: "This network needs an image.",
  too_long: "The text is longer than this network allows.",
  needs_target: "Pick where to post on this network.",
  account_gone: "This account is no longer connected. Reconnect it, then try again.",
  not_supported: "Posting to this network is not ready yet.",
  rejected: "The network turned the post down.",
  unavailable: "The network did not answer. Try again in a few minutes.",
  reconnect: "The sign in for this account has expired. Reconnect it, then try again.",
  no_permission: "This account has not allowed posting. Reconnect it and allow posting, then try again.",
  not_page_admin: "Your profile can't post to this Page. Check you are an admin of the Page, then reconnect.",
  not_finished: "The sign in for this account was not finished. Reconnect it, then try again.",
  duplicate: "The network says this matches a recent post. Change the text, then try again.",
  rate_limited: "The network is limiting posts from this account right now. Try again in an hour.",
  bad_image: "The network couldn't use the image. Try another JPEG or PNG.",
  network_changed: "This network changed how posting works. We are fixing it; try again later.",
};

/** Error codes where reconnecting the account is the next step. */
export const SOCIAL_RECONNECT_ERRORS = new Set(["reconnect", "no_permission", "not_page_admin", "account_gone", "not_finished"]);

/**
 * Splits a stored target error ("code" or "code:the network's words") into plain words to show.
 * A code this app does not know yet shows the network's own words when there are any, so a newer
 * server never leaves the phone with the generic line.
 */
export function socialErrorText(stored: string | null | undefined): { code: string; text: string; reconnect: boolean } {
  const raw = stored ?? "rejected";
  const i = raw.indexOf(":");
  const code = i > 0 ? raw.slice(0, i) : raw;
  const detail = i > 0 ? raw.slice(i + 1).trim() : "";
  const known = SOCIAL_ERROR_COPY[code];
  let text: string;
  if (code === "rejected" && detail) text = `The network turned the post down: \u201C${detail}\u201D`;
  else if (known) text = known;
  else if (detail) text = detail;
  else text = SOCIAL_ERROR_COPY.rejected!;
  return { code, text, reconnect: SOCIAL_RECONNECT_ERRORS.has(code) };
}

/** Why an account can't take this post right now, or null when it can. Shown under a greyed out account. */
export function whyNot(account: Pick<ConnectedAccountView, "app" | "status">, text: string, hasImage: boolean, health?: SocialAccountHealth | null): string | null {
  const net = SOCIAL_NETWORKS[account.app];
  if (!net) return "Posting to this network is not ready yet.";
  if (account.status === "expired" || account.status === "failed") return "Sign in expired. Reconnect to post here.";
  if (account.status === "pending") return "Sign in was not finished. Reconnect to post here.";
  if (account.status === "disabled") return "This account is turned off.";
  if (health && !health.ok && health.code && health.code !== "check_failed") return health.text ?? socialErrorText(health.code).text;
  if (net.image === "required" && !hasImage) return "Needs an image. Add one to post here.";
  if (text.length > net.maxChars) return `Too long for this network: ${text.length} of ${net.maxChars} characters.`;
  return null;
}

/** A note for an account that takes the post but changes it (for example leaves the image off). */
export function postNote(app: string, hasImage: boolean): string | null {
  const net = SOCIAL_NETWORKS[app];
  if (net && net.image === "none" && hasImage) return "Text only here. This network leaves the image off.";
  return null;
}

export const POST_STATUS: Record<PostStatus, { label: string; tone: "neutral" | "brand" | "ok" | "warn" | "bad" }> = {
  scheduled: { label: "Scheduled", tone: "brand" },
  sending: { label: "Sending", tone: "brand" },
  done: { label: "Posted", tone: "ok" },
  partial: { label: "Partly posted", tone: "warn" },
  failed: { label: "Not posted", tone: "bad" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export const TARGET_STATUS: Record<TargetStatus, string> = { pending: "Waiting", sent: "Posted", failed: "Not posted", skipped: "Skipped" };

export type PostFilter = "all" | "scheduled" | "sent" | "failed";
export const POST_FILTERS: { id: PostFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "scheduled", label: "Scheduled" }, { id: "sent", label: "Posted" }, { id: "failed", label: "Failed" },
];
export function filterPosts(posts: SocialPostView[], f: PostFilter): SocialPostView[] {
  if (f === "all") return posts;
  if (f === "scheduled") return posts.filter((p) => p.status === "scheduled" || p.status === "sending");
  if (f === "sent") return posts.filter((p) => p.status === "done" || p.status === "partial");
  return posts.filter((p) => p.status === "failed" || p.status === "partial");
}

/** Later choices on the phone, as offsets from now. The web has a full date picker. */
export function laterOptions(now: Date): { id: string; label: string; at: Date }[] {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  const tonight = new Date(now); tonight.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(9, 0, 0, 0);
  const out = [{ id: "hour", label: "In an hour", at: inHour }];
  if (tonight.getTime() - now.getTime() > 30 * 60_000) out.push({ id: "tonight", label: "Today at 6 pm", at: tonight });
  out.push({ id: "tomorrow", label: "Tomorrow at 9 am", at: tomorrow }, { id: "monday", label: "Monday at 9 am", at: monday });
  return out;
}

/** True when an account list shows something that needs the person (an expired or unfinished sign in). */
export const needsReconnect = (a: Pick<ConnectedAccountView, "status">) => a.status === "expired" || a.status === "failed" || a.status === "pending";

/** Networks the phone can connect through the platform sign in, in the web's order. */
export const PHONE_CONNECT_APPS = ["facebook", "instagram", "linkedin", "pinterest", "reddit"] as const;

/** One key per post being written, so a retried request never makes the post twice. */
export function newPostKey(): string {
  return `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator (an idempotency key that only has to differ between this phone's posts; not a secret)
}

/* ---------------------------------------------------------------- 1.10.6: results, sync with the networks, delete */

const NETWORK_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit", twitter: "X", threads: "Threads", tiktok: "TikTok", youtube: "YouTube" };
/** The network's short name, as the web says it: "Facebook", "LinkedIn", "X". */
export const networkName = (app: string) => NETWORK_NAME[app] ?? app.charAt(0).toUpperCase() + app.slice(1);

/** "Facebook and LinkedIn", "Facebook, Instagram and LinkedIn". Repeats are said once. */
export function andList(items: string[]): string {
  const u = [...new Set(items)];
  return u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

/** The quiet note on a posted LinkedIn row (the same words as the web). LinkedIn never says when a post is deleted there. */
export const LINKEDIN_DELETE_NOTE = "LinkedIn doesn't tell Multies when a post is deleted there. Deleted it on LinkedIn? Delete it here too.";

export const isRemoved = (t: Pick<PostTargetView, "status" | "networkState">) => t.status === "sent" && t.networkState === "removed";

/** A posted row that can't be checked but can be deleted from Multies (LinkedIn): it carries the quiet note. */
export const needsDeleteNote = (t: PostTargetView) => t.status === "sent" && !isRemoved(t) && t.canCheck === false && t.canDelete === true;

/** True when every network the post went to has since removed it. */
export const removedEverywhere = (p: SocialPostView) => {
  const sent = p.targets.filter((t) => t.status === "sent");
  return sent.length > 0 && sent.every((t) => t.networkState === "removed");
};

/** The badge for a whole post: "Removed" once every network removed it, else the post's own status. */
export function postBadge(p: SocialPostView): { label: string; tone: "neutral" | "brand" | "ok" | "warn" | "bad" } {
  if (removedEverywhere(p)) return { label: "Removed", tone: "neutral" };
  return POST_STATUS[p.status];
}

/** The chip on one network row: Posted, Not posted, Removed on Facebook, Waiting, Skipped. */
export function targetChip(t: PostTargetView): { label: string; tone: "neutral" | "brand" | "ok" | "warn" | "bad" } {
  if (isRemoved(t)) return { label: `Removed on ${networkName(t.app)}`, tone: "neutral" };
  if (t.status === "sent") return { label: "Posted", tone: "ok" };
  if (t.status === "failed") return { label: "Not posted", tone: "bad" };
  if (t.status === "skipped") return { label: "Skipped", tone: "neutral" };
  return { label: "Waiting", tone: "brand" };
}

export const SYNC_MAX_IDS = 20;
export const SYNC_WINDOW_MS = 30 * 86_400_000;

/**
 * The posts worth asking the network about: a Facebook (canCheck) row that was posted in the last 30 days and is not
 * already removed. Only posts on screen, at most 20 per call. The server holds each post to one check per 5 minutes.
 */
export function syncIds(posts: SocialPostView[] | undefined, now = Date.now()): string[] {
  return (posts ?? [])
    .filter((p) => p.targets.some((t) => t.canCheck && t.status === "sent" && t.networkState !== "removed" && t.sentAt && now - Date.parse(t.sentAt) < SYNC_WINDOW_MS))
    .slice(0, SYNC_MAX_IDS)
    .map((p) => p.id);
}

/** Puts fresher copies of posts (from sync, retry or a detail read) into a list, in place, keeping its order. */
export function mergePosts(list: SocialPostView[], fresh: SocialPostView[]): SocialPostView[] {
  if (!fresh.length) return list;
  const byId = new Map(fresh.map((p) => [p.id, p]));
  return list.map((p) => byId.get(p.id) ?? p);
}

/** True while a post set for now is still going out (some row waits for its network). */
export const stillSending = (p: SocialPostView, now = Date.now()) =>
  p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= now + 60_000 && p.targets.some((t) => t.status === "pending"));

/** The title of the screen after Post now, word for word as the web's sheet. */
export function resultTitle(p: SocialPostView, now = Date.now()): string {
  if (stillSending(p, now)) return "Posting now";
  if (p.status === "scheduled") return "Scheduled";
  const ok = p.targets.filter((t) => t.status === "sent").length;
  if (p.status === "done") return ok === 1 ? `Posted to ${networkName(p.targets.find((t) => t.status === "sent")?.app ?? p.targets[0]!.app)}` : `Posted to all ${ok} accounts`;
  if (p.status === "partial") return `Posted to ${ok} of ${p.targets.length} accounts`;
  if (p.status === "canceled") return "Canceled";
  return "Not posted";
}

/** "Posted to 1 of 2" on the detail card. */
export function postedCount(p: SocialPostView): string | null {
  const ok = p.targets.filter((t) => t.status === "sent" && !isRemoved(t)).length;
  if (p.status === "scheduled" || p.status === "sending" || p.status === "canceled") return null;
  return `Posted to ${ok} of ${p.targets.length}`;
}

/** Where a delete reaches: the networks it deletes on, and the ones where the post stays (they can't delete from Multies). */
export function deleteReach(p: SocialPostView): { on: string[]; stays: string[] } {
  const sent = p.targets.filter((t) => t.status === "sent" && t.networkState !== "removed");
  return { on: [...new Set(sent.filter((t) => t.canDelete).map((t) => networkName(t.app)))], stays: [...new Set(sent.filter((t) => !t.canDelete).map((t) => networkName(t.app)))] };
}

/** The confirm before a delete: what it says, and the words on the red button. */
export function deleteConfirm(p: SocialPostView): { title: string; body: string; button: string } {
  const title = "Delete this post?";
  if (p.status === "scheduled" && !p.targets.some((t) => t.status === "sent")) {
    return { title, body: "It won't go out, and it leaves your list in Multies. You can't undo this.", button: "Delete post" };
  }
  const { on, stays } = deleteReach(p);
  const parts: string[] = [];
  if (on.length) parts.push(`It will also be deleted from ${andList(on)}.`);
  else parts.push("It leaves your list in Multies.");
  if (stays.length) parts.push(`It stays on ${andList(stays)}. Delete it there yourself.`);
  parts.push("You can't undo this.");
  return { title, body: parts.join(" "), button: on.length ? `Delete from ${andList(on)}` : "Delete post" };
}

export type DeleteOutcome = "deleted" | "already_gone" | "not_supported" | "not_sent" | "failed";
export interface DeleteResult { deleted: boolean; results: { accountId: string; app: string; outcome: DeleteOutcome }[]; post: SocialPostView | null }

/** The short message after a delete: "Post deleted from Facebook and LinkedIn", or which network didn't delete it. */
export function deleteMessage(r: DeleteResult): { ok: boolean; text: string } {
  const done = r.results.filter((x) => x.outcome === "deleted" || x.outcome === "already_gone").map((x) => networkName(x.app));
  const failed = r.results.filter((x) => x.outcome === "failed").map((x) => networkName(x.app));
  if (r.deleted) return { ok: true, text: done.length ? `Post deleted from ${andList(done)}` : "Post deleted" };
  const head = done.length ? `Deleted from ${andList(done)}. ` : "";
  return { ok: false, text: `${head}${failed.length ? andList(failed) : "A network"} didn't delete it. Try again in a minute.` };
}

/** "1 min ago", "3 hours ago", "just now". */
export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return null;
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** "Checked with Facebook 1 min ago" under a post that Multies checks, or null. */
export function checkedLine(p: SocialPostView, now = Date.now()): string | null {
  const times = p.targets.filter((t) => t.canCheck && t.checkedAt).map((t) => Date.parse(t.checkedAt!)).filter(Number.isFinite);
  if (!times.length) return null;
  const apps = [...new Set(p.targets.filter((t) => t.canCheck && t.checkedAt).map((t) => networkName(t.app)))];
  return `Checked with ${andList(apps)} ${ago(new Date(Math.max(...times)).toISOString(), now)}`;
}

/** The one line for a post whose image a network leaves off (LinkedIn today). */
export function imageDropNote(p: SocialPostView): string | null {
  if (!p.imageUrl) return null;
  const apps = [...new Set(p.targets.filter((t) => SOCIAL_NETWORKS[t.app]?.image === "none").map((t) => networkName(t.app)))];
  return apps.length ? `${andList(apps)} posted the text only. ${apps.length === 1 ? "It doesn't" : "They don't"} take images from Multies yet.` : null;
}

/** What the Social card on Today says: the newest post's state, and how many need a look. */
export function socialSummary(posts: SocialPostView[] | undefined): { title: string; detail: string; failed: number; tone: "ok" | "warn" | "bad" | "neutral" } | null {
  if (!posts) return null;
  const failed = posts.filter((p) => p.status === "failed" || p.status === "partial").filter((p) => p.targets.some((t) => t.status === "failed")).length;
  const scheduled = posts.filter((p) => p.status === "scheduled" && !stillSending(p)).length;
  const latest = posts.find((p) => p.status !== "canceled");
  if (!latest) return { title: "No posts yet", detail: "Write one post for all your pages", failed: 0, tone: "neutral" };
  const badge = postBadge(latest);
  const title = failed ? tr("m.social.posts_need_a_look", { count: failed }) : latest.text.trim() ? latest.text.trim().split("\n")[0]! : "Image only";
  const bits = [failed ? null : `Latest: ${badge.label.toLowerCase()}`, scheduled ? `${scheduled} scheduled` : null].filter(Boolean);
  return { title, detail: failed ? tr("m.social.tap_to_see_why") : bits.join(". "), failed, tone: failed ? "bad" : badge.tone === "ok" ? "ok" : "neutral" };
}

/** The account check in four plain words for the Accounts chips. */
export function healthChip(a: Pick<ConnectedAccountView, "status">, h: SocialAccountHealth | null | undefined): { label: string; tone: "ok" | "warn" | "bad" | "neutral" } {
  if (a.status === "disabled") return { label: "Off", tone: "neutral" };
  if (needsReconnect(a)) return { label: "Sign in expired", tone: "warn" };
  if (!h || h.ok || !h.code || h.code === "check_failed") return { label: "Ready to post", tone: "ok" };
  if (h.code === "no_permission") return { label: "Posting not allowed", tone: "warn" };
  if (h.code === "not_page_admin" || h.code === "no_page" || h.code === "page_unreachable") return { label: "Page not reachable", tone: "warn" };
  if (SOCIAL_RECONNECT_ERRORS.has(h.code)) return { label: "Sign in expired", tone: "warn" };
  return { label: "Needs a look", tone: "warn" };
}

/** 1.10.7: what a long press on a post copies, shares or translates; Copy post link uses the first network link. */
export function postQuickTarget(post: SocialPostView): { title: string; subtitle?: string; text?: string; link: string | null; linkLabel: string } {
  const live = post.targets.find((t) => t.url && t.networkState !== "removed");
  const first = (post.text || "").trim().split(/\n/)[0] ?? "";
  return {
    title: first ? (first.length > 60 ? `${first.slice(0, 57)}...` : first) : "Post",
    subtitle: live ? `On ${post.targets.filter((t) => t.url).length > 1 ? "several networks" : live.app.charAt(0).toUpperCase() + live.app.slice(1)}` : undefined,
    text: post.text?.trim() ? post.text : undefined,
    link: live?.url ?? null,
    linkLabel: "Copy post link",
  };
}
