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
}

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
};
