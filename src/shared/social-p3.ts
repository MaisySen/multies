/**
 * R132: Social P3, the pure rules shared by the server and the web app (flag SOCIAL_P3_R132). Pin details for
 * Pinterest, YouTube video details and Google Business Profile posts (both behind held sub flags), the Snapchat share
 * link, best times to post from the workspace's own results (time zone by name, so daylight saving is safe) and the
 * writing help actions. No I/O here, so every rule has unit tests.
 */

/* ---------------------------------------------------------------- flags */

export interface P3Flags { p3?: boolean; youtubeUpload?: boolean; gbp?: boolean }

/** Networks the composer may offer for posting under these flags (held networks only when their own flag is on). */
export function p3PostApps(f: P3Flags): string[] {
  if (!f.p3) return [];
  return [...(f.youtubeUpload ? ["youtube"] : []), ...(f.gbp ? ["google_business_profile"] : [])];
}
/** Networks whose inbox and health rows R132 adds (YouTube works on the managed sign in; Business Profile only when its flag is on). */
export function p3SourceApps(f: P3Flags): string[] {
  if (!f.p3) return [];
  return ["youtube", ...(f.gbp ? ["google_business_profile"] : [])];
}

/* ---------------------------------------------------------------- per network details */

export const PIN_TITLE_MAX = 100;
export const PIN_ALT_MAX = 500;
export const LINK_MAX = 2048;
export const YT_TITLE_MAX = 100;
export const YT_DESC_MAX = 5000;
export const YT_PRIVACY = ["private", "unlisted", "public"] as const;
export type YtPrivacy = (typeof YT_PRIVACY)[number];
export const YT_PRIVACY_LABEL: Record<YtPrivacy, string> = { private: "Private", unlisted: "Unlisted", public: "Public" };
export const YT_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const YT_THUMB_MAX_BYTES = 2 * 1024 * 1024;
export const GBP_TEXT_MAX = 1500;
export const GBP_TITLE_MAX = 58;
export const GBP_COUPON_MAX = 58;
export const GBP_TERMS_MAX = 5000;
export const GBP_TYPES = ["update", "event", "offer"] as const;
export type GbpType = (typeof GBP_TYPES)[number];
export const GBP_TYPE_LABEL: Record<GbpType, string> = { update: "What's new", event: "Event", offer: "Offer" };

export interface PinDetails { title?: string | null; link?: string | null; alt?: string | null }
export interface YoutubeDetails { title?: string | null; privacy?: YtPrivacy | null }
export interface GbpDetails { type?: GbpType | null; title?: string | null; start?: string | null; end?: string | null; coupon?: string | null; terms?: string | null; redeem?: string | null }
export interface P3Extras { pin?: PinDetails | null; youtube?: YoutubeDetails | null; gbp?: GbpDetails | null }

const t = (v: unknown, n: number) => (typeof v === "string" ? v.split(String.fromCharCode(0)).join("").trim().slice(0, n) : "");

/** True for an https link a network will take. */
export function isHttpsLink(v: string, max = LINK_MAX): boolean {
  if (!v || v.length > max) return false;
  try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname && u.hostname.includes("."); } catch { return false; }
}

/** Keeps only known fields, trimmed and capped a little above each limit so the checks can still name the problem. */
export function cleanP3(x: unknown): P3Extras | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, Record<string, unknown> | undefined>;
  const out: P3Extras = {};
  if (o.pin && typeof o.pin === "object") {
    const pin = { title: t(o.pin.title, PIN_TITLE_MAX + 50) || null, link: t(o.pin.link, LINK_MAX + 50) || null, alt: t(o.pin.alt, PIN_ALT_MAX + 50) || null };
    if (pin.title || pin.link || pin.alt) out.pin = pin;
  }
  if (o.youtube && typeof o.youtube === "object") {
    const p = String(o.youtube.privacy ?? "");
    out.youtube = { title: t(o.youtube.title, YT_TITLE_MAX + 50) || null, privacy: (YT_PRIVACY as readonly string[]).includes(p) ? (p as YtPrivacy) : "private" };
  }
  if (o.gbp && typeof o.gbp === "object") {
    const ty = String(o.gbp.type ?? "update");
    out.gbp = {
      type: (GBP_TYPES as readonly string[]).includes(ty) ? (ty as GbpType) : "update", title: t(o.gbp.title, GBP_TITLE_MAX + 20) || null,
      start: t(o.gbp.start, 40) || null, end: t(o.gbp.end, 40) || null, coupon: t(o.gbp.coupon, GBP_COUPON_MAX + 20) || null,
      terms: t(o.gbp.terms, GBP_TERMS_MAX + 50) || null, redeem: t(o.gbp.redeem, LINK_MAX + 50) || null,
    };
  }
  return Object.keys(out).length ? out : null;
}

