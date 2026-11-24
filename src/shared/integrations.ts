/**
 * R80C: Connections, the shared contract between the server (/api/apps, /api/social) and the web app.
 * A workspace connects its own outside accounts; the sign in tokens stay with the integration platform and never
 * reach our database or the browser. Groups and labels here are ours, so the gallery reads the same in every place.
 */

/** Gallery groups, in the order they show. Social comes first. */
export const APP_GROUPS = [
  { id: "social", label: "Social" },
  { id: "mail", label: "Mail and chat" },
  { id: "storage", label: "Files and docs" },
  { id: "crm", label: "Sales and CRM" },
  { id: "payments", label: "Payments and accounting" },
  { id: "marketing", label: "Marketing" },
  { id: "work", label: "Projects and tasks" },
  { id: "calendar", label: "Calendar and booking" },
  { id: "support", label: "Support" },
  { id: "commerce", label: "Shop" },
  { id: "data", label: "Data and analytics" },
  { id: "ai", label: "AI" },
  { id: "dev", label: "Developer" },
  { id: "hr", label: "People and HR" },
  { id: "other", label: "Other" },
] as const;
export type AppGroup = (typeof APP_GROUPS)[number]["id"];

/** The platform's own category names (lower case) mapped to our groups. First match wins, in this order. */
const GROUP_RULES: [AppGroup, RegExp][] = [
  ["social", /^social media|^video & audio$/],
  ["payments", /payment|accounting|invoice|expense|taxes|banking|proposal/],
  ["crm", /crm|sales|contact management|lead/],
  ["marketing", /marketing|ads & conversion|newsletter|seo|url shortener/],
  ["mail", /^email|team chat|communication|phone & sms|notifications|transactional email|video conferencing/],
  ["storage", /file|document|signature|notes|knowledge|content & files|images & design/],
  ["calendar", /calendar|scheduling|booking|event management/],
  ["work", /project management|task management|productivity|team collaboration|time tracking/],
  ["support", /customer support|helpdesk|ticket/],
  ["commerce", /ecommerce|commerce/],
  ["data", /analytics|business intelligence|databases|spreadsheet|forms & surveys/],
  ["hr", /human resources|hr talent|recruit/],
  ["ai", /artificial intelligence|ai /],
  ["dev", /developer|server monitoring|it operations|security|model context protocol|devops/],
];

export function groupFor(categories: string[]): AppGroup {
  const cats = categories.map((c) => c.toLowerCase());
  for (const [g, re] of GROUP_RULES) if (cats.some((c) => re.test(c))) return g;
  return "other";
}

/** The social networks we lead with, in this order, even before the catalog loads. */
export const SOCIAL_FIRST = [
  "facebook", "instagram", "linkedin", "twitter", "youtube", "tiktok", "pinterest", "threads", "reddit",
  "google_business_profile", "telegram", "discord", "whatsapp", "snapchat",
] as const;

/** Display names that read better than the platform's own. */
export const APP_NAME_OVERRIDES: Record<string, string> = {
  facebook: "Facebook Pages", twitter: "X (Twitter)", google_business_profile: "Google Business Profile", whatsapp: "WhatsApp Business",
  linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok", discordbot: "Discord bot",
};

/** How an app connects here. `ready` connects now; `soon` waits for our own developer app with that network. */
export type AppAvailability = "ready" | "soon" | "key";

export interface AppSummary {
  slug: string;
  name: string;
  logo: string | null;
  description: string;
  group: AppGroup;
  availability: AppAvailability;
  /** Connected accounts in this workspace (any status). */
  connected: number;
  /** Social posting from the Social panel. */
  canPost: boolean;
}

export type AccountStatus = "active" | "pending" | "expired" | "failed" | "disabled";

