/**
 * R32: small floating menus for the doc blocks. The table menu shows above a table while the caret
 * is in it (rows, columns, header row, delete); the image bar shows above a selected image (size,
 * alt text, delete); the image dialog inserts by link or upload. Every action is one local editor
 * command, so in a live doc the others see the result through the shared document.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import {
  BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Captions, Maximize2, Minimize2,
  MoveHorizontal, PanelTop, TableColumnsSplit, TableRowsSplit, Trash2, Upload, X,
} from "lucide-react";
import { cn } from "@/web/lib/cn";
import { IMAGE_SIZE_LABELS, imageSize, isSafeImageSrc, type ImageSize } from "@/web/lib/docs-blocks-schema";
import type { ImageUploader } from "@/web/lib/docs-blocks";

/** Re-renders on every editor transaction (selection moves included). */
function useEditorTick(editor: Editor | null) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const on = () => set((n) => n + 1);
    editor.on("transaction", on);
    return () => { editor.off("transaction", on); };
  }, [editor]);
}

function MenuButton({ label, on, active, children, danger }: { label: string; on: () => void; active?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} onClick={on}
      className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-muted transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 [&_svg]:h-3.5 [&_svg]:w-3.5",
        active && "bg-brand/10 text-brand", danger && "hover:text-bad")}>
      {children}
    </button>
  );
}

const BAR = "fixed z-30 flex animate-pop-in items-center gap-0.5 rounded-lg border border-line bg-elevated p-0.5 shadow-pop motion-reduce:animate-none";

/** The DOM element of the nearest ancestor node of that type around the selection. */
function ancestorDom(editor: Editor, type: string): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === type) {
      const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null;
      return dom ? (dom.closest?.("table") ?? dom.querySelector?.("table") ?? dom) : null;
    }
  }
  return null;
}

function place(rect: DOMRect, width: number) {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.top > 52 ? rect.top - 40 : rect.bottom + 6;
  return { left, top };
}

export function TableMenu({ editor }: { editor: Editor | null }) {
  useEditorTick(editor);
  if (!editor || !editor.isEditable || !editor.isFocused || !editor.isActive("table")) return null;
  const el = ancestorDom(editor, "table");
  if (!el) return null;
  const c = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Table" data-testid="table-menu" className={BAR} style={place(el.getBoundingClientRect(), 300)}>
      <MenuButton label="Add row above" on={() => c().addRowBefore().run()}><BetweenHorizontalStart /></MenuButton>
      <MenuButton label="Add row below" on={() => c().addRowAfter().run()}><BetweenHorizontalEnd /></MenuButton>
      <MenuButton label="Add column left" on={() => c().addColumnBefore().run()}><BetweenVerticalStart /></MenuButton>
      <MenuButton label="Add column right" on={() => c().addColumnAfter().run()}><BetweenVerticalEnd /></MenuButton>
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <MenuButton label="Delete row" on={() => c().deleteRow().run()}><TableRowsSplit /></MenuButton>
      <MenuButton label="Delete column" on={() => c().deleteColumn().run()}><TableColumnsSplit /></MenuButton>
      <MenuButton label="Header row" on={() => c().toggleHeaderRow().run()}><PanelTop /></MenuButton>
      <MenuButton label="Delete table" danger on={() => c().deleteTable().run()}><Trash2 /></MenuButton>
    </div>
  );
}

const SIZE_ICONS: Record<ImageSize, typeof Minimize2> = { fit: Minimize2, wide: MoveHorizontal, full: Maximize2 };