const PHONE = /(\+?\d[\d\s().]{7,}\d)/;

/**
 * The one line problem a network has with this post's details, or null. format and imageCount come from the post;
 * the text is the network's own text. Pure, run in the composer before Schedule and again on the server.
 */
export function detailsProblem(app: string, text: string, x: P3Extras | null | undefined, opts: { format?: string; imageCount?: number; hasVideo?: boolean } = {}): string | null {
  if (app === "pinterest") {
    const pin = x?.pin;
    if (!pin) return null;
    if ((pin.title ?? "").length > PIN_TITLE_MAX) return `Pin title is too long: ${PIN_TITLE_MAX} characters at most.`;
    if (pin.link && !isHttpsLink(pin.link)) return "The pin link must be a full https link.";
    if ((pin.alt ?? "").length > PIN_ALT_MAX) return `Alt text is too long: ${PIN_ALT_MAX} characters at most.`;
    return null;
  }
  if (app === "youtube") {
    const y = x?.youtube;
    if (!opts.hasVideo) return "YouTube needs a video.";
    const title = (y?.title ?? "").trim();
    if (!title) return "Add a video title for YouTube.";
    if (title.length > YT_TITLE_MAX) return `Video title is too long: ${YT_TITLE_MAX} characters at most.`;
    if (/[<>]/.test(title) || /[<>]/.test(text)) return "YouTube doesn't take the characters < or > in titles and descriptions.";
    if (text.length > YT_DESC_MAX) return `Description is too long for YouTube: ${YT_DESC_MAX} characters at most.`;
    return null;
  }
  if (app === "google_business_profile") {
    const g = x?.gbp ?? { type: "update" as GbpType };
    if (text.length > GBP_TEXT_MAX) return `Too long for Google Business Profile: ${GBP_TEXT_MAX} characters at most.`;
    if (PHONE.test(text)) return "Google Business Profile turns down posts with phone numbers. Use the call button on your profile instead.";
    if (g.type === "event" || g.type === "offer") {
      const title = (g.title ?? "").trim();
      if (!title) return `Add a title for the ${g.type === "event" ? "event" : "offer"}.`;
      if (title.length > GBP_TITLE_MAX) return `Title is too long: ${GBP_TITLE_MAX} characters at most.`;
      const s = Date.parse(g.start ?? ""); const e = Date.parse(g.end ?? "");
      if (!Number.isFinite(s) || !Number.isFinite(e)) return "Add a start and an end.";
      if (e < s) return "The end must be after the start.";
    }
    if (g.type === "offer") {
      if ((g.coupon ?? "").length > GBP_COUPON_MAX) return `Coupon code is too long: ${GBP_COUPON_MAX} characters at most.`;
      if ((g.terms ?? "").length > GBP_TERMS_MAX) return "Terms are too long.";
      if (g.redeem && !isHttpsLink(g.redeem)) return "The redeem link must be a full https link.";
    }
    return null;
  }
  return null;
}

/** What the Pinterest pin tool takes. The description is the post text; the title falls back to its first line. */
export function pinArgs(text: string, board: string, image: { b64: string; type: string }, pin: PinDetails | null | undefined) {
  const title = (pin?.title ?? "").trim() || text.split("\n")[0]!.trim();
  return {
    board_id: board, description: text.slice(0, 800), title: title.slice(0, PIN_TITLE_MAX),
    ...(pin?.link && isHttpsLink(pin.link) ? { link: pin.link } : {}),
    ...(pin?.alt ? { alt_text: pin.alt.slice(0, PIN_ALT_MAX) } : {}),
    media_source: { source_type: "image_base64", content_type: image.type, data: image.b64 },
  };
}

