/**
 * R124: Blog with newsletter, inside Sites (flag BLOG_R124). Pure rules shared by the server and the web app: post
 * addresses, tags, status, schedule times, reading time, the public blog HTML (server rendered, no client JS except the
 * subscribe box) and the RSS 2.0 feed. Every value written into HTML or XML is escaped here.
 */
import { escHtml, slugify } from "./sites";

export type PostStatus = "draft" | "scheduled" | "published";
export const POST_STATUS_LABEL: Record<PostStatus, string> = { draft: "Draft", scheduled: "Scheduled", published: "Published" };

export const MAX_POSTS = 1000;
export const MAX_TAGS_PER_POST = 10;
export const MAX_TAG = 40;
export const MAX_EXCERPT = 300;
export const MAX_BIO = 400;
export const MAX_POST_TITLE = 200;
export const PER_PAGE = 10;
export const RSS_ITEMS = 20;
export const MAX_SCHEDULE_DAYS = 365;
export const POST_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
/** Addresses under /blog the blog itself uses. */
export const RESERVED_POST_SLUGS = ["tag", "author", "rss", "rss-xml", "feed", "page", "subscribe", "img", "preview"];

export interface LiveMeta { title: string; excerpt: string; cover: string; tags: string[]; authorId: string | null; readMins: number; text?: string }

export interface BlogInfo {
  siteId: string; title: string; description: string; subscribeOn: boolean; url: string; rssUrl: string; rootDocId: string | null;
  newsletter: { available: boolean; listId: string | null; ready: boolean; problems: string[]; mailboxId: string | null; senderName: string; senderAddress: string; counts: { subscribed: number; pending: number; unsubscribed: number } } | null;
}
export interface AuthorInfo { userId: string; slug: string; name: string; bio: string; photo: string; url: string; posts: number }
export interface PostSummary {
  id: string; docId: string; slug: string; title: string; excerpt: string; cover: string; tags: string[]; authorId: string | null; authorName: string;
  status: PostStatus; publishAt: number | null; publishedAt: number | null; updatedAt: number; hasUnpublished: boolean; emailed: boolean; url: string;
}
export interface PostDetail extends PostSummary {
  emailOnPublish: boolean; emailState: "none" | "scheduled" | "sent" | "skipped"; campaignId: string | null; canEdit: boolean; canEmail: boolean; previewUrl: string; readMins: number;
}

export function postSlugProblem(slug: string): string | null {
  if (!slug) return "Give the post an address.";
  if (!POST_SLUG_RE.test(slug) || slug.includes("--")) return "Use lowercase letters, numbers and single hyphens in the address.";
  if (RESERVED_POST_SLUGS.includes(slug)) return "That address is taken by the blog itself. Pick another one.";
  return null;
}

/** The first free address from `base` (base, base-2, base-3 ...) among `taken`. */
export function freePostSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  let b = slugify(base, "post").slice(0, 70).replace(/-+$/, "") || "post";
  if (RESERVED_POST_SLUGS.includes(b)) b = `${b}-post`;
  if (!set.has(b)) return b;
  for (let i = 2; i < 10_000; i++) { const s = `${b}-${i}`; if (!set.has(s)) return s; }
  return `${b}-${Date.now().toString(36)}`;
}

/** A tag's address: lowercase words joined by single hyphens (non Latin letters kept). */
export function tagSlug(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Cleans a tag list: trimmed, single spaces, no duplicates (by address), at most 10, each at most 40 characters. */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = []; const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const name = t.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG);
    const s = tagSlug(name);
    if (!name || !s || seen.has(s)) continue;
    seen.add(s); out.push(name);
    if (out.length >= MAX_TAGS_PER_POST) break;
  }
  return out;
}

/** Status from the live snapshot and its time: never published, waiting for its time, or live. */
export function postStatusOf(p: { live: unknown; publishAt: number | null }, now: number): PostStatus {
  if (!p.live) return "draft";
  if (p.publishAt !== null && p.publishAt > now) return "scheduled";
  return "published";
}
export const isLive = (p: { live: unknown; publishAt: number | null }, now: number) => postStatusOf(p, now) === "published";

/**
 * A publish time from the editor. The web app sends epoch milliseconds made from the person's own local time, so the
 * server never guesses a time zone. Null means now. Errors are plain words.
 */
export function scheduleProblem(at: number | null | undefined, now: number): string | null {
  if (at === null || at === undefined) return null;
  if (!Number.isFinite(at)) return "Pick a date and time.";
  if (at < now - 60_000) return "Pick a time in the future.";
  if (at > now + MAX_SCHEDULE_DAYS * 86_400_000) return "Schedule up to a year ahead.";
  return null;
}

/** Minutes to read at about 220 words a minute, at least 1. */
export function readingMinutes(text: string): number {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return Math.max(1, Math.round(words / 220));
}

