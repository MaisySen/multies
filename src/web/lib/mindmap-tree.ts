/**
 * R89: mind map mode. A doc read as a tree and written back, so the doc stays the one source of truth.
 *
 * The title is the root. Headings nest by level; bullets, numbers and to-dos nest under the heading (or the
 * bullet) they sit in. Everything else (paragraphs, tables, images, callouts) rides along as hidden "block"
 * children in its place, so treeToDoc(docToTree(doc)) gives the same blocks back. Edits are pure functions on the
 * tree; the editor then replaces only the top level blocks that changed (diffBlocks), which keeps co-editing and
 * carets elsewhere in the doc untouched.
 *
 * Invariant kept by every edit: in a root or heading node, non-heading children come before heading children,
 * because in a doc everything after a subheading belongs to that subheading.
 */
export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: unknown[] }

export type ListType = "bulletList" | "orderedList" | "taskList";
export type MindKind = "root" | "heading" | "item" | "block";

export interface MindNode {
  id: string;
  kind: MindKind;
  text: string;
  /** Heading level (1 to 6). */
  level?: number;
  listType?: ListType;
  /** The list's own attrs (an ordered list's start) and the item's (a to-do's checked), kept for the round trip. */
  listAttrs?: Record<string, unknown>;
  itemAttrs?: Record<string, unknown>;
  /** The heading's or first paragraph's attrs and inline content, kept until the text is renamed. */
  attrs?: Record<string, unknown>;
  inline?: PMNode[];
  /** A hidden block (paragraph, table...) kept as it was. */
  json?: PMNode;
  children: MindNode[];
}

const LISTS = new Set<string>(["bulletList", "orderedList", "taskList"]);
const MAX_LEVEL = 6;

export function inlineText(content: PMNode[] | undefined): string {
  let s = "";
  for (const n of content ?? []) {
    if (n.type === "text") s += n.text ?? "";
    else if (n.type === "hardBreak") s += " ";
    else if (n.content) s += inlineText(n.content);
  }
  return s;
}

function itemFrom(li: PMNode, listType: ListType, listAttrs: Record<string, unknown> | undefined): MindNode {
  const node: MindNode = { id: "", kind: "item", text: "", listType, listAttrs, itemAttrs: li.attrs, children: [] };
  const content = li.content ?? [];
  let start = 0;
  if (content[0]?.type === "paragraph") {
    node.text = inlineText(content[0].content);
    node.inline = content[0].content;
    node.attrs = content[0].attrs;
    start = 1;
  }
  for (const c of content.slice(start)) {
    if (LISTS.has(c.type)) for (const sub of c.content ?? []) node.children.push(itemFrom(sub, c.type as ListType, c.attrs));
    else node.children.push({ id: "", kind: "block", text: "", json: c, children: [] });
  }
  return node;
}

/** Gives every node a path id ("r", "r.0", "r.0.2"), counting hidden blocks too. */
export function assignIds(n: MindNode, id = "r"): MindNode {
  n.id = id;
  n.children.forEach((c, i) => assignIds(c, `${id}.${i}`));
  return n;
}

export function docToTree(doc: PMNode | null | undefined, title: string): MindNode {
  const root: MindNode = { id: "r", kind: "root", text: title, children: [] };
  const stack: MindNode[] = [root];
  for (const b of doc?.content ?? []) {
    if (b.type === "heading") {
      const level = clampLevel(Number(b.attrs?.level ?? 1));
      while (stack.length > 1 && (stack[stack.length - 1].level ?? 0) >= level) stack.pop();
      const h: MindNode = { id: "", kind: "heading", text: inlineText(b.content), level, attrs: b.attrs, inline: b.content, children: [] };
      stack[stack.length - 1].children.push(h);
      stack.push(h);
    } else if (LISTS.has(b.type)) {
      for (const li of b.content ?? []) stack[stack.length - 1].children.push(itemFrom(li, b.type as ListType, b.attrs));
    } else {
      stack[stack.length - 1].children.push({ id: "", kind: "block", text: "", json: b, children: [] });
    }
  }
  return assignIds(root);
}

