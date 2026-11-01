/**
 * R103: readability style extraction for the web clipper, on the Worker (no engine call, no third party code).
 * A small tolerant HTML tokenizer builds a tree; scripts, styles, forms, frames and page chrome (nav, header,
 * footer, asides, cookie and share bars) are dropped; the block with the most readable text (paragraph text weighted
 * down by link density, article and main preferred) becomes the doc. Output is our own Tiptap JSON: headings,
 * paragraphs, lists, quotes, code, rules, bold, italic, code and http(s) links. No HTML from the page is kept.
 * Patterns learned from the readability family of tools; no code copied.
 */

export interface HNode { tag: string; attrs: Record<string, string>; children: (HNode | string)[]; parent: HNode | null }
type Mark = { type: string; attrs?: Record<string, unknown> };
export interface DocNode { type: string; text?: string; attrs?: Record<string, unknown>; content?: DocNode[]; marks?: Mark[] }

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
const RAW = new Set(["script", "style", "noscript", "template", "textarea", "title", "svg", "math", "iframe", "object", "xmp"]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "figure", "hr", "header", "footer", "nav", "aside", "form", "dl", "dt", "dd"]);
const DROP = new Set(["nav", "header", "footer", "aside", "form", "button", "select", "input", "label", "fieldset", "iframe", "object", "embed", "svg", "canvas", "video", "audio", "picture", "img", "dialog", "menu", "noscript", "figcaption", "style", "script", "template", "link", "meta"]);
const JUNK = /(^|[\s_-])(nav|navbar|menu|footer|header|masthead|sidebar|side-bar|breadcrumbs?|comments?|share|sharing|social|cookie|consent|banner|advert|ads?|promo|related|recommended|subscribe|newsletter|popup|modal|signup|login|toolbar|skip|pagination|tags?|author-bio|byline-share)([\s_-]|$)/i;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "...", mdash: ", ", ndash: ", ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", reg: "(r)", trade: "(tm)", bull: "*", middot: " ", laquo: '"', raquo: '"', shy: "", zwj: "", zwnj: "", euro: "EUR", pound: "GBP", deg: " degrees" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** A forgiving parse: unknown or stray closing tags are ignored, a new block closes an open paragraph. */
export function parseHtml(html: string): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  const text = (t: string) => { if (t) cur.children.push(decodeEntities(t)); };
  const close = (tag: string) => {
    for (let n: HNode | null = cur; n && n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent ?? root; return; }
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { close(tag); continue; }
    if (BLOCKS.has(tag) && cur.tag === "p") cur = cur.parent ?? root;
    if (tag === "li") close("li");
    if (tag === "p") close("p");
    const node: HNode = { tag, attrs: parseAttrs(m[3] ?? ""), children: [], parent: cur };
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      const inner = end < 0 ? html.slice(last) : html.slice(last, end);
      if (tag === "title") node.children.push(decodeEntities(inner));
      cur.children.push(node);
      last = end < 0 ? html.length : (html.indexOf(">", end) + 1 || html.length);
      re.lastIndex = last;
      continue;
    }
    cur.children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3] ?? "")) cur = node;
  }
  text(html.slice(last));
  return root;
}

function* walk(n: HNode): Generator<HNode> {
  yield n;
  for (const c of n.children) if (typeof c !== "string") yield* walk(c);
}

export function textOf(n: HNode | string): string {
  if (typeof n === "string") return n;
  if (RAW.has(n.tag)) return "";
  return n.children.map(textOf).join("");
}

