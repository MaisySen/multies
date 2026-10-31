/**
 * R100 Tools C: QR codes and barcodes stamped onto a PDF, on the device (pdf-lib, MIT; QR from uqr, MIT). The Code 128
 * encoder is written here from the published symbol table. Positions are fractions of the page from the top left,
 * like Edit a PDF, so they hold at any zoom.
 */
import { encode as encodeQr } from "uqr";

export type CodeKind = "qr" | "code128";
export type Spot = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
export const SPOTS: Spot[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

export class CodeError extends Error {}

/* Code 128 symbol widths (bar, space, bar, space, bar, space), values 0 to 105; then the stop symbol. */
const C128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
export const C128_STOP = "2331112";
export const C128_TABLE = C128;
export const CODE128_MAX = 80;

/** Symbol values for text: set C (pairs of digits) for all digit text of even length 4+, else set B (printable ASCII). */
export function code128Values(text: string): number[] {
  if (!text) throw new CodeError("Type what the barcode should hold.");
  if (text.length > CODE128_MAX) throw new CodeError(`A barcode holds up to ${CODE128_MAX} characters. Use a QR code for longer text.`);
  let values: number[];
  if (/^\d+$/.test(text) && text.length >= 4 && text.length % 2 === 0) {
    values = [105];
    for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)));
  } else {
    const bad = [...text].find((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126);
    if (bad) throw new CodeError(`A barcode can only hold plain letters, digits and symbols; "${bad}" cannot go in one. Use a QR code instead.`);
    values = [104, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  }
  const check = values.reduce((sum, v, i) => sum + v * Math.max(1, i), 0) % 103;
  return [...values, check];
}

/** The bars as alternating widths in modules, starting with a bar (quiet zones not included). */
export function code128Widths(text: string): number[] {
  const pattern = code128Values(text).map((v) => C128[v]).join("") + C128_STOP;
  return [...pattern].map(Number);
}

/** The QR as rows of dark runs: [x, width] per run, so a page gets a few hundred boxes, not thousands. */
export function qrRuns(text: string): { size: number; rows: [number, number][][] } {
  if (!text) throw new CodeError("Type what the QR code should hold.");
  if (new TextEncoder().encode(text).length > 1200) throw new CodeError("That is too long for a QR code that phones can read. Keep it under 1,200 characters.");
  const qr = encodeQr(text, { ecc: "M", border: 0 });
  const rows = qr.data.map((row) => {
    const runs: [number, number][] = [];
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x++; continue; }
      const s = x; while (x < row.length && row[x]) x++;
      runs.push([s, x - s]);
    }
    return runs;
  });
  return { size: qr.size, rows };
}

export interface Placement { kind: CodeKind; text: string; pages: "all" | number[]; spot: Spot | { x: number; y: number }; size: number; label?: boolean }

/** Where a code of w by h points goes on a page, in pdf-lib coordinates (bottom left origin). Margin 24 pt. */
export function placeBox(spot: Placement["spot"], pageW: number, pageH: number, w: number, h: number, margin = 24): { x: number; y: number } {
  if (w > pageW - 2 * margin || h > pageH - 2 * margin) throw new CodeError("The code is bigger than the page. Make it smaller.");
  if (typeof spot === "object") {
    const x = Math.min(pageW - w, Math.max(0, spot.x * pageW));
    const top = Math.min(pageH - h, Math.max(0, spot.y * pageH));
    return { x, y: pageH - top - h };
  }
  const col = spot.endsWith("left") ? 0 : spot.endsWith("right") ? 2 : 1;
  const row = spot.startsWith("top") ? 0 : spot.startsWith("bottom") ? 2 : 1;
  const x = col === 0 ? margin : col === 2 ? pageW - margin - w : (pageW - w) / 2;
  const yTop = row === 0 ? margin : row === 2 ? pageH - margin - h : (pageH - h) / 2;
  return { x, y: pageH - yTop - h };
}

/** Box size in points: a QR is size by size; a barcode is size wide and a third as tall (plus room for its text). */
export function codeBox(kind: CodeKind, size: number, label = true): { w: number; h: number } {
  if (!Number.isFinite(size) || size < 36 || size > 400) throw new CodeError("Size can be from 36 to 400 points.");
  return kind === "qr" ? { w: size, h: size } : { w: size, h: Math.round(size / 3) + (label ? 12 : 0) };
}

/** Pages a placement lands on, 0 based, checked against the page count. */
export function targetPages(pages: Placement["pages"], count: number): number[] {
  if (pages === "all") return Array.from({ length: count }, (_, i) => i);
  if (!pages.length) throw new CodeError("Pick at least one page.");
  const bad = pages.find((p) => !Number.isInteger(p) || p < 1 || p > count);
  if (bad !== undefined) throw new CodeError(`This PDF has ${count} ${count === 1 ? "page" : "pages"}, so page ${bad} is not there.`);
  return [...new Set(pages)].map((p) => p - 1);
}

/** Reads "1, 3-5" style page lists (also "1 3 5"). */
export function parsePageList(input: string): number[] {
  const out: number[] = [];
  for (const part of input.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new CodeError(`"${part}" is not a page number. Use numbers like 1, 3 or 2-4.`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (b < a) throw new CodeError(`"${part}" runs backwards. Write it as ${b}-${a}.`);
    if (b - a > 2000) throw new CodeError("That page range is too long.");
    for (let p = a; p <= b; p++) out.push(p);
  }
  return out;
}

/** Stamps the code onto a PDF and returns the new bytes. */
export async function stampCode(bytes: Uint8Array, p: Placement): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
  let doc;
  try { doc = await PDFDocument.load(bytes); } catch (e) {
    if (/encrypt/i.test(String((e as Error)?.message))) throw new CodeError("This PDF is locked with a password. Remove the password first.");
    throw new CodeError("This file could not be opened as a PDF. Try Fix a PDF first.");
  }
  const { w, h } = codeBox(p.kind, p.size, p.label);
  const pages = targetPages(p.pages, doc.getPageCount());
  const black = rgb(0, 0, 0), white = rgb(1, 1, 1);
  const font = p.kind === "code128" && p.label ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const qr = p.kind === "qr" ? qrRuns(p.text) : null;
  const bars = p.kind === "code128" ? code128Widths(p.text) : null;
  for (const index of pages) {
    const page = doc.getPage(index);
    const { width, height } = page.getSize();
    const at = placeBox(p.spot, width, height, w, h);
    if (qr) {
      const quiet = 2, m = w / (qr.size + quiet * 2);
      page.drawRectangle({ x: at.x, y: at.y, width: w, height: h, color: white });
      qr.rows.forEach((runs, y) => runs.forEach(([x, len]) => page.drawRectangle({ x: at.x + (x + quiet) * m, y: at.y + h - (y + quiet + 1) * m, width: len * m, height: m, color: black })));
    } else if (bars) {
      const modules = bars.reduce((a, b) => a + b, 0) + 20;
      const m = w / modules;
      const barH = Math.round(w / 3);
      page.drawRectangle({ x: at.x, y: at.y, width: w, height: h, color: white });
      let x = at.x + 10 * m;
      bars.forEach((width, i) => { if (i % 2 === 0) page.drawRectangle({ x, y: at.y + h - barH, width: width * m, height: barH, color: black }); x += width * m; });
      if (font) {
        const size = 9, tw = font.widthOfTextAtSize(p.text, size);
        page.drawText(p.text, { x: at.x + (w - Math.min(tw, w)) / 2, y: at.y + 2, size, font, color: black, maxWidth: w });
      }
    }
  }
  return doc.save();
}
