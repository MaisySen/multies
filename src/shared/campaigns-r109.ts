/**
 * R109: mail merge plus (lists with consent, newsletters, journeys). Pure rules shared by the server and the
 * web app: merge fields with fallbacks, the email blocks and their HTML, the Spam Act footer, consent rules,
 * journey step timing in a time zone and the daily send plan. No I/O here, so every rule has a unit test.
 */
import { z } from "zod";

export const LIST_NAME_MAX = 80;
export const LIST_MEMBERS_IMPORT_MAX = 2000;
export const CAMPAIGN_BLOCKS_MAX = 40;
export const JOURNEY_STEPS_MAX = 10;
export const JOURNEY_DELAY_DAYS_MAX = 90;
export const CAMPAIGN_SPACING_SECONDS = 4;

export type MemberStatus = "pending" | "subscribed" | "unsubscribed" | "bounced" | "complained";
export type ConsentKind = "express" | "inferred";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled";
export type JourneyStatus = "draft" | "active" | "paused";

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  pending: "Waiting to confirm", subscribed: "Subscribed", unsubscribed: "Unsubscribed", bounced: "Bounced", complained: "Marked as spam",
};
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", paused: "Paused", cancelled: "Stopped",
};
export const CONSENT_SOURCES = ["Signup form", "In person", "Customer who bought from us", "Event signup", "Imported with consent", "Other"] as const;

// ------------------------------------------------------------------ blocks

