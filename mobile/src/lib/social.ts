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
  return `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