/** An excerpt from the body when the writer gave none: the first sentences up to about 200 characters. */
export function autoExcerpt(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${cut.slice(0, at > max * 0.5 ? at + (cut[at] === "." ? 1 : 0) : max).trim()}...`;
}

/** Doc image ids (dim_...) a stored image source points at, for the public image list. */
export const DOC_IMAGE_SRC = /^\/api\/doc-images\/(dim_[A-Za-z0-9]{6,40})$/;
export function docImageId(src: string): string | null { const m = DOC_IMAGE_SRC.exec(src.trim()); return m ? m[1]! : null; }

/** A cover as visitors load it: an uploaded doc image through the blog's image address, or an https link. */
export function publicImage(src: string, blogBase: string): string | null {
  const s = (src ?? "").trim();
  if (!s) return null;
  const id = docImageId(s);
  if (id) return `${blogBase}/img/${id}`;
  return /^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 2048 ? s : null;
}

// ---------------------------------------------------------------- dates

export function fmtPostDate(ms: number, tz = "Australia/Sydney"): string {
  try { return new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: tz }); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}
export const rfc822 = (ms: number) => new Date(ms).toUTCString();

// ---------------------------------------------------------------- RSS 2.0

export interface FeedItem { title: string; url: string; excerpt: string; publishedAt: number; author?: string; tags: string[]; cover?: string | null }
const xml = (s: string) => escHtml(s).replace(/&#39;/g, "&apos;");
// eslint-disable-next-line no-control-regex
const xmlSafe = (s: string) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");

export function rssXml(feed: { title: string; description: string; link: string; self: string; updated: number | null }, items: FeedItem[]): string {
  const x = (s: string) => xml(xmlSafe(s));
  const body = items.slice(0, RSS_ITEMS).map((i) => [
    "<item>",
    `<title>${x(i.title)}</title>`,
    `<link>${x(i.url)}</link>`,
    `<guid isPermaLink="true">${x(i.url)}</guid>`,
    `<pubDate>${rfc822(i.publishedAt)}</pubDate>`,
    i.author ? `<dc:creator>${x(i.author)}</dc:creator>` : "",
    ...i.tags.map((t) => `<category>${x(t)}</category>`),
    `<description>${x(i.excerpt)}</description>`,
    i.cover ? `<enclosure url="${x(i.cover)}" length="0" type="image/jpeg"/>` : "",
    "</item>",
  ].filter(Boolean).join("")).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n`
    + `<title>${x(feed.title)}</title>\n<link>${x(feed.link)}</link>\n<description>${x(feed.description || feed.title)}</description>\n<language>en</language>\n`
    + `<atom:link href="${x(feed.self)}" rel="self" type="application/rss+xml"/>\n`
    + (feed.updated ? `<lastBuildDate>${rfc822(feed.updated)}</lastBuildDate>\n` : "")
    + `${body}\n</channel>\n</rss>\n`;
}

// ---------------------------------------------------------------- public HTML (inside the site's page shell)

export interface CardPost { slug: string; title: string; excerpt: string; cover: string | null; tags: string[]; authorName: string; authorSlug: string | null; publishedAt: number; readMins: number }

export const BLOG_CSS = `.blog-head{margin:8px 0 28px}.blog-head h1{margin:0 0 6px}.blog-head p{margin:0;color:var(--muted,#6b7280)}
.posts{display:grid;gap:28px;margin:0;padding:0;list-style:none}.post-card{display:grid;gap:8px}.post-card h2{margin:0;font-size:1.35rem;line-height:1.3}.post-card h2 a{color:inherit;text-decoration:none}.post-card h2 a:hover{text-decoration:underline}
.post-card img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:var(--card,#f4f4f5)}.post-card p{margin:0}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:.9rem;color:var(--muted,#6b7280)}.meta a{color:inherit}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}.tags a{display:inline-block;padding:2px 10px;border:1px solid var(--line,#e4e4e7);border-radius:999px;font-size:.85rem;text-decoration:none;color:inherit}
.post h1{font-size:2.1rem;line-height:1.2;margin:4px 0 10px}.post .cover{width:100%;border-radius:14px;margin:18px 0}.post .body{font-size:1.07rem;line-height:1.75}.post .body img{max-width:100%;height:auto;border-radius:10px}
.post .body pre{overflow:auto;padding:12px;border-radius:8px;background:var(--card,#f4f4f5)}.post .body .table{overflow-x:auto}.post .body table{border-collapse:collapse}.post .body td,.post .body th{border:1px solid var(--line,#e4e4e7);padding:6px 10px}
.post .body blockquote{margin:16px 0;padding-left:16px;border-left:3px solid rgba(127,127,127,.4)}.post .body .callout{padding:12px 14px;border-radius:10px;background:var(--card,#f4f4f5)}
.author-card{display:flex;gap:14px;align-items:center;margin:28px 0;padding:16px;border:1px solid var(--line,#e4e4e7);border-radius:14px}.author-card img,.author-head img{width:56px;height:56px;border-radius:50%;object-fit:cover}
.author-head{display:flex;gap:16px;align-items:center;margin:8px 0 28px}.author-head img{width:80px;height:80px}
.pager{display:flex;justify-content:space-between;gap:12px;margin:32px 0 8px}.pager a{min-height:44px;display:inline-flex;align-items:center}
.subscribe{margin:36px 0 8px;padding:20px;border:1px solid var(--line,#e4e4e7);border-radius:14px}.subscribe h2{margin:0 0 4px;font-size:1.2rem}.subscribe p{margin:0 0 12px}
.subscribe form{display:flex;flex-wrap:wrap;gap:8px}.subscribe input[type=email]{flex:1 1 220px;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--muted,#6b7280);font:inherit;background:transparent;color:inherit}
.subscribe .btn{min-height:44px}.subscribe .note{font-size:.85rem;color:var(--muted,#6b7280);margin:10px 0 0}.subscribe .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.feed-link{font-size:.9rem}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}`;

