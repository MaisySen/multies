import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRevealRow, useWindowedList } from "@/web/lib/use-windowed-list"; // R44 (MB-210 follow up)
import { IconAgent, IconChat, IconFlag, IconGrip, IconMail, IconPlus, IconTasks } from "@/web/components/ui/icon";
import { Avatar } from "@/web/components/ui/misc";
import { initials } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, positionBetween, type CustomField, type Project, type Task, isAgentLike } from "./data";
import { ChecklistChip } from "./task-checklist"; // R26 (MB-85)
import { ClashBadge } from "./schedule-r38"; // R38: date clash badge
import { CardQuickEdits, CardTitle } from "./board-card-edit"; // R36
import { tone } from "@/web/components/app-bits";
import { TypeIcon } from "./task-type";
import { LimitChip, LimitMenu, overLimitToast } from "./board-lanes"; // R34 (MB-186)
import { limitState, wouldExceed, type BoardLimits, type ColumnLimit } from "@/shared/board-lanes";

export function TaskCard({ t, onOpen, dragging, handle, project }: { t: Task; onOpen?: () => void; dragging?: boolean; handle?: React.ReactNode; /** R36: given, the card edits in place. */ project?: Project }) {
  return (
    <div className={cn("group rounded-lg border border-line bg-elevated p-3 text-left shadow-sm transition-colors hover:border-line-strong", dragging && "rotate-1 border-brand/40 shadow-pop")}>
      {project ? <CardTitle t={t} onOpen={onOpen} /> : <button type="button" onClick={onOpen} className="block min-h-6 w-full text-left text-[13.5px] font-medium leading-snug text-fg outline-none focus-visible:underline">{t.title}</button>}
      {t.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">{t.labels.slice(0, 3).map((l) => <span key={l} className="rounded bg-fill px-1.5 py-px text-[11px] text-muted">{l}</span>)}</div>
      )}
      <div className="mt-2.5 flex items-center gap-2.5 text-[11.5px] text-subtle">
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"><TypeIcon type={t.type} /><span className="font-mono">{t.ref}</span></span>
        {!project && t.priority !== "none" && <span className={cn("inline-flex items-center gap-0.5", PRIORITY_COLOR[t.priority])} title={PRIORITY_LABEL[t.priority]}><IconFlag className="h-3 w-3" />{PRIORITY_LABEL[t.priority]}</span>}
        {!project && t.due && <span className={cn(isOverdue(t) && "text-bad")}>{dueLabel(t.due)}</span>}
        {t.source && <IconMail className="h-3 w-3" aria-label="From email" />}
        {t.subtasks.total > 0 && <span className="inline-flex items-center gap-0.5"><IconTasks className="h-3 w-3" />{t.subtasks.done}/{t.subtasks.total}</span>}
        <ChecklistChip checklist={t.checklist} />
        <ClashBadge id={t.id} />
        {t.commentCount > 0 && <span className="inline-flex items-center gap-0.5"><IconChat className="h-3 w-3" />{t.commentCount}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {project && <CardQuickEdits t={t} project={project} />}
          {!project && t.assignee && (isAgentLike(t.assignee)
            ? <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-brand-hover" title={`${t.assignee.name} (agent)`}><IconAgent className="h-3 w-3" /></span>
            : <span title={t.assignee.name}><Avatar label={initials(t.assignee.name)} className="h-5 w-5 text-[9px]" /></span>)}
          {handle}
        </span>
      </div>
    </div>
  );
}

export function SortableCard({ t, onOpen, project, win }: { t: Task; onOpen: () => void; project?: Project;
  /** R44: position in a windowed column (index from 0, and the column's full size) for the windowing hook and screen readers. */
  win?: { index: number; size: number } }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { statusId: t.statusId } });
  return (
    // The card drags by pointer anywhere on it; keyboard and screen reader users get a
    // separate handle, so the list item itself is not a button wrapping other buttons.
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...listeners}
      className={cn("touch-none rounded-lg", isDragging && "opacity-40")} data-testid="board-card" data-task-id={t.id}
      {...(win ? { "data-win-row": win.index, "data-win-key": t.id, "aria-posinset": win.index + 1, "aria-setsize": win.size } : {})}>
      <TaskCard t={t} onOpen={onOpen} project={project} handle={
        <button type="button" {...attributes} {...listeners} aria-roledescription="Draggable task" aria-label={`Move ${t.title}`}
          className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-surface hover:text-fg"><IconGrip className="h-3.5 w-3.5" aria-hidden /></button>
      } />
    </li>
  );
}