function isJunk(n: HNode): boolean {
  if (DROP.has(n.tag)) return true;
  const a = n.attrs;
  if ("hidden" in a || a["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? "")) return true;
  if (/^(navigation|banner|contentinfo|complementary|dialog|alertdialog|search|menu|menubar)$/i.test(a.role ?? "")) return true;
  const cls = `${a.class ?? ""} ${a.id ?? ""}`;
  return n.tag !== "article" && n.tag !== "main" && n.tag !== "body" && JUNK.test(cls) && !/(^|\s)(article|content|post|entry|story)(\s|$)/i.test(cls);
}

function prune(n: HNode) {
  n.children = n.children.filter((c) => typeof c === "string" || !isJunk(c));
  for (const c of n.children) if (typeof c !== "string") prune(c);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function score(n: HNode): number {
  let text = 0, link = 0, paras = 0;
  for (const d of walk(n)) {
    if (d.tag === "p" || d.tag === "pre" || d.tag === "blockquote" || d.tag === "li") {
      const t = norm(textOf(d)).length;
      if (t > 20) { text += t; paras += 1; }
    }
    if (d.tag === "a") link += norm(textOf(d)).length;
  }
  const density = text ? Math.min(1, link / Math.max(text, 1)) : 1;
  const boost = n.tag === "article" ? 1.4 : n.tag === "main" || n.attrs.role === "main" ? 1.2 : 1;
  return (text + paras * 25) * (1 - density * 0.9) * boost;
}

function pickRoot(body: HNode): HNode {
  let best = body, bestScore = score(body) * 0.6;
  for (const n of walk(body)) {
    if (n === body || !/^(article|main|section|div|td)$/.test(n.tag)) continue;
    const s = score(n);
    if (s > bestScore) { best = n; bestScore = s; }
  }
  return best;
}

export function safeHref(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

function inlineNodes(n: HNode | string, base: string, marks: Mark[], out: DocNode[]) {
  if (typeof n === "string") {
    const t = n.replace(/\s+/g, " ");
    if (t) out.push(marks.length ? { type: "text", text: t, marks } : { type: "text", text: t });
    return;
  }
  if (n.tag === "br") { out.push({ type: "hardBreak" }); return; }
  let m = marks;
  if (n.tag === "b" || n.tag === "strong") m = [...m.filter((x) => x.type !== "bold"), { type: "bold" }];
  else if (n.tag === "i" || n.tag === "em") m = [...m.filter((x) => x.type !== "italic"), { type: "italic" }];
  else if (n.tag === "code" || n.tag === "kbd" || n.tag === "samp") m = [{ type: "code" }];
  else if (n.tag === "a") {
    const href = safeHref(n.attrs.href, base);
    m = href ? [...m.filter((x) => x.type !== "link"), { type: "link", attrs: { href } }] : m;
  }
  for (const c of n.children) inlineNodes(c, base, m, out);
}

/** Tidies inline runs: trims the edges, merges spaces, drops empties. */
function tidy(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      const prev = out[out.length - 1];
      let t = n.text ?? "";
      if (prev?.type === "text" && /\s$/.test(prev.text ?? "")) t = t.replace(/^\s+/, "");
      if (!prev || prev.type === "hardBreak") t = t.replace(/^\s+/, "");
      if (!t) continue;
      if (prev?.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) { prev.text += t; continue; }
      out.push({ ...n, text: t });
    } else if (n.type === "hardBreak" && out.length && out[out.length - 1].type !== "hardBreak") out.push(n);
  }
  while (out.length && out[out.length - 1].type === "hardBreak") out.pop();
  const lastText = out[out.length - 1];
  if (lastText?.type === "text") { lastText.text = (lastText.text ?? "").replace(/\s+$/, ""); if (!lastText.text) out.pop(); }
  return out.map((n) => (n.type === "text" ? { ...n, text: (n.text ?? "").slice(0, 20_000) } : n));
}

const para = (content: DocNode[]): DocNode | null => (content.length ? { type: "paragraph", content } : null);
const hasBlockChild = (n: HNode) => n.children.some((c) => typeof c !== "string" && BLOCKS.has(c.tag));

/** Converts a subtree to doc blocks. */
function blocks(n: HNode, base: string, out: DocNode[], title: string, depth = 0) {
  if (out.length >= 2000 || depth > 40) return;
  const inline: DocNode[] = [];
  const flush = () => { const p = para(tidy(inline.splice(0))); if (p) out.push(p); };
  for (const c of n.children) {
    if (typeof c === "string" || !BLOCKS.has(c.tag)) { inlineNodes(c, base, [], inline); continue; }
    flush();
    const t = c.tag;
    if (/^h[1-6]$/.test(t)) {
      const txt = norm(textOf(c));
      if (txt && !(t === "h1" && txt.toLowerCase() === title.toLowerCase())) out.push({ type: "heading", attrs: { level: t === "h1" || t === "h2" ? 2 : 3 }, content: [{ type: "text", text: txt.slice(0, 500) }] });
    } else if (t === "p" || t === "dt" || t === "dd") {
      const parts: DocNode[] = [];
      inlineNodes(c, base, [], parts);
      const p = para(tidy(parts));
      if (p) out.push(p);
    } else if (t === "ul" || t === "ol") {
      const items: DocNode[] = [];
      for (const li of c.children) {
        if (typeof li === "string" || li.tag !== "li") continue;
        const inner: DocNode[] = [];
        if (hasBlockChild(li)) blocks(li, base, inner, title, depth + 1);
        else { const parts: DocNode[] = []; inlineNodes(li, base, [], parts); const p = para(tidy(parts)); if (p) inner.push(p); }
        const flat = inner.filter((x) => x.type === "paragraph" || x.type === "bulletList" || x.type === "orderedList");
        if (flat.length && flat[0].type === "paragraph") items.push({ type: "listItem", content: flat });
      }
      if (items.length) out.push({ type: t === "ul" ? "bulletList" : "orderedList", content: items });
    } else if (t === "blockquote") {
      const inner: DocNode[] = [];
      blocks(c, base, inner, title, depth + 1);
      const ps = inner.filter((x) => x.type === "paragraph");
      if (ps.length) out.push({ type: "blockquote", content: ps });
    } else if (t === "pre") {
      const code = textOf(c).replace(/\s+$/, "");
      if (code.trim()) out.push({ type: "codeBlock", content: [{ type: "text", text: code.slice(0, 50_000) }] });
    } else if (t === "hr") {
      if (out.length && out[out.length - 1].type !== "horizontalRule") out.push({ type: "horizontalRule" });
    } else if (t === "table") {
      for (const tr of walk(c)) {
        if (tr.tag !== "tr") continue;
        const cells = tr.children.filter((x): x is HNode => typeof x !== "string" && (x.tag === "td" || x.tag === "th")).map((x) => norm(textOf(x))).filter(Boolean);
        if (cells.length) out.push({ type: "paragraph", content: [{ type: "text", text: cells.join(" | ").slice(0, 2000) }] });
      }
    } else {
      blocks(c, base, out, title, depth + 1);
    }
  }
  flush();
}

export interface Extracted {
  title: string; description: string; siteName: string; byline: string; lang: string; canonical: string | null;
  content: DocNode; text: string; words: number;
}

function meta(root: HNode, keys: string[]): string {
  for (const k of keys) for (const n of walk(root)) {
    if (n.tag !== "meta") continue;
    const name = (n.attrs.property || n.attrs.name || "").toLowerCase();
    if (name === k && n.attrs.content) return norm(n.attrs.content);
  }
  return "";
}

function plain(nodes: DocNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text ?? "" : n.content ? plain(n.content) + (n.type === "paragraph" || n.type === "heading" ? "\n" : "") : "")).join("");
}

