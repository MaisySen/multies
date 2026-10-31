/**
 * R89: the whiteboard and diagram blocks as schema only (no React, no drawing libraries), so the server's shape
 * test, the guest view and every editor share one schema. The live views (docs-visual-views.tsx) load the
 * drawing libraries only when a block is on screen.
 *
 * whiteboard: an atom. The drawing lives in the shared document while people edit; `scene` is the saved copy
 * (elements as JSON) the leader writes back, so the row, page history and templates carry the board.
 * `page` marks a board that is the whole doc (a whiteboard doc).
 *
 * diagram: the source text of a diagram as the block's own text, so two people typing in it merge by character.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { boardTextOf } from "../../shared/docs-visual";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docsVisual: {
      insertWhiteboard: () => ReturnType;
      insertDiagram: (source: string) => ReturnType;
    };
  }
}

export const newBoardId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const Whiteboard = Node.create({
  name: "whiteboard",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      id: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-board"), renderHTML: (a: Record<string, unknown>) => ({ "data-board": a.id ?? "" }) },
      scene: { default: "[]", parseHTML: (el: HTMLElement) => el.getAttribute("data-scene") ?? "[]", renderHTML: (a: Record<string, unknown>) => ({ "data-scene": typeof a.scene === "string" ? a.scene : "[]" }) },
      page: { default: false, parseHTML: (el: HTMLElement) => el.getAttribute("data-page") === "true", renderHTML: (a: Record<string, unknown>) => (a.page ? { "data-page": "true" } : {}) },
      height: { default: 420, parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-height")) || 420, renderHTML: (a: Record<string, unknown>) => ({ "data-height": String(a.height ?? 420) }) },
    };
  },

  parseHTML() { return [{ tag: "div[data-board]" }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { class: "mm-board-static" }), "Whiteboard"]; },
  renderText({ node }) { return boardTextOf(node.attrs.scene); },

  addCommands() {
    return {
      insertWhiteboard: () => ({ commands }) => commands.insertContent([{ type: this.name, attrs: { id: newBoardId(), scene: "[]", page: false, height: 420 } }, { type: "paragraph" }]),
    };
  },
});

export const Diagram = Node.create({
  name: "diagram",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  parseHTML() { return [{ tag: "pre[data-diagram]", preserveWhitespace: "full" }]; },
  renderHTML({ HTMLAttributes }) { return ["pre", mergeAttributes(HTMLAttributes, { "data-diagram": "", class: "mm-diagram-static" }), ["code", 0]]; },

  addCommands() {
    return {
      insertDiagram: (source: string) => ({ commands }) => commands.insertContent([{ type: this.name, content: source ? [{ type: "text", text: source }] : [] }, { type: "paragraph" }]),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Tab types two spaces inside a diagram instead of leaving the editor.
      Tab: () => (this.editor.isActive(this.name) ? this.editor.commands.insertContent("  ") : false),
      // Three Enters at the end leave the block, like a code block.
      Enter: ({ editor }) => {
        if (!editor.isActive(this.name)) return false;
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== $from.parent.content.size || !$from.parent.textContent.endsWith("\n\n")) return false;
        return editor.chain().command(({ tr }) => { tr.delete($from.pos - 2, $from.pos); return true; }).exitCode().run();
      },
    };
  },
});
