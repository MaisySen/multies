/**
 * R78 Convert hub: the converters that run on the person's device. Loaded only by the Convert page (a lazy chunk), so
 * no public page and no other app page carries pdf-lib, the PDF reader, the spreadsheet libraries or the encoders.
 * Every function takes Files and gives Files back; nothing is uploaded. Libraries: pdf-lib (MIT), pdfjs-dist
 * (Apache 2.0), read-excel-file and write-excel-file (MIT), papaparse (MIT), gifenc (MIT), @jsquash/webp and
 * @jsquash/avif (Apache 2.0, libwebp and libavif are BSD), and from R86 libarchive.js (MIT, libarchive is BSD) to open
 * archives. See THIRD_PARTY_NOTICES.md.
 */
import { FORMATS, formatDef, renameTo, type ConverterDef, type FormatId } from "@/shared/convert-routes";

export class ConvertError extends Error {}

/* ---------- images ---------- */

/** The largest picture we draw: about 50 megapixels, and no side over 16,384 px (a phone browser's canvas limit). */
const MAX_AREA = 50_000_000;
const MAX_SIDE = 16_384;

async function loadSvg(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

/** Draws any image this browser can open onto a canvas. HEIC opens where the browser itself reads it (Safari). */
export async function decodeImage(file: Blob, from: FormatId): Promise<HTMLCanvasElement> {
  let src: CanvasImageSource & { width: number; height: number };
  let w: number, h: number;
  try {
    if (from === "svg") {
      const img = await loadSvg(file);
      w = img.naturalWidth || 1024; h = img.naturalHeight || 1024;
      // A drawing with no size of its own comes out 1024 px on its long side.
      if (!img.naturalWidth || !img.naturalHeight) { w = 1024; h = 1024; }
      src = img;
    } else {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      w = bmp.width; h = bmp.height; src = bmp;
    }
  } catch {
    if (from === "heic") throw new ConvertError("This browser can't open HEIC photos. Open Multies in Safari on an iPhone or Mac, or share the photo as JPG.");
    throw new ConvertError(`This ${formatDef(from).label} file could not be opened. It may be damaged.`);
  }
  if (w * h > MAX_AREA || w > MAX_SIDE || h > MAX_SIDE) {
    if ("close" in src && typeof src.close === "function") src.close();
    throw new ConvertError(`This picture is ${w} by ${h} pixels, too large to convert on this device.`);
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new ConvertError("This browser can't draw pictures right now.");
  ctx.drawImage(src, 0, 0, w, h);
  if ("close" in src && typeof src.close === "function") src.close();
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob | null>((res) => c.toBlob(res, type, q));

/** A copy with a white background, for formats with no see through parts (JPG, BMP). */
function flatten(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = c.width; out.height = c.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

const imageData = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height);

/** Whether this browser's canvas writes WEBP itself (most do; Safari does not). Measured once. */
let nativeWebp: boolean | null = null;
export function canvasWritesWebp(): boolean {
  if (nativeWebp !== null) return nativeWebp;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    nativeWebp = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch { nativeWebp = false; }
  return nativeWebp;
}

/** HEIC: true when this browser opens a tiny HEIC sample (only Safari does today). Checked once, on the first HEIC file. */
let heicChecked: Promise<boolean> | null = null;
export function browserOpensHeic(sample: Blob): Promise<boolean> {
  heicChecked ??= createImageBitmap(sample).then((b) => { b.close(); return true; }).catch(() => false);
  return heicChecked;
}

async function encodeWithWasm(kind: "webp" | "avif", c: HTMLCanvasElement, quality: number): Promise<Blob> {
  const data = imageData(c);
  if (kind === "webp") {
    const [{ default: factory }, { initEmscriptenModule }] = await Promise.all([import("@jsquash/webp/codec/enc/webp_enc.js"), import("@jsquash/webp/utils.js")]);
    const mod = await initEmscriptenModule(factory as never) as unknown as { encode: (d: Uint8ClampedArray, w: number, h: number, o: unknown) => Uint8Array | null };
    const { defaultOptions } = await import("@jsquash/webp/meta.js");
    const out = mod.encode(data.data, data.width, data.height, { ...defaultOptions, quality: Math.round(quality * 100) });
    if (!out) throw new ConvertError("The WEBP file could not be written.");
    return new Blob([out.slice().buffer], { type: "image/webp" });
  }
  const [{ default: factory }, { initEmscriptenModule }, { defaultOptions }] = await Promise.all([import("@jsquash/avif/codec/enc/avif_enc.js"), import("@jsquash/avif/utils.js"), import("@jsquash/avif/meta.js")]);
  const mod = await initEmscriptenModule(factory as never) as unknown as { encode: (d: Uint8Array, w: number, h: number, o: unknown) => Uint8Array | null };
  const out = mod.encode(new Uint8Array(data.data.buffer), data.width, data.height, { ...defaultOptions, quality: Math.round(quality * 70) });
  if (!out) throw new ConvertError("The AVIF file could not be written.");
  return new Blob([out.slice().buffer], { type: "image/avif" });
}

async function encodeGif(c: HTMLCanvasElement): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const { data, width, height } = imageData(c);
  const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: true });
  const index = applyPalette(data, palette, "rgba4444");
  const transparentIndex = palette.findIndex((p) => p[3] === 0);
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, { palette, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex) });
  gif.finish();
  return new Blob([gif.bytes().slice().buffer], { type: "image/gif" });
}

