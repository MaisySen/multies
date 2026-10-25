/**
 * R24.5 Docs page tree (left sidebar with sub pages, drag to reorder or nest, and a keyboard menu),
 * breadcrumbs, the "Linked from" section and the page link picker ([[ or the toolbar button).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { Editor } from "@tiptap/react";
import { ArrowDown, ArrowUp, CheckSquare, ChevronRight, FileText, IndentDecrease, IndentIncrease, Link2, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";

export const MAX_DEPTH = 6;
export interface TreeNode { id: string; title: string; parentId: string | null; position: number; depth: number; children: TreeNode[] }
interface TreeAnswer { tree: TreeNode[]; count: number; truncated: boolean }
interface Backlink { id: string; title: string; snippet: string; updatedAt: string }

export function useDocTree() {
  return useQuery({ queryKey: ["doc-tree"], queryFn: () => api.get<TreeAnswer>("/docs/tree") });
}

/** Every page with its parent and siblings, in tree order. */
export function flatten(tree: TreeNode[]) {
  const out: { node: TreeNode; parent: TreeNode | null; siblings: TreeNode[]; index: number }[] = [];
  const walk = (list: TreeNode[], parent: TreeNode | null) => list.forEach((node, index) => { out.push({ node, parent, siblings: list, index }); walk(node.children, node); });
  walk(tree, null);
  return out;
}

/** The pages above a page, top first. */
export function ancestorsOf(tree: TreeNode[], id: string): TreeNode[] {
  const byId = new Map(flatten(tree).map((e) => [e.node.id, e]));
  const out: TreeNode[] = [];
  for (let cur = byId.get(id)?.parent ?? null; cur && out.length < 50; cur = byId.get(cur.id)?.parent ?? null) out.unshift(cur);
  return out;
}

const heightOf = (n: TreeNode): number => 1 + Math.max(0, ...n.children.map(heightOf));
const contains = (n: TreeNode, id: string): boolean => n.id === id || n.children.some((c) => contains(c, id));

/** The words for deleting a page: its sub pages move up a level. */
export function deleteConfirmText(tree: TreeNode[] | undefined, id: string) {
  const e = tree ? flatten(tree).find((x) => x.node.id === id) : undefined;
  const n = e?.node.children.length ?? 0;
  if (!n) return "Delete this doc?";
  return `Delete this doc? Its ${n === 1 ? "sub page moves" : `${n} sub pages move`} up to ${e?.parent ? `"${e.parent.title}"` : "the top level"}.`;
}

function useMove() {
  const qc = useQueryClient();
  return async (id: string, body: { parentId?: string | null; beforeId?: string; afterId?: string }) => {
    try {
      await api.patch(`/docs/${id}/move`, body);
    } catch (e) { showError(e as Error); }
    await qc.invalidateQueries({ queryKey: ["doc-tree"] });
  };
}

const COLLAPSED_KEY = "mm.docTree.collapsed";
function readCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

