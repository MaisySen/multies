/**
 * Message body for the phone (R56b): plain text with tappable links, and a readable text version of
 * mail that only has an HTML part (newsletters, receipts) instead of "no plain text version".
 */
export type Segment = { kind: "text"; text: string } | { kind: "link"; text: string; url: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML numeric references outside the Unicode scalar range render as a replacement character. */
export function mailCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(value);
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return mailCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return mailCodePoint(parseInt(k.slice(1), 10));
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

const ZWSP = "\u200b";

/**
 * 1.9.11: what a link shows. Mail notifications carry long addresses that wrapped mid word on a phone
 * (".../actions/runs/40926009018" split anywhere). A web address shows without "https://" and "www.",
 * a very long one shortened to its site and last path parts ("github.com/…/actions/runs/40926009018"),
 * and a zero width space after each "/", "?", "&" and "=" so a line breaks between parts, never inside
 * a word. The tap always opens the full address (Segment.url).
 */
export function linkLabel(seg: { text: string; url: string }, max = 40): string {
  if (/^mailto:/i.test(seg.url)) return seg.text;
  let s = seg.text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const q = s.search(/[?#]/);
  if (s.length > max && q > 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  if (s.length > max) {
    const parts = s.split("/");
    const host = parts.shift() ?? "";
    const named = parts.filter(Boolean);
    const tail: string[] = [];
    let len = host.length + 2;
    for (let i = named.length - 1; i >= 0; i--) {
      let part = named[i];
      if (!tail.length) {
        // The last part (a run id, a file or page name) stays whole unless it is very long; then it is
        // cut after a "-", "_" or "." so the shortened label never ends in the middle of a word.
        if (part.length > 36) {
          const cut = part.slice(0, 32);
          const at = Math.max(cut.lastIndexOf("-"), cut.lastIndexOf("_"), cut.lastIndexOf("."));
          part = `${at > 12 ? cut.slice(0, at) : cut}\u2026`;
        }
      } else if (len + part.length + 1 > max) break;
      tail.unshift(part);
      len += part.length + 1;
    }
    s = `${host}/${tail.length < named.length ? "\u2026/" : ""}${tail.join("/")}`;
  }
  return breakable(s);
}

/** Lets a long address break after "/", "?", "&" and "=", never inside a word. */
export function breakable(s: string): string {
  return s.replace(/([/?&=])(?=.)/g, `$1${ZWSP}`);
}

/** The text to show: the plain part, or a text version of the HTML part when there is no plain part. */
export function bodyText(m: { text: string; html: string | null }): string {
  if (m.text && m.text.trim()) return m.text;
  return m.html ? htmlToText(m.html) : "";
}
