/**
 * R86 Edit PDF, on the device: reorder, turn and delete pages, add text, place a drawn signature, black out areas
 * for good, a watermark and page numbers, all saved into one new PDF (pdf-lib, MIT; pdf.js, Apache 2.0).
 *
 * Blacking out is real: a page with a blacked out area is redrawn as a picture with the boxes painted in, so the
 * words under them are gone from the file, not just covered. Positions are fractions of the page as shown (0 to 1
 * from the top left), so they hold at any zoom.
 */
import { ConvertError, loadPdfLib, loadPdfjs, numberPdf } from "./browser-ops";

export interface EditItem {
  id: string;
  /** The page's index in the original file. */
  page: number;
  kind: "text" | "sign" | "box";
  x: number; y: number; w: number; h: number;
  text?: string;
  /** Text size in points. */
  size?: number;
  /** A signature as a PNG data URL. */
  image?: string;
}
export interface EditPlan {
  /** Original page indexes in the new order; a page left out is deleted. */
  order: number[];
  /** Extra turn per original page, in degrees. */
  turn: Record<number, 0 | 90 | 180 | 270>;
  items: EditItem[];
  watermark?: string;
  numbers?: boolean;
}

export const EDIT_MAX_PAGES = 300;
export const EDIT_MAX_BYTES = 100 * 1024 * 1024;

/** Characters the built in PDF font can write (Latin letters, numbers and common signs). */
const WIN_ANSI = /^[\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac\n]*$/;
export const textFits = (t: string) => WIN_ANSI.test(t);

