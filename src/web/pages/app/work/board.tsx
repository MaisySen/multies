import { useMemo, useState } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bot, CheckSquare, Flag, Mail, MessageSquare, Plus } from "lucide-react";
import { Avatar } from "@/web/components/ui/misc";
import { initials } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, positionBetween, type Project, type Task } from "./data";

export function TaskCard({ t, onOpen, dragging }: { t: Task; onOpen?: () => void; dragging?: boolean }) {
  return (
    <div className={cn("group rounded-lg border border-line bg-elevated p-3 text-left shadow-sm transition-colors hover:border-line-strong", dragging && "rotate-1 border-brand/40 shadow-pop")}>
      <button type="button" onClick={onOpen} className="block w-full text-left text-[13.5px] font-medium leading-snug text-fg outline-none focus-visible:underline">{t.title}</button>
      {t.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">{t.labels.slice(0, 3).map((l) => <span key={l} className="rounded bg-white/[0.06] px-1.5 py-px text-[11px] text-muted">{l}</span>)}</div>
      )}
      <div className="mt-2.5 flex items-center gap-2.5 text-[11.5px] text-subtle">
        <span className="font-mono">{t.ref}</span>
        {t.priority !== "none" && <span className={cn("inline-flex items-center gap-0.5", PRIORITY_COLOR[t.priority])} title={PRIORITY_LABEL[t.priority]}><Flag className="h-3 w-3" />{PRIORITY_LABEL[t.priority]}</span>}
        {t.due && <span className={cn(isOverdue(t) && "text-bad")}>{dueLabel(t.due)}</span>}
        {t.source && <Mail className="h-3 w-3" aria-label="From email" />}
        {t.subtasks.total > 0 && <span className="inline-flex items-center gap-0.5"><CheckSquare className="h-3 w-3" />{t.subtasks.done}/{t.subtasks.total}</span>}
        {t.commentCount > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t.commentCount}</span>}
        <span className="ml-auto">
          {t.assignee && (t.assignee.type === "agent"
            ? <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-brand-hover" title={`${t.assignee.name} (agent)`}><Bot className="h-3 w-3" /></span>
            : <span title={t.assignee.name}><Avatar label={initials(t.assignee.name)} className="h-5 w-5 text-[9px]" /></span>)}
        </span>
      </div>
    </div>
  );
}

function SortableCard({ t, onOpen }: { t: Task; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { statusId: t.statusId } });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      className={cn("touch-none", isDragging && "opacity-40")} data-testid="board-card" aria-roledescription="Draggable task">
      <TaskCard t={t} onOpen={onOpen} />
    </li>
  );
}

function Column({ id, title, color, count, children, onAdd }: { id: string; title: string; color: string; count: number; children: React.ReactNode; onAdd: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { statusId: id } });
  return (
    <section aria-label={title} data-testid={`column-${title}`} className={cn("flex w-[280px] shrink-0 flex-col rounded-xl border border-line bg-surface/70", isOver && "border-brand/40")}>
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[12px] text-subtle tabular-nums">{count}</span>
        <button onClick={onAdd} className="ml-auto rounded p-1 text-subtle hover:bg-elevated hover:text-fg" aria-label={`Add a task to ${title}`}><Plus className="h-3.5 w-3.5" /></button>
      </header>
      <ul ref={setNodeRef} className="flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">{children}</ul>
    </section>
  );
}

/** Kanban: columns are the project's statuses. Drag a card to move or reorder it. */
export function Board({ project, tasks, onOpen, onMove, onAdd }: {
  project: Project; tasks: Task[]; onOpen: (id: string) => void;
  onMove: (id: string, statusId: string, position: number) => void; onAdd: (statusId: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [activeId, setActiveId] = useState<string | null>(null);
  // Local column assignment while dragging, so the card shows in the column it hovers.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const columns = useMemo(() => {
    const by: Record<string, Task[]> = Object.fromEntries(project.statuses.map((s) => [s.id, []]));
    for (const t of tasks) { const sid = overrides[t.id] ?? t.statusId; (by[sid] ??= []).push(t); }
    for (const list of Object.values(by)) list.sort((a, b) => a.position - b.position);
    return by;
  }, [project.statuses, tasks, overrides]);
  const statusOf = (id: string | number) => {
    const s = String(id);
    if (s.startsWith("col:")) return s.slice(4);
    const t = tasks.find((x) => x.id === s);
    return t ? overrides[t.id] ?? t.statusId : undefined;
  };
  const active = tasks.find((t) => t.id === activeId);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const to = statusOf(e.over.id);
    const from = statusOf(e.active.id);
    if (to && from && to !== from) setOverrides((o) => ({ ...o, [String(e.active.id)]: to }));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    setActiveId(null);
    const to = e.over ? statusOf(e.over.id) : undefined;
    setOverrides({});
    if (!to) return;
    const list = (columns[to] ?? []).filter((t) => t.id !== id);
    let index = list.length;
    if (e.over && !String(e.over.id).startsWith("col:")) {
      const overIndex = list.findIndex((t) => t.id === String(e.over!.id));
      if (overIndex >= 0) {
        const original = tasks.find((t) => t.id === id);
        const sameCol = original?.statusId === to;
        const oldIndex = sameCol ? (columns[to] ?? []).findIndex((t) => t.id === id) : -1;
        index = sameCol && oldIndex >= 0 && oldIndex <= overIndex ? overIndex + 1 : overIndex;
      }
    }
    const position = positionBetween(list[index - 1]?.position, list[index]?.position);
    const t = tasks.find((x) => x.id === id);
    if (t && (t.statusId !== to || Math.abs(t.position - position) > 1e-9)) onMove(id, to, position);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); setOverrides({}); }}>
      <div className="flex h-full gap-3 overflow-x-auto pb-4" data-testid="board">
        {project.statuses.map((s) => (
          <Column key={s.id} id={s.id} title={s.name} color={s.color} count={columns[s.id]?.length ?? 0} onAdd={() => onAdd(s.id)}>
            <SortableContext items={(columns[s.id] ?? []).map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {(columns[s.id] ?? []).map((t) => <SortableCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}
            </SortableContext>
          </Column>
        ))}
      </div>
      <DragOverlay>{active ? <TaskCard t={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
