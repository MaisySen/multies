/**
 * R123: Sites. Typed blocks (never HTML from people), their checks and the one renderer used by the public page and the
 * editor's live preview, so the preview is exactly what visitors get. Pure functions, no server or browser APIs.
 */

export type BlockType = "hero" | "heading" | "text" | "image" | "button" | "quote" | "features" | "divider" | "form" | "booking";
export interface FeatureItem { title: string; text: string }
export type Block =
  | { id: string; type: "hero"; title: string; text: string; buttonLabel: string; buttonUrl: string }
  | { id: string; type: "heading"; text: string; level: 2 | 3 }
  | { id: string; type: "text"; text: string }
  | { id: string; type: "image"; url: string; alt: string; caption: string }
  | { id: string; type: "button"; label: string; url: string; style: "primary" | "secondary" }
  | { id: string; type: "quote"; text: string; by: string }
  | { id: string; type: "features"; items: FeatureItem[] }
  | { id: string; type: "divider" }
  | { id: string; type: "form"; slug: string; title: string; text: string }
  | { id: string; type: "booking"; slug: string; title: string; text: string };

export type PageStatus = "draft" | "scheduled" | "published";
export type CommentStatus = "pending" | "approved" | "rejected";

export const MAX_BLOCKS = 60;
export const MAX_PAGES = 200;
export const MAX_FEATURES = 6;
export const MAX_TEXT = 5_000;
export const MAX_TITLE = 200;
export const MAX_URL = 2_048;
export const MAX_DESCRIPTION = 160;
export const MAX_COMMENT = 2_000;
export const MAX_VERSIONS = 30;
export const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const LINKED_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const RESERVED_PAGE_SLUGS = ["sitemap", "sitemap-xml", "comments", "assets", "feed", "robots"];

export const BLOCK_LABEL: Record<BlockType, string> = {
  hero: "Hero", heading: "Heading", text: "Text", image: "Image", button: "Button", quote: "Quote", features: "Features", divider: "Divider",
  form: "Form", booking: "Booking",
};
export const BLOCK_HINT: Record<BlockType, string> = {
  hero: "Big title, a line of text and a button", heading: "A section title", text: "Paragraphs with bold, italic and links",
  image: "A picture from a web address", button: "A link that looks like a button", quote: "A quote and who said it", features: "Up to six short points",
  divider: "A thin line between sections", form: "One of your forms", booking: "Your booking page",
};
export const STATUS_LABEL: Record<PageStatus, string> = { draft: "Draft", scheduled: "Scheduled", published: "Published" };

export function slugify(s: string, fallback = "page"): string {
  const v = s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return v || fallback;
}
export function pageSlugProblem(slug: string): string | null {
  if (!PAGE_SLUG_RE.test(slug)) return "Use small letters, numbers and single hyphens for the page address (up to 60).";
  if (RESERVED_PAGE_SLUGS.includes(slug)) return "That page address is reserved. Pick another.";
  return null;
}
export function siteSlugProblem(slug: string): string | null {
  return SITE_SLUG_RE.test(slug) ? null : "Use 3 to 40 small letters, numbers or hyphens for the site address.";
}

