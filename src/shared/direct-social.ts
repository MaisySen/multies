/**
 * R83: our own sign in for TikTok and Threads, shown in Connections > Social posts. Shared by the server
 * (/api/direct) and the web app. One linked account per network per workspace.
 */

export type DirectProvider = "tiktok" | "threads";
export const DIRECT_PROVIDERS: DirectProvider[] = ["tiktok", "threads"];
export const DIRECT_NAMES: Record<DirectProvider, string> = { tiktok: "TikTok", threads: "Threads" };

export interface DirectAccountView {
  provider: DirectProvider;
  /** The app keys are set on this host, so Connect works. */
  available: boolean;
  /** True on hosts that use the network's test app: only invited test accounts can connect. */
  testMode: boolean;
  connected: boolean;
  status: "active" | "expired" | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  connectedAt: string | null;
}

export interface DirectStatusResponse {
  canManage: boolean;
  accounts: DirectAccountView[];
}

/** TikTok creator_info, as the post form needs it (TikTok's Direct Post UX rules). */
export interface TikTokCreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyOptions: TikTokPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
}

export type TikTokPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacy, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export interface TikTokVideoView {
  id: string;
  title: string;
  coverUrl: string | null;
  shareUrl: string | null;
  createdAt: string | null;
  durationSec: number | null;
  views: number | null;
  likes: number | null;
}

export interface TikTokPublishView {
  id: string;
  publishId: string;
  title: string | null;
  status: "processing" | "published" | "failed" | "removed";
  error: string | null;
  createdAt: string;
}

export interface ThreadsPostView {
  id: string;
  text: string | null;
  permalink: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  createdAt: string | null;
}

/** Most bytes a TikTok video may have here (one upload request; the network takes up to 4 GB in parts). */
export const TIKTOK_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const TIKTOK_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const TIKTOK_TITLE_MAX = 2200;
export const THREADS_TEXT_MAX = 500;

/** Plain words for the reasons a connection or post did not go. */
export const DIRECT_ERROR_COPY: Record<string, string> = {
  not_connected: "Connect the account first.",
  expired: "The sign in expired. Connect the account again.",
  rejected: "The network turned the post down. Check the text and the file, then try again.",
  rate_limited: "The network asked us to slow down. Try again in a few minutes.",
  unavailable: "The network didn't answer. Try again in a moment.",
  spam_risk: "The network limits how many posts an account can make a day. Try again tomorrow.",
  privacy: "Pick who can see the video.",
  consent: "Agree to the music and branded content terms first.",
  branded_private: "Branded content can't be private. Pick another audience.",
};