/**
 * R44 (MB-210 follow up): the cards of one column, windowed. From 150 cards only the cards in view (plus a few above
 * and below) are mounted; spacers keep the column's scroll height, using each card's measured height. The sortable
 * list still holds every id, so drops land in the right place, the dragged card's column follows the pointer, and
 * J and K bring a card outside the window into view with its ring.
 */
export function ColumnCards({ list, project, onOpen, listRef, activeId }: { list: Task[]; project?: Project; onOpen: (id: string) => void;
  listRef: React.RefObject<HTMLUListElement | null>; activeId: string | null }) {
  const ids = useMemo(() => list.map((t) => t.id), [list]);
  const win = useWindowedList({ count: list.length, estimate: 96, listRef, keys: ids, gap: 8, overscan: 6 });
  useRevealRow(ids, win, listRef);
  const rows: { t: Task; i: number }[] = [];
  for (let i = win.start; i < win.end; i++) rows.push({ t: list[i], i });
  // The card being dragged stays mounted even when the column scrolls it out of the window.
  const activeAt = activeId && win.windowed ? ids.indexOf(activeId) : -1;
  const keepActive = activeAt >= 0 && (activeAt < win.start || activeAt >= win.end);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {win.start > 0 && <li aria-hidden className="shrink-0" style={{ height: win.padTop }} />}
      {keepActive && activeAt < win.start && <SortableCard key={activeId} t={list[activeAt]} project={project} onOpen={() => onOpen(activeId!)} />}
      {rows.map(({ t, i }) => <WinCard key={t.id} t={t} project={project} onOpen={onOpen} index={i} size={win.windowed ? list.length : 0} />)}
      {keepActive && activeAt >= win.end && <SortableCard key={activeId} t={list[activeAt]} project={project} onOpen={() => onOpen(activeId!)} />}
      {win.end < list.length && <li aria-hidden className="shrink-0" style={{ height: win.padBottom }} />}
    </SortableContext>
  );
}

/** R44: a card that re-renders only when its task, position or column size changes (scrolling mounts a few per frame). */
const WinCard = memo(function WinCard({ t, project, onOpen, index, size }: { t: Task; project?: Project; onOpen: (id: string) => void; index: number; size: number }) {
  const open = useCallback(() => onOpen(t.id), [onOpen, t.id]);
  return <SortableCard t={t} project={project} onOpen={open} win={size ? { index, size } : undefined} />;
});

function BoardColumn({ list, project, onOpen, activeId, ...col }: Omit<React.ComponentProps<typeof Column>, "children" | "listRef" | "count"> & {
  list: Task[]; project: Project; onOpen: (id: string) => void; activeId: string | null }) {
  const listRef = useRef<HTMLUListElement | null>(null);
  return (
    <Column {...col} count={list.length} listRef={listRef}>
      <ColumnCards list={list} project={project} onOpen={onOpen} listRef={listRef} activeId={activeId} />
    </Column>
  );
}

/**
 * R41 (MB-208): rapid entry at the foot of a column. Enter adds the task and keeps the field open and focused for the
 * next one; the new row shows at once (faded until the server answers). Escape, or leaving the field empty, closes it.
 * Creates go through the idempotent api.create, so a retried add is never doubled.
 */