function clampLevel(l: number) { return Math.max(1, Math.min(MAX_LEVEL, Number.isFinite(l) ? Math.round(l) : 1)); }

function para(n: MindNode): PMNode {
  const p: PMNode = { type: "paragraph" };
  if (n.attrs) p.attrs = n.attrs;
  if (n.inline && n.inline.length) p.content = n.inline;
  return p;
}

function emit(children: MindNode[], out: PMNode[], inItem: boolean) {
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.kind === "block") { if (c.json) out.push(c.json); continue; }
    if (c.kind === "heading" && !inItem) {
      const h: PMNode = { type: "heading", attrs: { ...(c.attrs ?? {}), level: clampLevel(c.level ?? 1) } };
      if (c.inline && c.inline.length) h.content = c.inline;
      out.push(h);
      emit(c.children, out, false);
      continue;
    }
    // A run of items of one list type becomes one list (a heading inside an item is written as an item).
    const type = c.listType ?? "bulletList";
    const run: MindNode[] = [];
    while (i < children.length && children[i].kind !== "block" && (children[i].kind === "item" || inItem) && (children[i].listType ?? "bulletList") === type) run.push(children[i++]);
    i--;
    const list: PMNode = { type };
    const attrs = run[0].listAttrs;
    if (attrs) list.attrs = attrs;
    list.content = run.map((it) => itemJson(it, type));
    out.push(list);
  }
}

function itemJson(it: MindNode, type: ListType): PMNode {
  const li: PMNode = { type: type === "taskList" ? "taskItem" : "listItem" };
  if (type === "taskList") li.attrs = { checked: false, ...(it.itemAttrs ?? {}) };
  else if (it.itemAttrs && Object.keys(it.itemAttrs).length) li.attrs = it.itemAttrs;
  const content: PMNode[] = [para(it)];
  emit(it.children, content, true);
  li.content = content;
  return li;
}

export function treeToDoc(root: MindNode): PMNode {
  const out: PMNode[] = [];
  emit(root.children, out, false);
  return { type: "doc", content: out };
}

// ---------- finding ----------

export interface Found { node: MindNode; parent: MindNode | null; index: number }