const url = z.string().trim().max(2000).refine((v) => /^https:\/\//i.test(v) || /^mailto:/i.test(v), "Use a link that starts with https://");
export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: z.string().max(200) }),
  z.object({ type: z.literal("text"), text: z.string().max(10_000) }),
  z.object({ type: z.literal("button"), label: z.string().min(1).max(60), url }),
  z.object({ type: z.literal("image"), url: z.string().trim().max(2000).refine((v) => /^https:\/\//i.test(v), "Use an image link that starts with https://"), alt: z.string().max(200).default("") }),
  z.object({ type: z.literal("divider") }),
]);
export type Block = z.infer<typeof blockSchema>;
export const blocksSchema = z.array(blockSchema).max(CAMPAIGN_BLOCKS_MAX);

export const STARTER_BLOCKS: Block[] = [
  { type: "heading", text: "News from {{workspace}}" },
  { type: "text", text: "Hi {{first_name | there}},\n\nHere is what is new this month." },
  { type: "button", label: "Read more", url: "https://" },
];

// ------------------------------------------------------------------ merge fields

export interface MergePerson { email: string; name?: string; fields?: Record<string, string> }
export interface MergeContext { workspace: string }

/** {{ key }} or {{ key | fallback }}. Keys: letters, digits and underscores. */
const FIELD = /\{\{\s*([a-zA-Z][\w]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function firstName(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/)[0];
  return "";
}

/** The value of one merge field for a person ("" when unknown). Field names are case insensitive. */
export function fieldValue(key: string, p: MergePerson, ctx: MergeContext): string {
  const k = key.toLowerCase();
  if (k === "email") return p.email;
  if (k === "name") return (p.name ?? "").trim();
  if (k === "first_name") return firstName(p.name);
  if (k === "last_name") { const parts = (p.name ?? "").trim().split(/\s+/); return parts.length > 1 ? parts[parts.length - 1] : ""; }
  if (k === "workspace") return ctx.workspace;
  const f = p.fields ?? {};
  const hit = Object.keys(f).find((x) => x.toLowerCase() === k);
  return hit ? String(f[hit] ?? "").trim() : "";
}

/** Fills merge fields; an empty value uses the fallback after the bar, else nothing. `escape` for HTML. */
export function fillMerge(text: string, p: MergePerson, ctx: MergeContext, escape = false): string {
  return text.replace(FIELD, (_m, key: string, fallback: string | undefined) => {
    const v = fieldValue(key, p, ctx) || (fallback ?? "");
    return escape ? escapeHtml(v) : v;
  });
}

/** Field names used in a text that a person has no value and no fallback for (for the preview warning). */
export function missingFields(texts: string[], p: MergePerson, ctx: MergeContext): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(FIELD)) if (!fieldValue(m[1], p, ctx) && !(m[2] ?? "").trim()) out.add(m[1]);
  return [...out];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------------------------ the email

export interface RenderContext extends MergeContext {
  brandColor: string | null;
  senderName: string;
  senderAddress: string;
  listName: string;
  unsubscribeUrl: string;
  /** Wraps a link for click counting; identity when counting is off. */
  trackLink?: (url: string) => string;
  /** The open image URL, when counting is on. */
  pixelUrl?: string | null;
  preheader?: string;
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The plain text paragraphs of a text block, with links turned into anchors after escaping. */
function textHtml(text: string, link: (u: string) => string, color: string) {
  return text.split(/\n{2,}/).map((para) => {
    const esc = escapeHtml(para).replace(/\n/g, "<br>");
    const linked = esc.replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${escapeHtml(link(u.replace(/&amp;/g, "&")))}" style="color:${color}">${u}</a>`);
    return `<p style="margin:0 0 16px;line-height:1.6">${linked}</p>`;
  }).join("");
}

/** The Spam Act footer: who sent it (name and contact), why, and the one click unsubscribe. */
export function footerText(ctx: Pick<RenderContext, "senderName" | "senderAddress" | "listName" | "unsubscribeUrl">): string {
  return `You get this email because you joined ${ctx.listName}.\nSent by ${ctx.senderName}, ${ctx.senderAddress}.\nUnsubscribe at any time: ${ctx.unsubscribeUrl}`;
}

export function renderEmail(blocks: Block[], p: MergePerson, ctx: RenderContext): { html: string; text: string } {
  const color = ctx.brandColor && HEX_COLOR.test(ctx.brandColor) ? ctx.brandColor : "#2f5bea";
  const link = ctx.trackLink ?? ((u: string) => u);
  const fill = (t: string) => fillMerge(t, p, ctx);
  const parts: string[] = [];
  const text: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading") { const t = fill(b.text); parts.push(`<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">${escapeHtml(t)}</h1>`); text.push(t); }
    else if (b.type === "text") { const t = fill(b.text); parts.push(textHtml(t, link, color)); text.push(t); }
    else if (b.type === "button") {
      const u = fill(b.url).trim();
      if (!/^(https:\/\/[^\s]+\.[^\s]+|mailto:\S+)/i.test(u)) continue;
      parts.push(`<p style="margin:8px 0 24px"><a href="${escapeHtml(link(u))}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(fill(b.label))}</a></p>`);
      text.push(`${fill(b.label)}: ${u}`);
    } else if (b.type === "image") parts.push(`<p style="margin:0 0 16px"><img src="${escapeHtml(b.url)}" alt="${escapeHtml(fill(b.alt))}" style="max-width:100%;height:auto;border-radius:8px"></p>`);
    else if (b.type === "divider") { parts.push(`<hr style="border:0;border-top:1px solid #e3e5ea;margin:24px 0">`); text.push("---"); }
  }
  const foot = `<p style="margin:0 0 6px">You get this email because you joined ${escapeHtml(ctx.listName)}.</p><p style="margin:0 0 6px">Sent by ${escapeHtml(ctx.senderName)}, ${escapeHtml(ctx.senderAddress)}.</p><p style="margin:0"><a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#5b6170">Unsubscribe</a></p>`;
  const pre = ctx.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(fill(ctx.preheader))}</div>` : "";
  const pixel = ctx.pixelUrl ? `<img src="${escapeHtml(ctx.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0">` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8">${pre}<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2430;font-size:16px"><div style="background:#ffffff;border-radius:12px;padding:28px 24px">${parts.join("")}</div><div style="padding:16px 8px;font-size:12px;color:#5b6170;line-height:1.5">${foot}</div>${pixel}</div></body></html>`;
  return { html, text: `${text.join("\n\n")}\n\n--\n${footerText(ctx)}` };
}