/** A plain 24 bit BMP (white behind see through parts). */
export function encodeBmp(rgba: Uint8ClampedArray, width: number, height: number): Blob {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, width, true); v.setInt32(22, height, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * height, true);
  v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, a = rgba[s + 3] / 255;
      const blend = (ch: number) => Math.round(ch * a + 255 * (1 - a));
      out[dst + x * 3] = blend(rgba[s + 2]); out[dst + x * 3 + 1] = blend(rgba[s + 1]); out[dst + x * 3 + 2] = blend(rgba[s]);
    }
  }
  return new Blob([buf], { type: "image/bmp" });
}

export interface ImageOptions { quality?: number }

/** Writes a canvas as the target format. */
export async function encodeImage(c: HTMLCanvasElement, to: FormatId, opts: ImageOptions = {}): Promise<Blob> {
  const q = opts.quality ?? 0.9;
  switch (to) {
    case "png": { const b = await toBlob(c, "image/png"); if (b) return b; break; }
    case "jpg": { const b = await toBlob(flatten(c), "image/jpeg", q); if (b) return b; break; }
    case "webp": {
      if (canvasWritesWebp()) { const b = await toBlob(c, "image/webp", q); if (b?.type === "image/webp") return b; }
      return encodeWithWasm("webp", c, q);
    }
    case "avif": return encodeWithWasm("avif", c, q);
    case "gif": return encodeGif(c);
    case "bmp": { const d = imageData(c); return encodeBmp(d.data, d.width, d.height); }
    default: break;
  }
  throw new ConvertError(`${formatDef(to).label} pictures can't be written here.`);
}

/** EXIF orientation of a JPEG (1 when there is none): pdf-lib embeds the raw bytes, so a turned photo must be redrawn. */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) return 1;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
      const t = i + 10;
      const le = bytes[t] === 0x49;
      const u16 = (o: number) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const u32 = (o: number) => (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    i += 2 + len;
  }
  return 1;
}

/* ---------- PDF ---------- */

type PdfLib = typeof import("pdf-lib");
let pdfLib: Promise<PdfLib> | null = null;
export const loadPdfLib = () => (pdfLib ??= import("pdf-lib").catch((e) => { pdfLib = null; throw e; }));

type Pdfjs = typeof import("pdfjs-dist");
let pdfjs: Promise<Pdfjs> | null = null;
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return lib;
  }).catch((e) => { pdfjs = null; throw e; });
  return pdfjs;
}