/** What the YouTube upload tool takes (held: Multies keeps no videos yet). Private unless the person picked otherwise. */
export function youtubeArgs(text: string, y: YoutubeDetails | null | undefined, videoUrl: string) {
  const tags = [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.slice(1)))].slice(0, 15);
  return { title: (y?.title ?? "").trim().slice(0, YT_TITLE_MAX), description: text.slice(0, YT_DESC_MAX), tags, categoryId: "22", privacyStatus: y?.privacy ?? "private", videoFilePath: videoUrl };
}

const gDate = (iso: string) => { const d = new Date(iso); return { date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, time: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() } }; };

/** A Business Profile localPost body (held: needs Business Profile API access). */
export function gbpBody(text: string, g: GbpDetails | null | undefined, imageUrl: string | null) {
  const type = g?.type ?? "update";
  const body: Record<string, unknown> = { languageCode: "en", summary: text.slice(0, GBP_TEXT_MAX), topicType: type === "update" ? "STANDARD" : type === "event" ? "EVENT" : "OFFER" };
  if (imageUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }];
  if ((type === "event" || type === "offer") && g?.start && g?.end) {
    const s = gDate(g.start); const e = gDate(g.end);
    body.event = { title: (g.title ?? "").slice(0, GBP_TITLE_MAX), schedule: { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time } };
  }
  if (type === "offer") body.offer = { ...(g?.coupon ? { couponCode: g.coupon } : {}), ...(g?.redeem ? { redeemOnlineUrl: g.redeem } : {}), ...(g?.terms ? { termsConditions: g.terms } : {}) };
  return body;
}

/* ---------------------------------------------------------------- Snapchat share */

/** Our own share page for a link (it loads the Snapchat share button; the app pages never load outside scripts). */
export function snapShareHref(link: string): string | null {
  if (!isHttpsLink(link)) return null;
  return `/share/snapchat?u=${encodeURIComponent(link)}`;
}

/* ---------------------------------------------------------------- best times */

export const BEST_MIN_POSTS = 20;
export const BEST_DAYS = 90;
/** Shown until a workspace has enough results: mid morning Tuesday, lunch Wednesday, early evening Thursday. */
export const DEFAULT_SLOTS: { day: number; hour: number }[] = [{ day: 1, hour: 9 }, { day: 2, hour: 12 }, { day: 3, hour: 18 }];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface BestSlot { day: number; hour: number; label: string; why: string; at: string }
export interface BestTimesResponse { defaults: boolean; posts: number; need: number; tz: string; slots: BestSlot[] }