export function find(root: MindNode, id: string): Found | null {
  if (root.id === id) return { node: root, parent: null, index: -1 };
  const walk = (p: MindNode): Found | null => {
    for (let i = 0; i < p.children.length; i++) {
      const c = p.children[i];
      if (c.id === id) return { node: c, parent: p, index: i };
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(root);
}

/** The children a mind map draws (hidden blocks left out). */
export const visible = (n: MindNode) => n.children.filter((c) => c.kind !== "block");

export function countHidden(n: MindNode): number {
  let k = 0;
  for (const c of n.children) k += (c.kind === "block" ? 1 : 0) + countHidden(c);
  return k;
}

// ---------- edits ----------

export interface EditResult { root: MindNode; focus: string }

const clone = (n: MindNode): MindNode => JSON.parse(JSON.stringify(n)) as MindNode;
const textInline = (text: string): PMNode[] => (text ? [{ type: "text", text }] : []);

function headingChildLevel(n: MindNode): number | null {
  const h = n.children.find((c) => c.kind === "heading");
  return h ? h.level ?? null : null;
}

/** Index where a non-heading child goes: after the last non-heading child, before the first heading child. */
function itemSlot(n: MindNode): number {
  const i = n.children.findIndex((c) => c.kind === "heading");
  return i < 0 ? n.children.length : i;
}

function shiftLevels(n: MindNode, delta: number) {
  if (n.kind === "heading") n.level = clampLevel((n.level ?? 1) + delta);
  for (const c of n.children) shiftLevels(c, delta);
}

/** Converts a node (and its subtree) to fit under a new parent. */
function fitUnder(n: MindNode, parent: MindNode): MindNode {
  if (parent.kind === "item") return toItem(n, parent.listType === "orderedList" || parent.listType === "taskList" ? parent.listType : "bulletList");
  if (n.kind === "heading") {
    const want = parent.kind === "root" ? (headingChildLevel(parent) ?? 1) : clampLevel((parent.level ?? 1) + 1);
    shiftLevels(n, want - (n.level ?? 1));
  }
  return n;
}

function toItem(n: MindNode, listType: ListType): MindNode {
  if (n.kind === "block") return n;
  const out: MindNode = { ...n, kind: "item", listType: n.kind === "item" ? n.listType : listType, level: undefined, children: [] };
  if (n.kind === "heading") { out.attrs = undefined; out.listAttrs = undefined; out.itemAttrs = undefined; }
  out.children = n.children.map((c) => toItem(c, listType));
  return out;
}

function insertChild(parent: MindNode, child: MindNode, at?: number) {
  if (child.kind === "heading") parent.children.splice(at ?? parent.children.length, 0, child);
  else {
    const slot = itemSlot(parent);
    parent.children.splice(at === undefined ? slot : Math.min(at, slot), 0, child);
  }
}

function blank(kind: "heading" | "item", parent: MindNode, opts: { level?: number; listType?: ListType } = {}): MindNode {
  if (kind === "heading") return { id: "", kind, text: "", level: clampLevel(opts.level ?? 1), inline: [], children: [] };
  void parent;
  return { id: "", kind, text: "", listType: opts.listType ?? "bulletList", inline: [], children: [] };
}

function idOf(root: MindNode, target: MindNode): string {
  assignIds(root);
  return target.id;
}

/** A new child at the end. Under the title: a heading; under a level 1 heading: a level 2 heading; otherwise a bullet. */
export function addChild(tree: MindNode, id: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || f.node.kind === "block") return null;
  const n = f.node;
  let child: MindNode;
  const hLevel = headingChildLevel(n);
  if (n.kind === "item") {
    const lastItem = [...n.children].reverse().find((c) => c.kind === "item");
    child = blank("item", n, { listType: lastItem?.listType ?? (n.listType === "taskList" ? "taskList" : "bulletList") });
  } else if (hLevel !== null) child = blank("heading", n, { level: hLevel });
  else if (n.kind === "root") {
    const lastItem = [...n.children].reverse().find((c) => c.kind === "item");
    child = lastItem ? blank("item", n, { listType: lastItem.listType }) : blank("heading", n, { level: 1 });
  } else if ((n.level ?? 1) === 1) child = blank("heading", n, { level: 2 });
  else {
    const lastItem = [...n.children].reverse().find((c) => c.kind === "item");
    child = blank("item", n, { listType: lastItem?.listType ?? "bulletList" });
  }
  insertChild(n, child);
  return { root, focus: idOf(root, child) };
}

/** A new node of the same kind right after this one (on the title, a new child). */
export function addSibling(tree: MindNode, id: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || f.node.kind === "block") return null;
  if (!f.parent) return addChild(tree, id);
  const n = f.node;
  const sib = n.kind === "heading" ? blank("heading", f.parent, { level: n.level }) : blank("item", f.parent, { listType: n.listType });
  if (n.kind === "item") { sib.listAttrs = n.listAttrs; if (n.listType === "taskList") sib.itemAttrs = { checked: false }; }
  f.parent.children.splice(f.index + 1, 0, sib);
  return { root, focus: idOf(root, sib) };
}

export function rename(tree: MindNode, id: string, text: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || f.node.kind === "block") return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === f.node.text) return { root: tree, focus: id };
  f.node.text = clean;
  f.node.inline = textInline(clean);
  return { root, focus: id };
}

/** Removes the node and everything under it. Focus moves to the previous visible sibling, or the parent. */
export function remove(tree: MindNode, id: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || !f.parent) return null;
  const sibs = f.parent.children;
  sibs.splice(f.index, 1);
  let target: MindNode = f.parent;
  for (let i = Math.min(f.index, sibs.length) - 1; i >= 0; i--) if (sibs[i].kind !== "block") { target = sibs[i]; break; }
  return { root, focus: idOf(root, target) };
}