/** The standard one click unsubscribe headers (RFC 8058). */
export function unsubscribeHeaders(oneClickUrl: string): Record<string, string> {
  return { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

// ------------------------------------------------------------------ consent

export interface ConsentRow { status: MemberStatus; consentKind: ConsentKind; consentAt: number | null; consentSource: string }

/**
 * Spam Act: a bulk email goes only to a subscribed person with recorded consent. Express consent needs
 * its source and time; inferred consent only when the list allows it. Suppressed addresses never.
 */
export function canSend(m: ConsentRow, list: { allowInferred: boolean }, suppressed: boolean): { ok: true } | { ok: false; reason: string } {
  if (suppressed) return { ok: false, reason: "Unsubscribed, bounced or marked as spam" };
  if (m.status !== "subscribed") return { ok: false, reason: MEMBER_STATUS_LABEL[m.status] };
  if (!m.consentAt || !m.consentSource.trim()) return { ok: false, reason: "No consent recorded" };
  if (m.consentKind === "inferred" && !list.allowInferred) return { ok: false, reason: "Only inferred consent, and this list needs express consent" };
  return { ok: true };
}

/** A new or imported person's starting status: confirmed lists wait for the person unless consent is already confirmed. */
export function startStatus(doubleOptIn: boolean, via: "signup" | "manual" | "import"): MemberStatus {
  if (via === "signup") return doubleOptIn ? "pending" : "subscribed";
  return "subscribed";
}

export const normEmail = (e: string) => e.trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;

// ------------------------------------------------------------------ time zones and timing

/** Offset of a time zone from UTC in minutes at a moment (positive east). */
export function tzOffsetMinutes(tz: string, at: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}

export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Local calendar date (y, m, d) of a moment in a time zone. */
function localDate(tz: string, at: number) {
  const d = new Date(at + tzOffsetMinutes(tz, at) * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

/** The UTC moment of a local wall time in a zone (handles daylight saving by re-checking the offset). */
export function zonedTime(tz: string, y: number, m: number, d: number, hour: number): number {
  const guess = Date.UTC(y, m, d, hour, 0, 0);
  let at = guess - tzOffsetMinutes(tz, guess) * 60000;
  at = guess - tzOffsetMinutes(tz, at) * 60000;
  return at;
}

/** When a journey step sends: `delayDays` local days after `from`, at `sendHour` local time; zero days sends now. */
export function stepSendAt(from: number, delayDays: number, sendHour: number, tz: string): number {
  if (delayDays <= 0) return from;
  const l = localDate(tz, from);
  return zonedTime(tz, l.y, l.m, l.d + delayDays, Math.min(23, Math.max(0, sendHour)));
}

/** Start of tomorrow (00:05) in a zone, for sends held by today's limit. */
export function nextDayStart(from: number, tz: string): number {
  const l = localDate(tz, from);
  return zonedTime(tz, l.y, l.m, l.d + 1, 0) + 5 * 60000;
}

/** How many to send today and how many wait, given what is left of today's limit. */
export function sendPlan(total: number, leftToday: number): { today: number; later: number } {
  const today = Math.max(0, Math.min(total, leftToday));
  return { today, later: total - today };
}

// ------------------------------------------------------------------ journeys

export const journeyStepSchema = z.object({
  delayDays: z.number().int().min(0).max(JOURNEY_DELAY_DAYS_MAX),
  subject: z.string().min(1).max(200),
  blocks: blocksSchema,
  onlyIfNotOpened: z.boolean().default(false),
});
export type JourneyStep = z.infer<typeof journeyStepSchema>;
export const journeyStepsSchema = z.array(journeyStepSchema).max(JOURNEY_STEPS_MAX);

export const WELCOME_SERIES: JourneyStep[] = [
  { delayDays: 0, subject: "Welcome to {{workspace}}", blocks: [{ type: "text", text: "Hi {{first_name | there}},\n\nThanks for joining. Here is what to expect from us." }], onlyIfNotOpened: false },
  { delayDays: 3, subject: "In case you missed it", blocks: [{ type: "text", text: "Hi {{first_name | there}},\n\nA quick reminder of our welcome note." }], onlyIfNotOpened: true },
];

/** Whether a journey step should be skipped: "only if not opened" and the last email was opened. */
export function skipStep(step: Pick<JourneyStep, "onlyIfNotOpened">, lastOpened: boolean): boolean {
  return step.onlyIfNotOpened && lastOpened;
}

/** Percent with no decimals, "0%" for none sent. */
export function rate(n: number, of: number): string {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : "0%";
}

/** Allowed recipients on staging (comma list of addresses or @domains). Empty list = no limit. */
export function allowedBy(allow: string[], email: string): boolean {
  if (!allow.length) return true;
  const e = normEmail(email);
  return allow.some((a) => {
    if (a.startsWith("@")) return e.endsWith(a);
    const wild = /^([^@+*]+)\+\*(@[^@*]+)$/.exec(a); // "name+*@domain": the mailbox and any of its +tags
    if (wild) return e.endsWith(wild[2]) && (e === `${wild[1]}${wild[2]}` || (e.startsWith(`${wild[1]}+`) && !e.slice(wild[1].length + 1, -wild[2].length).includes("@")));
    return e === a;
  });
}