/** The left sidebar: pages and sub pages. */
export function DocTreeSidebar({ currentId }: { currentId?: string }) {
  const q = useDocTree();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const move = useMove();
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const tree = useMemo(() => q.data?.tree ?? [], [q.data]);
  const flat = useMemo(() => flatten(tree), [tree]);
  // Open the way down to the current page.
  useEffect(() => {
    if (!currentId) return;
    const up = ancestorsOf(tree, currentId);
    if (up.some((a) => collapsed.has(a.id))) setCollapsed((s) => { const n = new Set(s); for (const a of up) n.delete(a.id); return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, tree]);
  const toggle = (id: string) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  const addPage = async (parentId: string | null) => {
    try {
      const r = await api.post<{ doc: { id: string } }>("/docs", { title: "Untitled", text: "", parentId });
      if (parentId) setCollapsed((s) => { const n = new Set(s); n.delete(parentId); return n; });
      await qc.invalidateQueries({ queryKey: ["doc-tree"] });
      navigate(`/app/docs/${r.doc.id}`);
    } catch (e) { showError(e as Error); }
  };
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : "";
    const node = flat.find((x) => x.node.id === id)?.node;
    if (!node || !over) return;
    const [kind, target] = over.split(":") as [string, string];
    if (target === id) return;
    if (kind === "end") { void move(id, { parentId: null }); return; }
    const t = flat.find((x) => x.node.id === target);
    if (!t) return;
    if (contains(node, target)) { toast.error("A page can't go inside one of its own sub pages."); return; }
    if (kind === "into") {
      if (t.node.depth + heightOf(node) > MAX_DEPTH) { toast.error(`Pages nest at most ${MAX_DEPTH} levels deep.`); return; }
      setCollapsed((s) => { const n = new Set(s); n.delete(target); return n; });
      void move(id, { parentId: target });
    } else if (kind === "before") {
      void move(id, { beforeId: target });
    }
  };

  return (
    <nav aria-label="Pages" className="w-60 shrink-0 max-lg:hidden" data-testid="doc-tree">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Pages</span>
        <button type="button" aria-label="New page" title="New page" onClick={() => void addPage(null)} className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"><Plus className="h-4 w-4" /></button>
      </div>
      {q.isPending ? <div className="space-y-2 px-2">{[0, 1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-elevated" />)}</div> : !tree.length ? (
        <p className="px-2 text-[13px] text-muted">No pages yet.</p>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <ul role="tree" aria-label="Pages" className="text-[13.5px]">
            {tree.map((n, i) => <TreeItem key={n.id} node={n} siblings={tree} index={i} parent={null} currentId={currentId} collapsed={collapsed} toggle={toggle} addPage={addPage} move={move} />)}
          </ul>
          <EndZone />
        </DndContext>
      )}
      {q.data?.truncated && <p className="mt-2 px-2 text-[12px] text-subtle">Showing the 2,000 most recent pages.</p>}
    </nav>
  );
}

function EndZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "end:root" });
  return <div ref={setNodeRef} aria-hidden className={cn("mx-2 mt-1 h-6 rounded-md border border-dashed border-transparent", isOver && "border-brand/50 bg-brand/5")} data-testid="doc-tree-end" />;
}

function Gap({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `before:${id}` });
  return <div ref={setNodeRef} aria-hidden className={cn("relative h-1", isOver && "before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded before:bg-brand")} data-testid={`gap-${id}`} />;
}