const e = escHtml;

export function postMetaHtml(p: { publishedAt: number; readMins: number; authorName: string; authorHref: string | null }): string {
  const who = p.authorName ? (p.authorHref ? `<a href="${e(p.authorHref)}" rel="author">${e(p.authorName)}</a>` : e(p.authorName)) : "";
  return `<p class="meta">${who ? `<span>${who}</span>` : ""}<time datetime="${new Date(p.publishedAt).toISOString()}">${e(fmtPostDate(p.publishedAt))}</time><span>${p.readMins} min read</span></p>`;
}

export function tagsHtml(tags: string[], blogBase: string): string {
  if (!tags.length) return "";
  return `<ul class="tags" aria-label="Tags">${tags.map((t) => `<li><a href="${e(`${blogBase}/tag/${encodeURIComponent(tagSlug(t))}`)}">${e(t)}</a></li>`).join("")}</ul>`;
}

export function postCardsHtml(posts: CardPost[], blogBase: string, empty: string): string {
  if (!posts.length) return `<p class="empty">${e(empty)}</p>`;
  return `<ol class="posts" role="list">${posts.map((p) => {
    const href = `${blogBase}/${p.slug}`;
    return `<li class="post-card"><article>${p.cover ? `<a href="${e(href)}" tabindex="-1" aria-hidden="true"><img src="${e(p.cover)}" alt="" loading="lazy"></a>` : ""}`
      + `<h2><a href="${e(href)}">${e(p.title)}</a></h2>${postMetaHtml({ publishedAt: p.publishedAt, readMins: p.readMins, authorName: p.authorName, authorHref: p.authorSlug ? `${blogBase}/author/${p.authorSlug}` : null })}`
      + `${p.excerpt ? `<p>${e(p.excerpt)}</p>` : ""}${tagsHtml(p.tags, blogBase)}</article></li>`;
  }).join("")}</ol>`;
}

export function pagerHtml(page: number, pages: number, hrefOf: (n: number) => string): string {
  if (pages <= 1) return "";
  const prev = page > 1 ? `<a href="${e(hrefOf(page - 1))}" rel="prev">Newer posts</a>` : "<span></span>";
  const next = page < pages ? `<a href="${e(hrefOf(page + 1))}" rel="next">Older posts</a>` : "<span></span>";
  return `<nav class="pager" aria-label="More posts">${prev}<span class="meta">Page ${page} of ${pages}</span>${next}</nav>`;
}

export function subscribeBoxHtml(o: { action: string; shield: string; blogTitle: string; senderName: string }): string {
  return `<section class="subscribe" aria-labelledby="sub-title"><h2 id="sub-title">Get new posts by email</h2><p>We send an email when ${e(o.senderName || o.blogTitle)} publishes. Unsubscribe from any email.</p>`
    + `<form id="blog-subscribe" method="post" action="${e(o.action)}" data-shield="${e(o.shield)}" novalidate><label class="visually-hidden" for="sub-email">Email address</label>`
    + `<input id="sub-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" required>`
    + `<div class="hp" aria-hidden="true"><label for="sub-hp">Leave this empty</label><input id="sub-hp" name="website" tabindex="-1" autocomplete="off"></div>`
    + `<button class="btn" type="submit">Subscribe</button></form><p class="note" id="sub-status" role="status" aria-live="polite">We'll email you a link to confirm first.</p>`
    + `<noscript><p class="note">Turn on JavaScript to subscribe.</p></noscript></section>`;
}

/** Page numbers from a query value: 1 for anything odd, capped at the last page. */
export function pageNumber(raw: string | undefined | null, pages: number): number {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, pages));
}

/** Rows for the subscriber CSV. Quotes every cell and defuses spreadsheet formulas. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${s.replace(/"/g, '""')}"`;
}
