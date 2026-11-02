/**
 * R117: Social P2a, the pure rules shared by the server and the web app. What Multies can send to each network in
 * each format (our own route, not only what the network allows), per network text and limits, the checks a post goes
 * through before it is sent, weekly time slots and the next free one, the evergreen picker and who may post, submit
 * and approve. No I/O here, so every rule has unit tests.
 */

import { detailsProblem } from "./social-p3";

export const SOCIAL_FORMATS = ["text", "image", "carousel", "video", "story"] as const;
export type SocialFormat = (typeof SOCIAL_FORMATS)[number];
export const FORMAT_LABELS: Record<SocialFormat, string> = { text: "Text", image: "Image", carousel: "Carousel", video: "Video", story: "Story or reel" };

/** Networks the composer knows. threads and tiktok are our own sign in (direct); the rest go through Connections. */
export const COMPOSER_NETWORKS = ["facebook", "instagram", "linkedin", "pinterest", "reddit", "threads", "tiktok"] as const;
export const NETWORK_LABEL: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit", threads: "Threads", tiktok: "TikTok", twitter: "X", testnet: "Test network",
};
export const networkLabel = (app: string) => NETWORK_LABEL[app] ?? app.charAt(0).toUpperCase() + app.slice(1);

export interface NetworkRules {
  /** Characters allowed in one post. */
  maxChars: number;
  /** Most images one post carries on our route (1 = single image only, 0 = no images). */
  maxImages: number;
  /** Image shape the network accepts (width / height), or null for any. */
  aspect: null | { min: number; max: number; fix: CropShape };
  /** Where a preview folds long text ("See more"). */
  fold: number;
  firstComment: boolean;
  poll: boolean;
  linkCard: boolean;
  /** Posts can be set for later (TikTok goes through its own form right away). */
  schedule: boolean;
}

export const NETWORK_RULES: Record<string, NetworkRules> = {
  facebook: { maxChars: 63206, maxImages: 10, aspect: null, fold: 480, firstComment: true, poll: false, linkCard: true, schedule: true },
  instagram: { maxChars: 2200, maxImages: 1, aspect: { min: 0.8, max: 1.91, fix: "portrait" }, fold: 125, firstComment: false, poll: false, linkCard: false, schedule: true },
  linkedin: { maxChars: 3000, maxImages: 0, aspect: null, fold: 210, firstComment: false, poll: true, linkCard: false, schedule: true },
  pinterest: { maxChars: 800, maxImages: 1, aspect: null, fold: 100, firstComment: false, poll: false, linkCard: false, schedule: true },
  reddit: { maxChars: 40000, maxImages: 0, aspect: null, fold: 300, firstComment: false, poll: false, linkCard: false, schedule: true },
  threads: { maxChars: 500, maxImages: 1, aspect: null, fold: 500, firstComment: false, poll: false, linkCard: false, schedule: true },
  testnet: { maxChars: 2000, maxImages: 4, aspect: null, fold: 300, firstComment: false, poll: false, linkCard: false, schedule: true }, // R118: staging only
  tiktok: { maxChars: 2200, maxImages: 0, aspect: null, fold: 100, firstComment: false, poll: false, linkCard: false, schedule: false },
};

/** What one network does with one format: takes it, takes it changed (how), or cannot take it (why). */
export type FormatFit = { fit: "yes" } | { fit: "changed"; how: string } | { fit: "no"; why: string };

export function formatFit(app: string, format: SocialFormat): FormatFit {
  const name = networkLabel(app);
  const r = NETWORK_RULES[app];
  if (!r) return { fit: "no", why: `Multies can't post to ${name} yet.` };
  if (app === "tiktok") return format === "video" || format === "story" ? { fit: "yes" } : { fit: "no", why: "TikTok takes videos." };
  if (format === "video" || format === "story") return { fit: "no", why: `Multies can't post videos to ${name} yet.` };
  if (format === "text") return app === "instagram" || app === "pinterest" ? { fit: "no", why: `${name} needs an image.` } : { fit: "yes" };
  if (r.maxImages === 0) return { fit: "changed", how: "Text only, the image is left off" };
  if (format === "carousel" && r.maxImages === 1) return { fit: "changed", how: "First image only" };
  return { fit: "yes" };
}