/** Swaps with the nearest sibling of the same kind above (-1) or below (+1). */
export function move(tree: MindNode, id: string, dir: -1 | 1): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || !f.parent) return null;
  const sibs = f.parent.children;
  let j = f.index + dir;
  while (j >= 0 && j < sibs.length && sibs[j].kind === "block") j += dir;
  if (j < 0 || j >= sibs.length || (sibs[j].kind === "heading") !== (f.node.kind === "heading")) return null;
  [sibs[f.index], sibs[j]] = [sibs[j], sibs[f.index]];
  return { root, focus: idOf(root, f.node) };
}

function contains(n: MindNode, id: string): boolean {
  return n.id === id || n.children.some((c) => contains(c, id));
}

/** Moves a node to be the last child of another (drag and drop, indent). Headings dropped on a bullet become bullets. */
export function moveTo(tree: MindNode, id: string, targetId: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  const t = find(root, targetId);
  if (!f || !t || !f.parent || t.node.kind === "block" || contains(f.node, targetId) || f.parent.id === targetId && f.index === f.parent.children.length - 1) return null;
  f.parent.children.splice(f.index, 1);
  const moved = fitUnder(f.node, t.node);
  insertChild(t.node, moved);
  return { root, focus: idOf(root, moved) };
}

/** Indent: becomes the last child of the previous sibling of the same kind. */
export function indent(tree: MindNode, id: string): EditResult | null {
  const f = find(tree, id);
  if (!f || !f.parent) return null;
  for (let i = f.index - 1; i >= 0; i--) {
    const s = f.parent.children[i];
    if (s.kind === f.node.kind) return moveTo(tree, id, s.id);
    if (s.kind !== "block") break;
  }
  return null;
}

/** Outdent: becomes the next sibling of its parent, when that keeps the doc's order (not out of a heading into a heading's list). */
export function outdent(tree: MindNode, id: string): EditResult | null {
  const root = clone(tree);
  const f = find(root, id);
  if (!f || !f.parent || f.parent.kind === "root") return null;
  const g = find(root, f.parent.id);
  if (!g || !g.parent) return null;
  const n = f.node;
  if (n.kind === "item" && f.parent.kind === "heading") return null;
  f.parent.children.splice(f.index, 1);
  if (n.kind === "heading") shiftLevels(n, (f.parent.level ?? 1) - (n.level ?? 1));
  g.parent.children.splice(g.index + 1, 0, n);
  return { root, focus: idOf(root, n) };
}

/** The visible node order for arrow keys: parent, first child, next sibling. */
export function neighbours(tree: MindNode, id: string, collapsed: Set<string> = new Set()) {
  const f = find(tree, id);
  if (!f) return { parent: null, firstChild: null, prev: null, next: null };
  const kids = collapsed.has(id) ? [] : visible(f.node);
  const sibs = f.parent ? visible(f.parent) : [];
  const i = sibs.findIndex((s) => s.id === id);
  return { parent: f.parent?.id ?? null, firstChild: kids[0]?.id ?? null, prev: i > 0 ? sibs[i - 1].id : null, next: i >= 0 && i < sibs.length - 1 ? sibs[i + 1].id : null };
}

// ---------- applying to the editor ----------

export interface BlockDiff { from: number; to: number; insert: PMNode[] }

/** The smallest run of top level blocks to replace: old blocks [from, to) become `insert`. Null when nothing changed. */
export function diffBlocks(oldBlocks: PMNode[], newBlocks: PMNode[]): BlockDiff | null {
  const a = oldBlocks.map((b) => JSON.stringify(b));
  const b = newBlocks.map((x) => JSON.stringify(x));
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return null;
  return { from: start, to: endA, insert: newBlocks.slice(start, endB) };
}
