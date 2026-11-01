/**
 * R100b link preview: a page's title, description, picture and site name, read from its HTML head
 * (Open Graph, Twitter cards, then plain title and description). Fetched through the SSRF guard and cached
 * at the edge for 6 hours; the picture is served through our own image proxy so the browser never calls the site.
 */
import { safeFetch, UnsafeUrlError, checkUrlShape } from "../../lib/safe-fetch";

export const PREVIEW_HTML_MAX = 1024 * 1024;
export const PREVIEW_IMAGE_MAX = 5 * 1024 * 1024;
export const PREVIEW_TTL_S = 6 * 3600;

export interface LinkPreview { url: string; finalUrl: string; title: string; description: string; siteName: string; image: string | null; imageUrl: string | null; favicon: string | null }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string | undefined, max: number) => {
  const t = decodeEntities((s ?? "").replace(/<[^>]*>/g, " ")).replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
}

const absolute = (href: string | undefined, base: string): string | null => {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
};

/** Reads the head of an HTML page. Pure, so it is tested without a network. */
export function parsePreview(html: string, pageUrl: string): Omit<LinkPreview, "url" | "finalUrl" | "image"> {
  const head = html.slice(0, 512 * 1024).split(/<body[\s>]/i)[0];
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  let favicon: string | null = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(a.rel ?? "") && a.href) { favicon = absolute(a.href, pageUrl); if (favicon) break; }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const title = clean(meta["og:title"] ?? meta["twitter:title"] ?? titleTag, 200) || host;
  const description = clean(meta["og:description"] ?? meta["twitter:description"] ?? meta.description, 400);
  const siteName = clean(meta["og:site_name"] ?? meta["application-name"], 80) || host;
  const imageUrl = absolute(meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"], pageUrl);
  return { title, description, siteName, imageUrl, favicon: favicon ?? absolute("/favicon.ico", pageUrl) };
}

/** Text from bytes in the page's own charset when it says one we know, else UTF-8. */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const declared = contentType.match(/charset=([\w-]+)/i)?.[1] ?? new TextDecoder("latin1").decode(bytes.subarray(0, 2048)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try { return new TextDecoder(declared?.toLowerCase() || "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

export const previewImagePath = (imageUrl: string) => `/api/tools-c2/link-preview/image?u=${encodeURIComponent(imageUrl)}`;

export async function fetchLinkPreview(fetcher: typeof fetch, raw: string): Promise<LinkPreview> {
  const shaped = checkUrlShape(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw : `https://${raw.trim()}`);
  const r = await safeFetch(fetcher, shaped.toString(), { maxBytes: PREVIEW_HTML_MAX, timeoutMs: 6000, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
  if (r.status === 404 || r.status === 410) throw new UnsafeUrlError("That page was not found.");
  if (r.status >= 400) throw new UnsafeUrlError("That site did not share a preview.");
  if (!/text\/html|application\/xhtml/.test(r.contentType)) {
    const host = new URL(r.url).hostname.replace(/^www\./, "");
    const kind = r.contentType.split(";")[0] || "file";
    return { url: shaped.toString(), finalUrl: r.url, title: host, description: `A ${kind} file, not a web page.`, siteName: host, image: null, imageUrl: null, favicon: null };
  }
  const p = parsePreview(decodeHtml(r.bytes, r.contentType), r.url);
  return { url: shaped.toString(), finalUrl: r.url, ...p, image: p.imageUrl ? previewImagePath(p.imageUrl) : null };
}

/** The first bytes say which picture type it is; anything else (SVG, HTML) is refused. */
export function imageTypeOf(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69) return "image/avif";
  return null;
}

export async function fetchPreviewImage(fetcher: typeof fetch, raw: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const r = await safeFetch(fetcher, raw, { maxBytes: PREVIEW_IMAGE_MAX + 1, timeoutMs: 6000, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8" });
  if (r.status >= 400) throw new UnsafeUrlError("That picture could not be loaded.");
  if (r.truncated) throw new UnsafeUrlError("That picture is over 5 MB.");
  const type = imageTypeOf(r.bytes);
  if (!type) throw new UnsafeUrlError("That is not a picture we can show.");
  return { bytes: r.bytes, contentType: type };
}
