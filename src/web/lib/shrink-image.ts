/**
 * SOCFIX: shrinks a picked photo in the browser so it fits every network (and the stored limit) before upload.
 * Canvas only (no library, no new host). EXIF orientation is applied by the browser when it decodes; a browser that
 * does not is caught by comparing the stored JPEG size with the decoded one and turned by hand.
 */

import { encodeUnder, fitSize, jpegInfo, orientedSize, photoBudget, photoNote, SOCIAL_PHOTO_INPUT_MAX, SOCIAL_PHOTO_TYPES } from "@/shared/social-image";

export interface ShrunkPhoto { src: string; w: number; h: number; contentType: string; dataB64: string; bytes: number; note: string | null }

const UNREADABLE = "That photo could not be read here. Save it as a JPEG or PNG and try again.";

function typeOf(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t) return t;
  return /\.hei[cf]$/i.test(file.name) ? "image/heic" : "";
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error(UNREADABLE)); r.readAsDataURL(blob); });
}

type Decoded = { source: CanvasImageSource; w: number; h: number; close: () => void };

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bm = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bm, w: bm.width, h: bm.height, close: () => bm.close() };
    } catch { /* fall back to an image element */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(UNREADABLE)); i.src = url; });
    if (img.decode) await img.decode().catch(() => undefined);
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) { URL.revokeObjectURL(url); throw e; }
}

/** Reads, turns upright and shrinks one photo. Throws plain words only when the file truly cannot be read. */
export async function shrinkPhoto(file: File, apps?: readonly string[]): Promise<ShrunkPhoto> {
  const type = typeOf(file);
  if (!(SOCIAL_PHOTO_TYPES as readonly string[]).includes(type)) throw new Error("Use a photo: JPEG, PNG, WebP or HEIC.");
  if (file.size > SOCIAL_PHOTO_INPUT_MAX) throw new Error("That photo is over 40 MB. Pick a smaller one.");
  const budget = photoBudget(apps);
  const head = type === "image/jpeg" ? jpegInfo(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())) : null;
  const dec = await decode(file).catch(() => { throw new Error(type.includes("hei") ? "This browser can't open HEIC photos. Save it as a JPEG and try again." : UNREADABLE); });
  try {
    if (!(dec.w > 0 && dec.h > 0)) throw new Error(UNREADABLE);
    // A browser that ignored a quarter turn shows the stored (sideways) size; turn it by hand.
    const turn = head && head.orientation >= 5 && head.w !== head.h && dec.w === head.w && dec.h === head.h ? head.orientation : 1;
    const upright = orientedSize(dec.w, dec.h, turn);
    const small = (type === "image/jpeg" || type === "image/png") && file.size <= budget.bytes && Math.max(upright.w, upright.h) <= budget.edge && (head?.orientation ?? 1) === 1;
    if (small) {
      const src = await toDataUrl(file);
      return { src, w: upright.w, h: upright.h, contentType: type, dataB64: src.slice(src.indexOf(",") + 1), bytes: file.size, note: null };
    }
    const size = fitSize(upright.w, upright.h, budget.edge);
    const canvas = document.createElement("canvas");
    const draw = (w: number, h: number) => {
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(UNREADABLE);
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // a see through PNG gets a white back (JPEG has no transparency)
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      if (turn >= 5) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate(turn === 6 || turn === 5 ? Math.PI / 2 : -Math.PI / 2);
        if (turn === 5 || turn === 7) ctx.scale(-1, 1);
        ctx.drawImage(dec.source, -h / 2, -w / 2, h, w);
      } else ctx.drawImage(dec.source, 0, 0, w, h);
    };
    let drawn = "";
    const r = await encodeUnder(size.w, size.h, budget.bytes, async (w, h, q) => {
      if (drawn !== `${w}x${h}`) { draw(w, h); drawn = `${w}x${h}`; }
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
      if (!blob) throw new Error(UNREADABLE);
      return { blob, bytes: blob.size };
    });
    canvas.width = 0; canvas.height = 0;
    const src = await toDataUrl(r.out.blob);
    return { src, w: r.w, h: r.h, contentType: "image/jpeg", dataB64: src.slice(src.indexOf(",") + 1), bytes: r.out.bytes, note: photoNote(file.size, r.out.bytes, true) };
  } finally { dec.close(); }
}