/** The readable part of a page, as a doc. `url` is the final address (relative links resolve against it). */
export function extractReadable(html: string, url: string, contentType = "text/html"): Extracted {
  const site = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  if (contentType.includes("text/plain")) {
    const paras = html.split(/\n\s*\n/).map(norm).filter(Boolean).slice(0, 2000);
    const content: DocNode = { type: "doc", content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t.slice(0, 20_000) }] })) };
    const text = paras.join("\n");
    return { title: paras[0]?.slice(0, 200) || site, description: "", siteName: site, byline: "", lang: "", canonical: null, content, text, words: text.split(/\s+/).filter(Boolean).length };
  }
  const root = parseHtml(html);
  let titleTag = "";
  for (const n of walk(root)) if (n.tag === "title") { titleTag = norm(textOf(n.children[0] ?? "")); break; }
  const ogTitle = meta(root, ["og:title", "twitter:title"]);
  const title = (ogTitle || titleTag || site).slice(0, 300);
  const description = meta(root, ["description", "og:description", "twitter:description"]).slice(0, 600);
  const siteName = (meta(root, ["og:site_name", "application-name"]) || site).slice(0, 120);
  const byline = meta(root, ["author", "article:author"]).slice(0, 120);
  let lang = "";
  let canonical: string | null = null;
  for (const n of walk(root)) {
    if (n.tag === "html" && n.attrs.lang) lang = n.attrs.lang.slice(0, 20);
    if (n.tag === "link" && /(^|\s)canonical(\s|$)/i.test(n.attrs.rel ?? "")) canonical = safeHref(n.attrs.href, url);
  }
  const body = [...walk(root)].find((n) => n.tag === "body") ?? root;
  prune(body);
  const pick = pickRoot(body);
  const out: DocNode[] = [];
  blocks(pick, url, out, title);
  const content: DocNode = { type: "doc", content: out };
  const text = plain(out);
  return { title, description, siteName, byline, lang, canonical, content, text, words: text.split(/\s+/).filter(Boolean).length };
}
