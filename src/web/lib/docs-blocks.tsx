/**
 * R32: the editable side of the doc blocks: the callout's icon (click to change the variant),
 * pasting or dropping images (uploaded, or inserted by link), and the editor extension list used
 * by the doc page and the meeting notes. The schema itself is in docs-blocks-schema.ts.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { IconCheckCircle, IconInfo, IconOctagonAlert, IconWarning, type IconComponent } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { Callout, CALLOUT_LABELS, calloutVariant, nextCalloutVariant, type CalloutVariant } from "./docs-callout";
import { docBlockSchemaExtensions, imageDim, isSafeImageSrc, looksLikeImageUrl } from "./docs-blocks-schema";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export const CALLOUT_ICONS: Record<CalloutVariant, IconComponent> = { info: IconInfo, success: IconCheckCircle, warning: IconWarning, danger: IconOctagonAlert };

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant = calloutVariant(node.attrs.variant);
  const Icon = CALLOUT_ICONS[variant];
  const next = nextCalloutVariant(variant);
  return (
    <NodeViewWrapper as="div" className="mm-callout" data-callout={variant} role="note">
      <button type="button" contentEditable={false} className="mm-callout-icon" data-testid="callout-icon"
        aria-label={`${CALLOUT_LABELS[variant]} callout. Change to ${CALLOUT_LABELS[next]}`} title={`Change to ${CALLOUT_LABELS[next]}`}
        disabled={!editor.isEditable}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => updateAttributes({ variant: next })}>
        <Icon className="h-4 w-4" aria-hidden />
      </button>
      <NodeViewContent className="mm-callout-body" />
    </NodeViewWrapper>
  );
}

const EditableCallout = Callout.extend({ addNodeView() { return ReactNodeViewRenderer(CalloutView); } });

// ---------------------------------------------------------------- images: upload, paste, drop

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Largest image kept inline in the doc when the workspace has no file storage. */
export const INLINE_IMAGE_LIMIT = 450_000;
const MAX_EDGE = 2000;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}

/** Large photos are scaled to 2000 px on the long edge (gifs are kept so they still move). */
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif" || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.85));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}

/**
 * Uploads an image for a doc and returns its src: our own same origin path when the workspace has
 * file storage, else the image inline (up to 450 KB). Throws a readable error otherwise.
 */
export async function uploadDocImage(docId: string, file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Use a PNG, JPEG, GIF or WebP image.");
  const blob = await shrink(file);
  const dataUrl = await readAsDataUrl(blob);
  try {
    const r = await api.post<{ src: string }>("/doc-images", { docId, filename: file.name || "image", contentType: blob.type || file.type, contentBase64: dataUrl.split(",")[1] ?? "" });
    return r.src;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 503 && e.code === "uploads_unavailable")) throw e;
    if (blob.size > INLINE_IMAGE_LIMIT) throw new Error("This workspace keeps images in the doc itself, up to 450 KB. Try a smaller image or paste a link.", { cause: e });
    return dataUrl;
  }
}

export type ImageUploader = (file: File) => Promise<string>;

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => IMAGE_TYPES.includes(f.type));
}

// ---------------------------------------------------------------- R33: image sizes

export interface ImageDims { width: number; height: number }

/** The natural size of an image source (a link, our upload path or a local file's object URL); null if it does not load in time. */
export function measureImage(src: string, timeoutMs = 4000): Promise<ImageDims | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => { clearTimeout(t); const width = imageDim(img.naturalWidth); const height = imageDim(img.naturalHeight); resolve(width && height ? { width, height } : null); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.referrerPolicy = "no-referrer";
    img.src = src;
  });
}

async function measureFile(f: File): Promise<ImageDims | null> {
  if (typeof URL === "undefined" || !URL.createObjectURL) return null;
  const url = URL.createObjectURL(f);
  try { return await measureImage(url); } finally { URL.revokeObjectURL(url); }
}

/** Image nodes with no stored size whose size is now known: [position, size] pairs for the next edit to save. */
export function imagesToSize(doc: PmNode, measured: Map<string, ImageDims>): [number, ImageDims][] {
  const out: [number, ImageDims][] = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== "image") return true;
    const dims = !imageDim(n.attrs.width) || !imageDim(n.attrs.height) ? measured.get(String(n.attrs.src ?? "")) : undefined;
    if (dims) out.push([pos, dims]);
    return false;
  });
  return out;
}