export async function openPdf(file: Blob, _name: string) {
  const { PDFDocument } = await loadPdfLib();
  try {
    const doc = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    if (doc.getPageCount() < 1) throw new Error("no pages");
    return doc;
  } catch (err) {
    if (/encrypt/i.test(String((err as Error)?.message))) throw new ConvertError("This PDF is locked with a password. Take the password off with Remove password, then convert it here.");
    throw new ConvertError(`This PDF can't be opened. It may be damaged.`);
  }
}

const pdfFile = (bytes: Uint8Array, name: string) => new File([bytes.slice().buffer], name, { type: "application/pdf" });

/** Points per CSS pixel: a 96 dpi picture prints at its own size. */
const PX = 0.75;
const A4: [number, number] = [595.28, 841.89];

export interface ImagesPdfOptions { pageSize?: "image" | "a4" }

/** Images into one PDF, one per page. JPG and PNG are embedded as they are (no quality loss) unless a photo is turned. */
export async function imagesToPdf(files: { file: File; from: FormatId }[], name: string, opts: ImagesPdfOptions = {}): Promise<File> {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  for (const { file, from } of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let img;
    if (from === "jpg" && jpegOrientation(bytes) === 1) img = await doc.embedJpg(bytes).catch(() => null);
    else if (from === "png") img = await doc.embedPng(bytes).catch(() => null);
    if (!img) {
      const c = await decodeImage(file, from);
      const opaque = from === "jpg" || from === "heic" || from === "bmp";
      const blob = opaque ? await encodeImage(c, "jpg", { quality: 0.92 }) : await encodeImage(c, "png");
      const raw = new Uint8Array(await blob.arrayBuffer());
      img = opaque ? await doc.embedJpg(raw) : await doc.embedPng(raw);
    }
    const w = img.width * PX, h = img.height * PX;
    if (opts.pageSize === "a4") {
      const [pw, ph] = w > h ? [A4[1], A4[0]] : A4;
      const m = 36, s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h, 1);
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - w * s) / 2, y: (ph - h * s) / 2, width: w * s, height: h * s });
    } else {
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
  }
  return pdfFile(await doc.save(), name);
}

export async function mergePdfs(files: File[], name: string): Promise<File> {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await openPdf(f, f.name);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return pdfFile(await out.save(), name);
}

export async function pageCount(file: File): Promise<number> {
  return (await openPdf(file, file.name)).getPageCount();
}

/** Each range ([1, 3] is pages 1 to 3) as its own PDF; no ranges means every page on its own. */
export async function splitPdf(file: File, ranges: [number, number][] | null): Promise<File[]> {
  const { PDFDocument } = await loadPdfLib();
  const src = await openPdf(file, file.name);
  const n = src.getPageCount();
  const list = ranges ?? Array.from({ length: n }, (_, i) => [i + 1, i + 1] as [number, number]);
  const base = file.name.replace(/\.pdf$/i, "");
  const out: File[] = [];
  for (const [a, b] of list) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
    pages.forEach((p) => doc.addPage(p));
    out.push(pdfFile(await doc.save(), `${base}-${a === b ? `p${a}` : `p${a}-${b}`}.pdf`));
  }
  return out;
}

export async function rotatePdf(file: File, turn: 90 | 180 | 270): Promise<File> {
  const { degrees } = await loadPdfLib();
  const doc = await openPdf(file, file.name);
  for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + turn) % 360));
  return pdfFile(await doc.save(), file.name.replace(/\.pdf$/i, "-rotated.pdf"));
}

export interface NumberOptions { position?: "bottom-center" | "bottom-right"; style?: "n" | "page n of N" }

export async function numberPdf(file: File, opts: NumberOptions = {}): Promise<File> {
  const { StandardFonts, rgb } = await loadPdfLib();
  const doc = await openPdf(file, file.name);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const text = opts.style === "page n of N" ? `Page ${i + 1} of ${pages.length}` : String(i + 1);
    const size = 10;
    const { width } = p.getSize();
    const tw = font.widthOfTextAtSize(text, size);
    const box = p.getCropBox();
    const x = opts.position === "bottom-right" ? box.x + width - 36 - tw : box.x + (box.width - tw) / 2;
    p.drawText(text, { x, y: box.y + 22, size, font, color: rgb(0.25, 0.25, 0.28) });
  });
  return pdfFile(await doc.save(), file.name.replace(/\.pdf$/i, "-numbered.pdf"));
}

