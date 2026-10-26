/**
 * R32: the extra doc blocks (table, image, callout) as schema only. The doc editor, the meeting
 * notes, the guest view and the server's shape test all build from this one list, so a doc with a
 * table opens everywhere and the shared (Yjs) document has the same schema on every client.
 * The editable views (table menu, image toolbar, callout icon) are added in docs-blocks.tsx.
 */
import { mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { Callout } from "./docs-callout";

export const IMAGE_SIZES = ["fit", "wide", "full"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const IMAGE_SIZE_LABELS: Record<ImageSize, string> = { fit: "Fit", wide: "Wide", full: "Full width" };

/** Same origin doc image uploads (doc-images-r32.ts) are served from here. */
export const DOC_IMAGE_PATH = "/api/doc-images/";
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

/** True for an image source the doc may hold: https, our own upload path, or inline png/jpeg/gif/webp data. Never svg or javascript. */
export function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== "string" || src.length > 700_000) return false;
  const s = [...src].filter((ch) => ch.charCodeAt(0) > 0x20).join("");
  if (s.startsWith(DOC_IMAGE_PATH)) return /^\/api\/doc-images\/[A-Za-z0-9_-]+$/.test(s);
  if (/^data:/i.test(s)) return DATA_IMAGE.test(s);
  try { return new URL(s).protocol === "https:"; } catch { return false; }
}

/** A pasted line that is just an https link to an image file. */
export function looksLikeImageUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === "https:" && /\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname);
  } catch { return false; }
}

export function imageSize(v: unknown): ImageSize {
  return (IMAGE_SIZES as readonly string[]).includes(v as string) ? (v as ImageSize) : "fit";
}

/** Block images with alt text and a size (fit, wide, full). Unsafe sources are not rendered. */
export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      size: {
        default: "fit",
        parseHTML: (el: HTMLElement) => imageSize(el.getAttribute("data-size")),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-size": imageSize(attrs.size) }),
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (!isSafeImageSrc(attrs.src)) delete attrs.src;
    return ["img", mergeAttributes({ class: "mm-doc-img", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }, this.options.HTMLAttributes, attrs)];
  },
}).configure({ inline: false, allowBase64: true });

/** The schema extensions for the three blocks, in a fixed order. */
export function docBlockSchemaExtensions() {
  return [
    TableKit.configure({ table: { resizable: false, HTMLAttributes: { class: "mm-table" } } }),
    DocImage,
    Callout,
  ];
}