/** The text one network gets: its own edited text, else the main text. */
export function textFor(main: string, texts: Record<string, string> | null | undefined, app: string): string {
  const own = texts?.[app];
  return typeof own === "string" && own.trim() ? own : main;
}

/** Counts characters the way people see them (an emoji counts once). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export type CropShape = "original" | "square" | "portrait" | "story" | "wide";
export const CROP_SHAPES: { id: CropShape; label: string; ratio: number | null }[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "square", label: "Square", ratio: 1 },
  { id: "portrait", label: "Portrait 4:5", ratio: 4 / 5 },
  { id: "story", label: "Story 9:16", ratio: 9 / 16 },
  { id: "wide", label: "Wide 1.91:1", ratio: 1.91 },
];
export type CropAnchor = "start" | "center" | "end";

/** The part of a w x h image kept for a shape (start = top or left). */
export function cropRect(w: number, h: number, shape: CropShape, anchor: CropAnchor = "center") {
  const ratio = CROP_SHAPES.find((s) => s.id === shape)?.ratio ?? null;
  if (!ratio || w <= 0 || h <= 0) return { x: 0, y: 0, w, h };
  let cw = w, ch = Math.round(w / ratio);
  if (ch > h) { ch = h; cw = Math.round(h * ratio); }
  const pos = (room: number) => (anchor === "start" ? 0 : anchor === "end" ? room : Math.round(room / 2));
  return { x: pos(w - cw), y: pos(h - ch), w: cw, h: ch };
}

export interface PollInput { question: string; options: string[]; days: number }
export const POLL_DAYS = [1, 3, 7, 14] as const;
export function pollProblem(p: PollInput | null | undefined): string | null {
  if (!p) return null;
  const question = p.question ?? "";
  const opts = p.options.map((o) => o.trim()).filter(Boolean);
  if (opts.length < 2) return "A poll needs at least 2 options.";
  if (opts.length > 4) return "A poll can have 4 options at most.";
  if (opts.some((o) => charCount(o) > 30)) return "Each poll option can be 30 characters at most.";
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return "Each poll option must be different.";
  if (!question.trim()) return "Write the poll question.";
  if (charCount(question.trim()) > 140) return "The poll question can be 140 characters at most.";
  if (!(POLL_DAYS as readonly number[]).includes(p.days)) return "Pick how long the poll runs.";
  return null;
}

export interface PostExtras { firstComment?: string | null; poll?: PollInput | null; linkCard?: boolean; /** R132: per network details (pin, youtube, gbp). */ pin?: import("./social-p3").PinDetails | null; youtube?: import("./social-p3").YoutubeDetails | null; gbp?: import("./social-p3").GbpDetails | null }

/** One account's check before sending. */
export type CheckState = "ready" | "changed" | "out";
export interface AccountCheck { accountId: string; app: string; state: CheckState; notes: string[] }

export interface CheckInput {
  format: SocialFormat;
  main: string;
  texts?: Record<string, string> | null;
  images: { w: number; h: number }[];
  extras?: PostExtras | null;
  accounts: { id: string; app: string; target?: string | null; broken?: string | null; needsTarget?: boolean }[];
  /** Set when the post is going out later. */
  scheduled?: boolean;
}

