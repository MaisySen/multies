/**
 * Message body for the phone (R56b): plain text with tappable links, and a readable text version of
 * mail that only has an HTML part (newsletters, receipts) instead of "no plain text version".
 */
export type Segment = { kind: "text"; text: string } | { kind: "link"; text: string; url: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
    if (k.startsWith("#")) return ENTITIES[k] ?? String.fromCodePoint(parseInt(k.slice(1), 10) || 32);
    return ENTITIES[k] ?? m;
  });
}

/** A readable text version of an HTML body: blocks become lines, links keep their address as "label <url>". */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = decode(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const url = decode(href).trim();
    if (!/^(https?:|mailto:)/i.test(url)) return label;
    if (!label || label === url || label.replace(/^mailto:/i, "") === url.replace(/^mailto:/i, "")) return ` ${url} `;
    return ` ${label} \u0001${url}\u0002 `;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote|section|article|header|footer)>/gi, "\n").replace(/<li[^>]*>/gi, "\u2022 ");
  s = s.replace(/<img\b[^>]*>/gi, "").replace(/<[^>]+>/g, "");
  s = decode(s).replace(/\u0001/g, "<").replace(/\u0002/g, ">").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const URL_RE = /(<)?((?:https?:\/\/|mailto:)[^\s<>"]+|www\.[^\s<>"]+\.[^\s<>"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)(>)?/gi;

/** Splits text into plain runs and links. "<https://...>" shows as the bare address; "[image: X]" lines go. */
export function linkSegments(text: string): Segment[] {
  const clean = text.replace(/^\[image: [^\]]*\]\s*$/gim, "").replace(/\[image: [^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n");
  const out: Segment[] = [];
  let last = 0;
  for (const m of clean.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let raw = m[2];
    let trail = "";
    while (/[.,;:!?)\]]$/.test(raw) && !(raw.endsWith(")") && raw.includes("("))) { trail = raw.slice(-1) + trail; raw = raw.slice(0, -1); }
    if (start > last) out.push({ kind: "text", text: clean.slice(last, start) });
    const url = /^(https?:|mailto:)/i.test(raw) ? raw : raw.includes("@") && !raw.startsWith("www.") ? `mailto:${raw}` : `https://${raw}`;
    out.push({ kind: "link", text: raw.replace(/^mailto:/i, ""), url });
    if (trail) out.push({ kind: "text", text: trail });
    last = start + m[0].length;
  }
  if (last < clean.length) out.push({ kind: "text", text: clean.slice(last) });
  return out.filter((s) => s.text.length > 0);
}

/** The text to show: the plain part, or a text version of the HTML part when there is no plain part. */
export function bodyText(m: { text: string; html: string | null }): string {
  if (m.text && m.text.trim()) return m.text;
  return m.html ? htmlToText(m.html) : "";
}