/** Writes the measured sizes into a transaction (no history entry). Returns false when there was nothing to write. */
export function applyImageSizes(tr: Transaction, measured: Map<string, ImageDims>): boolean {
  const todo = imagesToSize(tr.doc, measured);
  for (const [pos, d] of todo) {
    const node = tr.doc.nodeAt(pos);
    if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: d.width, height: d.height });
  }
  if (todo.length) tr.setMeta("addToHistory", false).setMeta(IMAGE_SIZES_META, true);
  return todo.length > 0;
}
const IMAGE_SIZES_META = "mmImageSizes";

/**
 * Older images have no stored size. Viewing a doc never writes: the editor notes each loaded image's size
 * and saves it with the person's next real edit (appendTransaction), so the next open reserves the box.
 */
export function imageSizePlugin(): Plugin {
  const measured = new Map<string, ImageDims>();
  return new Plugin({
    key: new PluginKey("docImageSizes"),
    view(view) {
      const onLoad = (e: Event) => {
        const img = e.target as HTMLImageElement | null;
        if (!img || img.tagName !== "IMG" || !img.classList.contains("mm-doc-img") || img.hasAttribute("width")) return;
        const width = imageDim(img.naturalWidth); const height = imageDim(img.naturalHeight);
        const src = img.getAttribute("src");
        if (width && height && src && measured.size < 500) measured.set(src, { width, height });
      };
      view.dom.addEventListener("load", onLoad, true);
      return { destroy: () => view.dom.removeEventListener("load", onLoad, true) };
    },
    appendTransaction(trs, _old, state) {
      if (!measured.size || !trs.some((t) => t.docChanged && !t.getMeta(IMAGE_SIZES_META) && !t.getMeta("y-sync$"))) return null;
      const tr = state.tr;
      return applyImageSizes(tr, measured) ? tr : null;
    },
  });
}

async function insertFiles(view: EditorView, files: File[], pos: number | null, upload: ImageUploader, onError: (e: Error) => void) {
  for (const f of files) {
    try {
      const [src, dims] = await Promise.all([upload(f), measureFile(f)]);
      if (!isSafeImageSrc(src)) continue;
      const type = view.state.schema.nodes.image;
      const node = type.create({ src, ...(dims ?? {}), alt: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").slice(0, 120) || null });
      const at = pos ?? view.state.selection.from;
      view.dispatch(view.state.tr.insert(Math.min(at, view.state.doc.content.size), node));
    } catch (e) { onError(e as Error); }
  }
}

/** Paste or drop an image file (uploaded), or paste a link to an image (inserted as an image). */
export const DocImagePaste = Extension.create<{ upload: ImageUploader | null; onError: (e: Error) => void }>({
  name: "docImagePaste",
  addOptions() { return { upload: null, onError: () => {} }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [imageSizePlugin(), new Plugin({
      key: new PluginKey("docImagePaste"),
      props: {
        handlePaste(view, event) {
          const files = imageFiles(event.clipboardData?.files);
          if (files.length && opts.upload) { event.preventDefault(); void insertFiles(view, files, null, opts.upload, opts.onError); return true; }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!event.clipboardData?.getData("text/html") && looksLikeImageUrl(text)) {
            const node = view.state.schema.nodes.image.create({ src: text.trim(), alt: null });
            view.dispatch(view.state.tr.replaceSelectionWith(node));
            // R33: the size is saved with the next edit once it loads (imageSizePlugin).
            return true;
          }
          return false;
        },
        handleDrop(view, event, _slice, moved) {
          if (moved || !opts.upload) return false;
          const files = imageFiles((event as DragEvent).dataTransfer?.files);
          if (!files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
          void insertFiles(view, files, at?.pos ?? null, opts.upload, opts.onError);
          return true;
        },
      },
    })];
  },
});

/** The editable blocks for a doc editor. Same schema as docBlockSchemaExtensions(), plus views and paste handling. */
export function docBlockExtensions(opts: { upload?: ImageUploader | null; onError?: (e: Error) => void } = {}) {
  const [table, image] = docBlockSchemaExtensions();
  return [table, image, EditableCallout, DocImagePaste.configure({ upload: opts.upload ?? null, onError: opts.onError ?? (() => {}) })];
}
