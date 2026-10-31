/**
 * R89: the editable whiteboard and diagram blocks: the shared schema (docs-visual-schema.ts) plus their live views.
 * The views receive the doc's room and the reader's name and colour through the extension options.
 */
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Diagram, Whiteboard } from "@/web/lib/docs-visual-schema";
import { DiagramView } from "./diagram-view";
import { WhiteboardView, type VisualOptions } from "./whiteboard-view";

/** Events inside a board belong to the board, never to the text editor around it. */
const boardStopEvent = ({ event }: { event: Event }) => {
  const t = event.target as HTMLElement | null;
  return !!t?.closest?.(".mm-board-canvas, .excalidraw, button, [role=menu]");
};

export function docsVisualViewExtensions(opts: Partial<VisualOptions> = {}) {
  const options: VisualOptions = {
    session: opts.session ?? null,
    readOnly: opts.readOnly ?? false,
    title: opts.title ?? (() => "Whiteboard"),
    user: opts.user ?? (() => ({ name: "Someone", color: "#e8590c" })),
  };
  return [
    Whiteboard.extend({
      addOptions() { return options; },
      addNodeView() { return ReactNodeViewRenderer(WhiteboardView, { stopEvent: boardStopEvent, ignoreMutation: () => true }); },
    }),
    Diagram.extend({
      addNodeView() {
        return ReactNodeViewRenderer(DiagramView, {
          stopEvent: ({ event }) => { const t = event.target as HTMLElement | null; return !!t?.closest?.("button, [role=menu], .mm-diagram-svg"); },
        });
      },
    }),
  ];
}
