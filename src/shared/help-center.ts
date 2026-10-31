/**
 * R122: help center rules shared by the server and the web app (pure, no I/O): addresses, search terms, the redaction a
 * solved ticket goes through before it can become a public answer, and the limits on public posts.
 */

export const HC_NAME_MAX = 80;
export const HC_INTRO_MAX = 300;
export const HC_TITLE_MAX = 160;
export const HC_SUMMARY_MAX = 300;
export const HC_QUESTION_MAX = 4000;
export const HC_ANSWER_MAX = 8000;
export const HC_AUTHOR_MAX = 60;
export const HC_COMMENT_MAX = 1000;
export const HC_CATEGORY_MAX = 50;
export const HC_PAGE_SIZE = 10;
export const HC_SEARCH_TERMS_MAX = 6;
export const HC_TERMS_PER_ITEM = 200;

export type ArticleStatus = "draft" | "published";
export type PostStatus = "pending" | "published" | "hidden";
export const POST_STATUS_LABEL: Record<PostStatus, string> = { pending: "Waiting", published: "Live", hidden: "Hidden" };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
/** Words that are ours or could mislead visitors; a help center address cannot be one of them. */
const RESERVED = new Set(["app", "api", "admin", "help", "support", "multies", "login", "signin", "signup", "www", "static", "assets", "new", "search"]);

/** "Getting started: billing!" to "getting-started-billing" (ASCII, 60 at most, never empty). */
export function slugify(s: string, fallback = "page"): string {
  const out = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return out || fallback;
}
export const slugOk = (s: string) => SLUG_RE.test(s);
export function centerSlugProblem(s: string): string | null {
  if (!SLUG_RE.test(s) || s.length < 3) return "Use 3 to 60 lowercase letters, numbers and single hyphens.";
  if (RESERVED.has(s)) return "That address is taken. Try another.";
  return null;
}

/** A slug that is free among `taken`: base, base-2, base-3 and so on. */
export function freeSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const s = `${base.slice(0, 56)}-${i}`;
    if (!set.has(s)) return s;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------------------------------------------

const STOP = new Set(("a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so " +
  "that the their them then there these this to up us was we what when where which who why will with you your").split(" "));

/** Lowercase words of 2 to 32 letters or digits, accents folded, stop words dropped. */
export function words(s: string): string[] {
  const folded = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const out: string[] = [];
  for (const w of folded.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2 && w.length <= 32 && !STOP.has(w)) out.push(w);
  return out;
}

/** The weighted terms of an item: title words count 5, summary 3, body 1; at most HC_TERMS_PER_ITEM, heaviest first. */
export function termsOf(parts: { title: string; summary?: string; body?: string }): { term: string; weight: number }[] {
  const m = new Map<string, number>();
  const add = (s: string | undefined, w: number) => { for (const t of words(s ?? "")) m.set(t, Math.min(50, (m.get(t) ?? 0) + w)); };
  add(parts.title, 5); add(parts.summary, 3); add((parts.body ?? "").slice(0, 20000), 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, HC_TERMS_PER_ITEM).map(([term, weight]) => ({ term, weight }));
}

/** The query's search words (distinct, at most HC_SEARCH_TERMS_MAX); each matches terms that start with it. */
export function queryTerms(q: string): string[] {
  return [...new Set(words(q.slice(0, 200)))].slice(0, HC_SEARCH_TERMS_MAX);
}
/** The exclusive upper bound of a prefix range: "bill" to "bilm". */
export function prefixEnd(t: string): string {
  return t.slice(0, -1) + String.fromCharCode(t.charCodeAt(t.length - 1) + 1);
}

export function pageOf(raw: string | null | undefined): number {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  return Number.isFinite(n) && n >= 1 && n <= 50 ? n : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction: a solved ticket on its way to a public answer
// ---------------------------------------------------------------------------------------------------------------

export interface PrivateBits { names: string[]; emails: string[] }
export interface Redacted { text: string; removed: { emails: number; phones: number; names: number; quoted: number } }

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w/])\+?\d[\d ()-]{6,}\d(?![\w/])/g;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The name parts worth hiding: the full name and each part of 2 letters or more. */
export function nameParts(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const full = n.trim().replace(/\s+/g, " ");
    if (full.length >= 2 && !full.includes("@")) out.add(full);
    for (const p of full.split(" ")) if (p.length >= 2 && !p.includes("@")) out.add(p);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Cuts quoted history (lines starting with ">", "On ... wrote:" and everything after, a "-- " signature). */
function cutQuoted(text: string): { text: string; quoted: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let quoted = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{4,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || l === "-- " || l.trim() === "--") { quoted += lines.length - i; break; }
    if (/^\s*>/.test(l)) { quoted++; continue; }
    kept.push(l);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), quoted };
}

/**
 * Removes the customer's email addresses (all addresses), phone numbers, their name and quoted history. A greeting
 * that named them ("Hi Grace,") keeps the greeting ("Hi,").
 */
export function redactForPublic(input: string, bits: PrivateBits): Redacted {
  const removed = { emails: 0, phones: 0, names: 0, quoted: 0 };
  const cut = cutQuoted(input);
  removed.quoted = cut.quoted;
  let text = cut.text.replace(EMAIL_RE, () => { removed.emails++; return "[email removed]"; });
  text = text.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 8 ? (removed.phones++, "[phone removed]") : m));
  for (const n of nameParts(bits.names)) {
    const greet = new RegExp(`\\b(hi|hello|hey|dear|thanks|thank you|cheers)\\s+${escRe(n)}\\b`, "gi");
    text = text.replace(greet, (_m, g: string) => { removed.names++; return g; });
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(n)}(?![\\p{L}\\p{N}])`, "giu");
    text = text.replace(re, () => { removed.names++; return "the customer"; });
  }
  return { text: text.replace(/ +([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim(), removed };
}

/** True when the text still names the customer or carries their address (the server refuses that without Keep). */
export function stillPrivate(text: string, bits: PrivateBits): boolean {
  const low = text.toLowerCase();
  for (const e of bits.emails) if (e && low.includes(e.toLowerCase())) return true;
  for (const n of nameParts(bits.names)) {
    if (n.length < 3) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Public posts
// ---------------------------------------------------------------------------------------------------------------

/** Plain text a visitor typed: control characters out, spaces tidied, length capped. */
export function cleanPost(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/** A post that is mostly links or shouting is held even when posts go live at once. */
export function looksLikeSpam(s: string): boolean {
  const links = (s.match(/https?:\/\//gi) ?? []).length;
  if (links >= 3) return true;
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 30 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) return true;
  return false;
}

export const helpfulPercent = (yes: number, no: number) => (yes + no ? Math.round((yes * 100) / (yes + no)) : null);

export interface HelpCenterSettings { on: boolean; slug: string; name: string; intro: string; qaOn: boolean; moderate: boolean; suggestInChat: boolean }
