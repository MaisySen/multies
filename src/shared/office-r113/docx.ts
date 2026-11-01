/**
 * R113: DOCX to editor blocks and back (our own code over fflate and fast-xml-parser). Basic fidelity: headings,
 * paragraphs, bold, italic, underline, strike, code, links, bullet and numbered lists (nested), quotes, code blocks,
 * tables, images, line breaks and dividers. Everything else is named in `notes` so the editor can say it plainly.
 */
import { OFFICE_CAPS, OfficeError, attr, child, children, esc, find, findAll, isText, isZip, kids, parseXml, readRels, tagOf, text, textOf, unzipParts, zipParts, type XNode } from "./xml";

export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: PMMark[] }
export interface LoadedDoc { doc: PMNode; notes: string[] }

const W = "w:";
const on = (el: XNode | undefined) => !!el && !["0", "false", "off", "none"].includes(String(attr(el, "w:val") ?? "true").toLowerCase());

export function readDocx(bytes: Uint8Array): LoadedDoc {
  if (!isZip(bytes)) throw new OfficeError("not_office", "This is not a Word document (.docx).");
  const parts = unzipParts(bytes, (n) => n.startsWith("word/") || n === "[Content_Types].xml");
  const main = parts["word/document.xml"];
  if (!main) throw new OfficeError("broken", "This document could not be read. It may be damaged.");
  const notes = new Set<string>();
  const names = Object.keys(parts);
  if (names.some((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) notes.add("Headers and footers are not shown.");
  if (parts["word/comments.xml"]) notes.add("Comments are not shown.");
  if (names.some((n) => /^word\/footnotes\.xml$/.test(n)) && /footnoteReference/.test(text(main).slice(0, 2_000_000))) notes.add("Footnotes are not shown.");
  const rels = readRels(text(parts["word/_rels/document.xml.rels"]), "word");
  const styleNames = new Map<string, string>();
  if (parts["word/styles.xml"]) for (const s of findAll(parseXml(text(parts["word/styles.xml"])), "w:style")) {
    const id = attr(s, "w:styleId"); const nm = child(s, "w:name"); if (id && nm) styleNames.set(id, String(attr(nm, "w:val") ?? "").toLowerCase());
  }
  const numFmt = readNumbering(parts["word/numbering.xml"] ? text(parts["word/numbering.xml"]) : "");
  let imageBytes = 0;
  const ctx = {
    image(rid: string, cx?: number, cy?: number): PMNode | null {
      const rel = rels.get(rid); const data = rel && !rel.external ? parts[rel.target] : undefined;
      if (!data) { notes.add("Some pictures could not be read."); return null; }
      if (data.length > OFFICE_CAPS.imageBytes || imageBytes + data.length > OFFICE_CAPS.imagesBytes) { notes.add("Some large pictures were left out to keep the editor fast."); return null; }
      const mime = mimeOf(rel!.target); if (!mime) { notes.add("Some pictures use a format we cannot show."); return null; }
      imageBytes += data.length;
      const attrs: Record<string, unknown> = { src: `data:${mime};base64,${b64(data)}` };
      if (cx && cy) { attrs.width = Math.round(cx / 9525); attrs.height = Math.round(cy / 9525); }
      return { type: "image", attrs };
    },
    link(rid: string): string | null { const r = rels.get(rid); return r?.external && /^(https?:|mailto:)/i.test(r.target) ? r.target : null; },
  };
  const body = find(parseXml(text(main)), "w:body");
  const blocks = body ? readBlocks(kids(body), ctx, styleNames, numFmt, notes) : [];
  return { doc: { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] }, notes: [...notes] };
}

type Ctx = { image(rid: string, cx?: number, cy?: number): PMNode | null; link(rid: string): string | null };
type ListPara = { kind: "bulletList" | "orderedList"; level: number; para: PMNode; key: string };

function readNumbering(src: string): (numId: string, lvl: number) => "bulletList" | "orderedList" {
  if (!src) return () => "bulletList";
  const doc = parseXml(src); const abs = new Map<string, Map<number, string>>(); const nums = new Map<string, string>();
  for (const a of findAll(doc, "w:abstractNum")) {
    const m = new Map<number, string>();
    for (const l of children(a, "w:lvl")) { const f = child(l, "w:numFmt"); m.set(Number(attr(l, "w:ilvl") ?? 0), String(f ? attr(f, "w:val") : "bullet")); }
    abs.set(String(attr(a, "w:abstractNumId")), m);
  }
  for (const n of findAll(doc, "w:num")) { const a = child(n, "w:abstractNumId"); if (a) nums.set(String(attr(n, "w:numId")), String(attr(a, "w:val"))); }
  return (numId, lvl) => { const f = abs.get(nums.get(numId) ?? "")?.get(lvl) ?? "bullet"; return f === "bullet" || f === "none" ? "bulletList" : "orderedList"; };
}

function readBlocks(nodes: XNode[], ctx: Ctx, styles: Map<string, string>, numFmt: (id: string, l: number) => "bulletList" | "orderedList", notes: Set<string>): PMNode[] {
  const out: PMNode[] = []; let pending: ListPara[] = []; let quote: PMNode[] = []; let code: string[] = [];
  const flushList = () => { if (pending.length) { out.push(...buildLists(pending)); pending = []; } };
  const flushQuote = () => { if (quote.length) { out.push({ type: "blockquote", content: quote }); quote = []; } };
  const flushCode = () => { if (code.length) { out.push({ type: "codeBlock", content: code.join("\n") ? [{ type: "text", text: code.join("\n") }] : undefined }); code = []; } };
  const flushAll = () => { flushList(); flushQuote(); flushCode(); };
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "w:sdt") { const c = child(n, "w:sdtContent"); if (c) { flushAll(); out.push(...readBlocks(kids(c), ctx, styles, numFmt, notes)); } continue; }
    if (tag === "w:tbl") { flushAll(); out.push(readTable(n, ctx, styles, numFmt, notes)); continue; }
    if (tag !== "w:p") continue;
    const pPr = child(n, "w:pPr");
    const styleId = pPr ? attr(child(pPr, "w:pStyle") ?? {}, "w:val") : undefined;
    const style = (styleId && styles.get(styleId)) || (styleId ?? "").toLowerCase();
    const numPr = pPr ? child(pPr, "w:numPr") : undefined;
    const outline = pPr ? child(pPr, "w:outlineLvl") : undefined;
    if (pPr && child(pPr, "w:jc") && /center|right|both/.test(String(attr(child(pPr, "w:jc")!, "w:val")))) notes.add("Text alignment is not kept.");
    const { inline, images } = readInline(kids(n), ctx, notes);
    const hr = pPr && child(pPr, "w:pBdr") && !inline.length && !images.length;
    let block: PMNode;
    const hm = /^heading ?([1-6])$/.exec(style) ?? (style === "title" ? [, "1"] : style === "subtitle" ? [, "2"] : null) ?? (outline && Number(attr(outline, "w:val")) < 6 ? [, String(Number(attr(outline, "w:val")) + 1)] : null);
    if (/^(code|html preformatted|plain text|source code)$/.test(style)) { flushList(); flushQuote(); code.push(inline.map((x) => x.text ?? "\n").join("")); continue; }
    flushCode();
    if (hr) { flushAll(); out.push({ type: "horizontalRule" }); continue; }
    if (hm) block = { type: "heading", attrs: { level: Number(hm[1]) }, content: inline.length ? inline : undefined };
    else block = { type: "paragraph", content: inline.length ? inline : undefined };
    if (numPr && !hm) {
      const id = String(attr(child(numPr, "w:numId") ?? {}, "w:val") ?? "0"); const lvl = Math.min(8, Number(attr(child(numPr, "w:ilvl") ?? {}, "w:val") ?? 0));
      if (id !== "0") { flushQuote(); pending.push({ kind: numFmt(id, lvl), level: lvl, para: block, key: id }); for (const im of images) pending.push({ kind: numFmt(id, lvl), level: lvl, para: im, key: id }); continue; }
    }
    flushList();
    if (/quote/.test(style)) { quote.push(block, ...images); continue; }
    flushQuote();
    if (block.content || !images.length) out.push(block);
    out.push(...images);
  }
  flushAll();
  return out;
}