export function firstLink(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

/** Every rule the composer and the server check, per account, in plain words. */
export function composerChecks(input: CheckInput): AccountCheck[] {
  return input.accounts.map((a) => {
    const name = networkLabel(a.app);
    const r = NETWORK_RULES[a.app];
    const out = (why: string): AccountCheck => ({ accountId: a.id, app: a.app, state: "out", notes: [why] });
    if (!r) return out(`Multies can't post to ${name} yet.`);
    if (a.broken) return out(a.broken);
    const fit = formatFit(a.app, input.format);
    if (fit.fit === "no") return out(fit.why);
    if (input.scheduled && !r.schedule) return out(`${name} posts go out right away, so it can't be scheduled here.`);
    const text = textFor(input.main, input.texts, a.app).trim();
    if (!text && a.app !== "tiktok") return out("Write some text first.");
    // R132: per network details (pin title, link, alt text), checked only when the post carries them.
    const p3 = detailsProblem(a.app, text, input.extras ?? null, { format: input.format, imageCount: input.images.length });
    if (p3) return out(p3);
    const len = charCount(text);
    if (len > r.maxChars) return out(`Too long for ${name}: ${len.toLocaleString("en")} of ${r.maxChars.toLocaleString("en")} characters.`);
    if (a.needsTarget && !(a.target ?? "").trim()) return out(a.app === "pinterest" ? "Pick a board." : a.app === "reddit" ? "Pick a community." : "Pick a Page.");
    const usesImages = input.format === "image" || input.format === "carousel";
    if (usesImages && !input.images.length && r.maxImages > 0) return out(`${name} needs an image. Add one first.`);
    if (input.extras?.poll && a.app === "linkedin") {
      const p = pollProblem(input.extras.poll);
      if (p) return out(p);
    }
    const notes: string[] = [];
    if (fit.fit === "changed") notes.push(fit.how);
    if (usesImages && input.images.length > r.maxImages && r.maxImages > 1) notes.push(`Takes ${r.maxImages} images, the last ${input.images.length - r.maxImages} are left off`);
    if (usesImages && r.aspect && input.images[0]) {
      const { w, h } = input.images[0];
      const ratio = w / h;
      if (ratio < r.aspect.min - 0.01 || ratio > r.aspect.max + 0.01) notes.push(`Image shape will be cropped by ${name} (use Crop, Portrait 4:5)`);
    }
    if (input.extras?.firstComment?.trim() && !r.firstComment) notes.push("First comment is left off here");
    if (input.extras?.poll && !r.poll) notes.push("Poll is left off here");
    if (input.extras?.linkCard && r.linkCard && firstLink(text)) notes.push("Link card from your first link");
    const changed = notes.some((n) => !n.startsWith("Link card"));
    return { accountId: a.id, app: a.app, state: changed ? "changed" : "ready", notes };
  });
}

/* ---------------------------------------------------------------- time slots */

export interface SlotRule { accountId: string | null; weekday: number; minute: number; tz: string }

/** Minutes the zone is ahead of UTC at this instant. */
export function tzOffsetMinutes(at: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
    const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour") % 24, v("minute"));
    return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch { return 0; }
}

/** Wall clock date parts of an instant in a zone. */
function wall(at: Date, tz: string) {
  const d = new Date(at.getTime() + tzOffsetMinutes(at, tz) * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
}

/** The instant of a wall clock time in a zone. */
export function zonedInstant(y: number, m: number, d: number, minute: number, tz: string): Date {
  const guess = Date.UTC(y, m, d, Math.floor(minute / 60), minute % 60);
  let t = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - tzOffsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

/** Slot times from `from` for `days` days, earliest first, each with the account it belongs to (null = all). */
export function slotTimes(rules: SlotRule[], from: Date, days: number): { at: Date; accountId: string | null }[] {
  const out: { at: Date; accountId: string | null }[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const start = wall(from, r.tz);
    for (let i = 0; i <= days; i++) {
      const base = new Date(Date.UTC(start.y, start.m, start.d + i));
      if (base.getUTCDay() !== r.weekday) continue;
      const at = zonedInstant(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), r.minute, r.tz);
      if (at.getTime() < from.getTime() || at.getTime() > from.getTime() + days * 86_400_000) continue;
      const k = `${at.getTime()}|${r.accountId ?? "*"}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ at, accountId: r.accountId });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface BusyPost { runAt: string | Date; accountIds: string[]; status?: string }

/** A slot is taken when a post for any of its accounts sits within 5 minutes of it. */
const TAKEN_MS = 5 * 60_000;
const LIVE = new Set(["scheduled", "sending", "done", "partial", "review"]);

export function isTaken(at: Date, accountIds: string[], posts: BusyPost[]): boolean {
  return posts.some((p) => (!p.status || LIVE.has(p.status)) && Math.abs(new Date(p.runAt).getTime() - at.getTime()) < TAKEN_MS
    && (accountIds.length === 0 || p.accountIds.some((id) => accountIds.includes(id))));
}

/**
 * Free slots for the picked accounts, earliest first: a slot counts when it is for all accounts or for one of them,
 * at least `leadMs` from now, and no post for those accounts sits on it.
 */
export function freeSlots(rules: SlotRule[], posts: BusyPost[], accountIds: string[], now: Date, opts: { days?: number; leadMs?: number; limit?: number } = {}): Date[] {
  const from = new Date(now.getTime() + (opts.leadMs ?? 10 * 60_000));
  const res: Date[] = [];
  for (const s of slotTimes(rules, from, opts.days ?? 14)) {
    if (s.accountId && accountIds.length && !accountIds.includes(s.accountId)) continue;
    const ids = s.accountId ? [s.accountId] : accountIds;
    if (isTaken(s.at, ids, posts)) continue;
    if (res.some((d) => d.getTime() === s.at.getTime())) continue;
    res.push(s.at);
    if (res.length >= (opts.limit ?? 1)) break;
  }
  return res;
}

/* ---------------------------------------------------------------- evergreen */

export const EVERGREEN_RULES = { minGapDays: 14, maxUses: 10, perWeek: 3, lookAheadHours: 48 } as const;

export interface EvergreenCandidate { id: string; accountIds: string[]; uses: number; lastUsedAt: Date | null }

/**
 * Which evergreen post fills a free slot: one whose accounts the slot serves, used fewer than maxUses times, not used
 * in the last minGapDays, and never the same post as the one just before (no exact repeats back to back). Least
 * recently used first; ties go to the fewest uses.
 */
export function pickEvergreen(cands: EvergreenCandidate[], ctx: { now: Date; lastSourceId: string | null; slotAccountId: string | null }): EvergreenCandidate | null {
  const gap = EVERGREEN_RULES.minGapDays * 86_400_000;
  const ok = cands.filter((c) => c.uses < EVERGREEN_RULES.maxUses
    && c.id !== ctx.lastSourceId
    && (!c.lastUsedAt || ctx.now.getTime() - c.lastUsedAt.getTime() >= gap)
    && (!ctx.slotAccountId || c.accountIds.includes(ctx.slotAccountId)));
  ok.sort((a, b) => (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0) || a.uses - b.uses || a.id.localeCompare(b.id));
  return ok[0] ?? null;
}

/* ---------------------------------------------------------------- roles */

export type WorkspaceRole = "owner" | "admin" | "member";
/** Owners and admins post and approve; members write drafts and submit them for approval. */
export const canPublish = (role: WorkspaceRole | string | null | undefined) => role === "owner" || role === "admin";
export const canApprove = canPublish;
export const canSubmit = (role: WorkspaceRole | string | null | undefined) => role === "owner" || role === "admin" || role === "member";

/** Statuses added in R117. The phone app (1.10.6) never sees these unless it asks for them. */
export const DRAFT_STATUSES = ["draft", "review", "changes", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Who may edit a post now: its author while it is a draft or sent back, an approver while it is not sent. */
export function canEditPost(role: string, userId: string, post: { status: string; createdBy: string | null }): boolean {
  if (["draft", "changes"].includes(post.status)) return post.createdBy === userId || canPublish(role);
  if (["review", "scheduled", "rejected"].includes(post.status)) return canPublish(role);
  return false;
}

/** Library limits on the free plan. */
export const LIBRARY_LIMITS = { items: 200, imageBytes: 25 * 1024 * 1024, imageMax: 1_000_000, textMax: 5000 } as const;
export type LibraryKind = "image" | "caption" | "hashtags";
export interface LibraryItemView { id: string; kind: LibraryKind; name: string; body: string | null; imageUrl: string | null; campaign: string | null; sizeBytes: number; createdAt: string; mediaId?: string }
export interface LibraryView { items: LibraryItemView[]; usedBytes: number; limits: typeof LIBRARY_LIMITS }

export interface SlotView { id: string; accountId: string | null; weekday: number; minute: number; tz: string }

/** Campaign names: trimmed, 40 characters, no surrounding spaces. */
export function cleanCampaign(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}