function TreeItem({ node, siblings, index, parent, currentId, collapsed, toggle, addPage, move }: {
  node: TreeNode; siblings: TreeNode[]; index: number; parent: TreeNode | null; currentId?: string; collapsed: Set<string>;
  toggle: (id: string) => void; addPage: (parentId: string | null) => Promise<void>; move: ReturnType<typeof useMove>;
}) {
  const drag = useDraggable({ id: node.id });
  const drop = useDroppable({ id: `into:${node.id}` });
  const open = !collapsed.has(node.id);
  const hasKids = node.children.length > 0;
  const prev = siblings[index - 1];
  const next = siblings[index + 1];
  const active = node.id === currentId;
  const style = drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 20 } : undefined;
  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={active} aria-level={node.depth}>
      <Gap id={node.id} />
      <div ref={(el) => { drop.setNodeRef(el); drag.setNodeRef(el); }} style={style} {...drag.listeners} {...drag.attributes} role="group" aria-roledescription="draggable page"
        data-testid={`tree-row-${node.title}`}
        className={cn("group flex items-center gap-0.5 rounded-md py-0.5 pr-1", active ? "bg-brand/10 text-fg" : "text-muted hover:bg-hover hover:text-fg",
          drop.isOver && !drag.isDragging && "ring-2 ring-brand/50", drag.isDragging && "opacity-70 shadow-pop bg-elevated")}>
        <button type="button" onClick={() => toggle(node.id)} aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`} tabIndex={hasKids ? 0 : -1}
          className={cn("rounded p-0.5 text-subtle hover:text-fg", !hasKids && "invisible")}>
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <Link to={`/app/docs/${node.id}`} draggable={false} className={cn("flex min-w-0 flex-1 items-center gap-1.5 py-0.5", active && "font-medium")}>
          <FileText className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{node.title || "Untitled"}</span>
        </Link>
        <div className="opacity-0 focus-within:opacity-100 group-hover:opacity-100" onPointerDown={(e) => e.stopPropagation()}>
          <Menu align="end" trigger={<button type="button" aria-label={`Page actions for ${node.title}`} className="rounded p-0.5 text-subtle hover:text-fg"><MoreHorizontal className="h-4 w-4" /></button>}>
            <MenuItem icon={<Plus />} onSelect={() => { if (node.depth >= MAX_DEPTH) toast.error(`Pages nest at most ${MAX_DEPTH} levels deep.`); else void addPage(node.id); }}>Add sub page</MenuItem>
            <MenuItem icon={<ArrowUp />} onSelect={() => { if (prev) void move(node.id, { beforeId: prev.id }); }}>Move up</MenuItem>
            <MenuItem icon={<ArrowDown />} onSelect={() => { if (next) void move(node.id, { afterId: next.id }); }}>Move down</MenuItem>
            <MenuItem icon={<IndentIncrease />} onSelect={() => { if (prev) void move(node.id, { parentId: prev.id }); }}>Indent</MenuItem>
            <MenuItem icon={<IndentDecrease />} onSelect={() => { if (parent) void move(node.id, { parentId: parent.parentId, afterId: parent.id }); }}>Outdent</MenuItem>
          </Menu>
        </div>
      </div>
      {hasKids && open && (
        <ul role="group" className="ml-3 border-l border-line pl-1">
          {node.children.map((c, i) => <TreeItem key={c.id} node={c} siblings={node.children} index={i} parent={node} currentId={currentId} collapsed={collapsed} toggle={toggle} addPage={addPage} move={move} />)}
        </ul>
      )}
    </li>
  );
}

/** Docs > parent > page. */
export function DocBreadcrumbs({ docId, title }: { docId: string; title: string }) {
  const q = useDocTree();
  const up = q.data ? ancestorsOf(q.data.tree, docId) : [];
  if (!up.length) return null;
  return (
    <nav aria-label="Breadcrumbs" className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-[12.5px] text-subtle" data-testid="doc-breadcrumbs">
      {up.map((a) => (
        <span key={a.id} className="inline-flex min-w-0 items-center gap-1">
          <Link to={`/app/docs/${a.id}`} className="max-w-[12rem] truncate hover:text-fg">{a.title || "Untitled"}</Link>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </span>
      ))}
      <span className="max-w-[12rem] truncate text-muted" aria-current="page">{title || "Untitled"}</span>
    </nav>
  );
}

function BacklinkList({ items }: { items: Backlink[] }) {
  return (
    <ul className="space-y-2">
      {items.map((b) => (
        <li key={b.id}>
          <Link to={`/app/docs/${b.id}`} className="block rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong">
            <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg"><FileText className="h-3.5 w-3.5 text-muted" />{b.title || "Untitled"}</span>
            {b.snippet && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-relaxed text-muted">{b.snippet}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The bottom of a doc: the docs that link here. */
export function LinkedFrom({ docId }: { docId: string }) {
  const q = useQuery({ queryKey: ["backlinks", "doc", docId], queryFn: () => api.get<{ backlinks: Backlink[] }>(`/docs/${docId}/backlinks`), staleTime: 0, refetchOnMount: "always" });
  const items = q.data?.backlinks ?? [];
  return (
    <section aria-label="Linked from" className="mt-10 border-t border-line pt-5" data-testid="linked-from">
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-muted"><Link2 className="h-3.5 w-3.5" />Linked from{items.length ? ` (${items.length})` : ""}</h2>
      {q.isPending ? <div className="h-10 animate-pulse rounded-lg bg-elevated" /> : items.length ? <BacklinkList items={items} /> : (
        <p className="text-[13px] text-subtle">No other pages link here yet. Type [[ in a page to link to this one.</p>
      )}
    </section>
  );
}

/** On the task panel: docs whose body links to this task. Hidden when there are none. */
export function TaskDocBacklinks({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: ["backlinks", "task", taskId], queryFn: () => api.get<{ backlinks: Backlink[] }>(`/tasks/${taskId}/backlinks`), staleTime: 0, refetchOnMount: "always" });
  const items = q.data?.backlinks ?? [];
  if (!items.length) return null;
  return (
    <section className="mt-6" aria-label="Linked from docs" data-testid="task-linked-from">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Linked from docs</h3>
      <BacklinkList items={items} />
    </section>
  );
}

interface PickItem { type: "doc" | "task"; id: string; title: string; hint: string }

/** Find a page or task and put a link to it at the caret. */
export function PageLinkPicker({ editor, open, onClose, selfId }: { editor: Editor | null; open: boolean; onClose: () => void; selfId: string }) {
  const tree = useDocTree();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();
  const tasks = useQuery({
    queryKey: ["page-link-tasks", term], enabled: open && term.length >= 2,
    queryFn: () => api.get<{ groups: { type: string; items: { id: string; title: string; subtitle: string }[] }[] }>(`/search?q=${encodeURIComponent(term)}&types=tasks&limit=6`),
  });
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  const items: PickItem[] = useMemo(() => {
    const pages = flatten(tree.data?.tree ?? []).map((e) => e.node).filter((n) => n.id !== selfId && n.title.toLowerCase().includes(term.toLowerCase())).slice(0, 8)
      .map((n) => ({ type: "doc" as const, id: n.id, title: n.title || "Untitled", hint: "Page" }));
    const ts = (tasks.data?.groups.find((g) => g.type === "tasks")?.items ?? []).map((t) => ({ type: "task" as const, id: t.id, title: t.title, hint: t.subtitle || "Task" }));
    return [...pages, ...(term.length >= 2 ? ts : [])];
  }, [tree.data, tasks.data, term, selfId]);
  if (!open) return null;
  const pick = (it: PickItem | undefined) => {
    if (!it || !editor) return;
    const href = it.type === "doc" ? `/app/docs/${it.id}` : `/app/tasks?view=list&task=${it.id}`;
    editor.view.focus(); // at once, so the next key lands in the doc, not the search box
    editor.chain().focus().insertContent([{ type: "text", text: it.title, marks: [{ type: "link", attrs: { href } }] }, { type: "text", text: " " }]).run();
    onClose();
  };
  return (
    <div role="dialog" aria-label="Link a page or task" className="absolute left-0 top-full z-30 mt-1 w-80 rounded-xl border border-line bg-elevated p-2 shadow-pop" data-testid="page-link-picker">
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="Find a page or task" aria-label="Find a page or task"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); editor?.commands.focus(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); pick(items[sel]); }
        }}
        className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13.5px] outline-none focus:border-brand" />
      <ul role="listbox" aria-label="Matches" className="mt-1 max-h-64 overflow-auto">
        {items.map((it, i) => (
          <li key={`${it.type}:${it.id}`} role="option" aria-selected={i === sel}>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)} onMouseEnter={() => setSel(i)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px]", i === sel ? "bg-brand/10 text-fg" : "text-muted")}>
              {it.type === "doc" ? <FileText className="h-3.5 w-3.5 shrink-0" /> : <CheckSquare className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
              <span className="shrink-0 text-[11.5px] text-subtle">{it.hint}</span>
            </button>
          </li>
        ))}
        {!items.length && <li className="px-2 py-1.5 text-[13px] text-subtle">{term.length >= 2 && tasks.isFetching ? "Searching" : "No matches"}</li>}
      </ul>
    </div>
  );
}

/** Opens the picker when "[[" is typed, removing the brackets. Local edits only. */
export function useBracketTrigger(editor: Editor | null, onOpen: () => void) {
  useEffect(() => {
    if (!editor) return;
    const on = ({ transaction }: { transaction: { docChanged: boolean; getMeta: (k: string) => unknown } }) => {
      if (!transaction.docChanged || transaction.getMeta("y-sync$")) return;
      const { from, empty } = editor.state.selection;
      if (!empty || from < 2) return;
      if (editor.state.doc.textBetween(from - 2, from, "\n", "\n") === "[[") {
        editor.chain().deleteRange({ from: from - 2, to: from }).run();
        onOpen();
      }
    };
    editor.on("update", on as never);
    return () => { editor.off("update", on as never); };
  }, [editor, onOpen]);
}