function buildLists(items: ListPara[]): PMNode[] {
  // A stack of open lists; each item becomes a listItem at its level (deeper levels nest in the last item).
  const roots: PMNode[] = [];
  const stack: { list: PMNode; level: number; key: string }[] = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].level > it.level) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.level === it.level && (top.list.type !== it.kind || top.key !== it.key) && it.para.type !== "image") { stack.pop(); top = stack[stack.length - 1]; }
    if (!top || top.level < it.level) {
      const list: PMNode = { type: it.kind, content: [] };
      if (top) { const lastItem = top.list.content![top.list.content!.length - 1]; if (lastItem) lastItem.content!.push(list); else top.list.content!.push({ type: "listItem", content: [{ type: "paragraph" }, list] }); }
      else roots.push(list);
      stack.push({ list, level: it.level, key: it.key }); top = stack[stack.length - 1];
    }
    if (it.para.type === "image" && top.list.content!.length) top.list.content![top.list.content!.length - 1].content!.push(it.para);
    else top.list.content!.push({ type: "listItem", content: [it.para.type === "heading" ? { type: "paragraph", content: it.para.content } : it.para] });
  }
  return roots;
}

function readTable(tbl: XNode, ctx: Ctx, styles: Map<string, string>, numFmt: (id: string, l: number) => "bulletList" | "orderedList", notes: Set<string>): PMNode {
  const rows: PMNode[] = [];
  for (const tr of children(tbl, "w:tr")) {
    const trPr = child(tr, "w:trPr"); const header = !!(trPr && child(trPr, "w:tblHeader"));
    const cells: PMNode[] = [];
    for (const tc of children(tr, "w:tc")) {
      const tcPr = child(tc, "w:tcPr");
      const span = tcPr && child(tcPr, "w:gridSpan") ? Number(attr(child(tcPr, "w:gridSpan")!, "w:val") ?? 1) : 1;
      const vm = tcPr ? child(tcPr, "w:vMerge") : undefined;
      if (vm) notes.add("Merged table cells open as separate cells.");
      if (vm && attr(vm, "w:val") !== "restart") { cells.push({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: span, rowspan: 1 }, content: [{ type: "paragraph" }] }); continue; }
      const content = readBlocks(kids(tc), ctx, styles, numFmt, notes).filter((b) => b.type !== "horizontalRule");
      cells.push({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: Math.max(1, Math.min(span, 50)), rowspan: 1 }, content: content.length ? content : [{ type: "paragraph" }] });
    }
    if (cells.length) rows.push({ type: "tableRow", content: cells });
  }
  return rows.length ? { type: "table", content: rows } : { type: "paragraph" };
}