export function ColumnComposer({ title, onQuickAdd, variant = "column" }: {
  title: string; onQuickAdd: (title: string) => Promise<unknown>;
  /** R42: "list" is the same rapid add drawn as a row at the foot of the Tasks list. */
  variant?: "column" | "list";
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ key: number; title: string }[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const key = ++seq.current;
    setPending((p) => [...p, { key, title: t }]);
    setText("");
    requestAnimationFrame(() => ref.current?.focus());
    void onQuickAdd(t).catch(() => { setText((cur) => cur || t); }).finally(() => setPending((p) => p.filter((x) => x.key !== key)));
  };
  const list = variant === "list";
  return (
    <div className={list ? "mt-2" : "px-2 pb-2"} data-testid={list ? "list-composer" : `composer-${title}`}>
      {pending.map((p) => (
        <div key={p.key} className={list ? "mb-2 flex min-h-12 items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 text-[14px] text-fg opacity-60 sm:min-h-10"
          : "mb-2 rounded-lg border border-line bg-elevated px-3 py-2.5 text-[13.5px] opacity-60 elev-1"} data-testid="pending-card" aria-busy="true">
          {list && <span className="h-4 w-4 shrink-0 animate-pulse rounded-full border-2 border-line-strong motion-reduce:animate-none" aria-hidden />}{p.title}
        </div>
      ))}
      {open ? (
        <input ref={ref} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Task name, then Enter" aria-label={`New task in ${title}`} maxLength={500}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } else if (e.key === "Escape") { e.preventDefault(); setText(""); setOpen(false); } }}
          onBlur={() => { if (!text.trim()) setOpen(false); }}
          className="h-11 w-full rounded-lg border border-brand bg-surface px-3 text-[14px] text-fg outline-none ring-4 ring-brand/15 placeholder:text-subtle max-sm:text-base sm:h-10" />
      ) : (
        list ? (
          <button type="button" onClick={() => setOpen(true)} aria-label="Add task" title={`Add a task to ${title}`}
            className="group flex min-h-12 w-full items-center gap-2.5 rounded-xl border border-dashed border-line-strong px-3.5 text-left text-[15px] text-muted transition-colors duration-150 hover:border-brand/50 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 motion-reduce:transition-none sm:min-h-10 sm:text-[13.5px]">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-hover transition-transform duration-150 group-active:scale-90 motion-reduce:transition-none" aria-hidden><IconPlus className="h-3.5 w-3.5" /></span>
            <span>Add task</span><span className="ml-auto truncate text-[12px] text-subtle">{title}</span>
          </button>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg motion-reduce:transition-none sm:min-h-9">
            <IconPlus className="h-3.5 w-3.5" aria-hidden />Add task
          </button>
        )
      )}
    </div>
  );
}

function Column({ id, title, color, count, children, onAdd, limit, onSetLimit, onQuickAdd, listRef }: { id: string; title: string; color: string; count: number; children: React.ReactNode; onAdd: () => void;
  /** R44: the card list element, for the windowing hook. */
  listRef?: React.MutableRefObject<HTMLUListElement | null>;
  onQuickAdd?: (title: string) => Promise<unknown>;
  /** R34 (MB-186): this column's WIP limit, and the header menu to change it. */
  limit?: ColumnLimit; onSetLimit?: (v: { max?: number | null; min?: number | null }) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { statusId: id } });
  const over = limitState(count, limit) === "over";
  return (
    <section aria-label={title} data-testid={`column-${title}`} data-over={over ? "true" : undefined}
      className={cn("flex w-[min(280px,85vw)] shrink-0 snap-start flex-col rounded-xl border border-t-2 border-line bg-surface/70 transition-colors duration-150 motion-reduce:transition-none", over ? "border-t-[#D70015]" : "border-t-transparent", isOver && "border-brand/40")}>
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2 w-2 rounded-full" style={{ background: tone(color) }} aria-hidden />
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <LimitChip count={count} limit={limit} />
        {onSetLimit && <span className="ml-auto"><LimitMenu title={title} limit={limit} onSet={onSetLimit} /></span>}
        <button onClick={onAdd} className={cn(!onSetLimit && "ml-auto", "inline-flex h-10 w-10 items-center justify-center rounded text-subtle hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:p-1")} aria-label={`Add a task to ${title}`}><IconPlus className="h-3.5 w-3.5" /></button>
      </header>
      <ul ref={(el) => { setNodeRef(el); if (listRef) listRef.current = el; }} aria-label={`${title} cards`} data-testid="board-column-cards"
        className={cn("flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain px-2 [overflow-anchor:none]", onQuickAdd ? "pb-2" : "pb-3")}>{children}</ul>
      {onQuickAdd && <ColumnComposer title={title} onQuickAdd={onQuickAdd} />}
    </section>
  );
}

/** Kanban: columns are the project's statuses. Drag a card to move or reorder it. */
export const NO_VALUE = "__none";

const EPIC_COLOR = "#5856d6";

/** Round 22: board columns when grouped by epic: each epic (by board order), then "No epic". */
export function epicColumns(tasks: Pick<Task, "id" | "title" | "type" | "position">[]) {
  const epics = tasks.filter((t) => t.type === "epic").sort((a, b) => a.position - b.position);
  return [...epics.map((e) => ({ id: e.id, name: e.title, color: EPIC_COLOR })), { id: NO_VALUE, name: "No epic", color: "#8e8e93" }];
}

/** The epic column a card sits in: its parent when that parent is one of the columns, else "No epic". */
export function epicKey(t: Pick<Task, "parentId">, cols: { id: string }[]) {
  return t.parentId && t.parentId !== NO_VALUE && cols.some((c) => c.id === t.parentId) ? t.parentId : NO_VALUE;
}

/**
 * Kanban: columns are the project's statuses, or the options of a single select field when
 * `groupBy` is set (plus a column for tasks with no value). Drag a card to move or reorder it.
 */
