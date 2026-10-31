/**
 * R87: Links in Tools (short links, QR, click stats, bio page, go links). Shared by the server, the web page and tests.
 */

export const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
export const GO_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
export const AUTO_CODE_LENGTH = 7;
export const MAX_URL = 2048;
export const MAX_TAGS = 10;
export const MAX_BULK = 500;
export const MAX_BIO_ITEMS = 40;
export const MAX_SOCIALS = 12;
export const STATS_DAYS = [7, 30, 90] as const;

/** Bio page slugs that read like our own pages. */
export const RESERVED_SLUGS = new Set(["admin", "api", "app", "bio", "help", "login", "logout", "multies", "settings", "signup", "support", "status", "www", "mail", "official", "security", "billing", "team"]);

export const normCode = (s: string) => s.trim().toLowerCase();

export type LinkStatus = "active" | "off" | "expired" | "used_up";

export interface ShortLinkInfo {
  id: string;
  code: string;
  shortUrl: string;
  url: string;
  title: string | null;
  tags: string[];
  enabled: boolean;
  status: LinkStatus;
  expiresAt: string | null;
  maxClicks: number | null;
  hasPassword: boolean;
  clicks: number;
  lastClickAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  canEdit: boolean;
}

export interface StatRow { key: string; n: number }
export interface LinkStats {
  days: { day: string; clicks: number; visitors: number }[];
  total: number;
  visitors: number;
  countries: StatRow[];
  referrers: StatRow[];
  devices: StatRow[];
  browsers: StatRow[];
  os: StatRow[];
  botClicks: number;
}

export type BioIcon = "link" | "globe" | "mail" | "phone" | "calendar" | "shop" | "doc" | "video" | "music" | "star" | "heart" | "map";
export const BIO_ICONS: BioIcon[] = ["link", "globe", "mail", "phone", "calendar", "shop", "doc", "video", "music", "star", "heart", "map"];
export interface BioItem { id: string; title: string; url: string; icon: BioIcon; on: boolean }

export type SocialKind = "instagram" | "facebook" | "linkedin" | "x" | "youtube" | "tiktok" | "threads" | "github" | "whatsapp" | "telegram" | "email" | "website";
export const SOCIALS: { kind: SocialKind; label: string; hint: string }[] = [
  { kind: "instagram", label: "Instagram", hint: "https://instagram.com/yourname" },
  { kind: "facebook", label: "Facebook", hint: "https://facebook.com/yourpage" },
  { kind: "linkedin", label: "LinkedIn", hint: "https://linkedin.com/in/yourname" },
  { kind: "x", label: "X", hint: "https://x.com/yourname" },
  { kind: "youtube", label: "YouTube", hint: "https://youtube.com/@yourname" },
  { kind: "tiktok", label: "TikTok", hint: "https://tiktok.com/@yourname" },
  { kind: "threads", label: "Threads", hint: "https://threads.net/@yourname" },
  { kind: "github", label: "GitHub", hint: "https://github.com/yourname" },
  { kind: "whatsapp", label: "WhatsApp", hint: "https://wa.me/61400000000" },
  { kind: "telegram", label: "Telegram", hint: "https://t.me/yourname" },
  { kind: "email", label: "Email", hint: "you@example.com" },
  { kind: "website", label: "Website", hint: "https://example.com" },
];
export interface BioSocial { kind: SocialKind; url: string }

export interface BioPageInfo {
  id: string | null;
  scope: "workspace" | "me";
  slug: string;
  url: string;
  title: string;
  bio: string;
  avatar: "logo" | "photo" | "none";
  avatarUrl: string | null;
  theme: "brand" | "light" | "dark";
  brandColor: string | null;
  items: (BioItem & { clicks: number })[];
  socials: BioSocial[];
  published: boolean;
  views: number;
  canEdit: boolean;
  /** Avatar choices the server can fill: the workspace logo, the person's photo. */
  logoUrl: string | null;
  photoUrl: string | null;
}

export type GoTargetKind = "url" | "doc" | "task" | "project";
export interface GoLinkInfo {
  id: string;
  name: string;
  targetKind: GoTargetKind;
  targetId: string | null;
  url: string | null;
  label: string | null;
  description: string | null;
  href: string;
  clicks: number;
  createdByName: string | null;
  canEdit: boolean;
}

