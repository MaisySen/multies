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
 * backtrack over itself. Headings, fences and link targets are read with plain scans; a run of spaces before the rest
 * of a line is taken whole ("(?=(\s+))\N" never gives part of it back); inline scans are remembered per line and have
 * a work budget per line as a backstop. Each case
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
 * Each scan is done once per line and remembered (where each [ closes, where a span of each kind can close), so a line
 * needs a few passes however many unclosed *, _, ~~ or [ it has: the heaviest of 200,000 random lines packed with
 * marks took under 8. A line built to make the scans quadratic, such as thousands of unmatched runs of backticks, runs
 * out; it is kept as plain text with its web links, instead of holding the server for seconds.
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

/**
 * What the scans of one string have found, so no scan runs twice: where each [ closes, and per delimiter where the scan
 * for a closer that passes each position ends (stored plus 2, so 0 means not scanned yet).
 */
interface Seen { brackets?: Int32Array; closers: Map<string, Int32Array> }

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
  const seen: Seen = { closers: new Map() };
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
        const close = matchBracket(s, i, work, seen);
        const url = close > 0 && s[close + 1] === "(" ? linkTarget(s, close + 2, work) : null;
        if (url) {
          flush();
          pushAll(out, spans(s.slice(i + 1, close), [...marks, { type: "link", attrs: { href: url.href } }], depth + 1, work));
          i = url.end;
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
        // A mark already open here is not opened again, so its closer is not looked for.
        const end = leftOk && !has(mark) && !/\s/.test(s[i + delim.length] ?? " ") ? closing(s, i + delim.length, delim, work, seen) : -1;
        if (end > 0) {
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

/**
 * The index of the ] that closes the [ at `open`, or -1. A backslash takes the next character with it. QUAL1: every [
 * the inline scan stops at lies on the one chain of positions this walk takes from the start of the string (the scan
 * passes over a backslash pair, a code span, a link or a span, and none of those ends in a backslash), so one pass with
 * a stack finds every pair, the same ones a walk from each [ found before.
 */
function matchBracket(s: string, open: number, work: Work, seen: Seen): number {
  if (!seen.brackets) {
    spend(work, s.length);
    const pairs = new Int32Array(s.length).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === "[") stack.push(i);
      else if (s[i] === "]" && stack.length) pairs[stack.pop()!] = i;
    }
    seen.brackets = pairs;
  }
  return seen.brackets[open];
}

const SPACE = /\s/;
const isQuoteMark = (c: string | undefined) => c === '"' || c === "'";

/**
 * The target of a link whose "](" ends just before `at`: the address and the index after its ")", or null. A title in
 * quotes may follow the address; < and > around it are dropped. Reads text exactly as
 * /^\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)/ did before QUAL1, which backtracked
 * quadratically on a long run of spaces with no ")" after it. tests/markdown-redos-qual1.test.ts compares the two.
 */
export function linkTarget(s: string, at: number, work?: { left: number }): { href: string; end: number } | null {
  const n = s.length;
  const space = (k: number) => k < n && SPACE.test(s[k]);
  const plain = (k: number) => k < n && !SPACE.test(s[k]) && s[k] !== "(" && s[k] !== ")" && s[k] !== "<" && s[k] !== ">";
  let far = at;
  // Spaces, an optional "title" after them, spaces, then ")": the index after the ")", or -1.
  const close = (u: number): number => {
    let v = u;
    while (space(v)) v++;
    if (v > u && isQuoteMark(s[v])) {
      let x = v + 1;
      while (x < n && !isQuoteMark(s[x])) x++;
      far = Math.max(far, x);
      if (x >= n) return -1;
      let z = x + 1;
      while (space(z)) z++;
      far = Math.max(far, z);
      return s[z] === ")" ? z + 1 : -1;
    }
    far = Math.max(far, v);
    return s[v] === ")" ? v + 1 : -1;
  };
  let w = at;
  while (space(w)) w++;
  let q = w;
  if (s[q] === "<") q++;
  const start = q;
  while (plain(q)) q++;
  // (parts) in brackets, with no spaces or brackets inside, then more plain characters.
  while (s[q] === "(") {
    let k = q + 1;
    while (k < n && !SPACE.test(s[k]) && s[k] !== "(" && s[k] !== ")") k++;
    if (s[k] !== ")") { far = Math.max(far, k); break; }
    k++;
    while (plain(k)) k++;
    q = k;
  }
  const href = s.slice(start, q);
  if (s[q] === ">") q++;
  let end = close(q);
  let found: { href: string; end: number } | null = end >= 0 ? { href, end } : null;
  // As the pattern did when that fails: no address, and the leading spaces start a title.
  if (!found && w > at) {
    end = close(at);
    if (end >= 0) found = { href: "", end };
  }
  if (work) spend(work, far - at + 1);
  return found;
}

/**
 * Where a scan for a closing `delim` goes from position i: i itself when a closer stands there, or the next position
 * to look at (a backslash takes the next character with it, a closed code span is passed over whole).
 */
function closeStep(s: string, i: number, delim: string, work: Work): number {
  if (s[i] === "\\") return i + 2;
  if (s[i] === "`") {
    let j = i;
    while (s[j] === "`") j++;
    const e = s.indexOf(s.slice(i, j), j);
    spend(work, (e > 0 ? e : s.length) - i);
    if (e > 0) return e + (j - i);
  }
  if (!s.startsWith(delim, i) || SPACE.test(s[i - 1])) return i + 1;
  if (delim.length === 1 && s[i + 1] === delim) return i + 2; // a double delimiter inside a single span
  if (delim[0] === "_" && i + delim.length < s.length && /[\p{L}\p{N}]/u.test(s[i + delim.length])) return i + 1;
  return i;
}

/**
 * The first closer the scan meets from `start` on, or -1. Where the scan goes from a position depends on that position
 * alone, so every position it passes is remembered with the answer, and a later scan that reaches one stops there.
 */
function scanFrom(s: string, start: number, delim: string, work: Work, memo: Int32Array): number {
  const path: number[] = [];
  let found = -1;
  for (let i = start; i < s.length;) {
    if (memo[i]) { found = memo[i] - 2; break; }
    path.push(i);
    const next = closeStep(s, i, delim, work);
    if (next === i) { found = i; break; }
    i = next;
  }
  spend(work, path.length);
  for (const p of path) memo[p] = found + 2;
  return found;
}

/** The index of the delimiter that closes a span opened just before `from`, or -1. */
function closing(s: string, from: number, delim: string, work: Work, seen: Seen): number {
  let memo = seen.closers.get(delim);
  if (!memo) { memo = new Int32Array(s.length + 1); seen.closers.set(delim, memo); }
  const first = scanFrom(s, from, delim, work, memo);
  // A closer right at `from` would make an empty span; the scan goes on past it.
  return first === from ? scanFrom(s, from + 1, delim, work, memo) : first;
}
