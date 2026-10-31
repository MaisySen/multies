/**
 * Tools P2 (H5): secure share links and e-sign, the parts the server and the web app share.
 * Limits live here, in one place.
 */
import type { PlanId } from "./plans";

const MB = 1024 * 1024;

/** Live bytes of share and signing files a workspace may keep at once, by plan. */
export const KEPT_FILE_CAP: Record<PlanId, number> = { starter: 100 * MB, pro: 1024 * MB, business: 5 * 1024 * MB };
/** Every workspace together, so the account stays inside the KV storage its plan includes. */
export const KEPT_FILE_GLOBAL_CAP = 800 * MB;
/** One KV value holds at most 25 MiB. */
export const KEPT_FILE_MAX_BYTES = 25 * MB;

export const SHARE_MIN_SECONDS = 60 * 60;
export const SHARE_MAX_SECONDS = 30 * 86_400;
/** Wrong passwords before a link pauses, and for how long. */
export const SHARE_WRONG_TRIES = 5;
export const SHARE_LOCK_SECONDS = 15 * 60;
export const SHARE_MAX_DOWNLOADS = 1000;

/** The expiry choices the app offers (seconds). */
export const SHARE_EXPIRY_CHOICES: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "14 days", seconds: 14 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export const SIGN_MAX_DAYS = 30;
export const SIGN_MAX_SIGNERS = 10;
export const SIGN_MAX_PAGES = 200;

/** The one plain line every e-sign screen carries (legal-copy.md, for owner and lawyer review). */
export const ESIGN_NOTE = "Electronic signatures suit most everyday business documents. Some documents, such as wills, powers of attorney and documents that must be witnessed, need a different way of signing.";

export interface ShareDownloadRow { at: string; country: string | null; agent: string | null; /** R88 */ kind?: "download" | "view"; region?: string | null }

export interface ShareLinkInfo {
  id: string;
  name: string;
  bytes: number;
  source: "upload" | "result" | "attachment";
  hasPassword: boolean;
  maxDownloads: number | null;
  downloads: number;
  /** R88: page opens (link previewers not counted). */
  views?: number;
  notifyFirst: boolean;
  expiresAt: string;
  createdAt: string;
  status: "active" | "expired" | "revoked" | "used_up" | "paused";
  /** Only in the answer that creates the link: the token is never stored, so it cannot be shown again. */
  url?: string;
  log?: ShareDownloadRow[];
}

export interface KeptUsage { bytes: number; cap: number }

/** A field placed on a page: PDF points from the top left of the page. */
export interface SignField { signer: number; kind: "signature" | "initials" | "date"; page: number; x: number; y: number; w: number; h: number }
export interface SignPage { page: number; width: number; height: number; img?: string }

export type SignRequestStatus = "draft" | "preparing" | "out" | "finishing" | "completed" | "declined" | "cancelled" | "expired" | "failed";
export type SignerStatus = "waiting" | "sent" | "viewed" | "signed" | "declined";

export interface SignEventRow { at: string; name: string; email: string; action: string; ipCountry: string | null; detail?: string | null }
export interface SignSignerInfo { id: string; position: number; name: string; email: string; status: SignerStatus; sentAt: string | null; viewedAt: string | null; signedAt: string | null; declinedAt: string | null; declineReason: string | null }
export interface SignRequestInfo {
  id: string;
  kind: "self" | "request";
  status: SignRequestStatus;
  title: string;
  orderMode: "any" | "sequence";
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  sourceSha256: string;
  finalSha256: string | null;
  error: string | null;
  signers: SignSignerInfo[];
  events?: SignEventRow[];
  downloadUrl?: string;
  waitingOn?: string[];
}
