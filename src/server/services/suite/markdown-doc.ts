/**
 * R28 (found by Haajir, tsk_0mvomqyyoe2zq3y7483): markdown to the docs editor's node format.
 *
 * The editor is Tiptap (StarterKit plus task lists), so the output uses its node and mark names:
 * heading (levels 1 to 6), paragraph, bulletList, orderedList, listItem, taskList, taskItem,
 * blockquote, codeBlock, horizontalRule, hardBreak; marks bold, italic, strike, code and link.
 * It covers the markdown agents actually write; anything it does not know stays as plain text,
 * so nothing is lost. Link targets are filtered later by the docs service (http, https, mailto only).
 *
 * QUAL1: any member, key or connected AI app can send up to 200,000 characters here, so no line may make the parser
 * backtrack over itself. Headings and fences are read with plain scans; a run of spaces before the rest of a line is
 * taken whole ("(?=(\s+))\N" never gives part of it back); inline formatting has a work budget per line. Each case
 * that used to take seconds is timed in tests/markdown-redos-qual1.test.ts, which also checks that every rewritten
 * pattern reads lines exactly as the old one did.
 */
export interface MdNode { type: string; text?: string; content?: MdNode[]; attrs?: Record<string, unknown>; marks?: MdMark[] }
export interface MdMark { type: string; attrs?: Record<string, unknown> }

const RULE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/** [1] indent, [2] marker, [4] text. */
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?=(\s+))\3(.*)$/;
/** [1] the box, [3] text. */
const TASK = /^\[([ xX])\](?=(\s+))\2(.*)$/;

const CALLOUT_OPEN = /^\s{0,3}:::\s*([a-z]+)\s*$/i;
const CALLOUT_CLOSE = /^\s{0,3}:::\s*$/;
/** [1] the word, [3] text. */
const QUOTE_ALERT = /^\s{0,3}>\s?\[!([a-z]+)\](?=(\s*))\2(.*)$/i;
const IMAGE_LINE = /^\s{0,3}!\[([^\]]{0,300})\]\((https:\/\/[^\s)]+)\)\s*$/;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;
const TABLE_RULE = /^\s{0,3}\|(\s*:?-{1,}:?\s*\|)+\s*$/;
const VARIANTS: Record<string, string> = { info: "info", note: "info", important: "info", success: "success", tip: "success", check: "success", warning: "warning", warn: "warning", caution: "warning", danger: "danger", error: "danger", alert: "danger" };

const HEADING_OPEN = /^\s{0,3}(#{1,6})\s/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_LANG = /^[\w+#.-]*$/;
const LINE_BREAK = /[\n\r\p{Zl}\p{Zp}]/u;

/**
 * "## Title ##": the level and the text, closing #s and spaces dropped, or null. Reads lines exactly as
 * /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/ did before QUAL1, which took seconds on a heading full of spaces.
 */
export function headingLine(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trimStart().trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  text = text.slice(0, end).trimEnd();
  return LINE_BREAK.test(text) ? null : { level: m[1].length, text };
}

/**
 * "```ts": the fence and its language word, or null. Reads lines exactly as
 * /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/ did before QUAL1, which was quadratic on runs of spaces.
 */
export function fenceLine(line: string): { fence: string; lang: string } | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const lang = line.slice(m[0].length).trim();
  return FENCE_LANG.test(lang) ? { fence: m[1], lang } : null;
}
const isHeading = (line: string) => headingLine(line) !== null;
const isFence = (line: string) => fenceLine(line) !== null;

function callout(word: string, body: string[], depth: number): MdNode {
  const variant = VARIANTS[word.toLowerCase()] ?? "info";
  const content = depth < 16 ? blocks(body, depth + 1) : [paragraph(body.join(" "))];
  return { type: "callout", attrs: { variant }, content: content.length ? content : [{ type: "paragraph" }] };
}