/** A link target people may use: https, http, mailto or a path on this site. Anything else (javascript:, data:) is null. */
export function safeUrl(raw: string, opts: { allowMailto?: boolean; allowPath?: boolean } = { allowMailto: true, allowPath: true }): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > MAX_URL || /[\u0000-\u001f\s]/.test(s)) return null;
  if (opts.allowPath !== false && s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  if (opts.allowMailto !== false && /^mailto:[^@\s]+@[^@\s]+$/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}
export const safeImageUrl = (raw: string): string | null => {
  const u = safeUrl(raw, { allowMailto: false, allowPath: false });
  return u && u.startsWith("https://") ? u : null;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").slice(0, max);
const oneLine = (v: unknown, max: number) => str(v, max).replace(/\s+/g, " ").trim();
const idOf = (v: unknown, i: number) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : `b${i}${Math.random().toString(36).slice(2, 8)}`);

export class BlockError extends Error {}

/** Checks and trims blocks from the editor. Throws BlockError with a plain message on anything it cannot keep. */
export function cleanBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) throw new BlockError("The page content is not valid. Reload and try again.");
  if (raw.length > MAX_BLOCKS) throw new BlockError(`A page can hold up to ${MAX_BLOCKS} blocks.`);
  const seen = new Set<string>();
  return raw.map((r, i): Block => {
    const b = (r ?? {}) as Record<string, unknown>;
    let id = idOf(b.id, i);
    if (seen.has(id)) id = `${id}x${i}`;
    seen.add(id);
    const n = i + 1;
    const url = (v: unknown, what: string, required: boolean): string => {
      const s = oneLine(v, MAX_URL);
      if (!s) { if (required) throw new BlockError(`Block ${n}: add the ${what}.`); return ""; }
      const ok = safeUrl(s);
      if (!ok) throw new BlockError(`Block ${n}: the ${what} must start with https://, http://, mailto: or /.`);
      return ok;
    };
    switch (b.type) {
      case "hero": return { id, type: "hero", title: oneLine(b.title, MAX_TITLE), text: str(b.text, 600), buttonLabel: oneLine(b.buttonLabel, 60), buttonUrl: url(b.buttonUrl, "button address", !!oneLine(b.buttonLabel, 60)) };
      case "heading": return { id, type: "heading", text: oneLine(b.text, MAX_TITLE), level: b.level === 3 ? 3 : 2 };
      case "text": return { id, type: "text", text: str(b.text, MAX_TEXT) };
      case "image": {
        const s = oneLine(b.url, MAX_URL);
        const ok = s ? safeImageUrl(s) : "";
        if (s && !ok) throw new BlockError(`Block ${n}: images need an https:// address.`);
        return { id, type: "image", url: ok ?? "", alt: oneLine(b.alt, 300), caption: oneLine(b.caption, 300) };
      }
      case "button": return { id, type: "button", label: oneLine(b.label, 60), url: url(b.url, "button address", !!oneLine(b.label, 60)), style: b.style === "secondary" ? "secondary" : "primary" };
      case "quote": return { id, type: "quote", text: str(b.text, 1_000), by: oneLine(b.by, 120) };
      case "features": {
        const items = Array.isArray(b.items) ? b.items.slice(0, MAX_FEATURES) : [];
        return { id, type: "features", items: items.map((x) => ({ title: oneLine((x as FeatureItem)?.title, 120), text: str((x as FeatureItem)?.text, 400) })) };
      }
      case "divider": return { id, type: "divider" };
      case "form":
      case "booking": {
        const slug = oneLine(b.slug, 80);
        if (slug && !LINKED_SLUG_RE.test(slug)) throw new BlockError(`Block ${n}: pick a ${b.type === "form" ? "form" : "booking page"} from the list.`);
        return { id, type: b.type, slug, title: oneLine(b.title, MAX_TITLE), text: str(b.text, 400) };
      }
      default: throw new BlockError(`Block ${n} is not a block type pages can use.`);
    }
  });
}

export function newBlock(type: BlockType, id: string): Block {
  switch (type) {
    case "hero": return { id, type, title: "A clear title for your page", text: "One or two lines that say what you do and who it is for.", buttonLabel: "Get in touch", buttonUrl: "mailto:hello@example.com" };
    case "heading": return { id, type, text: "Section title", level: 2 };
    case "text": return { id, type, text: "Write here. Use **bold**, *italic* and [links](https://example.com)." };
    case "image": return { id, type, url: "", alt: "", caption: "" };
    case "button": return { id, type, label: "Learn more", url: "https://example.com", style: "primary" };
    case "quote": return { id, type, text: "A short quote from a happy customer.", by: "Customer name" };
    case "features": return { id, type, items: [{ title: "Fast", text: "Say why it matters." }, { title: "Simple", text: "Say why it matters." }, { title: "Local", text: "Say why it matters." }] };
    case "divider": return { id, type };
    case "form": return { id, type, slug: "", title: "Send us a message", text: "" };
    case "booking": return { id, type, slug: "", title: "Book a time", text: "" };
  }
}

// ------------------------------------------------------------------------------------------------ rendering

export const escHtml = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function relOf(url: string, nofollow: boolean) {
  const external = /^https?:/i.test(url);
  return external ? ` rel="noopener noreferrer${nofollow ? " nofollow ugc" : ""}"` : "";
}

/** Escaped text with **bold**, *italic* and [label](url) links (safe targets only), line breaks kept. */
export function inlineHtml(text: string, opts: { nofollow?: boolean } = {}): string {
  const out: string[] = [];
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => escHtml(s).replace(/\*\*([^*\n]{1,500})\*\*/g, "<strong>$1</strong>").replace(/\*([^*\n]{1,500})\*/g, "<em>$1</em>").replace(/\n/g, "<br>");
  while ((m = re.exec(text))) {
    out.push(plain(text.slice(last, m.index)));
    const url = safeUrl(m[2]);
    out.push(url ? `<a href="${escHtml(url)}"${relOf(url, !!opts.nofollow)}>${plain(m[1])}</a>` : plain(m[0]));
    last = m.index + m[0].length;
  }
  out.push(plain(text.slice(last)));
  return out.join("");
}
const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inlineHtml(p)}</p>`).join("");

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** The brand colour when white text on it passes WCAG AA (4.5:1), else a neutral dark. */
export function buttonColour(brand: string | null | undefined): string {
  const l = brand ? luminance(brand) : null;
  if (l === null) return "#18181b";
  return 1.05 / (l + 0.05) >= 4.5 ? `#${/^#?([0-9a-f]{6})$/i.exec(brand!.trim())![1].toLowerCase()}` : "#18181b";
}

