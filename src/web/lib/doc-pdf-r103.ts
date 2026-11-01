/**
 * R103: a PDF snapshot of a saved page (or any doc), made in the browser with pdf-lib (already a dependency, MIT).
 * Text only: title, source line, headings, paragraphs, lists, quotes and code, wrapped on A4. Characters the
 * standard fonts cannot draw are replaced, so the file always opens.
 */
interface PMNode { type: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown> }
type Line = { text: string; size: number; bold?: boolean; mono?: boolean; indent?: number; gap?: number };

const winAnsi = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, ", ").replace(/\u2026/g, "...").replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?");
const textOf = (n: PMNode): string => (n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(textOf).join(""));

export function docLines(doc: PMNode): Line[] {
  const out: Line[] = [];
  const walk = (nodes: PMNode[], indent: number, ordered = false) => {
    let i = 1;
    for (const n of nodes) {
      if (n.type === "heading") out.push({ text: textOf(n), size: (n.attrs?.level as number) <= 2 ? 15 : 13, bold: true, gap: 8, indent });
      else if (n.type === "paragraph") out.push({ text: textOf(n), size: 11, gap: 5, indent });
      else if (n.type === "blockquote") walk(n.content ?? [], indent + 18);
      else if (n.type === "codeBlock") for (const l of textOf(n).split("\n")) out.push({ text: l, size: 9.5, mono: true, indent: indent + 8 });
      else if (n.type === "bulletList" || n.type === "orderedList" || n.type === "taskList") walk(n.content ?? [], indent, n.type === "orderedList");
      else if (n.type === "listItem" || n.type === "taskItem") {
        const [first, ...rest] = n.content ?? [];
        out.push({ text: `${ordered ? `${i}.` : "*"} ${first ? textOf(first) : ""}`, size: 11, indent: indent + 12, gap: 2 });
        walk(rest, indent + 24);
        i += 1;
      } else if (n.type === "horizontalRule") out.push({ text: "", size: 6, gap: 6 });
      else if (n.content) walk(n.content, indent);
    }
  };
  walk(doc.content ?? [], 0);
  return out;
}

export async function docPdf(title: string, doc: PMNode, source?: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(winAnsi(title));
  const fonts = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), mono: await pdf.embedFont(StandardFonts.Courier) };
  const W = 595.28, H = 841.89, M = 56;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const draw = (l: Line) => {
    const font = l.mono ? fonts.mono : l.bold ? fonts.bold : fonts.reg;
    const max = W - M * 2 - (l.indent ?? 0);
    const words = winAnsi(l.text).split(/(\s+)/);
    const rows: string[] = [];
    let row = "";
    for (const w of words) {
      const next = row + w;
      if (font.widthOfTextAtSize(next, l.size) > max && row.trim()) { rows.push(row.trimEnd()); row = w.trimStart(); } else row = next;
    }
    rows.push(row);
    y -= l.gap ?? 0;
    for (const r of rows) {
      if (y < M + l.size) { page = pdf.addPage([W, H]); y = H - M; }
      page.drawText(r, { x: M + (l.indent ?? 0), y: y - l.size, size: l.size, font, color: rgb(0.08, 0.09, 0.11) });
      y -= l.size * 1.45;
    }
  };
  draw({ text: title, size: 20, bold: true });
  if (source) draw({ text: source, size: 9, gap: 2 });
  for (const l of docLines(doc)) draw(l);
  return pdf.save();
}

export async function downloadDocPdf(title: string, doc: PMNode, source?: string) {
  const bytes = await docPdf(title, doc, source);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(title || "Page").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80).trim() || "Page"}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
