/**
 * R32: the callout block for docs. A soft tinted box with an icon and its own paragraphs, in four
 * variants (info, success, warning, danger). It serialises to <div data-callout="info"> so it
 * round trips through the editor's HTML, the shared (Yjs) document and the read only renderer.
 * This file is the schema only (no React), so the server shape tests and the guest view use it;
 * the editable view with the variant switch lives in docs-blocks.tsx.
 */
import { Node, mergeAttributes, wrappingInputRule } from "@tiptap/core";

export const CALLOUT_VARIANTS = ["info", "success", "warning", "danger"] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/** Words people type for a variant (":::note", "> [!TIP]") mapped to the four we draw. */
const ALIASES: Record<string, CalloutVariant> = {
  info: "info", note: "info", important: "info",
  success: "success", tip: "success", check: "success", done: "success",
  warning: "warning", warn: "warning", caution: "warning",
  danger: "danger", error: "danger", alert: "danger",
};

/** A known variant for any word, or "info" when it is not one. */
export function calloutVariant(word: unknown): CalloutVariant {
  return (typeof word === "string" && ALIASES[word.trim().toLowerCase()]) || "info";
}

/** The next variant in the cycle, used when the icon is clicked. */
export function nextCalloutVariant(v: unknown): CalloutVariant {
  const i = CALLOUT_VARIANTS.indexOf(calloutVariant(v));
  return CALLOUT_VARIANTS[(i + 1) % CALLOUT_VARIANTS.length];
}

/** Readable names, for the icon button's label. */
export const CALLOUT_LABELS: Record<CalloutVariant, string> = { info: "Info", success: "Success", warning: "Warning", danger: "Danger" };

/** ":::info " (or note, tip, warning, danger...) at the start of an empty line makes a callout. */
export const CALLOUT_INPUT = /^:::(info|note|important|success|tip|check|done|warning|warn|caution|danger|error|alert)\s$/i;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the current block in a callout of that variant. */
      setCallout: (variant?: CalloutVariant) => ReturnType;
      /** Changes the variant of the callout around the caret. */
      setCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info",
        parseHTML: (el: HTMLElement) => calloutVariant(el.getAttribute("data-callout")),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-callout": calloutVariant(attrs.variant) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ class: "mm-callout", role: "note" }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setCallout: (variant = "info") => ({ commands }) => commands.wrapIn(this.name, { variant: calloutVariant(variant) }),
      setCalloutVariant: (variant) => ({ commands }) => commands.updateAttributes(this.name, { variant: calloutVariant(variant) }),
    };
  },

  addInputRules() {
    return [wrappingInputRule({ find: CALLOUT_INPUT, type: this.type, getAttributes: (m) => ({ variant: calloutVariant(m[1]) }) })];
  },
});