const EMPTY: Task[] = [];

export function Board({ project, tasks: allTasks, onOpen, onMove, onAdd, onQuickAdd, groupBy, byEpic, limits, onSetLimit }: {
  /** R41 (MB-208): inline rapid add at the foot of each status column (not offered when grouped by a field or epic). */
  onQuickAdd?: (columnId: string, title: string) => Promise<unknown>;
  project: Project; tasks: Task[]; onOpen: (id: string) => void;
  /** R34 (MB-186): WIP limits per column id, and the header menu that changes them. */
  limits?: BoardLimits; onSetLimit?: (columnId: string, v: { max?: number | null; min?: number | null }) => void;
  onMove: (id: string, columnId: string, position: number) => void; onAdd: (columnId: string) => void;
  groupBy?: CustomField;
  /** Round 22: one column per epic in the project, plus "No epic". Epics themselves are the columns, not cards. */
  byEpic?: boolean;
}) {
  const epicCols = useMemo(() => byEpic ? epicColumns(allTasks) : null, [byEpic, allTasks]);
  const tasks = useMemo(() => byEpic ? allTasks.filter((t) => t.type !== "epic") : allTasks, [byEpic, allTasks]);
  const cols = useMemo(() => epicCols
    ? epicCols
    : groupBy
    ? [...groupBy.options.map((o) => ({ id: o.id, name: o.label, color: o.color })), { id: NO_VALUE, name: `No ${groupBy.name.toLowerCase()}`, color: "#8e8e93" }]
    : project.statuses.map((s) => ({ id: s.id, name: s.name, color: s.color })), [epicCols, groupBy, project.statuses]);
  const keyOf = useCallback((t: Task) => {
    if (epicCols) return epicKey(t, epicCols);
    if (!groupBy) return t.statusId;
    const v = t.fields?.[groupBy.id];
    return typeof v === "string" && groupBy.options.some((o) => o.id === v) ? v : NO_VALUE;
  }, [groupBy, epicCols]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [activeId, setActiveId] = useState<string | null>(null);
  // Local column assignment while dragging, so the card shows in the column it hovers.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const columns = useMemo(() => {
    const by: Record<string, Task[]> = Object.fromEntries(cols.map((s) => [s.id, []]));
    for (const t of tasks) { const sid = overrides[t.id] ?? keyOf(t); (by[sid] ??= []).push(t); }
    for (const list of Object.values(by)) list.sort((a, b) => a.position - b.position);
    return by;
  }, [cols, tasks, overrides, keyOf]);
  const statusOf = (id: string | number) => {
    const s = String(id);
    if (s.startsWith("col:")) return s.slice(4);
    const t = tasks.find((x) => x.id === s);
    return t ? overrides[t.id] ?? keyOf(t) : undefined;
  };
  const active = tasks.find((t) => t.id === activeId);
  // R44 (MB-210 follow up): each column windows its cards (ColumnCards); the R43 "Show 100 more" cap is gone.

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
        const sameCol = original ? keyOf(original) === to : false;
        const oldIndex = sameCol ? (columns[to] ?? []).findIndex((t) => t.id === id) : -1;
        index = sameCol && oldIndex >= 0 && oldIndex <= overIndex ? overIndex + 1 : overIndex;
      }
    }
    const position = positionBetween(list[index - 1]?.position, list[index]?.position);
    const t = tasks.find((x) => x.id === id);
    if (t && keyOf(t) !== to && limits?.[to]?.max !== undefined && wouldExceed(list.length + 1, limits[to])) {
      overLimitToast(cols.find((c) => c.id === to)?.name ?? "this column", limits[to]!.max!); // R34: the card still moves
    }
    if (t && (keyOf(t) !== to || Math.abs(t.position - position) > 1e-9)) onMove(id, to, position);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); setOverrides({}); }}>
      <div className="flex h-full snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-4 sm:snap-none" data-testid="board">
        {cols.map((s) => (
          <BoardColumn key={s.id} id={s.id} title={s.name} color={s.color} list={columns[s.id] ?? EMPTY} project={project} onOpen={onOpen} activeId={activeId} onAdd={() => onAdd(s.id)}
            onQuickAdd={onQuickAdd && !groupBy && !byEpic ? (title) => onQuickAdd(s.id, title) : undefined}
            limit={limits?.[s.id]} onSetLimit={onSetLimit ? (v) => onSetLimit(s.id, v) : undefined} />
        ))}
      </div>
      <DragOverlay>{active ? <TaskCard t={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
