/**
 * R95 mind map: a project's tasks and subtasks as a tree that grows to the right. Drag a node onto another to move
 * it under that task (or onto the project to make it top level); a move under its own subtask is refused; every
 * move has undo. Keyboard: arrows move between nodes, Enter opens, M starts a move, arrows pick where, Enter drops,
 * Escape cancels. Phones get an outline with a Move to menu on each row.
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Skeleton } from "@/web/components/ui/misc";
import { useTasks } from "./data";
import { toast } from "sonner";
import { cn } from "@/web/lib/cn";
import { useMediaQuery } from "@/web/lib/use-compact";
import { PHONE_QUERY } from "@/web/lib/phone";
import { Select } from "@/web/components/ui/input";
import { EmptyState } from "@/web/components/ui/misc";
import { IconChevronDown, IconChevronRight, IconListTree, IconProject } from "@/web/components/ui/icon";
import { tone } from "@/web/components/app-bits";
import { buildTree, wouldCycle, type MapNode } from "@/shared/tasks-plus-r95";

export interface MapTask { id: string; ref: string; title: string; parentId: string | null; status: string; projectId: string }
const ROOT = "__project__";
const COL_W = 236, ROW_H = 52, NODE_W = 200, NODE_H = 38;

interface Placed { id: string; title: string; ref: string; status: string; depth: number; y: number; parent: string | null; hasKids: boolean }

/** Tidy tree layout: each leaf gets its own row, a parent sits in the middle of its children. */
export function layoutTree(roots: MapNode<MapTask>[], collapsed: Set<string>, title: string): Placed[] {
  const out: Placed[] = [];
  let row = 0;
  const walk = (n: MapNode<MapTask>, depth: number, parent: string): number => {
    const kids = collapsed.has(n.item.id) ? [] : n.children;
    const ys = kids.map((k) => walk(k, depth + 1, n.item.id));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * ROW_H;
    out.push({ id: n.item.id, title: n.item.title, ref: n.item.ref, status: n.item.status, depth, y, parent, hasKids: n.children.length > 0 });
    return y;
  };
  const ys = roots.map((r) => walk(r, 1, ROOT));
  out.push({ id: ROOT, title, ref: "", status: "", depth: 0, y: ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : 0, parent: null, hasKids: roots.length > 0 });
  return out;
}

