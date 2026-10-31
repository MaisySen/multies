/**
 * R89: mind map mode. The doc drawn as a tree (lib/mindmap-tree.ts); every edit here is written straight into
 * the doc (only the top level blocks that changed), and the map redraws from the doc, so the doc stays the one
 * source of truth and co-editors see each change in both views.
 * Keys: Tab adds a child, Enter adds a sibling, arrows move between nodes, F2 or typing renames, Space folds,
 * Alt with up or down reorders, Shift Tab moves a node out a level, Delete removes. Readers can look and fold.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import { IconChevronRight, IconDownload, IconListTree, IconPlus } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { cn } from "@/web/lib/cn";
import { showError } from "@/web/lib/show-error";
import {
  addChild, addSibling, countHidden, diffBlocks, docToTree, find, indent, move, moveTo, neighbours, outdent, remove, rename, treeToDoc, visible,
  type EditResult, type MindNode, type PMNode,
} from "@/web/lib/mindmap-tree";
import { downloadBlob, pngToPdf, safeName, svgBlob, svgToPng } from "./export-file";
import { readTokens, useThemeKey } from "./theme";

const COL = 236, ROW = 44, NODE_H = 34, PAD = 24, MAX_W = 196;

interface Box { id: string; node: MindNode; x: number; y: number; w: number; depth: number; folded: boolean; hidden: number }

const textWidth = (s: string, root: boolean) => Math.min(MAX_W, Math.max(56, Math.round(s.length * (root ? 8.4 : 7.4)) + 28));

/** A simple tidy layout: leaves take one row each, a parent sits in the middle of its children. */
function layout(tree: MindNode, folded: Set<string>): { boxes: Box[]; links: [Box, Box][]; width: number; height: number } {
  const boxes: Box[] = [];
  const links: [Box, Box][] = [];
  let row = 0;
  const walk = (n: MindNode, depth: number): Box => {
    const kids = folded.has(n.id) ? [] : visible(n);
    const childBoxes = kids.map((k) => walk(k, depth + 1));
    const y = childBoxes.length ? (childBoxes[0].y + childBoxes[childBoxes.length - 1].y) / 2 : PAD + (row++) * ROW;
    const text = n.text || (n.kind === "root" ? "Untitled" : "");
    const b: Box = { id: n.id, node: n, x: PAD + depth * COL, y, w: textWidth(text || "New idea", n.kind === "root"), depth, folded: folded.has(n.id) && visible(n).length > 0, hidden: countHidden(n) };
    boxes.push(b);
    for (const c of childBoxes) links.push([b, c]);
    return b;
  };
  walk(tree, 0);
  const width = Math.max(...boxes.map((b) => b.x + b.w)) + PAD;
  const height = Math.max(PAD * 2 + ROW, row * ROW + PAD * 2);
  return { boxes, links, width, height };
}

const curve = (a: Box, b: Box) => {
  const x1 = a.x + a.w, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
};

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s: string, w: number) => { const max = Math.floor((w - 24) / 7.2); return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s; };