/** The cells of a "| a | b |" row ("\|" stays a literal bar). */
function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function table(rows: string[][]): MdNode {
  let widest = 0;
  for (const r of rows) widest = Math.max(widest, r.length); // QUAL1: a loop, not a spread (thousands of rows overflow the stack)
  const cols = Math.min(widest, 30);
  const cell = (type: string, text: string): MdNode => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [text ? withInline({ type: "paragraph" }, text) : { type: "paragraph" }] });
  return {
    type: "table",
    content: rows.slice(0, 500).map((r, ri) => ({ type: "tableRow", content: Array.from({ length: cols }, (_, ci) => cell(ri === 0 ? "tableHeader" : "tableCell", r[ci] ?? "")) })),
  };
}

const indentOf = (line: string) => (line.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "    ").length;
const blank = (line: string) => !line.trim();

/** A whole markdown text as a Tiptap document. */
export function markdownToDoc(md: string): MdNode {
  return { type: "doc", content: blocks(md.replace(/\r\n?/g, "\n").split("\n"), 0) };
}

function blocks(lines: string[], depth: number): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = fenceLine(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.fence[0] === "`" ? "`" : "~"}{${fence.fence.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      const text = body.join("\n");
      out.push({ type: "codeBlock", attrs: { language: fence.lang || null }, ...(text ? { content: [{ type: "text", text }] } : {}) });
      continue;
    }
    const h = headingLine(line);
    if (h) { out.push(withInline({ type: "heading", attrs: { level: h.level } }, h.text)); i++; continue; }
    if (RULE.test(line)) { out.push({ type: "horizontalRule" }); i++; continue; }
    // R32: callouts (":::info" ... ":::", or a "> [!NOTE]" quote), a line that is only an image, and pipe tables.
    const open = line.match(CALLOUT_OPEN);
    if (open) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !CALLOUT_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(callout(open[1], body, depth));
      continue;
    }
    const alert = line.match(QUOTE_ALERT);
    if (alert) {
      const body: string[] = [alert[3]];
      i++;
      while (i < lines.length && !blank(lines[i]) && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)![1]);
      out.push(callout(alert[1], body, depth));
      continue;
    }
    const img = line.match(IMAGE_LINE);
    if (img) { out.push({ type: "image", attrs: { src: img[2], alt: img[1] || null, title: null, width: null, height: null, size: "fit" } }); i++; continue; }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const rows: string[][] = [cells(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(table(rows));
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || inner.length)) {
        const q = lines[i].match(QUOTE);
        if (!q && (ITEM.test(lines[i]) || isHeading(lines[i]) || isFence(lines[i]))) break;
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ type: "blockquote", content: depth < 16 ? nonEmpty(blocks(inner, depth + 1)) : [paragraph(inner.join(" "))] });
      continue;
    }
    if (ITEM.test(line)) { i = list(lines, i, depth, out); continue; }
    // A paragraph: lines up to a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !(para.length && (isFence(lines[i]) || isHeading(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || RULE.test(lines[i]) || CALLOUT_OPEN.test(lines[i]) || IMAGE_LINE.test(lines[i])))) {
      para.push(lines[i]);
      i++;
    }
    out.push(paragraphFromLines(para));
  }
  return out;
}