export function MindMap({ tasks, projectName, projectColor, onOpen, onMove }: {
  tasks: MapTask[]; projectName: string; projectColor?: string | null; onOpen: (id: string) => void;
  onMove: (id: string, parentId: string | null) => Promise<void>;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string>(ROOT);
  const [moving, setMoving] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const parentOf = useMemo(() => new Map(tasks.map((t) => [t.id, t.parentId])), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const roots = useMemo(() => buildTree(tasks), [tasks]);
  const placed = useMemo(() => layoutTree(roots, collapsed, projectName), [roots, collapsed, projectName]);
  const pos = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const order = useMemo(() => [...placed].sort((a, b) => a.y - b.y || a.depth - b.depth), [placed]);

  const canDrop = (id: string, target: string) => id !== target && !wouldCycle(parentOf, id, target === ROOT ? null : target) && (parentOf.get(id) ?? ROOT) !== target;
  const move = async (id: string, target: string) => {
    const t = byId.get(id); if (!t) return;
    const to = target === ROOT ? null : target;
    if (id === target || wouldCycle(parentOf, id, to)) { const msg = "A task can't go under one of its own subtasks."; setLive(msg); toast.error(msg); return; }
    if ((t.parentId ?? null) === to) return;
    const from = t.parentId ?? null;
    try {
      await onMove(id, to);
      const where = to ? `under ${byId.get(to)?.title}` : "to the top level";
      setLive(`Moved ${t.title} ${where}.`);
      toast(`Moved ${t.title} ${where}`, { action: { label: "Undo", onClick: () => void onMove(id, from) } });
    } catch { /* the caller shows the error */ }
  };

  const focusNode = (id: string) => { setFocus(id); requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus()); };
  const key = (e: KeyboardEvent, id: string) => {
    const p = pos.get(id)!; const i = order.findIndex((o) => o.id === id);
    const go = (to: string | undefined | null) => { if (to) { e.preventDefault(); focusNode(to); } };
    if (e.key === "ArrowDown") go(order[i + 1]?.id);
    else if (e.key === "ArrowUp") go(order[i - 1]?.id);
    else if (e.key === "ArrowLeft") { if (!moving && p.hasKids && !collapsed.has(id) && id !== ROOT) { e.preventDefault(); setCollapsed(new Set([...collapsed, id])); } else go(p.parent); }
    else if (e.key === "ArrowRight") { if (collapsed.has(id)) { e.preventDefault(); const c = new Set(collapsed); c.delete(id); setCollapsed(c); } else go(order.find((o) => o.parent === id)?.id); }
    else if (e.key === "Escape" && moving) { e.preventDefault(); setLive("Move cancelled."); setMoving(null); focusNode(moving); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (moving) { const m = moving; setMoving(null); if (canDrop(m, id)) void move(m, id); else setLive("Can't move it there."); focusNode(m); }
      else if (id !== ROOT) onOpen(id);
    } else if ((e.key === "m" || e.key === "M") && id !== ROOT && !moving) {
      e.preventDefault(); setMoving(id); setLive(`Moving ${byId.get(id)?.title}. Use the arrows to pick where, Enter to drop it there, Escape to cancel.`);
    }
  };

  if (!tasks.length) return <EmptyState icon={<IconListTree />} title="No tasks in this project yet" body="Add tasks and subtasks, then see them here as a map you can rearrange." />;
  if (phone) return <Outline roots={roots} projectName={projectName} parentOf={parentOf} tasks={tasks} onOpen={onOpen} onMove={(id, to) => void move(id, to ?? ROOT)} />;

  const width = (Math.max(...placed.map((p) => p.depth)) + 1) * COL_W + 24;
  const height = Math.max(...placed.map((p) => p.y)) + ROW_H + 24;
  const xy = (p: Placed) => ({ x: 12 + p.depth * COL_W, y: 12 + p.y });
  return (
    <div className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface" ref={box} data-testid="mind-map">
      <p className="sr-only" aria-live="polite">{live}</p>
      {moving && <div className="sticky left-0 top-0 z-10 bg-brand/10 px-4 py-2 text-[12.5px]" role="status">Moving {byId.get(moving)?.title}: pick a task and press Enter, or Escape to cancel.</div>}
      <div className="relative" style={{ width, height }} role="tree" aria-label={`${projectName} mind map`}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
          {placed.filter((p) => p.parent).map((p) => {
            const a = xy(pos.get(p.parent!)!), b = xy(p);
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
            return <path key={p.id} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--color-line-strong, #c7c7cc)" strokeWidth={1.5} />;
          })}
        </svg>
        {placed.map((p) => {
          const { x, y } = xy(p);
          const root = p.id === ROOT;
          const done = p.status === "done";
          const target = (moving && moving !== p.id && canDrop(moving, p.id)) || over === p.id;
          return (
            <div key={p.id} role="treeitem" aria-level={p.depth + 1} aria-expanded={p.hasKids ? !collapsed.has(p.id) : undefined} aria-selected={focus === p.id}
              data-node={p.id} data-testid={root ? "map-root" : "map-node"} tabIndex={focus === p.id ? 0 : -1} draggable={!root}
              onFocus={() => setFocus(p.id)} onKeyDown={(e) => key(e, p.id)} onDoubleClick={() => !root && onOpen(p.id)}
              onDragStart={(e: DragEvent) => { e.dataTransfer.setData("text/x-map-node", p.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e: DragEvent) => { const id = [...e.dataTransfer.types].includes("text/x-map-node"); if (id) { e.preventDefault(); setOver(p.id); } }}
              onDragLeave={() => setOver((o) => (o === p.id ? null : o))}
              onDrop={(e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/x-map-node"); if (id) void move(id, p.id); }}
              className={cn("absolute flex items-center gap-2 rounded-xl border px-2.5 text-[13px] shadow-sm outline-none transition-[box-shadow,background-color,top] duration-150 focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                root ? "border-transparent bg-fg text-bg font-semibold" : "cursor-grab border-line bg-elevated hover:bg-hover active:cursor-grabbing",
                target && "ring-2 ring-brand/60", moving === p.id && "opacity-50")}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}>
              {root ? <IconProject size={15} aria-hidden style={{ color: tone(projectColor) }} /> : <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full border", done ? "border-ok bg-ok" : p.status === "doing" ? "border-brand bg-brand/40" : "border-line-strong")} aria-hidden />}
              <span className={cn("min-w-0 flex-1 truncate", done && "text-subtle line-through")} title={p.title}>{p.title}</span>
              {p.hasKids && !root && (
                <button type="button" tabIndex={-1} aria-label={collapsed.has(p.id) ? `Show subtasks of ${p.title}` : `Hide subtasks of ${p.title}`}
                  onClick={(e) => { e.stopPropagation(); const c = new Set(collapsed); if (c.has(p.id)) c.delete(p.id); else c.add(p.id); setCollapsed(c); }}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-fill">{collapsed.has(p.id) ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}</button>
              )}
            </div>
          );
        })}
      </div>
      <p className="sticky bottom-0 left-0 bg-surface/90 px-4 py-2 text-[12px] text-subtle backdrop-blur">Drag a task onto another to move it under it. Keyboard: arrows to move around, M to move a task, Enter to open.</p>
    </div>
  );
}

/** Phones: the same tree as an indented outline, with Move to on each row. */
function Outline({ roots, projectName, parentOf, tasks, onOpen, onMove }: {
  roots: MapNode<MapTask>[]; projectName: string; parentOf: Map<string, string | null>; tasks: MapTask[]; onOpen: (id: string) => void; onMove: (id: string, to: string | null) => void;
}) {
  const rows: { n: MapNode<MapTask>; depth: number }[] = [];
  const walk = (n: MapNode<MapTask>, depth: number) => { rows.push({ n, depth }); n.children.forEach((c) => walk(c, depth + 1)); };
  roots.forEach((r) => walk(r, 0));
  return (
    <div className="rounded-xl border border-line bg-surface" data-testid="mind-map-outline">
      <p className="hairline-b px-4 py-2.5 text-[13px] font-semibold">{projectName}</p>
      <ul>
        {rows.map(({ n, depth }, i) => (
          <li key={n.item.id} className={cn("flex min-h-12 items-center gap-2 py-1 pr-2", i > 0 && "hairline-t")} style={{ paddingLeft: 16 + depth * 18 }} data-testid="outline-row">
            <button type="button" className={cn("min-w-0 flex-1 truncate text-left text-[14px]", n.item.status === "done" && "text-subtle line-through")} onClick={() => onOpen(n.item.id)}>{n.item.title}</button>
            <Select aria-label={`Move ${n.item.title} to`} value={n.item.parentId ?? ""} onChange={(e) => onMove(n.item.id, e.target.value || null)} className="h-11 w-32 shrink-0 text-[13px]">
              <option value="">Top level</option>
              {tasks.filter((t) => t.id !== n.item.id && !wouldCycle(parentOf, n.item.id, t.id)).map((t) => <option key={t.id} value={t.id}>Under {t.title}</option>)}
            </Select>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The view in the Tasks page: loads the project's tasks with their subtasks. */
export function MindMapView({ project, onOpen }: { project: { id: string; name: string; color?: string | null }; onOpen: (id: string) => void }) {
  const q = useTasks({ projectId: project.id, includeSubtasks: "true" });
  const qc = useQueryClient();
  const onMove = async (id: string, parentId: string | null) => {
    try { await api.patch(`/tasks/${id}`, { parentId }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch (e) { showError(e as Error); throw e; }
  };
  if (q.isPending) return <Skeleton className="h-[420px] rounded-xl" />;
  const tasks = (q.data ?? []).filter((t) => t.projectId === project.id).map((t) => ({ id: t.id, ref: t.ref, title: t.title, parentId: t.parentId ?? null, status: t.status, projectId: t.projectId }));
  return <MindMap tasks={tasks} projectName={project.name} projectColor={project.color} onOpen={onOpen} onMove={onMove} />;
}

export default MindMapView;
