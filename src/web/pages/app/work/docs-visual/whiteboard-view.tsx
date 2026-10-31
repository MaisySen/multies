/**
 * R89: the whiteboard block in a doc (and the whole page of a whiteboard doc). This wrapper is small; the board
 * itself loads in its own chunk once the block comes near the screen, so a doc without a board stays as light as
 * before.
 */
import { Suspense, useCallback, useEffect, useRef, useState, Component, type MutableRefObject, type ReactNode } from "react";
import { lazyPage } from "@/web/components/lazy-page";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IconDownload, IconEye, IconMaximize, IconMinimize, IconShapes } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import type { CollabSession } from "../doc-collab";
import { isDark, useThemeKey } from "./theme";
import { BOARD_ASSET_PATH } from "@/web/lib/board-asset-path";

const loadCanvas = () => {
  // The board's fonts are served from our own origin (copied at build time); main.tsx sets this first, this is a guard.
  if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = BOARD_ASSET_PATH;
  return import("./whiteboard-canvas");
};
const WhiteboardCanvas = lazyPage(loadCanvas, "default", { quiet: true });

export interface VisualOptions {
  session: CollabSession | null;
  readOnly: boolean;
  /** The doc title, for file names. */
  title: () => string;
  user: () => { name: string; color: string };
}

class BoardBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted" role="alert">
        <IconShapes className="h-6 w-6 text-subtle" aria-hidden />
        <p>Could not load the whiteboard.</p>
        <button type="button" className="rounded-md border border-line px-3 py-1.5 font-medium text-fg hover:bg-hover" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}>Try again</button>
      </div>
    );
  }
}

export function BoardSkeleton({ label = "Loading the whiteboard" }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col gap-3 p-4" aria-label={label} aria-busy="true">
      <div className="mx-auto h-10 w-72 max-w-full animate-pulse rounded-lg bg-fill" />
      <div className="flex-1 animate-pulse rounded-lg bg-fill/60" />
    </div>
  );
}

export function WhiteboardView({ node, editor, updateAttributes, extension, selected }: NodeViewProps) {
  const opts = extension.options as VisualOptions;
  const readOnly = !editor.isEditable || opts.readOnly;
  const page = node.attrs.page === true;
  useThemeKey();
  const dark = isDark();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(page);
  const [full, setFull] = useState(false);
  const [retry, setRetry] = useState(0);
  const localExport = useRef<((kind: "png" | "svg") => Promise<void>) | null>(null);
  const exportRef = page ? (pageBoardExport as MutableRefObject<((kind: "png" | "svg") => Promise<void>) | null>) : localExport;

  useEffect(() => {
    if (near || !box.current) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: "400px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("textarea")) setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const onSnapshot = useCallback((scene: string) => {
    if (editor.isDestroyed) return;
    updateAttributes({ scene });
  }, [editor, updateAttributes]);

  const id = typeof node.attrs.id === "string" && node.attrs.id ? node.attrs.id : "board";
  return (
    <NodeViewWrapper as="div" contentEditable={false} data-drag-handle={page ? undefined : ""} data-testid="whiteboard-block" data-board-id={id}
      className={cn("mm-board not-prose relative", page ? "mm-board-page" : "my-3 rounded-xl border border-line bg-surface", full && "mm-board-full", selected && !page && "ring-2 ring-brand")}>
      {!page && (
        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5 text-[12.5px] text-muted">
          <span className="inline-flex items-center gap-1.5 px-1 font-medium text-fg"><IconShapes className="h-4 w-4 text-muted" aria-hidden />Whiteboard</span>
          {readOnly && <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11.5px]" data-testid="board-view-only"><IconEye className="h-3 w-3" aria-hidden />View only</span>}
          <span className="ml-auto" />
          <BoardButton label="Download as PNG" onClick={() => void exportRef.current?.("png")}><IconDownload className="h-3.5 w-3.5" aria-hidden />PNG</BoardButton>
          <BoardButton label="Download as SVG" onClick={() => void exportRef.current?.("svg")}><IconDownload className="h-3.5 w-3.5" aria-hidden />SVG</BoardButton>
          <BoardButton label={full ? "Exit full screen" : "Full screen"} onClick={() => setFull((f) => !f)}>{full ? <IconMinimize className="h-3.5 w-3.5" aria-hidden /> : <IconMaximize className="h-3.5 w-3.5" aria-hidden />}<span className="max-sm:sr-only">{full ? "Exit" : "Full screen"}</span></BoardButton>
        </div>
      )}
      <div ref={box} className={cn("mm-board-canvas", page || full ? "h-full" : "h-[420px] max-sm:h-[360px]")} data-testid="whiteboard-canvas">
        {near ? (
          <BoardBoundary key={retry} onRetry={() => setRetry((n) => n + 1)}>
            <Suspense fallback={<BoardSkeleton />}>
              <WhiteboardCanvas boardId={id} scene={String(node.attrs.scene ?? "[]")} session={opts.session} readOnly={readOnly} dark={dark}
                user={opts.user()} title={opts.title()} onSnapshot={onSnapshot} exportRef={exportRef} />
            </Suspense>
          </BoardBoundary>
        ) : <BoardSkeleton />}
      </div>
    </NodeViewWrapper>
  );
}

function BoardButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center">{children}</button>;
}

/** Exports the page board of a whiteboard doc from the doc's own top bar. */
export const pageBoardExport: { current: ((kind: "png" | "svg") => Promise<void>) | null } = { current: null };