export interface RenderSite { name: string; brandColor: string | null; logoUrl: string | null; nav: { title: string; href: string; current?: boolean }[]; homeHref: string }
export interface RenderPage { title: string; blocks: Block[]; seoTitle?: string; description?: string; image?: string | null; canonical?: string | null }
export interface RenderLinks { formHref: (slug: string) => string; bookingHref: (slug: string) => string }
export interface RenderOpts { preview?: boolean; noindex?: boolean; extraHtml?: string; scriptSrc?: string | null; footer?: string }

export function blockHtml(b: Block, links: RenderLinks): string {
  switch (b.type) {
    case "hero": return `<section class="hero">${b.title ? `<h1>${escHtml(b.title)}</h1>` : ""}${b.text ? `<p class="lead">${inlineHtml(b.text)}</p>` : ""}${b.buttonLabel && b.buttonUrl ? `<p><a class="btn" href="${escHtml(b.buttonUrl)}"${relOf(b.buttonUrl, false)}>${escHtml(b.buttonLabel)}</a></p>` : ""}</section>`;
    case "heading": return b.text ? `<h${b.level}>${escHtml(b.text)}</h${b.level}>` : "";
    case "text": return b.text.trim() ? `<div class="text">${paragraphs(b.text)}</div>` : "";
    case "image": return b.url ? `<figure><img src="${escHtml(b.url)}" alt="${escHtml(b.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">${b.caption ? `<figcaption>${escHtml(b.caption)}</figcaption>` : ""}</figure>` : "";
    case "button": return b.label && b.url ? `<p><a class="btn${b.style === "secondary" ? " btn2" : ""}" href="${escHtml(b.url)}"${relOf(b.url, false)}>${escHtml(b.label)}</a></p>` : "";
    case "quote": return b.text.trim() ? `<blockquote><p>${inlineHtml(b.text)}</p>${b.by ? `<cite>${escHtml(b.by)}</cite>` : ""}</blockquote>` : "";
    case "features": { const items = b.items.filter((i) => i.title || i.text); return items.length ? `<ul class="features">${items.map((i) => `<li>${i.title ? `<h3>${escHtml(i.title)}</h3>` : ""}${i.text ? `<p>${inlineHtml(i.text)}</p>` : ""}</li>`).join("")}</ul>` : ""; }
    case "divider": return "<hr>";
    case "form":
    case "booking": {
      if (!b.slug) return "";
      const href = b.type === "form" ? links.formHref(b.slug) : links.bookingHref(b.slug);
      const label = b.type === "form" ? "Open the form" : "Pick a time";
      return `<section class="card">${b.title ? `<h2>${escHtml(b.title)}</h2>` : ""}${b.text ? `<p>${inlineHtml(b.text)}</p>` : ""}<p><a class="btn" href="${escHtml(href)}">${label}</a></p></section>`;
    }
  }
}

