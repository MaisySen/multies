/**
 * R29: the docs editor's own shape for a doc the server writes from text or markdown.
 *
 * The web editor (Tiptap: StarterKit plus task lists) normalises what it loads in two ways:
 * every node and mark carries all of its attributes (defaults filled in), and a doc always ends
 * with an empty paragraph (StarterKit's trailing node), which it adds on the first transaction
 * after opening, even a click. A doc appended through the API that ended in a list or a code
 * block therefore changed on the first click: the page said "Unsaved changes" and wrote a new
 * version nobody typed, so the agent's next append with ifVersion got a 409.
 *
 * The server now writes exactly what the editor would, so opening such a doc changes nothing.
 * tests/docs-editor-shape-r29.test.ts compares this table with the editor schema's own defaults.
 */
export interface ShapeNode { type?: string; text?: string; content?: ShapeNode[]; attrs?: Record<string, unknown>; marks?: ShapeMark[] }
export interface ShapeMark { type: string; attrs?: Record<string, unknown> }

/** Attribute defaults, in the editor schema's order. Types not listed here have no attributes. */
export const NODE_ATTR_DEFAULTS: Record<string, Record<string, unknown>> = {
  codeBlock: { language: null },
  heading: { level: 1 },
  orderedList: { start: 1, type: null },
  taskItem: { checked: false },
};
export const MARK_ATTR_DEFAULTS: Record<string, Record<string, unknown>> = {
  link: { href: null, target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null },
};
const NO_ATTRS = new Set(["doc", "paragraph", "blockquote", "bulletList", "listItem", "taskList", "text", "hardBreak", "horizontalRule"]);

/** Only attributes the editor knows survive, each with its default when missing. Unknown node types are left as they are. */
function withAttrs<T extends { type?: string; attrs?: Record<string, unknown> }>(n: T, table: Record<string, Record<string, unknown>>): T {
  const type = n.type ?? "";
  const defaults = table[type];
  const { attrs, ...rest } = n;
  if (defaults) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaults)) out[k] = attrs && attrs[k] !== undefined ? attrs[k] : v;
    return { ...rest, attrs: out } as T;
  }
  if (NO_ATTRS.has(type) || table === MARK_ATTR_DEFAULTS) return rest as T;
  return n;
}

/** Keys in the order the editor writes them (type, attrs, content, marks, text), so a hash of the JSON matches too. */
function shapeNode(n: ShapeNode, depth: number): ShapeNode {
  const { type, attrs, content, marks, text, ...rest } = withAttrs(n, NODE_ATTR_DEFAULTS);
  const out: ShapeNode = { type, ...rest };
  if (attrs) out.attrs = attrs;
  if (Array.isArray(content)) out.content = depth < 64 ? content.map((c) => shapeNode(c, depth + 1)) : content;
  if (marks) out.marks = marks.map((m) => withAttrs(m, MARK_ATTR_DEFAULTS));
  if (text !== undefined) out.text = text;
  return out;
}

/** True when the editor would add an empty paragraph at the end (StarterKit's trailing node rule). */
export function needsTrailingParagraph(doc: ShapeNode) {
  const last = doc.content?.[doc.content.length - 1];
  return !last || last.type !== "paragraph";
}

/** The doc as the editor holds it after loading: attributes filled, ending with a paragraph. */
export function editorShape<T extends ShapeNode>(doc: T): T {
  const out = shapeNode(doc, 0);
  const content = [...(out.content ?? [])];
  if (needsTrailingParagraph({ content })) content.push({ type: "paragraph" });
  return { ...out, content } as T;
}