/** Weekday (Monday = 0) and hour of an instant in a named time zone. */
export function zoned(ms: number, tz: string): { day: number; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms)); }
  catch { parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms)); }
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { day: DAYS.indexOf(get("weekday")), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function safeTz(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}

/** The next instant at or after now + leadMin that is weekday `day`, hour `hour`, minute 0 in tz (DST safe: checks each hour). */
export function nextAt(day: number, hour: number, tz: string, nowMs: number, leadMin = 15): string {
  const start = Math.ceil((nowMs + leadMin * 60_000) / 3_600_000) * 3_600_000;
  for (let i = 0; i < 24 * 8 + 2; i++) {
    const ms = start + i * 3_600_000;
    const z = zoned(ms, tz);
    if (z.day === day && z.hour === hour) return new Date(ms - z.minute * 60_000).toISOString();
  }
  return new Date(start).toISOString();
}

export function slotLabel(day: number, hour: number): string {
  const am = hour < 12; const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${DAYS[day]} ${h} ${am ? "am" : "pm"}`;
}

/**
 * Top 3 weekday and hour slots by average engagement rate (engagement / reach) in the workspace's time zone, with a
 * one line why. Under BEST_MIN_POSTS posts with results, the defaults, marked as defaults.
 */
export function bestSlots(rows: { sentAt: string; reach: number | null; engagement: number | null }[], tzRaw: string | null | undefined, nowMs: number): BestTimesResponse {
  const tz = safeTz(tzRaw);
  const cells = new Map<string, { day: number; hour: number; sum: number; n: number }>();
  let posts = 0; let total = 0;
  for (const r of rows) {
    if (!r.reach || r.reach <= 0 || r.engagement == null) continue;
    const ms = Date.parse(r.sentAt);
    if (!Number.isFinite(ms)) continue;
    const rate = r.engagement / r.reach;
    const z = zoned(ms, tz);
    const k = `${z.day}:${z.hour}`;
    const c = cells.get(k) ?? { day: z.day, hour: z.hour, sum: 0, n: 0 };
    c.sum += rate; c.n += 1; cells.set(k, c);
    posts += 1; total += rate;
  }
  if (posts < BEST_MIN_POSTS) {
    return { defaults: true, posts, need: BEST_MIN_POSTS - posts, tz, slots: DEFAULT_SLOTS.map((s) => ({ ...s, label: slotLabel(s.day, s.hour), why: "A common good time. Yours show after 20 posts with results.", at: nextAt(s.day, s.hour, tz, nowMs) })) };
  }
  const avg = total / posts;
  const top = [...cells.values()].map((c) => ({ ...c, rate: c.sum / c.n })).sort((a, b) => b.rate - a.rate || b.n - a.n || a.day - b.day || a.hour - b.hour).slice(0, 3);
  return {
    defaults: false, posts, need: 0, tz,
    slots: top.map((c) => {
      const pct = (c.rate * 100).toFixed(c.rate < 0.1 ? 1 : 0);
      const x = avg > 0 ? c.rate / avg : 1;
      const why = `${pct}% engagement from ${c.n} ${c.n === 1 ? "post" : "posts"}${x >= 1.1 ? `, ${x.toFixed(1)} times your average` : ""}.`;
      return { day: c.day, hour: c.hour, label: slotLabel(c.day, c.hour), why, at: nextAt(c.day, c.hour, tz, nowMs) };
    }),
  };
}

/* ---------------------------------------------------------------- writing help */

export const WRITE_ACTIONS = ["shorter", "friendlier", "formal", "hashtags", "fit"] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export const WRITE_LABEL: Record<WriteAction, string> = { shorter: "Make it shorter", friendlier: "Make it friendlier", formal: "Make it more formal", hashtags: "Add hashtags", fit: "Fit to each network" };
export const WRITE_TEXT_MAX = 3000;
export const WRITE_DAILY = 30;
export const WRITE_GLOBAL_UNITS = 1_500;
export const WRITE_LIMIT_MESSAGE = "Daily writing help limit reached, try again tomorrow.";
export const WRITE_ERROR_MESSAGE = "Couldn't rewrite this. Try again.";

export function writePrompt(action: WriteAction, text: string, maxChars: number | null): { system: string; user: string } {
  const ask: Record<WriteAction, string> = {
    shorter: "Rewrite the post shorter and tighter. Keep the meaning, links and hashtags.",
    friendlier: "Rewrite the post in a warmer, friendlier tone. Keep the meaning, links and hashtags.",
    formal: "Rewrite the post in a more formal, professional tone. Keep the meaning, links and hashtags.",
    hashtags: "Return the post unchanged, then a blank line, then 3 to 5 relevant hashtags on one line.",
    fit: "Rewrite the post so it fits the character limit. Keep the meaning and any link.",
  };
  const limit = maxChars ? ` It must be at most ${maxChars} characters.` : "";
  return {
    system: `You edit social media posts for a small business. ${ask[action]}${limit} Reply with the post text only: no quotes, no notes, no preamble. Do not use em dashes or en dashes.`,
    user: text,
  };
}

/** Cleans what the AI returned: no wrapping quotes or labels, no long dashes, cut to the limit at a word. */
export function cleanRewrite(raw: string, original: string, action: WriteAction, maxChars: number | null): string {
  let s = String(raw ?? "").replace(/\r/g, "").trim();
  s = s.replace(/^(here('| i)s|sure|rewritten|post)[^\n:]*:\s*/i, "").trim();
  if (/^["'\u201c].*["'\u201d]$/s.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/\s*[\u2013\u2014]\s*/g, ", ");
  if (action === "hashtags" && !s.startsWith(original.slice(0, 20))) {
    const tags = (s.match(/#[\p{L}\p{N}_]+/gu) ?? []).slice(0, 5);
    s = tags.length ? `${original.trim()}\n\n${[...new Set(tags)].join(" ")}` : original;
  }
  return fitText(s || original, maxChars);
}

/** Cuts text to max characters at the last word break (no AI needed when the AI's answer is still too long). */
export function fitText(s: string, max: number | null): string {
  if (!max || [...s].length <= max) return s;
  const chars = [...s].slice(0, Math.max(1, max - 1)).join("");
  const cut = chars.lastIndexOf(" ");
  return `${(cut > max * 0.6 ? chars.slice(0, cut) : chars).trimEnd()}\u2026`;
}