export function ImageToolbar({ editor }: { editor: Editor | null }) {
  useEditorTick(editor);
  const [altOpen, setAltOpen] = useState(false);
  const sel = editor?.state.selection;
  const isImage = !!editor && editor.isEditable && sel instanceof NodeSelection && sel.node.type.name === "image";
  const pos = isImage ? (sel as NodeSelection).from : -1;
  useEffect(() => { setAltOpen(false); }, [pos]);
  if (!editor || !isImage) return null;
  const node = (sel as NodeSelection).node;
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  if (!dom) return null;
  const size = imageSize(node.attrs.size);
  const set = (attrs: Record<string, unknown>) => editor.chain().setNodeSelection(pos).updateAttributes("image", attrs).run();
  return (
    <div role="toolbar" aria-label="Image" data-testid="image-toolbar" className={BAR} style={place(dom.getBoundingClientRect(), 340)}>
      {(Object.keys(IMAGE_SIZE_LABELS) as ImageSize[]).map((s) => {
        const Icon = SIZE_ICONS[s];
        return <MenuButton key={s} label={IMAGE_SIZE_LABELS[s]} active={size === s} on={() => set({ size: s })}><Icon /></MenuButton>;
      })}
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      {altOpen ? (
        <AltInput initial={typeof node.attrs.alt === "string" ? node.attrs.alt : ""} onDone={(alt) => { set({ alt: alt.trim() || null }); setAltOpen(false); }} />
      ) : (
        <MenuButton label={node.attrs.alt ? `Alt text: ${node.attrs.alt}` : "Add alt text"} on={() => setAltOpen(true)}>
          <Captions /><span className="ml-1 text-[12px]">{node.attrs.alt ? "Alt" : "Add alt"}</span>
        </MenuButton>
      )}
      <MenuButton label="Delete image" danger on={() => editor.chain().focus().deleteSelection().run()}><Trash2 /></MenuButton>
    </div>
  );
}

function AltInput({ initial, onDone }: { initial: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input autoFocus aria-label="Alt text" data-testid="image-alt-input" value={v} maxLength={300} placeholder="Describe the image"
      onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(v); } if (e.key === "Escape") onDone(initial); }}
      className="h-7 w-48 rounded-md border border-line bg-surface px-2 text-[12.5px] outline-none focus:ring-2 focus:ring-brand/60" />
  );
}

/** Insert an image by link or upload, with alt text. */
export function ImageInsertDialog({ editor, open, onClose, upload }: { editor: Editor | null; open: boolean; onClose: () => void; upload: ImageUploader | null }) {
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setUrl(""); setAlt(""); setErr(null); setBusy(false); setTimeout(() => urlRef.current?.focus(), 0); } }, [open]);
  if (!open || !editor) return null;
  const insert = (src: string) => {
    editor.chain().focus().insertContent({ type: "image", attrs: { src, alt: alt.trim() || null } }).run();
    onClose();
  };
  const fromUrl = () => {
    const s = url.trim();
    if (!isSafeImageSrc(s) || s.startsWith("data:")) { setErr("Use an https link to an image."); return; }
    insert(s);
  };
  const fromFile = async (f: File | undefined) => {
    if (!f || !upload) return;
    setBusy(true); setErr(null);
    try { insert(await upload(f)); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh] backdrop-blur-[1px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="img-dlg-title" data-testid="image-dialog"
        className="w-[min(28rem,calc(100vw-2rem))] animate-pop-in rounded-2xl border border-line bg-elevated p-4 shadow-pop motion-reduce:animate-none"
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
        <div className="mb-3 flex items-center">
          <h2 id="img-dlg-title" className="text-[15px] font-semibold">Add an image</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto rounded p-1 text-muted hover:bg-hover hover:text-fg"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); fromUrl(); }} className="space-y-2.5">
          <label className="block text-[12.5px] text-muted">Image link
            <input ref={urlRef} data-testid="image-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://"
              className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13.5px] text-fg outline-none focus:ring-2 focus:ring-brand/60" />
          </label>
          <label className="block text-[12.5px] text-muted">Alt text (read aloud by screen readers)
            <input data-testid="image-alt" value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image"
              className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13.5px] text-fg outline-none focus:ring-2 focus:ring-brand/60" />
          </label>
          {err && <p role="alert" className="text-[12.5px] text-bad">{err}</p>}
          <div className="flex items-center gap-2 pt-1">
            {upload && (
              <>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label="Upload an image" onChange={(e) => void fromFile(e.target.files?.[0])} />
                <button type="button" disabled={busy} onClick={() => file.current?.click()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-fg hover:bg-hover disabled:opacity-60">
                  <Upload className="h-3.5 w-3.5" aria-hidden />{busy ? "Uploading" : "Upload"}
                </button>
              </>
            )}
            <button type="submit" data-testid="image-insert" disabled={busy || !url.trim()}
              className="ml-auto inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-[13px] font-medium text-white hover:bg-brand/90 disabled:opacity-50">Insert</button>
          </div>
        </form>
      </div>
    </div>
  );
}