/** Every page as a picture (PNG or JPG), drawn at twice the page size (about 144 dpi), up to 200 pages. */
export async function pdfToImages(file: File, to: "png" | "jpg", onPage?: (done: number, total: number) => void): Promise<File[]> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try { doc = await task.promise; } catch (err) {
    void task.destroy();
    if ((err as { name?: string })?.name === "PasswordException") throw new ConvertError(`${file.name} is locked with a password. Remove the password first.`);
    throw new ConvertError(`${file.name} could not be read as a PDF.`);
  }
  try {
    if (doc.numPages > 200) throw new ConvertError(`${file.name} has ${doc.numPages} pages. Pictures can be made from up to 200 pages at a time; split it first.`);
    const base = file.name.replace(/\.pdf$/i, "");
    const out: File[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 4096 / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as never).promise;
      const blob = await encodeImage(c, to, { quality: 0.9 });
      const name = doc.numPages === 1 ? `${base}.${to}` : `${base}-p${String(i).padStart(String(doc.numPages).length, "0")}.${to}`;
      out.push(new File([blob], name, { type: formatDef(to).mime }));
      page.cleanup();
      onPage?.(i, doc.numPages);
    }
    return out;
  } finally {
    void task.destroy();
  }
}

/* ---------- spreadsheets ---------- */

type Cell = string | number | boolean | Date | null;
interface SheetRows { name: string; rows: Cell[][] }

async function readSheets(file: File, from: FormatId): Promise<SheetRows[]> {
  if (from === "xlsx") {
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    try {
      const sheets = await readXlsxFile(file);
      return sheets.map((s) => ({ name: s.sheet, rows: s.data as Cell[][] }));
    } catch { throw new ConvertError(`${file.name} could not be read as an Excel file.`); }
  }
  const text = await file.text();
  if (from === "json") {
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ConvertError(`${file.name} is not valid JSON.`); }
    const list = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data as object).find(Array.isArray) : null;
    if (!Array.isArray(list)) throw new ConvertError(`${file.name} needs a list of rows to become a table.`);
    if (list.every(Array.isArray)) return [{ name: "Sheet1", rows: (list as unknown[][]).map((r) => r.map(cellOf)) }];
    const keys: string[] = [];
    for (const r of list) if (r && typeof r === "object") for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return [{ name: "Sheet1", rows: [keys, ...list.map((r) => keys.map((k) => cellOf((r as Record<string, unknown>)?.[k])))] }];
  }
  const Papa = (await import("papaparse")).default;
  const res = Papa.parse<string[]>(text.replace(/^\ufeff/, ""), { delimiter: from === "tsv" ? "\t" : "", skipEmptyLines: "greedy" });
  return [{ name: "Sheet1", rows: res.data }];
}

function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  return JSON.stringify(v);
}

const cellText = (v: Cell) => (v === null ? "" : v instanceof Date ? v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10).replace("T", " ") : String(v));

async function writeSheet(s: SheetRows, to: FormatId): Promise<Blob> {
  if (to === "xlsx") {
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    const width = Math.max(1, ...s.rows.map((r) => r.length));
    const data = s.rows.map((r) => Array.from({ length: width }, (_, i) => {
      const v = r[i] ?? null;
      return v === null ? null : { value: v as string | number | boolean | Date, ...(v instanceof Date ? { format: "yyyy-mm-dd" } : {}) };
    }));
    return writeXlsxFile(data as never, { sheet: s.name.slice(0, 31) || "Sheet1" } as never).toBlob();
  }
  if (to === "json") {
    const [head = [], ...rest] = s.rows;
    const keys = head.map((h, i) => (cellText(h) || `column_${i + 1}`));
    const list = rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] instanceof Date ? cellText(r[i]) : (r[i] ?? null)])));
    return new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
  }
  const Papa = (await import("papaparse")).default;
  const text = Papa.unparse(s.rows.map((r) => r.map(cellText)), { delimiter: to === "tsv" ? "\t" : ",", newline: "\r\n" });
  return new Blob([to === "csv" ? "\ufeff" + text : text], { type: formatDef(to).mime + ";charset=utf-8" });
}

