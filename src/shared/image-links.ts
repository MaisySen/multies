/**
 * R100b image links: the URL params of the image service (/api/img/doc/:id and /api/img/file/:id), parsed,
 * capped and written back in one canonical order so equal requests share one cache entry. Pure: no DOM, no network.
 */
export const IMAGE_FITS = ["inside", "cover", "contain", "fill"] as const;
export const IMAGE_CROPS = ["smart", "center", "top", "bottom", "left", "right"] as const;
export const IMAGE_FORMATS = ["auto", "webp", "jpeg", "png"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];
export type ImageCrop = (typeof IMAGE_CROPS)[number];
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export type ImageSource = "doc" | "file";

/** The biggest edge the service makes, and the biggest source it reads. */
export const IMAGE_MAX_EDGE = 4096;
export const IMAGE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_QUALITY = { min: 30, max: 95, default: 82 } as const;

export interface ImageParams { w: number; h: number; fit: ImageFit; crop: ImageCrop; fmt: ImageFormat; q: number; area: [number, number, number, number] | null }
export const DEFAULT_IMAGE_PARAMS: ImageParams = { w: 0, h: 0, fit: "inside", crop: "center", fmt: "auto", q: IMAGE_QUALITY.default, area: null };

export class ImageParamError extends Error {}

const KEYS = ["w", "h", "fit", "crop", "fmt", "q", "area"] as const;
const int = (raw: string, name: string, min: number, max: number): number => {
  if (!/^\d{1,5}$/.test(raw)) throw new ImageParamError(`${name} must be a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ImageParamError(`${name} must be between ${min} and ${max}.`);
  return n;
};

/** Reads w, h, fit, crop, fmt, q and area. Unknown params are refused so a typo never serves the original by surprise. */
export function parseImageParams(q: URLSearchParams | Record<string, string | undefined>): ImageParams {
  const get = (k: string): string | undefined => (q instanceof URLSearchParams ? (q.get(k) ?? undefined) : q[k]);
  if (q instanceof URLSearchParams) {
    for (const k of q.keys()) if (!(KEYS as readonly string[]).includes(k)) throw new ImageParamError(`Unknown setting: ${k.slice(0, 20)}.`);
  }
  const p: ImageParams = { ...DEFAULT_IMAGE_PARAMS };
  const w = get("w"), h = get("h"), fit = get("fit"), crop = get("crop"), fmt = get("fmt"), qq = get("q"), area = get("area");
  if (w) p.w = int(w, "Width", 0, IMAGE_MAX_EDGE);
  if (h) p.h = int(h, "Height", 0, IMAGE_MAX_EDGE);
  if (fit) { if (!(IMAGE_FITS as readonly string[]).includes(fit)) throw new ImageParamError("Fit must be inside, cover, contain or fill."); p.fit = fit as ImageFit; }
  if (crop) { if (!(IMAGE_CROPS as readonly string[]).includes(crop)) throw new ImageParamError("Crop must be smart, center, top, bottom, left or right."); p.crop = crop as ImageCrop; }
  if (fmt) { if (!(IMAGE_FORMATS as readonly string[]).includes(fmt)) throw new ImageParamError("Format must be auto, webp, jpeg or png."); p.fmt = fmt as ImageFormat; }
  if (qq) p.q = int(qq, "Quality", IMAGE_QUALITY.min, IMAGE_QUALITY.max);
  if (area) {
    const parts = area.split(",");
    if (parts.length !== 4) throw new ImageParamError("Crop area must be four numbers: x, y, width, height.");
    const [x, y, aw, ah] = parts.map((s, i) => int(s.trim(), ["Crop x", "Crop y", "Crop width", "Crop height"][i], i < 2 ? 0 : 1, 20000));
    p.area = [x, y, aw, ah];
  }
  if ((p.fit === "cover" || p.fit === "fill" || p.fit === "contain") && !(p.w && p.h)) {
    if (p.w || p.h) throw new ImageParamError("Cover, contain and fill need both a width and a height.");
  }
  return p;
}

/** The params in one fixed order with defaults left out: the cache key and the link people copy. */
export function canonicalImageQuery(p: ImageParams): string {
  const out: string[] = [];
  if (p.w) out.push(`w=${p.w}`);
  if (p.h) out.push(`h=${p.h}`);
  if (p.fit !== DEFAULT_IMAGE_PARAMS.fit) out.push(`fit=${p.fit}`);
  if (p.fit === "cover" && p.crop !== DEFAULT_IMAGE_PARAMS.crop) out.push(`crop=${p.crop}`);
  if (p.fmt !== DEFAULT_IMAGE_PARAMS.fmt) out.push(`fmt=${p.fmt}`);
  if (p.q !== DEFAULT_IMAGE_PARAMS.q && p.fmt !== "png") out.push(`q=${p.q}`);
  if (p.area) out.push(`area=${p.area.join(",")}`);
  return out.join("&");
}

export function imageLink(source: ImageSource, id: string, p: ImageParams): string {
  const q = canonicalImageQuery(p);
  return `/api/img/${source}/${encodeURIComponent(id)}${q ? `?${q}` : ""}`;
}

/** The engine's option names for the params. */
export function engineImageOptions(p: ImageParams): Record<string, string> {
  const o: Record<string, string> = { w: String(p.w), h: String(p.h), fit: p.fit, gravity: p.crop, format: p.fmt, quality: String(p.q) };
  if (p.area) o.area = p.area.join(",");
  return o;
}

/** Reads a Multies image address someone pasted (a doc image, an image link or a mail attachment link). */
export function readImageAddress(raw: string): { source: ImageSource; id: string; params: ImageParams } | null {
  let u: URL;
  try { u = new URL(raw.trim(), "https://app.invalid"); } catch { return null; }
  const m = u.pathname.match(/^\/api\/(?:img\/(doc|file)|(doc-images)|mail\/attachments)\/([A-Za-z0-9_-]{1,80})\/?$/);
  if (!m) return null;
  const source: ImageSource = m[1] ? (m[1] as ImageSource) : m[2] ? "doc" : "file";
  let params = DEFAULT_IMAGE_PARAMS;
  if (m[1]) { try { params = parseImageParams(u.searchParams); } catch { params = DEFAULT_IMAGE_PARAMS; } }
  return { source, id: m[3], params };
}