/** One list (bullets, numbers or task boxes) starting at line i; returns the next line index. */
function list(lines: string[], start: number, depth: number, out: MdNode[]): number {
  const first = lines[start].match(ITEM)!;
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const isTask = !ordered && TASK.test(first[4]);
  const items: MdNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || indentOf(lines[i]) !== base) break;
    if (/\d/.test(m[2]) !== ordered || (!ordered && TASK.test(m[4]) !== isTask)) break; // another kind of list starts
    // The item's own text, then every following line indented deeper (or a lazy continuation).
    const own: string[] = [m[4]];
    const nested: string[] = [];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        // QUAL1: the blank lines before a deeper line all go with it at once (a slice per blank line was quadratic).
        let next = i + 1;
        while (next < lines.length && blank(lines[next])) next++;
        if (next < lines.length && indentOf(lines[next]) > base) { while (i < next) { nested.push(""); i++; } continue; }
        break;
      }
      if (indentOf(l) > base) { nested.push(l); i++; continue; }
      if (!nested.length && !ITEM.test(l) && !isHeading(l) && !isFence(l) && !QUOTE.test(l) && !RULE.test(l)) { own.push(l); i++; continue; }
      break;
    }
    let text = own.join("\n");
    let checked: boolean | undefined;
    if (isTask) { const t = text.match(TASK); if (t) { checked = t[1].toLowerCase() === "x"; text = t[3]; } }
    const content: MdNode[] = [paragraphFromLines(text.split("\n"))];
    if (nested.length) {
      let cut = Infinity;
      for (const l of nested) if (!blank(l)) cut = Math.min(cut, indentOf(l));
      const inner = nested.map((l) => (blank(l) ? "" : l.replace(/\t/g, "    ").slice(cut)));
      pushAll(content, depth < 16 ? blocks(inner, depth + 1) : [paragraph(inner.join(" ").trim())]);
    }
    items.push(isTask ? { type: "taskItem", attrs: { checked: !!checked }, content } : { type: "listItem", content });
  }
  const startAt = ordered ? Number.parseInt(first[2], 10) : 1;
  out.push(isTask ? { type: "taskList", content: items } : ordered ? { type: "orderedList", attrs: { start: startAt }, content: items } : { type: "bulletList", content: items });
  return i;
}

const nonEmpty = (nodes: MdNode[]) => (nodes.length ? nodes : [{ type: "paragraph" }]);
const paragraph = (text: string): MdNode => withInline({ type: "paragraph" }, text);

/** Lines of one paragraph: joined with a space, except a line ending in two spaces or a backslash, which is a line break. */
function paragraphFromLines(lines: string[]): MdNode {
  const content: MdNode[] = [];
  lines.forEach((raw, n) => {
    const keep = n < lines.length - 1 ? breakAt(raw) : -1;
    const line = (keep >= 0 ? raw.slice(0, keep) : raw).trim();
    pushAll(content, inline(line, []));
    if (n < lines.length - 1) content.push(keep >= 0 ? { type: "hardBreak" } : { type: "text", text: " " });
  });
  return { type: "paragraph", ...(content.length ? { content: merge(content) } : {}) };
}

/**
 * Where a line that ends in a break (two or more spaces, or a backslash) ends without it, or -1. Same reading as
 * /( {2,}|\\)$/ before QUAL1, which was quadratic on a long run of spaces inside a line.
 */
function breakAt(raw: string): number {
  let k = raw.length;
  while (k > 0 && raw[k - 1] === " ") k--;
  if (raw.length - k >= 2) return k;
  return raw.endsWith("\\") ? raw.length - 1 : -1;
}

/** QUAL1: push without a spread, which overflows the stack on very long arrays. */
function pushAll(out: MdNode[], nodes: MdNode[]) {
  for (const n of nodes) out.push(n);
}

function withInline(node: MdNode, text: string): MdNode {
  const content = merge(inline(text.trim(), []));
  return content.length ? { ...node, content } : node;
}

/** Joins neighbouring text nodes that carry the same marks. */
function merge(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === "text" && !n.text) continue;
    if (prev && prev.type === "text" && n.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) prev.text += n.text!;
    else out.push({ ...n });
  }
  // Leading or trailing spaces only around breaks are noise.
  return out;
}

const text = (s: string, marks: MdMark[]): MdNode => (marks.length ? { type: "text", text: s, marks: [...marks] } : { type: "text", text: s });
const BARE_URL = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