/** A spreadsheet in another table format. A workbook with several sheets becomes one file per sheet. */
export async function convertSheet(file: File, from: FormatId, to: FormatId): Promise<File[]> {
  const sheets = (await readSheets(file, from)).filter((s) => s.rows.length);
  if (!sheets.length) throw new ConvertError(`${file.name} has no rows to convert.`);
  const single = sheets.length === 1 || to === "xlsx";
  if (to === "xlsx" && sheets.length > 1) {
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    const blob = await writeXlsxFile(sheets.map((s) => ({ data: s.rows.map((r) => r.map((v) => (v === null ? null : { value: v }))), sheet: s.name.slice(0, 31) })) as never).toBlob();
    return [new File([blob], renameTo(file.name, to), { type: formatDef(to).mime })];
  }
  const out: File[] = [];
  for (const s of sheets) {
    const blob = await writeSheet(s, to);
    const suffix = single ? "" : `-${s.name.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "_") || "sheet"}`;
    out.push(new File([blob], renameTo(file.name, to, suffix), { type: formatDef(to).mime }));
  }
  return out;
}

/* ---------- one step ---------- */

export interface StepOptions { quality?: number; onProgress?: (fraction: number) => void }

/** Runs one browser converter on one file. */
export async function runBrowserStep(step: ConverterDef, file: File, opts: StepOptions = {}): Promise<File[]> {
  switch (step.run) {
    case "image": {
      const c = await decodeImage(file, step.from);
      const blob = await encodeImage(c, step.to, { quality: opts.quality });
      c.width = c.height = 0;
      return [new File([blob], renameTo(file.name, step.to), { type: formatDef(step.to).mime })];
    }
    case "image-pdf":
      return [await imagesToPdf([{ file, from: step.from }], renameTo(file.name, "pdf"))];
    case "pdf-image":
      return pdfToImages(file, step.to as "png" | "jpg", (d, t) => opts.onProgress?.(d / t));
    case "sheet":
      return convertSheet(file, step.from, step.to);
    case "archive": {
      const inside = await extractArchive(file, (d, t) => opts.onProgress?.((d / t) * 0.7));
      return [await makeArchive(inside, step.to as ArchiveOut, renameTo(file.name, step.to))];
    }
    default:
      throw new ConvertError("This step can't run on this device.");
  }
}

/** Many files as one ZIP, each name kept (a repeated name gets a number). */
export async function zipFiles(files: File[]): Promise<Blob> {
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  // R86: a file unpacked from an archive keeps its folder.
  for (const [name, f] of uniqueNames(files)) entries[name] = new Uint8Array(await f.arrayBuffer());
  // Pictures, PDFs and workbooks are packed already; storing them is faster and barely bigger.
  return new Blob([zipSync(entries, { level: 0 }).slice().buffer], { type: "application/zip" });
}

/* ---------- R86: archives ---------- */

/** Where a file sat inside the archive it came out of ("photos/2024/"), so packing it again keeps the folders. */
const FOLDERS = new WeakMap<File, string>();
export const folderOf = (f: File) => FOLDERS.get(f) ?? "";

/** Each file's path in an archive, folders kept, a repeated path numbered. */
function uniqueNames(files: File[]): [string, File][] {
  const used = new Set<string>();
  return files.map((f) => {
    const full = folderOf(f) + f.name;
    let name = full;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = full.replace(/(\.[^./]+)?$/, ` (${i})$1`);
    used.add(name.toLowerCase());
    return [name, f];
  });
}