export interface LinkHostInfo {
  host: string | null;
  status: "none" | "pending" | "dns_ok" | "live" | "failed";
  defaultBase: string;
  base: string;
  verifiedDomains: { id: string; name: string }[];
  canEdit: boolean;
  target: string;
}

/** Where a go link opens inside the app. */
export function goHref(kind: GoTargetKind, targetId: string | null, url: string | null): string {
  if (kind === "url") return url ?? "/app";
  if (kind === "doc") return `/app/docs/${encodeURIComponent(targetId ?? "")}`;
  if (kind === "task") return `/app/tasks?task=${encodeURIComponent(targetId ?? "")}`;
  return `/app/tasks?project=${encodeURIComponent(targetId ?? "")}`;
}

/** Adds UTM fields to a destination, keeping its own query and fragment. Empty fields are left out. */
export function withUtm(url: string, utm: Partial<Record<"source" | "medium" | "campaign" | "term" | "content", string>>): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  for (const k of ["source", "medium", "campaign", "term", "content"] as const) {
    const v = utm[k]?.trim();
    if (v) u.searchParams.set(`utm_${k}`, v); else if (k in utm) u.searchParams.delete(`utm_${k}`);
  }
  return u.toString();
}

export function readUtm(url: string): Record<"source" | "medium" | "campaign" | "term" | "content", string> {
  const out = { source: "", medium: "", campaign: "", term: "", content: "" };
  try { const u = new URL(url); for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = u.searchParams.get(`utm_${k}`) ?? ""; } catch { /* not a URL yet */ }
  return out;
}

/** Bots, crawlers and the fetchers that make link previews in chats and feeds: sent on, never counted. */
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|discord|slack|skypeuripreview|linkedin|embedly|iframely|pinterest|vkshare|snapchat|mastodon|bluesky|cardyb|quora link|outbrain|google-?(?:read-aloud|inspectiontool|site-verification)|headlesschrome|phantomjs|python|curl|wget|go-http-client|okhttp|java\/|axios|node-fetch|undici|libwww|httpclient|apache-httpclient|scrapy|lighthouse|pingdom|uptime|monitor|feedfetcher|validator/i;
export function isBotAgent(ua: string | null | undefined): boolean {
  if (!ua || ua.length < 12) return true;
  return BOT_RE.test(ua);
}

export function deviceOf(ua: string | null | undefined): "Phone" | "Tablet" | "Desktop" {
  const s = ua ?? "";
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) return "Tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(s)) return "Phone";
  return "Desktop";
}

export function browserOf(ua: string | null | undefined): string {
  const s = ua ?? "";
  if (/SamsungBrowser\//.test(s)) return "Samsung Internet";
  if (/Edg[A-Z]?\//.test(s)) return "Edge";
  if (/OPR\/|Opera/.test(s)) return "Opera";
  if (/Firefox\/|FxiOS/.test(s)) return "Firefox";
  if (/CriOS|Chrome\//.test(s)) return "Chrome";
  if (/Safari\//.test(s)) return "Safari";
  return "Other";
}

export function osOf(ua: string | null | undefined): string {
  const s = ua ?? "";
  if (/iPhone|iPad|iPod/.test(s)) return "iOS";
  if (/Android/.test(s)) return "Android";
  if (/Windows/.test(s)) return "Windows";
  if (/Mac OS X|Macintosh/.test(s)) return "macOS";
  if (/CrOS/.test(s)) return "ChromeOS";
  if (/Linux/.test(s)) return "Linux";
  return "Other";
}

/** The host a click came from, or "Direct". Our own host and blank referrers count as direct. */
export function referrerOf(ref: string | null | undefined, ownHost?: string): string {
  if (!ref) return "Direct";
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").replace(/^l\./, "").replace(/^lm\./, "");
    if (!h || (ownHost && h === ownHost.replace(/^www\./, ""))) return "Direct";
    if (h === "t.co") return "x.com";
    return h.slice(0, 100);
  } catch { return "Direct"; }
}

/** One CSV line, quoted where needed (a leading = + - @ is prefixed so a sheet does not run it). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