export interface ConnectedAccountView {
  id: string;
  app: string;
  appName: string;
  logo: string | null;
  status: AccountStatus;
  /** A readable name for the account when the platform gives one (a page, a handle). */
  label: string | null;
  createdAt: string;
  /** SA1: who the account is on its network (a profile or page name) and its picture, when the network said. */
  name?: string | null;
  avatarUrl?: string | null;
  /** SA1: on confirm, true when this sign in replaced an older connection to the same account (one row, fresh sign in). */
  refreshed?: boolean;
  /** On confirm: the connection is live, but it could not be checked against the workspace's other connections. */
  warning?: string;
  /** SOC1: LinkedIn granted organization access on this login, so company Pages can be chosen (flag SOCIAL_MULTI_SOC1). */
  companyPages?: boolean;
}

/** SA1: the plain note on LinkedIn, until LinkedIn approves page access (no organization scopes are asked for). */
export const LINKEDIN_PAGE_NOTE = "Posting to a company page needs LinkedIn's approval for page access. Your personal profile works now.";

export interface CatalogResponse {
  available: boolean;
  canManage: boolean;
  apps: AppSummary[];
  accounts: ConnectedAccountView[];
  /** True when the full catalog could not be read and only the social list is shown. */
  partial: boolean;
}

/* ---------------------------------------------------------------- social posting */

/** Networks the Social panel can post to, with what each needs. */
export interface SocialNetwork {
  app: string;
  /** Characters the network allows in one post. */
  maxChars: number;
  /** "required": a post needs an image. "optional": text alone works. "none": the image is left off. */
  image: "required" | "optional" | "none";
  /** What the account posts into: a page, a board, a community. null when it posts to the account itself. */
  target: null | { kind: "page" | "board" | "subreddit"; label: string };
}

export const SOCIAL_NETWORKS: Record<string, SocialNetwork> = {
  facebook: { app: "facebook", maxChars: 63206, image: "optional", target: { kind: "page", label: "Page" } },
  instagram: { app: "instagram", maxChars: 2200, image: "required", target: null },
  linkedin: { app: "linkedin", maxChars: 3000, image: "optional", target: null }, // SOCFIX: images go up first, then the post
  pinterest: { app: "pinterest", maxChars: 800, image: "required", target: { kind: "board", label: "Board" } },
  reddit: { app: "reddit", maxChars: 40000, image: "none", target: { kind: "subreddit", label: "Community" } },
  twitter: { app: "twitter", maxChars: 280, image: "none", target: null },
  threads: { app: "threads", maxChars: 500, image: "optional", target: null },
  testnet: { app: "testnet", maxChars: 2000, image: "optional", target: null }, // R118: staging only test network
};

export const canPostTo = (app: string) => app in SOCIAL_NETWORKS;

export type PostStatus = "scheduled" | "sending" | "done" | "partial" | "failed" | "canceled" | "draft" | "review" | "changes" | "rejected";
export type TargetStatus = "pending" | "sent" | "failed" | "skipped";

export interface PostTargetView {
  accountId: string;
  app: string;
  label: string | null;
  target: string | null;
  /** The page, board or community name shown to people (target is the id the network takes). */
  targetName: string | null;
  status: TargetStatus;
  url: string | null;
  error: string | null;
  sentAt: string | null;
  /**
   * Oct 31: what the network said when last asked. "removed" = gone there (url is then null); "live" = still up;
   * null = not asked yet. canCheck is false where the network does not tell us (LinkedIn), canDelete where Multies
   * can delete the post on the network too.
   */
  networkState?: "live" | "removed" | null;
  checkedAt?: string | null;
  canCheck?: boolean;
  canDelete?: boolean;
  /** R117: a note on this result, for example a first comment that did not go. */
  note?: string | null;
}

/** Networks Multies can ask whether a sent post is still up, and networks it can delete a post on. */
export const SOCIAL_CAN_CHECK = ["facebook"] as const;
export const SOCIAL_CAN_DELETE = ["facebook", "linkedin"] as const;

/** Per network result of deleting a post from Multies. */
export type DeleteOutcome = "deleted" | "already_gone" | "not_supported" | "not_sent" | "failed";