/** A path from inside an archive, made safe: no leading slash, no "..", no drive letters, no control characters. */
export function safeArchivePath(path: string): string {
  return path.replace(/\\/g, "/").split("/").map((p) => [...p].filter((ch) => ch.charCodeAt(0) >= 32).join("").trim()).filter((p) => p && p !== "." && p !== ".." && !/^[A-Za-z]:$/.test(p)).join("/");
}

/** The most files and bytes we unpack on a device at once. */
export const ARCHIVE_MAX_FILES = 2000;
export const ARCHIVE_MAX_BYTES = 500 * 1024 * 1024;

let archiveLib: Promise<typeof import("./vendor/libarchive.js")> | null = null;
async function archiveReader() {
  archiveLib ??= import("./vendor/libarchive.js").then((m) => {
    // The worker and its WebAssembly are served from our own origin (public/vendor/libarchive).
    m.Archive.init({ getWorker: () => new Worker("/vendor/libarchive/worker-bundle.js", { type: "module" }) });
    return m;
  });
  return (await archiveLib).Archive;
}

/** Every file inside a ZIP, 7Z, TAR, TAR.GZ or RAR archive. Folders are kept for packing again. */
export async function extractArchive(file: File, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const Archive = await archiveReader();
  let reader;
  try { reader = await Archive.open(file); } catch { throw new ConvertError(`${file.name} could not be opened. It may be damaged or not an archive.`); }
  try {
    if ((await reader.hasEncryptedData()) === true) throw new ConvertError(`${file.name} is locked with a password, so it can't be unpacked here.`);
    const list = await reader.getFilesArray();
    if (!list.length) throw new ConvertError(`${file.name} has no files in it.`);
    if (list.length > ARCHIVE_MAX_FILES) throw new ConvertError(`${file.name} holds ${list.length.toLocaleString()} files. Up to ${ARCHIVE_MAX_FILES.toLocaleString()} can be unpacked at once.`);
    const total = list.reduce((n, e) => n + (e.file.size || 0), 0);
    if (total > ARCHIVE_MAX_BYTES) throw new ConvertError(`${file.name} unpacks to ${Math.round(total / 1048576)} MB. Up to 500 MB can be unpacked on this device.`);
    const out: File[] = [];
    let done = 0;
    await reader.extractFiles((entry) => {
      done += 1;
      onProgress?.(done, list.length);
      const path = safeArchivePath(entry.path + entry.file.name);
      if (!path) return;
      const slash = path.lastIndexOf("/");
      const f = new File([entry.file], path.slice(slash + 1), { type: guessType(path) });
      FOLDERS.set(f, slash >= 0 ? path.slice(0, slash + 1) : "");
      out.push(f);
    });
    // extractFiles hands each file over just after it resolves; wait for the last one.
    for (let i = 0; i < 50 && out.length < list.length; i++) await new Promise((r) => setTimeout(r, 20));
    if (!out.length) throw new ConvertError(`${file.name} has no files in it.`);
    return out;
  } catch (err) {
    if (err instanceof ConvertError) throw err;
    throw new ConvertError(`${file.name} could not be unpacked. It may be damaged.`);
  } finally {
    void reader.close();
  }
}

function guessType(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const hit = FORMATS.find((f) => f.exts.includes(ext));
  return hit?.mime ?? "application/octet-stream";
}

export type ArchiveOut = "zip" | "tar" | "tgz";