export interface OpenedPdf {
  pages: { width: number; height: number }[];
  /** Draws one page at a width in CSS pixels into a canvas (the device's pixel ratio is applied). */
  draw(page: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  close(): void;
}

/** Opens a PDF for the editor: page sizes as shown, and a way to draw each page. */
export async function openForEdit(file: File): Promise<OpenedPdf> {
  if (file.size > EDIT_MAX_BYTES) throw new ConvertError(`${file.name} is over 100 MB. Make it smaller first, then edit it.`);
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try { doc = await task.promise; } catch (err) {
    void task.destroy();
    if ((err as { name?: string })?.name === "PasswordException") throw new ConvertError(`${file.name} is locked with a password. Remove the password first, then edit it.`);
    throw new ConvertError(`${file.name} could not be opened as a PDF. It may be damaged.`);
  }
  if (doc.numPages > EDIT_MAX_PAGES) { void task.destroy(); throw new ConvertError(`${file.name} has ${doc.numPages} pages. Up to ${EDIT_MAX_PAGES} can be edited at once; split it first.`); }
  const pages: { width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const v = p.getViewport({ scale: 1 });
    pages.push({ width: v.width, height: v.height });
  }
  return {
    pages,
    async draw(page, canvas, cssWidth) {
      const p = await doc.getPage(page + 1);
      const base = p.getViewport({ scale: 1 });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const v = p.getViewport({ scale: (cssWidth / base.width) * ratio });
      canvas.width = Math.round(v.width); canvas.height = Math.round(v.height);
      await p.render({ canvasContext: canvas.getContext("2d")!, viewport: v, canvas } as Parameters<typeof p.render>[0]).promise;
    },
    close() { void task.destroy(); },
  };
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Saves every change into a new PDF. onStep reports progress from 0 to 1. */
export async function applyEdits(file: File, plan: EditPlan, onStep?: (fraction: number) => void): Promise<File> {
  if (!plan.order.length) throw new ConvertError("Every page has been deleted. Keep at least one page.");
  for (const it of plan.items) if (it.kind === "text" && it.text && !textFits(it.text)) throw new ConvertError(`"${it.text.slice(0, 30)}" has letters the PDF font can't write. Use Latin letters, numbers and common signs.`);
  if (plan.watermark && !textFits(plan.watermark)) throw new ConvertError("The watermark has letters the PDF font can't write. Use Latin letters, numbers and common signs.");
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let src;
  try { src = await PDFDocument.load(bytes, { updateMetadata: false }); } catch { throw new ConvertError(`${file.name} could not be opened as a PDF.`); }
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const boxed = new Set(plan.items.filter((i) => i.kind === "box").map((i) => i.page));
  const lib = boxed.size ? await loadPdfjs() : null;
  const viewTask = lib ? lib.getDocument({ data: bytes.slice() }) : null;
  const view = viewTask ? await viewTask.promise : null;
  try {
    for (let k = 0; k < plan.order.length; k++) {
      const idx = plan.order[k];
      onStep?.(k / plan.order.length);
      let page;
      let rot: number;
      if (boxed.has(idx) && view) {
        // Redraw the page as a picture with the boxes painted in: the words under them leave the file.
        const p = await view.getPage(idx + 1);
        const v1 = p.getViewport({ scale: 1 });
        const v = p.getViewport({ scale: 2.5 });
        const c = document.createElement("canvas");
        c.width = Math.round(v.width); c.height = Math.round(v.height);
        const g = c.getContext("2d")!;
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: g, viewport: v, canvas: c } as Parameters<typeof p.render>[0]).promise;
        g.fillStyle = "#000";
        for (const b of plan.items) if (b.page === idx && b.kind === "box") g.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.88));
        c.width = c.height = 0;
        if (!blob) throw new ConvertError("A page could not be redrawn on this device. Try again.");
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        page = out.addPage([v1.width, v1.height]);
        page.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
        rot = 0;
      } else {
        [page] = await out.copyPages(src, [idx]);
        out.addPage(page);
        rot = ((page.getRotation().angle % 360) + 360) % 360;
      }
      // Draw items in the page as shown: map shown fractions to the page's own space, which may be turned.
      const box = page.getCropBox();
      const shownW = rot % 180 ? box.height : box.width, shownH = rot % 180 ? box.width : box.height;
      const at = (fx: number, fy: number) => {
        const sx = fx * shownW, sy = fy * shownH; // from the top left as shown
        switch (rot) {
          case 90: return { x: box.x + sy, y: box.y + sx };
          case 180: return { x: box.x + box.width - sx, y: box.y + sy };
          case 270: return { x: box.x + box.width - sy, y: box.y + box.height - sx };
          default: return { x: box.x + sx, y: box.y + box.height - sy };
        }
      };
      for (const it of plan.items) {
        if (it.page !== idx || it.kind === "box") continue;
        if (it.kind === "text" && it.text?.trim()) {
          const size = it.size ?? 14;
          const lines = it.text.split("\n");
          lines.forEach((line, n) => {
            const o = at(it.x, it.y + ((n + 0.8) * size * 1.2) / shownH);
            page.drawText(line, { x: o.x, y: o.y, size, font, color: rgb(0.07, 0.07, 0.09), rotate: degrees(rot) });
          });
        } else if (it.kind === "sign" && it.image) {
          const png = await out.embedPng(dataUrlBytes(it.image));
          const o = at(it.x, it.y + it.h);
          page.drawImage(png, { x: o.x, y: o.y, width: it.w * shownW, height: it.h * shownH, rotate: degrees(rot) });
        }
      }
      if (plan.watermark?.trim()) {
        const text = plan.watermark.trim().slice(0, 60);
        const size = Math.min(72, (Math.hypot(shownW, shownH) * 0.75) / Math.max(1, bold.widthOfTextAtSize(text, 1)));
        const tw = bold.widthOfTextAtSize(text, size);
        const angle = Math.atan2(shownH, shownW);
        const cx = shownW / 2 - (Math.cos(angle) * tw) / 2, cy = shownH / 2 + (Math.sin(angle) * tw) / 2 - size / 3;
        const o = at(cx / shownW, cy / shownH);
        page.drawText(text, { x: o.x, y: o.y, size, font: bold, color: rgb(0.55, 0.55, 0.6), opacity: 0.28, rotate: degrees(rot + (angle * 180) / Math.PI) });
      }
      const turn = plan.turn[idx] ?? 0;
      if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    }
  } finally {
    void viewTask?.destroy();
  }
  onStep?.(0.95);
  const name = file.name.replace(/\.pdf$/i, "") + "-edited.pdf";
  let result = new File([(await out.save()).slice().buffer], name, { type: "application/pdf" });
  if (plan.numbers) result = new File([await numberPdf(result)], name, { type: "application/pdf" });
  onStep?.(1);
  return result;
}
