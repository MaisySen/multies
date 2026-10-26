/**
 * R28 (found by Haajir, tsk_0mvomqyyoe2zq3y7483): markdown to the docs editor's node format.
 *
 * The editor is Tiptap (StarterKit plus task lists), so the output uses its node and mark names:
 * heading (levels 1 to 6), paragraph, bulletList, orderedList, listItem, taskList, taskItem,
 * blockquote, codeBlock, horizontalRule, hardBreak; marks bold, italic, strike, code and link.
 * It covers the markdown agents actually write; anything it does not know stays as plain text,
 * so nothing is lost. Link targets are filtered later by the docs service (http, https, mailto only).
 */
export interface MdNode { type: string; text?: string; content?: MdNode[]; attrs?: Record<string, unknown>; marks?: MdMark[] }
export interface MdMark { type: string; attrs?: Record<string, unknown> }

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

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
    const fence = line.match(FENCE);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[2][0] === "`" ? "`" : "~"}{${fence[2].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      const text = body.join("\n");
      out.push({ type: "codeBlock", attrs: { language: fence[3] || null }, ...(text ? { content: [{ type: "text", text }] } : {}) });
      continue;
    }
    const h = line.match(HEADING);
    if (h) { out.push(withInline({ type: "heading", attrs: { level: h[1].length } }, h[2])); i++; continue; }
    if (RULE.test(line)) { out.push({ type: "horizontalRule" }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || inner.length)) {
        const q = lines[i].match(QUOTE);
        if (!q && (ITEM.test(lines[i]) || HEADING.test(lines[i]) || FENCE.test(lines[i]))) break;
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ type: "blockquote", content: depth < 16 ? nonEmpty(blocks(inner, depth + 1)) : [paragraph(inner.join(" "))] });
      continue;
    }
    if (ITEM.test(line)) { i = list(lines, i, depth, out); continue; }
    // A paragraph: lines up to a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !(para.length && (FENCE.test(lines[i]) || HEADING.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || RULE.test(lines[i])))) {
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
  const isTask = !ordered && TASK.test(first[3]);
  const items: MdNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || indentOf(lines[i]) !== base) break;
    if (/\d/.test(m[2]) !== ordered || (!ordered && TASK.test(m[3]) !== isTask)) break; // another kind of list starts
    // The item's own text, then every following line indented deeper (or a lazy continuation).
    const own: string[] = [m[3]];
    const nested: string[] = [];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        const next = lines.slice(i + 1).find((x) => !blank(x));
        if (next !== undefined && indentOf(next) > base) { nested.push(""); i++; continue; }
        break;
      }
      if (indentOf(l) > base) { nested.push(l); i++; continue; }
      if (!nested.length && !ITEM.test(l) && !HEADING.test(l) && !FENCE.test(l) && !QUOTE.test(l) && !RULE.test(l)) { own.push(l); i++; continue; }
      break;
    }
    let text = own.join("\n");
    let checked: boolean | undefined;
    if (isTask) { const t = text.match(TASK); if (t) { checked = t[1].toLowerCase() === "x"; text = t[2]; } }
    const content: MdNode[] = [paragraphFromLines(text.split("\n"))];
    if (nested.length) {
      const cut = Math.min(...nested.filter((l) => !blank(l)).map(indentOf));
      const inner = nested.map((l) => (blank(l) ? "" : l.replace(/\t/g, "    ").slice(cut)));
      content.push(...(depth < 16 ? blocks(inner, depth + 1) : [paragraph(inner.join(" ").trim())]));
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
    const hard = /( {2,}|\\)$/.test(raw) && n < lines.length - 1;
    const line = (hard ? raw.replace(/( {2,}|\\)$/, "") : raw).trim();
    content.push(...inline(line, []));
    if (n < lines.length - 1) content.push(hard ? { type: "hardBreak" } : { type: "text", text: " " });
  });
  return { type: "paragraph", ...(content.length ? { content: merge(content) } : {}) };
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

/** Inline markdown: code spans, links, bold, italic and strike, with backslash escapes. */
export function inline(s: string, marks: MdMark[], depth = 0): MdNode[] {
  const out: MdNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(...plainWithLinks(buf, marks)); buf = ""; } };
  const has = (t: string) => marks.some((m) => m.type === t);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!~<>|]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const run = s.slice(i).match(/^`+/)![0];
      const end = s.indexOf(run, i + run.length);
      if (end > i) {
        flush();
        let code = s.slice(i + run.length, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(text(code, [...marks.filter((m) => m.type === "link"), { type: "code" }]));
        i = end + run.length;
        continue;
      }
    }
    if (depth < 8) {
      if (ch === "[" && !has("link")) {
        const close = matchBracket(s, i);
        const url = close > 0 && s[close + 1] === "(" ? s.slice(close + 2).match(/^\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)/) : null;
        if (url) {
          flush();
          out.push(...inline(s.slice(i + 1, close), [...marks, { type: "link", attrs: { href: url[1] } }], depth + 1));
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
        const end = leftOk && !/\s/.test(s[i + delim.length] ?? " ") ? closing(s, i + delim.length, delim) : -1;
        if (end > 0 && !has(mark)) {
          flush();
          out.push(...inline(s.slice(i + delim.length, end), [...marks, { type: mark }], depth + 1));
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

function matchBracket(s: string, open: number): number {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "[") level++;
    else if (s[i] === "]" && --level === 0) return i;
  }
  return -1;
}

/** The index of the delimiter that closes a span opened just before `from`, or -1. */
function closing(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") { const run = s.slice(i).match(/^`+/)![0]; const e = s.indexOf(run, i + run.length); if (e > 0) { i = e + run.length - 1; continue; } }
    if (!s.startsWith(delim, i) || /\s/.test(s[i - 1])) continue;
    if (delim.length === 1 && s[i + 1] === delim) { i++; continue; } // a double delimiter inside a single span
    if (delim[0] === "_" && i + delim.length < s.length && /[\p{L}\p{N}]/u.test(s[i + delim.length])) continue;
    if (i === from) continue;
    return i;
  }
  return -1;
}