/** A USTAR tar of these files (folders kept). Names over 100 bytes use the prefix field, up to 255. */
export async function tarFiles(files: File[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const [name, f] of uniqueNames(files)) {
    let bytesName = enc.encode(name);
    let prefix = new Uint8Array(0);
    if (bytesName.length > 100) {
      const cut = name.lastIndexOf("/", 154);
      if (cut > 0 && enc.encode(name.slice(cut + 1)).length <= 100) { prefix = enc.encode(name.slice(0, cut)); bytesName = enc.encode(name.slice(cut + 1)); }
      else bytesName = enc.encode(name.slice(-100).replace(/^[^/]*\//, ""));
    }
    const h = new Uint8Array(512);
    h.set(bytesName.slice(0, 100), 0);
    const oct = (n: number, len: number) => enc.encode(n.toString(8).padStart(len - 1, "0") + "\0");
    h.set(oct(0o644, 8), 100); h.set(oct(0, 8), 108); h.set(oct(0, 8), 116);
    h.set(oct(f.size, 12), 124); h.set(oct(Math.floor((f.lastModified || now * 1000) / 1000), 12), 136);
    h.set(enc.encode("        "), 148);
    h[156] = 0x30; // "0": a plain file
    h.set(enc.encode("ustar\0"), 257); h.set(enc.encode("00"), 263);
    h.set(prefix.slice(0, 155), 345);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    parts.push(h, new Uint8Array(await f.arrayBuffer()));
    const pad = (512 - (f.size % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Packs files into one ZIP, TAR or TAR.GZ. ZIP squeezes what can be squeezed and stores what is packed already. */
export async function makeArchive(files: File[], to: ArchiveOut, name: string): Promise<File> {
  if (!files.length) throw new ConvertError("There are no files to pack.");
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > ARCHIVE_MAX_BYTES) throw new ConvertError(`These files come to ${Math.round(total / 1048576)} MB. Up to 500 MB can be packed on this device.`);
  const fflate = await import("fflate");
  if (to === "zip") {
    const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
    for (const [n, f] of uniqueNames(files)) entries[n] = [new Uint8Array(await f.arrayBuffer()), { level: PACKED.test(n) ? 0 : 6 }];
    return new File([fflate.zipSync(entries).slice().buffer], name, { type: "application/zip" });
  }
  const tar = await tarFiles(files);
  if (to === "tar") return new File([tar.slice().buffer], name, { type: "application/x-tar" });
  return new File([fflate.gzipSync(tar, { level: 6 }).slice().buffer], name, { type: "application/gzip" });
}
const PACKED = /\.(jpe?g|png|gif|webp|avif|heic|mp4|mov|webm|mp3|m4a|aac|ogg|opus|zip|7z|gz|tgz|rar|docx|xlsx|pptx|pdf)$/i;

/* ---------- R86: smaller photos ---------- */

export type CompressLevel = "light" | "medium" | "strong";
const PHOTO_LEVELS: Record<CompressLevel, { side: number; quality: number }> = {
  light: { side: 4096, quality: 0.85 },
  medium: { side: 2560, quality: 0.75 },
  strong: { side: 1600, quality: 0.6 },
};

/** A photo redrawn smaller (JPG, PNG or WEBP stays the same type). The original comes back when it is already small. */
export async function compressImage(file: File, from: FormatId, level: CompressLevel): Promise<{ file: File; same: boolean }> {
  const { side, quality } = PHOTO_LEVELS[level];
  const c = await decodeImage(file, from);
  const scale = Math.min(1, side / Math.max(c.width, c.height));
  let target = c;
  if (scale < 1) {
    target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(c.width * scale));
    target.height = Math.max(1, Math.round(c.height * scale));
    const g = target.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(c, 0, 0, target.width, target.height);
    c.width = c.height = 0;
  }
  const blob = await encodeImage(target, from, { quality });
  target.width = target.height = 0;
  if (blob.size >= file.size) return { file, same: true };
  return { file: new File([blob], renameTo(file.name, from, "-smaller"), { type: formatDef(from).mime }), same: false };
}

/* ---------- R86: the text of a searchable PDF ---------- */

/** All the words in a PDF that has a text layer (an OCR result), page by page, as a TXT file. */
export async function pdfText(file: File, name: string): Promise<File> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof it.str !== "string") continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line.trimEnd()); line = ""; }
      }
      if (line.trim()) lines.push(line.trimEnd());
      pages.push(lines.join("\n").trim());
      page.cleanup();
    }
    const text = pages.join("\n\n").trim();
    if (!text) throw new ConvertError(`No words were found in ${file.name}.`);
    return new File([text + "\n"], name, { type: "text/plain" });
  } finally {
    void task.destroy();
  }
}