const CSS = (btn: string) => `:root{color-scheme:light dark;--bg:#ffffff;--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--card:#f4f4f5;--btn:${btn}}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--fg:#f4f4f5;--muted:#a1a1aa;--line:#2e2e33;--card:#1a1a1e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit;text-underline-offset:3px}a:focus-visible,.btn:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.top{border-bottom:1px solid var(--line)}.top .in{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;text-decoration:none}.brand img{height:28px;width:auto}
nav{margin-left:auto;display:flex;gap:16px;flex-wrap:wrap}nav a{text-decoration:none;color:var(--muted);padding:10px 0;min-height:44px;display:inline-flex;align-items:center}nav a[aria-current=page]{color:var(--fg);font-weight:600}
.in{max-width:760px;margin:0 auto;padding:0 20px}main{padding:32px 0 48px}h1{font-size:2.2rem;line-height:1.2;margin:0 0 12px}h2{font-size:1.5rem;line-height:1.3;margin:32px 0 8px}h3{font-size:1.15rem;margin:24px 0 6px}
.hero{padding:24px 0 8px}.lead{font-size:1.2rem;color:var(--muted)}.text p{margin:0 0 14px}
figure{margin:24px 0}img{max-width:100%;height:auto;border-radius:8px}figcaption{color:var(--muted);font-size:.9rem;margin-top:6px}
blockquote{margin:24px 0;padding:4px 0 4px 16px;border-left:3px solid var(--line)}blockquote p{margin:0 0 6px;font-size:1.1rem}cite{color:var(--muted);font-style:normal}
hr{border:0;border-top:1px solid var(--line);margin:32px 0}.features{list-style:none;padding:0;margin:24px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.features li{background:var(--card);border-radius:8px;padding:16px}.features h3{margin:0 0 4px}.features p{margin:0;color:var(--muted)}
.card{background:var(--card);border-radius:8px;padding:20px;margin:24px 0}.card h2{margin-top:0}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:10px 18px;border-radius:8px;background:var(--btn);color:#fff;text-decoration:none;font-weight:600;border:0;font:inherit;font-weight:600;cursor:pointer}
.btn2{background:transparent;color:var(--fg);border:1px solid var(--line)}
.comments{border-top:1px solid var(--line);margin-top:40px;padding-top:8px}.comment{padding:12px 0;border-bottom:1px solid var(--line)}.comment b{display:block}.comment time{color:var(--muted);font-size:.85rem}
label{display:block;font-weight:600;margin:12px 0 4px}input,textarea{width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.note{color:var(--muted);font-size:.9rem}.msg{background:var(--card);border-radius:8px;padding:12px;margin:12px 0}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:.9rem;padding:20px 0 32px}.empty{color:var(--muted)}
@media (max-width:480px){h1{font-size:1.8rem}main{padding:20px 0 32px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

/** The whole public page (also the editor preview, with preview true: no indexing, links inert in the sandboxed frame). */
export function renderPageHtml(site: RenderSite, page: RenderPage, links: RenderLinks, opts: RenderOpts = {}): string {
  const title = (page.seoTitle || page.title || site.name).trim();
  const fullTitle = title === site.name ? title : `${title} | ${site.name}`;
  const desc = (page.description ?? "").trim();
  const body = page.blocks.map((b) => blockHtml(b, links)).join("\n");
  const head = [
    `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escHtml(fullTitle)}</title>`,
    desc ? `<meta name="description" content="${escHtml(desc)}">` : "",
    `<meta property="og:type" content="website">`, `<meta property="og:title" content="${escHtml(title)}">`, `<meta property="og:site_name" content="${escHtml(site.name)}">`,
    desc ? `<meta property="og:description" content="${escHtml(desc)}">` : "",
    page.image ? `<meta property="og:image" content="${escHtml(page.image)}"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`,
    page.canonical ? `<link rel="canonical" href="${escHtml(page.canonical)}"><meta property="og:url" content="${escHtml(page.canonical)}">` : "",
    opts.preview || opts.noindex ? `<meta name="robots" content="noindex, nofollow">` : "",
    `<style>${CSS(buttonColour(site.brandColor))}</style>`,
  ].filter(Boolean).join("");
  const nav = site.nav.length > 1 ? `<nav aria-label="Pages">${site.nav.map((n) => `<a href="${escHtml(n.href)}"${n.current ? ` aria-current="page"` : ""}>${escHtml(n.title)}</a>`).join("")}</nav>` : "";
  const logo = site.logoUrl ? `<img src="${escHtml(site.logoUrl)}" alt="">` : "";
  return `<!doctype html><html lang="en"><head>${head}</head><body><header class="top"><div class="in"><a class="brand" href="${escHtml(site.homeHref)}">${logo}<span>${escHtml(site.name)}</span></a>${nav}</div></header><main id="main"><div class="in">${body || `<p class="empty">This page has no content yet.</p>`}${opts.extraHtml ?? ""}</div></main><footer><div class="in">${escHtml(opts.footer ?? site.name)}</div></footer>${opts.scriptSrc ? `<script src="${escHtml(opts.scriptSrc)}" defer></script>` : ""}</body></html>`;
}

export function statusOf(p: { status: PageStatus; publishAt: number | null }, now: number): PageStatus {
  if (p.status === "scheduled" && p.publishAt !== null && p.publishAt <= now) return "published";
  return p.status;
}

// ------------------------------------------------------------------------------------------------ API shapes
export interface SiteInfo {
  id: string; slug: string; name: string; description: string; commentsOn: boolean; editors: string[]; homePageId: string | null; url: string; canEdit: boolean;
}
export interface PageSummary {
  id: string; slug: string; title: string; status: PageStatus; publishAt: number | null; publishedAt: number | null; hasUnpublished: boolean; views: number;
  membersCanView: boolean; isHome: boolean; updatedAt: number; url: string | null; waitingComments: number;
}
export interface PageDetail extends PageSummary {
  blocks: Block[]; seoTitle: string; description: string; image: string; commentsOn: boolean;
}
export interface VersionInfo { id: string; kind: "saved" | "published"; title: string; byName: string; createdAt: number; blocks: number }
export interface CommentInfo { id: string; pageId: string; pageTitle: string; name: string; body: string; status: CommentStatus; createdAt: number }
export interface StatsOut { days: { day: string; views: number }[]; total: number; pages: { id: string; title: string; views: number }[]; sources: { source: string; views: number }[]; devices: { device: string; views: number }[] }
