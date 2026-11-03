/**
 * SOCFIX: photos for social posts. A phone photo (often 3 to 15 MB, sometimes HEIC or WebP) is shrunk in the browser
 * to fit every network before it is uploaded, so a normal photo never meets a size error. Pure rules here (sizes,
 * EXIF orientation, the quality steps); the canvas work is in src/web/lib/shrink-image.ts. No I/O, so it is unit tested.
 */

import { SOCIAL_IMAGE_MAX_BYTES } from "./integrations";

/** Largest photo the picker takes before shrinking it (a 48 MP phone photo is about 12 to 25 MB). */
export const SOCIAL_PHOTO_INPUT_MAX = 40 * 1024 * 1024;
/** Types the picker offers. HEIC and HEIF open only where the browser can decode them (Safari). */
export const SOCIAL_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
export const SOCIAL_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

/** Each network's own published still image limit (bytes) and longest side we send (pixels). */
export const NETWORK_IMAGE_LIMITS: Record<string, { bytes: number; edge: number }> = {
  facebook: { bytes: 4 * 1024 * 1024, edge: 2048 },
  instagram: { bytes: 8 * 1024 * 1024, edge: 1440 },
  linkedin: { bytes: 5 * 1024 * 1024, edge: 2048 },
  pinterest: { bytes: 20 * 1024 * 1024, edge: 2048 },
  reddit: { bytes: 20 * 1024 * 1024, edge: 2048 },
  threads: { bytes: 8 * 1024 * 1024, edge: 1440 },
  testnet: { bytes: 4 * 1024 * 1024, edge: 2048 },
};

/**
 * What one photo is shrunk to: under the tightest of the stored limit and every network's limit, and no longer
 * than 2048 px on its longest side (sharp on every network's feed; Instagram and Threads scale to 1440 themselves).
 * A little headroom under the byte limit leaves room for the upload's own framing.
 */
export function photoBudget(apps: readonly string[] = Object.keys(NETWORK_IMAGE_LIMITS)): { bytes: number; edge: number } {
  let bytes = SOCIAL_IMAGE_MAX_BYTES;
  for (const a of apps) { const l = NETWORK_IMAGE_LIMITS[a]; if (l) bytes = Math.min(bytes, l.bytes); }
  return { bytes: Math.floor(bytes * 0.96), edge: 2048 };
}

/** Width and height that fit inside edge on the longest side, aspect kept, never upscaled. */
export function fitSize(w: number, h: number, edge: number): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 1, h: 1 };
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** EXIF orientations 5 to 8 turn the picture a quarter, so width and height swap. */
export function orientedSize(w: number, h: number, orientation: number): { w: number; h: number } {
  return orientation >= 5 && orientation <= 8 ? { w: h, h: w } : { w, h };
}

/** Reads a JPEG's stored size (SOF) and EXIF orientation (1 when absent) from its first bytes. */
export function jpegInfo(b: Uint8Array): { w: number; h: number; orientation: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2; let orientation = 1; let w = 0; let h = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) break;
    if (marker === 0xe1 && i + 10 <= b.length && String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif") orientation = exifOrientation(b, i + 10, i + 2 + len) ?? orientation;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && i + 9 <= b.length) {
      h = (b[i + 5]! << 8) | b[i + 6]!; w = (b[i + 7]! << 8) | b[i + 8]!;
    }
    i += 2 + len;
  }
  return w && h ? { w, h, orientation } : null;
}

function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (start + 8 > end || end > b.length) return null;
  const le = b[start] === 0x49;
  const u16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
  const u32 = (p: number) => (le ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)) + b[p + 3]! * 16777216 : b[p]! * 16777216 + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!));
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return null;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : null; }
  }
  return null;
}

/** Quality steps tried in turn, best first; the size steps down after the last one. */
export const PHOTO_QUALITIES = [0.88, 0.8, 0.72, 0.64, 0.56] as const;

/**
 * Finds the best encoding under the byte budget: quality first, then 85 % of the size, until it fits or the photo is
 * 320 px. encode is the canvas (or a stand in for tests) and answers the encoded byte length for a size and quality.
 */
export async function encodeUnder<T extends { bytes: number }>(
  w: number, h: number, budget: number, encode: (w: number, h: number, quality: number) => Promise<T>,
): Promise<{ out: T; w: number; h: number; quality: number }> {
  let cw = w; let ch = h; let last: { out: T; w: number; h: number; quality: number } | null = null;
  for (let round = 0; round < 12; round++) {
    for (const q of PHOTO_QUALITIES) {
      const out = await encode(cw, ch, q);
      last = { out, w: cw, h: ch, quality: q };
      if (out.bytes <= budget) return last;
    }
    if (Math.max(cw, ch) <= 320) break;
    cw = Math.max(1, Math.round(cw * 0.85)); ch = Math.max(1, Math.round(ch * 0.85));
  }
  throw new Error("That photo could not be made small enough. Try another one.");
}

/** Plain words for the picker: what happened to the photo. */
export function photoNote(fromBytes: number, toBytes: number, resized: boolean): string | null {
  if (!resized) return null;
  const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return `Optimised for posting, ${mb(fromBytes)} to ${mb(toBytes)}`;
}