function plainWithLinks(s: string, marks: MdMark[]): MdNode[] {
  if (marks.some((m) => m.type === "link" || m.type === "code")) return [text(s, marks)];
  const out: MdNode[] = [];
  let at = 0;
  for (const m of s.matchAll(BARE_URL)) {
    if (m.index! > at) out.push(text(s.slice(at, m.index), marks));
    out.push(text(m[0], [...marks, { type: "link", attrs: { href: m[0] } }]));
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push(text(s.slice(at), marks));
  return out;
}

/**
 * QUAL1: the work inline formatting may do on one line, in characters scanned: about INLINE_SCANS passes over it.
 * Ordinary text needs a few. A line built to make the scans quadratic (thousands of unclosed *, _, ~~, [ or `) runs
 * out and is kept as plain text with its web links, instead of holding the server for seconds.
 */
const INLINE_SCANS = 16;
const INLINE_SLACK = 1024;
interface Work { left: number }
class OutOfWork extends Error {}
const OUT_OF_WORK = new OutOfWork("inline formatting work budget");
function spend(work: Work, chars: number) {
  work.left -= chars;
  if (work.left < 0) throw OUT_OF_WORK;
}

/** Inline markdown: code spans, links, bold, italic and strike, with backslash escapes. */
export function inline(s: string, marks: MdMark[], depth = 0): MdNode[] {
  const work: Work = { left: INLINE_SCANS * s.length + INLINE_SLACK };
  try {
    return spans(s, marks, depth, work);
  } catch (e) {
    if (e === OUT_OF_WORK) return plainWithLinks(s, marks);
    throw e;
  }
}

function spans(s: string, marks: MdMark[], depth: number, work: Work): MdNode[] {
  const out: MdNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { pushAll(out, plainWithLinks(buf, marks)); buf = ""; } };
  const has = (t: string) => marks.some((m) => m.type === t);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!~<>|]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const run = s.slice(i, j);
      const end = s.indexOf(run, j);
      spend(work, (end > i ? end : s.length) - i);
      if (end > i) {
        flush();
        let code = s.slice(j, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(text(code, [...marks.filter((m) => m.type === "link"), { type: "code" }]));
        i = end + run.length;
        continue;
      }
    }
    if (depth < 8) {
      if (ch === "[" && !has("link")) {
        const close = matchBracket(s, i, work);
        const url = close > 0 && s[close + 1] === "(" ? s.slice(close + 2).match(/^\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)/) : null;
        if (url) {
          flush();
          pushAll(out, spans(s.slice(i + 1, close), [...marks, { type: "link", attrs: { href: url[1] } }], depth + 1, work));
          i = close + 2 + url[0].length;
          continue;
        }
      }
      if (ch === "<") {
        const auto = s.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/);
        if (auto && !has("link")) { flush(); out.push(text(auto[1], [...marks, { type: "link", attrs: { href: auto[1] } }])); i += auto[0].length; continue; }
      }
      const delim = s.startsWith("**", i) ? "**" : s.startsWith("__", i) ? "__" : s.startsWith("~~", i) ? "~~" : ch === "*" || ch === "_" ? ch : "";
      if (delim) {
        const mark = delim === "~~" ? "strike" : delim.length === 2 ? "bold" : "italic";
        const leftOk = delim[0] !== "_" || i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]);
        const end = leftOk && !/\s/.test(s[i + delim.length] ?? " ") ? closing(s, i + delim.length, delim, work) : -1;
        if (end > 0 && !has(mark)) {
          flush();
          pushAll(out, spans(s.slice(i + delim.length, end), [...marks, { type: mark }], depth + 1, work));
          i = end + delim.length;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function matchBracket(s: string, open: number, work: Work): number {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "[") level++;
    else if (s[i] === "]" && --level === 0) { spend(work, i - open); return i; }
  }
  spend(work, s.length - open);
  return -1;
}

/** The index of the delimiter that closes a span opened just before `from`, or -1. */
function closing(s: string, from: number, delim: string, work: Work): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const e = s.indexOf(s.slice(i, j), j);
      spend(work, (e > 0 ? e : s.length) - i);
      if (e > 0) { i = e + (j - i) - 1; continue; }
    }
    if (!s.startsWith(delim, i) || /\s/.test(s[i - 1])) continue;
    if (delim.length === 1 && s[i + 1] === delim) { i++; continue; } // a double delimiter inside a single span
    if (delim[0] === "_" && i + delim.length < s.length && /[\p{L}\p{N}]/u.test(s[i + delim.length])) continue;
    if (i === from) continue;
    spend(work, i - from);
    return i;
  }
  spend(work, s.length - from);
  return -1;
}
