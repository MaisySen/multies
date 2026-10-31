/** R89: saving a drawing as a file (PNG, SVG, PDF) from the browser. */

export function safeName(title: string, ext: string) {
  const base = (title || "drawing").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "drawing";
  return `${base}.${ext}`;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function svgBlob(svg: string | SVGSVGElement) {
  const text = typeof svg === "string" ? svg : new XMLSerializer().serializeToString(svg);
  return new Blob([text.startsWith("<?xml") ? text : `<?xml version="1.0" encoding="UTF-8"?>\n${text}`], { type: "image/svg+xml" });
}

/** Draws an SVG onto a canvas at `scale` and returns a PNG, with an optional solid background. */
export async function svgToPng(svg: string, opts: { scale?: number; background?: string } = {}): Promise<Blob> {
  const scale = opts.scale ?? 2;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  const vb = (el.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const w = Number.parseFloat(el.getAttribute("width") ?? "") || vb[2] || 800;
  const h = Number.parseFloat(el.getAttribute("height") ?? "") || vb[3] || 600;
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(el)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Could not draw the image.")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const c = canvas.getContext("2d");
    if (!c) throw new Error("Could not draw the image.");
    if (opts.background) { c.fillStyle = opts.background; c.fillRect(0, 0, canvas.width, canvas.height); }
    c.scale(scale, scale);
    c.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not draw the image.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A one page PDF holding the PNG, sized to the picture (pdf-lib, already used by the PDF tools). */
export async function pngToPdf(png: Blob, widthPx: number, heightPx: number): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()));
  const w = widthPx * 0.75, h = heightPx * 0.75; // px to pt
  const page = pdf.addPage([w + 48, h + 48]);
  page.drawImage(img, { x: 24, y: 24, width: w, height: h });
  const bytes = await pdf.save();
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}
