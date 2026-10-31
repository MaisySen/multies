/**
 * R100 Tools C: read a PDF's comments and highlights on the device (pdf.js, Apache 2.0). Nothing is uploaded and the
 * file is not changed. Each note keeps its page, kind, author, date, its words and, for a highlight, the words it marks.
 */
import { loadPdfjs } from "@/web/lib/convert/browser-ops";

export type NoteKind = "comment" | "highlight" | "underline" | "strike" | "box" | "drawing" | "stamp" | "text box";
export interface PdfNote { page: number; kind: NoteKind; author: string; date: Date | null; text: string; marked: string; replies: number }

const KINDS: Record<string, NoteKind> = { Text: "comment", Highlight: "highlight", Underline: "underline", Squiggly: "underline", StrikeOut: "strike", Square: "box", Circle: "box", Polygon: "drawing", PolyLine: "drawing", Ink: "drawing", Stamp: "stamp", FreeText: "text box", Caret: "comment" };
export const NOTE_LABEL: Record<NoteKind, string> = { comment: "Comment", highlight: "Highlight", underline: "Underline", strike: "Crossed out", box: "Shape", drawing: "Drawing", stamp: "Stamp", "text box": "Text box" };

/** PDF dates look like D:20261101093000+11'00'. */
export function pdfDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", sign, oh = "00", om = "00"] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (sign === "+" || sign === "-") t -= (sign === "+" ? 1 : -1) * ((+oh) * 60 + (+om)) * 60000;
  const date = new Date(t);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface RawAnnot { subtype?: string; contentsObj?: { str?: string }; contents?: string; titleObj?: { str?: string }; title?: string; modificationDate?: string; creationDate?: string; rect?: number[]; quadPoints?: unknown; inReplyTo?: string; id?: string; popupRef?: string }
interface RawText { str: string; transform: number[]; width: number; height: number }

/** Words of the page whose start sits inside the annotation's box. */
export function markedWords(rect: number[] | undefined, items: RawText[]): string {
  if (!rect || rect.length < 4) return "";
  const [x1, y1, x2, y2] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  return items.filter((t) => { const x = t.transform[4], y = t.transform[5] + (t.height || 0) / 3; return x >= x1 - 2 && x <= x2 + 2 && y >= y1 - 2 && y <= y2 + 2; }).map((t) => t.str).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Turns pdf.js annotations of one page into notes; replies are counted on the note they answer. */
export function notesFromPage(page: number, annots: RawAnnot[], items: RawText[]): PdfNote[] {
  const replies = new Map<string, number>();
  for (const a of annots) if (a.inReplyTo) replies.set(a.inReplyTo, (replies.get(a.inReplyTo) ?? 0) + 1);
  const out: PdfNote[] = [];
  for (const a of annots) {
    const kind = a.subtype ? KINDS[a.subtype] : undefined;
    if (!kind || a.inReplyTo) continue;
    const text = (a.contentsObj?.str ?? a.contents ?? "").trim();
    const marked = kind === "highlight" || kind === "underline" || kind === "strike" ? markedWords(a.rect, items) : "";
    if (!text && !marked && kind !== "stamp" && kind !== "drawing" && kind !== "box") continue;
    out.push({ page, kind, author: (a.titleObj?.str ?? a.title ?? "").trim(), date: pdfDate(a.modificationDate ?? a.creationDate), text, marked, replies: a.id ? replies.get(a.id) ?? 0 : 0 });
  }
  return out;
}

export function notesAsText(file: string, notes: PdfNote[]): string {
  const lines = [`Comments in ${file}`, ""];
  for (const n of notes) {
    lines.push(`Page ${n.page}, ${NOTE_LABEL[n.kind]}${n.author ? `, ${n.author}` : ""}${n.date ? `, ${n.date.toISOString().slice(0, 10)}` : ""}`);
    if (n.marked) lines.push(`  Marked: "${n.marked}"`);
    if (n.text) lines.push(`  ${n.text.replace(/\n/g, "\n  ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const NOTES_MAX_BYTES = 100 * 1024 * 1024;
export const NOTES_MAX_PAGES = 1000;

export async function readNotes(file: File, onPage?: (done: number, total: number) => void): Promise<{ notes: PdfNote[]; pages: number }> {
  if (file.size > NOTES_MAX_BYTES) throw new Error(`${file.name} is over 100 MB.`);
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try { doc = await task.promise; } catch (err) {
    void task.destroy();
    if ((err as { name?: string })?.name === "PasswordException") throw new Error(`${file.name} is locked with a password. Remove the password first.`);
    throw new Error(`${file.name} could not be opened as a PDF. Try Fix a PDF first.`);
  }
  try {
    const total = Math.min(doc.numPages, NOTES_MAX_PAGES);
    const notes: PdfNote[] = [];
    for (let i = 1; i <= total; i++) {
      const p = await doc.getPage(i);
      const annots = (await p.getAnnotations()) as RawAnnot[];
      if (annots.length) {
        const needText = annots.some((a) => a.subtype && ["Highlight", "Underline", "Squiggly", "StrikeOut"].includes(a.subtype));
        const items = needText ? ((await p.getTextContent()).items as unknown[]).filter((t): t is RawText => typeof (t as RawText).str === "string") : [];
        notes.push(...notesFromPage(i, annots, items));
      }
      onPage?.(i, total);
    }
    return { notes, pages: doc.numPages };
  } finally { void task.destroy(); }
}