export interface SocialPostView {
  id: string;
  text: string;
  imageUrl: string | null;
  status: PostStatus;
  runAt: string;
  createdAt: string;
  createdBy: string | null;
  targets: PostTargetView[];
  /** R117 (composer v2, drafts and approvals, evergreen). Optional: older servers do not send them. */
  format?: "text" | "image" | "carousel" | "video" | "story" | null;
  texts?: Record<string, string> | null;
  extras?: { firstComment?: string | null; poll?: { question: string; options: string[]; days: number } | null; linkCard?: boolean } | null;
  images?: { mediaId: string; url: string }[];
  campaign?: string | null;
  evergreen?: boolean;
  evergreenOf?: string | null;
  submittedBy?: string | null;
  reviewNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  updatedAt?: string;
}

/** Biggest image a post may carry (bytes). The stored copy is base64, under the database's row limit. */
export const SOCIAL_IMAGE_MAX_BYTES = 1_000_000;
export const SOCIAL_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
/** Most text a post may carry before per network limits. */
export const SOCIAL_TEXT_MAX = 5000;
/** Furthest ahead a post can be set. */
export const SOCIAL_MAX_AHEAD_DAYS = 180;

/** Plain words for a target that did not go, keyed by our own error codes. */
export const SOCIAL_ERROR_COPY: Record<string, string> = {
  needs_image: "This network needs an image.",
  too_long: "The text is longer than this network allows.",
  needs_target: "Pick where to post on this network.",
  account_gone: "This account is no longer connected. Reconnect it in Connections.",
  not_supported: "Posting to this network is not ready yet.",
  rejected: "The network turned the post down.",
  unavailable: "The network did not answer. Try again in a few minutes.",
  reconnect: "The sign in for this account has expired. Reconnect it, then try again.",
  no_permission: "This account has not allowed posting. Reconnect it and allow posting, then try again.",
  not_page_admin: "Your profile can't post to this Page. Check you are an admin of the Page, then reconnect.",
  duplicate: "The network says this matches a recent post. Change the text, then try again.",
  rate_limited: "The network is limiting posts from this account right now. Try again in an hour.",
  bad_image: "The network couldn't use the image. Try another JPEG or PNG.",
  network_changed: "This network changed how posting works. We are fixing it; try again later.",
};

/** Error codes where reconnecting the account is the next step. */
export const SOCIAL_RECONNECT_ERRORS = new Set(["reconnect", "no_permission", "not_page_admin", "account_gone", "not_finished", "page_lost"]);

/** What the account check says before anyone writes a post (words for the account list in the composer). */
export const SOCIAL_HEALTH_COPY: Record<string, string> = {
  reconnect: "Sign in expired. Reconnect to post here.",
  no_permission: "Posting isn't allowed for this account yet. Reconnect and allow posting.",
  not_page_admin: "This profile can't post to any Page. Check you are a Page admin, then reconnect.",
  not_finished: "Sign in was not finished. Reconnect to post here.",
  check_failed: "We couldn't check this account just now. You can still post.",
  no_channel: "This Google account has no YouTube channel. Create one on YouTube, then reconnect.",
  page_lost: "Lost permission for this Page. Reconnect Facebook to post here again.", // SOC1
};

/** One account's check, from GET /api/social/health. */
export interface SocialAccountHealth { accountId: string; app: string; ok: boolean; code: string | null; text: string | null }

/** Splits a stored target error ("code" or "rejected:the network's words") into plain words to show. */
export function socialErrorText(stored: string | null | undefined): { code: string; text: string } {
  const raw = stored ?? "rejected";
  const i = raw.indexOf(":");
  const code = i > 0 ? raw.slice(0, i) : raw;
  const detail = i > 0 ? raw.slice(i + 1).trim() : "";
  const base = SOCIAL_ERROR_COPY[code] ?? SOCIAL_ERROR_COPY.rejected!;
  return { code, text: code === "rejected" && detail ? `The network turned the post down: “${detail}”` : base };
}
