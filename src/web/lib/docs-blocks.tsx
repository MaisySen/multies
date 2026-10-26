/**
 * R32: the editable side of the doc blocks: the callout's icon (click to change the variant),
 * pasting or dropping images (uploaded, or inserted by link), and the editor extension list used
 * by the doc page and the meeting notes. The schema itself is in docs-blocks-schema.ts.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";
import { Callout, CALLOUT_LABELS, calloutVariant, nextCalloutVariant, type CalloutVariant } from "./docs-callout";
import { docBlockSchemaExtensions, isSafeImageSrc, looksLikeImageUrl } from "./docs-blocks-schema";

export const CALLOUT_ICONS: Record<CalloutVariant, typeof Info> = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: OctagonAlert };

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

async function insertFiles(view: EditorView, files: File[], pos: number | null, upload: ImageUploader, onError: (e: Error) => void) {
  for (const f of files) {
    try {
      const src = await upload(f);
      if (!isSafeImageSrc(src)) continue;
      const type = view.state.schema.nodes.image;
      const node = type.create({ src, alt: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").slice(0, 120) || null });
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
    return [new Plugin({
      key: new PluginKey("docImagePaste"),
      props: {
        handlePaste(view, event) {
          const files = imageFiles(event.clipboardData?.files);
          if (files.length && opts.upload) { event.preventDefault(); void insertFiles(view, files, null, opts.upload, opts.onError); return true; }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!event.clipboardData?.getData("text/html") && looksLikeImageUrl(text)) {
            const node = view.state.schema.nodes.image.create({ src: text.trim(), alt: null });
            view.dispatch(view.state.tr.replaceSelectionWith(node));
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