function readInline(nodes: XNode[], ctx: Ctx, notes: Set<string>, marks: PMMark[] = []): { inline: PMNode[]; images: PMNode[] } {
  const inline: PMNode[] = []; const images: PMNode[] = [];
  const push = (t: string, m: PMMark[]) => {
    if (!t) return;
    const last = inline[inline.length - 1];
    if (last && last.type === "text" && sameMarks(last.marks, m)) last.text += t;
    else inline.push(m.length ? { type: "text", text: t, marks: m } : { type: "text", text: t });
  };
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "w:r") {
      const rPr = child(n, "w:rPr"); const m = [...marks];
      if (rPr) {
        if (on(child(rPr, "w:b"))) m.push({ type: "bold" });
        if (on(child(rPr, "w:i"))) m.push({ type: "italic" });
        if (on(child(rPr, "w:u"))) m.push({ type: "underline" });
        if (on(child(rPr, "w:strike")) || on(child(rPr, "w:dstrike"))) m.push({ type: "strike" });
        const fonts = child(rPr, "w:rFonts"); if (fonts && /consolas|courier|mono/i.test(String(attr(fonts, "w:ascii") ?? ""))) m.push({ type: "code" });
        if (child(rPr, "w:color") || child(rPr, "w:sz") || child(rPr, "w:highlight") || child(rPr, "w:shd")) notes.add("Text colours, highlights and font sizes are not kept.");
      }
      for (const k of kids(n)) {
        const t = tagOf(k);
        if (t === "w:t") push(textOf(k), m);
        else if (t === "w:tab") push("\t", m);
        else if (t === "w:br" || t === "w:cr") { if (attr(k, "w:type") === "page") notes.add("Page breaks are not kept."); else inline.push({ type: "hardBreak" }); }
        else if (t === "w:noBreakHyphen") push("-", m);
        else if (t === "w:drawing") {
          const blip = find(kids(k), "a:blip"); const ext = find(kids(k), "wp:extent");
          if (find(kids(k), "wps:txbx") || find(kids(k), "w:txbxContent")) notes.add("Text boxes and shapes are not kept.");
          const rid = blip ? attr(blip, "r:embed") : undefined;
          if (rid) { const im = ctx.image(rid, Number(ext ? attr(ext, "cx") : 0), Number(ext ? attr(ext, "cy") : 0)); if (im) images.push(im); }
          else notes.add("Text boxes and shapes are not kept.");
        } else if (t === "w:pict" || t === "mc:AlternateContent" || t === "w:object") notes.add("Text boxes and shapes are not kept.");
        else if (t === "w:footnoteReference" || t === "w:endnoteReference") notes.add("Footnotes are not shown.");
      }
    } else if (tag === "w:hyperlink") {
      const rid = attr(n, "r:id"); const href = rid ? ctx.link(rid) : null;
      const r = readInline(kids(n), ctx, notes, href ? [...marks, { type: "link", attrs: { href } }] : marks);
      for (const x of r.inline) inline.push(x); images.push(...r.images);
    } else if (tag === "w:ins" || tag === "w:smartTag" || tag === "w:fldSimple" || tag === "w:customXml" || tag === "w:sdt" || tag === "w:sdtContent") {
      if (tag === "w:ins") notes.add("Tracked changes are accepted when you save.");
      const r = readInline(kids(n), ctx, notes, marks); for (const x of r.inline) inline.push(x); images.push(...r.images);
    } else if (tag === "w:del") notes.add("Tracked changes are accepted when you save.");
  }
  // Merge text runs with equal marks split by nested readers.
  const merged: PMNode[] = [];
  for (const x of inline) { const last = merged[merged.length - 1]; if (last && x.type === "text" && last.type === "text" && sameMarks(last.marks, x.marks)) last.text += x.text ?? ""; else merged.push(x); }
  return { inline: merged, images };
}
const sameMarks = (a?: PMMark[], b?: PMMark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
function mimeOf(name: string): string | null {
  const e = name.toLowerCase().split(".").pop();
  return e === "png" ? "image/png" : e === "jpg" || e === "jpeg" ? "image/jpeg" : e === "gif" ? "image/gif" : e === "webp" ? "image/webp" : e === "bmp" ? "image/bmp" : null;
}
function b64(u: Uint8Array): string { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s: string): Uint8Array { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
void isText;

// ---------- writing ----------
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

export function writeDocx(doc: PMNode): Uint8Array {
  const rels: string[] = []; const media: Record<string, Uint8Array> = {}; const nums: string[] = [];
  let rid = 3; let img = 0; let listCount = 0;
  const relId = (type: string, target: string, external = false) => { const id = `rId${rid++}`; rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`); return id; };
  const runs = (content: PMNode[] | undefined): string => (content ?? []).map((n) => {
    if (n.type === "hardBreak") return "<w:r><w:br/></w:r>";
    if (n.type === "image") return imageRun(n);
    if (n.type !== "text" || !n.text) return "";
    const marks = n.marks ?? [];
    const pr = [marks.some((m) => m.type === "bold") && "<w:b/>", marks.some((m) => m.type === "italic") && "<w:i/>", marks.some((m) => m.type === "underline") && '<w:u w:val="single"/>', marks.some((m) => m.type === "strike") && "<w:strike/>", marks.some((m) => m.type === "code") && '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'].filter(Boolean).join("");
    const link = marks.find((m) => m.type === "link");
    const parts = n.text.split(/(\t|\n)/).map((s) => (s === "\t" ? "<w:tab/>" : s === "\n" ? "<w:br/>" : s ? `<w:t xml:space="preserve">${esc(s)}</w:t>` : "")).join("");
    const run = `<w:r>${pr || link ? `<w:rPr>${link ? '<w:rStyle w:val="Hyperlink"/>' : ""}${pr}</w:rPr>` : ""}${parts}</w:r>`;
    const href = link ? String(link.attrs?.href ?? "") : "";
    return href && /^(https?:|mailto:)/i.test(href) ? `<w:hyperlink r:id="${relId("hyperlink", href, true)}">${run}</w:hyperlink>` : run;
  }).join("");
  const imageRun = (n: PMNode): string => {
    const src = String(n.attrs?.src ?? ""); const m = /^data:(image\/(png|jpeg|gif|webp|bmp));base64,(.+)$/.exec(src);
    if (!m) return "";
    const bytes = unb64(m[3]); const ext = m[2] === "jpeg" ? "jpg" : m[2];
    img++; const name = `image${img}.${ext}`; media[`word/media/${name}`] = bytes;
    const id = relId("image", `media/${name}`);
    let w = Number(n.attrs?.width) || 0, h = Number(n.attrs?.height) || 0;
    if (!w || !h) { const d = imageSize(bytes); w = d?.w ?? 400; h = d?.h ?? 300; }
    if (w > 600) { h = Math.round((h * 600) / w); w = 600; }
    const cx = w * 9525, cy = h * 9525;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${img}" name="Picture ${img}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${img}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const para = (pPr: string, content?: PMNode[]) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs(content)}</w:p>`;
  const blocks = (nodes: PMNode[] | undefined, ctx: { style?: string; list?: { numId: number; level: number } } = {}): string => (nodes ?? []).map((n) => {
    const listPr = ctx.list ? `<w:numPr><w:ilvl w:val="${ctx.list.level}"/><w:numId w:val="${ctx.list.numId}"/></w:numPr>` : "";
    const styled = (s?: string) => (s ?? ctx.style ? `<w:pStyle w:val="${s ?? ctx.style}"/>` : "");
    switch (n.type) {
      case "paragraph": return para(styled(ctx.list ? "ListParagraph" : undefined) + listPr, n.content);
      case "heading": return para(styled(`Heading${Math.min(6, Math.max(1, Number(n.attrs?.level) || 1))}`) + listPr, n.content);
      case "blockquote": return blocks(n.content, { ...ctx, style: "Quote" });
      case "codeBlock": return para(styled("Code"), [{ type: "text", text: (n.content ?? []).map((x) => x.text ?? "").join("") }]);
      case "horizontalRule": return para('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
      case "image": return para(styled(), [n]);
      case "bulletList": case "orderedList": {
        let numId = 1;
        if (n.type === "orderedList") { if (!ctx.list || ctx.list.numId === 1) { listCount++; numId = 2 + listCount; nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${Number(n.attrs?.start) || 1}"/></w:lvlOverride></w:num>`); } else numId = ctx.list.numId; }
        const level = ctx.list ? Math.min(8, ctx.list.level + 1) : 0;
        return (n.content ?? []).map((li) => (li.content ?? []).map((b, i) => (b.type === "bulletList" || b.type === "orderedList")
          ? blocks([b], { list: { numId, level: level } })
          : i === 0 ? blocks([b], { list: { numId, level } }) : blocks([b], { style: "ListParagraph" })).join("")).join("");
      }
      case "table": {
        const rows = n.content ?? [];
        const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + (Number(c.attrs?.colspan) || 1), 0)));
        const tw = Math.floor(9000 / cols);
        return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${tw}"/>`).join("")}</w:tblGrid>${rows.map((r) => {
          const header = (r.content ?? []).every((c) => c.type === "tableHeader");
          return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${(r.content ?? []).map((c) => { const span = Number(c.attrs?.colspan) || 1; const inner = blocks(c.content); return `<w:tc><w:tcPr><w:tcW w:w="${tw * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${inner.includes("<w:p>") || inner.includes("<w:p ") ? inner : `${inner}<w:p/>`}</w:tc>`; }).join("")}</w:tr>`;
        }).join("")}</w:tbl><w:p/>`;
      }
      default: return n.content ? blocks(n.content, ctx) : "";
    }
  }).join("");
  const body = blocks(doc.content);
  const lvls = (fmt: (i: number) => string, text: (i: number) => string) => Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt(i)}"/><w:lvlText w:val="${text(i)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(() => "bullet", (i) => ["\u2022", "\u25e6", "\u25aa"][i % 3])}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls((i) => ["decimal", "lowerLetter", "lowerRoman"][i % 3], (i) => `%${i + 1}.`)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>${nums.join("")}</w:numbering>`;
  const heading = (i: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${i}"><w:name w:val="heading ${i}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${i - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-AU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[40, 32, 28, 24, 22, 22].map((s, i) => heading(i + 1, s)).join("")}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body || "<w:p/>"}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipParts({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join("")}</Relationships>`,
    "word/document.xml": document,
    "word/styles.xml": styles,
    "word/numbering.xml": numbering,
    ...media,
  });
}

/** Pixel size from a PNG, GIF or JPEG header (null when unknown). */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  if (b[0] === 0x47 && b[1] === 0x49 && b.length > 10) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]; const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}