/** The map as a standalone SVG (same layout, our colours), for PNG, PDF and SVG files. */
export function mindmapSvg(tree: MindNode, folded: Set<string>): { svg: string; width: number; height: number } {
  const t = readTokens();
  const { boxes, links, width, height } = layout(tree, folded);
  const paths = links.map(([a, b]) => `<path d="${curve(a, b)}" fill="none" stroke="${t.line}" stroke-width="1.5"/>`).join("");
  const nodes = boxes.map((b) => {
    const root = b.node.kind === "root", heading = b.node.kind === "heading";
    const fill = root ? t.brand : heading ? t.brandSoft : t.surface;
    const ink = root ? "#ffffff" : t.fg;
    return `<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${NODE_H}" rx="10" fill="${fill}" stroke="${root ? t.brand : t.line}"/><text x="${b.x + 12}" y="${b.y + NODE_H / 2 + 4.5}" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="${root || heading ? 600 : 400}" fill="${ink}">${escXml(clip(b.node.text || (root ? "Untitled" : ""), b.w))}</text></g>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${t.surface}"/>${paths}${nodes}</svg>`;
  return { svg, width, height };
}

export function MindMapView({ editor, title, readOnly, onRenameTitle }: { editor: Editor; title: string; readOnly: boolean; onRenameTitle: (t: string) => void }) {
  useThemeKey();
  const [doc, setDoc] = useState<PMNode>(() => editor.getJSON() as PMNode);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState("r");
  const [editing, setEditing] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // The doc is the source: redraw on every change, local or from a co-editor.
  useEffect(() => {
    const on = () => setDoc(editor.getJSON() as PMNode);
    editor.on("update", on);
    return () => { editor.off("update", on); };
  }, [editor]);

  const tree = useMemo(() => docToTree(doc, title), [doc, title]);
  const { boxes, links, width, height } = useMemo(() => layout(tree, folded), [tree, folded]);
  const focusId = find(tree, focus) ? focus : "r";

  useLayoutEffect(() => {
    if (editing) return;
    const el = wrap.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(focusId)}"]`);
    if (el && document.activeElement !== el && wrap.current?.contains(document.activeElement ?? null) !== false) el.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusId, editing, boxes]);

  /** Writes an edited tree into the doc: one transaction replacing only the changed top level blocks. */
  const apply = useCallback((r: EditResult | null, then?: (focus: string) => void) => {
    if (!r || readOnly) return;
    try {
      const next = treeToDoc(r.root);
      const cur = editor.getJSON() as PMNode;
      const d = diffBlocks(cur.content ?? [], next.content ?? []);
      if (d) {
        const { state } = editor;
        const starts: number[] = [];
        state.doc.forEach((_child, offset) => { starts.push(offset); });
        starts.push(state.doc.content.size);
        const from = starts[Math.min(d.from, starts.length - 1)];
        const to = starts[Math.min(d.to, starts.length - 1)];
        const nodes = d.insert.map((b) => state.schema.nodeFromJSON(b));
        const tr = state.tr.replaceWith(from, Math.max(from, to), nodes);
        if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create());
        editor.view.dispatch(tr);
      }
      setFocus(r.focus);
      then?.(r.focus);
    } catch (e) { showError(e as Error); }
  }, [editor, readOnly]);

  const startEdit = (id: string, fresh = false, initial?: string) => {
    if (readOnly) return;
    const f = find(tree, id);
    if (!f) return;
    setEditing({ id, text: initial ?? f.node.text, fresh });
  };

  const commitEdit = (keep = true) => {
    const e = editing;
    if (!e) return;
    setEditing(null);
    const text = e.text.trim();
    if (e.id === "r") { if (keep && text && text !== title) onRenameTitle(text); return; }
    if (!keep || !text) {
      if (e.fresh) apply(remove(tree, e.id));
      return;
    }
    const f = find(tree, e.id);
    if (f && f.node.text !== text) apply(rename(tree, e.id, text));
  };

  const addAndEdit = (r: EditResult | null) => apply(r, (id) => setEditing({ id, text: "", fresh: true }));

  const onKey = (e: React.KeyboardEvent, id: string) => {
    if (editing) return;
    const nb = neighbours(tree, id, folded);
    const k = e.key;
    let handled = true;
    if (k === "ArrowRight") { if (folded.has(id) && visible(find(tree, id)!.node).length) setFolded((s) => { const n = new Set(s); n.delete(id); return n; }); else if (nb.firstChild) setFocus(nb.firstChild); }
    else if (k === "ArrowLeft") { if (nb.parent) setFocus(nb.parent); }
    else if (k === "ArrowDown" && e.altKey) apply(move(tree, id, 1));
    else if (k === "ArrowUp" && e.altKey) apply(move(tree, id, -1));
    else if (k === "ArrowDown") { if (nb.next) setFocus(nb.next); }
    else if (k === "ArrowUp") { if (nb.prev) setFocus(nb.prev); }
    else if (k === "Home") setFocus("r");
    else if (readOnly) handled = k === " " ? (toggleFold(id), true) : false;
    else if (k === "Tab" && e.shiftKey) apply(outdent(tree, id));
    else if (k === "Tab") addAndEdit(addChild(tree, id));
    else if (k === "Enter" && e.shiftKey) apply(indent(tree, id));
    else if (k === "Enter") { if (id === "r") addAndEdit(addChild(tree, id)); else addAndEdit(addSibling(tree, id)); }
    else if (k === "F2") startEdit(id);
    else if (k === " ") toggleFold(id);
    else if ((k === "Delete" || k === "Backspace") && id !== "r") {
      const f = find(tree, id);
      const many = f ? f.node.children.length : 0;
      if (many && !window.confirm(`Delete "${f!.node.text || "this idea"}" and the ${many} ${many === 1 ? "item" : "items"} under it?`)) return;
      apply(remove(tree, id));
    }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) startEdit(id, false, k);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const toggleFold = (id: string) => setFolded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const exportAs = async (kind: "png" | "svg" | "pdf") => {
    try {
      const { svg, width: w, height: h } = mindmapSvg(tree, folded);
      const name = `${title || "Mind map"} mind map`;
      if (kind === "svg") downloadBlob(svgBlob(svg), safeName(name, "svg"));
      else {
        const png = await svgToPng(svg, { scale: 2 });
        if (kind === "png") downloadBlob(png, safeName(name, "png"));
        else downloadBlob(await pngToPdf(png, w * 2, h * 2), safeName(name, "pdf"));
      }
      toast.success(`Saved as ${kind.toUpperCase()}`);
    } catch (e) { showError(e as Error); }
  };

  const isEmpty = visible(tree).length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mindmap">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-1 pb-2 text-[12.5px] text-muted">
        <IconListTree className="h-4 w-4" aria-hidden />
        <span className="max-sm:hidden">{readOnly ? "Arrows move, Space folds." : "Tab adds a child, Enter a sibling, arrows move, type to rename."}</span>
        <span className="ml-auto" />
        {!readOnly && (
          <>
            <Button variant="ghost" size="sm" onClick={() => addAndEdit(addChild(tree, focusId))} data-testid="mindmap-add-child"><IconPlus className="h-3.5 w-3.5" />Child</Button>
            <Button variant="ghost" size="sm" disabled={focusId === "r"} onClick={() => addAndEdit(addSibling(tree, focusId))}><IconPlus className="h-3.5 w-3.5" />Sibling</Button>
            <Button variant="ghost" size="sm" className="sm:hidden" onClick={() => startEdit(focusId)}>Rename</Button>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => void exportAs("png")} aria-label="Download as PNG"><IconDownload className="h-3.5 w-3.5" />PNG</Button>
        <Button variant="ghost" size="sm" onClick={() => void exportAs("pdf")} aria-label="Download as PDF"><IconDownload className="h-3.5 w-3.5" />PDF</Button>
        <Button variant="ghost" size="sm" onClick={() => void exportAs("svg")} aria-label="Download as SVG"><IconDownload className="h-3.5 w-3.5" />SVG</Button>
      </div>
      <div ref={wrap} className="relative min-h-[360px] flex-1 overflow-auto overscroll-contain rounded-xl bg-bg/50 [touch-action:pan-x_pan-y]" role="tree" aria-label={`Mind map of ${title || "Untitled"}`}>
        <div className="relative" style={{ width, height }}>
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            {links.map(([a, b]) => <path key={`${a.id}-${b.id}`} d={curve(a, b)} fill="none" className="stroke-line-strong" strokeWidth={1.5} />)}
          </svg>
          {boxes.map((b) => {
            const root = b.node.kind === "root", heading = b.node.kind === "heading";
            const kids = visible(b.node).length;
            const isEditing = editing?.id === b.id;
            return (
              <div key={b.id} className="absolute" style={{ left: b.x, top: b.y, width: b.w + (kids ? 22 : 0) }}>
                {isEditing ? (
                  <input autoFocus value={editing.text} aria-label="Idea text" data-testid="mindmap-input"
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    onBlur={() => commitEdit(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const tab = e.key === "Tab" && !e.shiftKey; const id = b.id; commitEdit(true); if (tab && editing.text.trim()) setTimeout(() => setFocus(id), 0); }
                      else if (e.key === "Escape") { e.preventDefault(); commitEdit(false); }
                      e.stopPropagation();
                    }}
                    className="h-[34px] w-full min-w-[160px] rounded-[10px] border-2 border-brand bg-surface px-3 text-[13px] text-fg outline-none" />
                ) : (
                  <div role="treeitem" tabIndex={b.id === focusId ? 0 : -1} data-node={b.id} data-testid="mindmap-node" aria-level={b.depth + 1} aria-selected={b.id === focusId}
                    aria-expanded={kids ? !b.folded : undefined}
                    draggable={!readOnly && !root}
                    onDragStart={(e) => { setDrag(b.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.node.text); }}
                    onDragOver={(e) => { if (drag && drag !== b.id) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); if (drag && drag !== b.id) apply(moveTo(tree, drag, b.id)); setDrag(null); }}
                    onDragEnd={() => setDrag(null)}
                    onFocus={() => setFocus(b.id)}
                    onClick={() => setFocus(b.id)}
                    onDoubleClick={() => startEdit(b.id)}
                    onKeyDown={(e) => onKey(e, b.id)}
                    title={b.node.text}
                    className={cn("flex h-[34px] cursor-default select-none items-center truncate rounded-[10px] border px-3 text-[13px] outline-none transition-shadow duration-150",
                      root ? "border-brand bg-brand font-semibold text-brand-fg" : heading ? "border-brand/30 bg-brand-soft font-semibold text-fg" : "border-line bg-surface text-fg",
                      b.id === focusId && "ring-2 ring-brand ring-offset-2 ring-offset-bg", drag === b.id && "opacity-50")}
                    style={{ width: b.w }}>
                    <span className="truncate">{b.node.text || (root ? title || "Untitled" : <span className="text-subtle">Untitled</span>)}</span>
                    {b.hidden > 0 && !root && <span className="ml-1.5 shrink-0 rounded bg-fill px-1 text-[10.5px] font-normal text-muted" title={`${b.hidden} more ${b.hidden === 1 ? "block" : "blocks"} in the doc`}>+{b.hidden}</span>}
                  </div>
                )}
                {kids > 0 && !isEditing && (
                  <button type="button" tabIndex={-1} onClick={() => toggleFold(b.id)} aria-label={b.folded ? `Show ${kids} under ${b.node.text}` : `Fold ${b.node.text}`}
                    className="absolute right-0 top-[7px] grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-[10px] text-muted hover:text-fg max-sm:top-[3px] max-sm:h-7 max-sm:w-7">
                    {b.folded ? kids : <IconChevronRight className="h-3 w-3 rotate-180" aria-hidden />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {isEmpty && !readOnly && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <p className="pointer-events-auto rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-muted shadow-sm">
              Press Tab to add your first idea, or <button type="button" className="inline-flex items-center gap-1 font-medium text-brand-hover underline" onClick={() => addAndEdit(addChild(tree, "r"))}><IconPlus className="h-3 w-3" />add one</button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
