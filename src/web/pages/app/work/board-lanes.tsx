/**
 * R34 (MB-186): board swimlanes and WIP limits on the web.
 * - useBoardSettings: one read per project board, one write per change (PUT /projects/:id/board), optimistic.
 * - LimitChip and LimitMenu: the "4 / 5" chip and the header menu that sets a column's max and min.
 * - LaneBoard: rows (lanes) by assignee, epic, priority or project, crossed with the status columns. Cards drag
 *   between columns and lanes; dropping in another lane sets that field. Collapsed lanes are remembered on this
 *   device only (no server write). Buckets are memoized lane x column so a 200 card board drags smoothly.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { IconAgent, IconBoardFolder, IconChevronRight, IconFlag, IconGauge, IconMountain, IconUserRound } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { initials } from "@/web/lib/format";
import { Avatar } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { PromptDialog } from "@/web/components/ui/confirm";
import {
  DEFAULT_BOARD, NO_LANE, PRIORITY_LANES, bucketLanes, cellId, columnTotals, limitLabel, limitState, parseCellId, wouldExceed,
  type BoardSettings, type ColumnLimit, type Lane, type Swimlanes,
} from "@/shared/board-lanes";
import { PRIORITY_LABEL, positionBetween, type AssigneeOption, type Project, type Task, isAgentLike } from "./data";
import { ColumnCards, TaskCard } from "./board";

export const SWIMLANE_LABEL: Record<Swimlanes, string> = { none: "None", assignee: "Assignee", epic: "Epic", priority: "Priority", project: "Project" };

// ---------------------------------------------------------------- settings

type BoardPatch = { swimlanes?: Swimlanes; column?: { id: string; max?: number | null; min?: number | null } };

export function useBoardSettings(projectId: string | undefined) {
  const qc = useQueryClient();
  const key = useMemo(() => ["board-settings", projectId ?? ""], [projectId]);
  const q = useQuery({
    queryKey: key, enabled: !!projectId, staleTime: 60_000,
    queryFn: async () => (await api.get<{ board: BoardSettings }>(`/projects/${projectId}/board`)).board,
  });
  const m = useMutation({
    mutationFn: async (patch: BoardPatch) => (await api.put<{ board: BoardSettings }>(`/projects/${projectId}/board`, patch)).board,
    onMutate: (patch) => {
      const prev = qc.getQueryData<BoardSettings>(key);
      const base = prev ?? DEFAULT_BOARD;
      let limits = { ...base.limits };
      if (patch.column) {
        const { id, max, min } = patch.column;
        const next: ColumnLimit = { ...(limits[id] ?? {}) };
        if (max !== undefined) { if (max) next.max = max; else delete next.max; }
        if (min !== undefined) { if (min) next.min = min; else delete next.min; }
        if (next.max === undefined && next.min === undefined) delete limits[id]; else limits = { ...limits, [id]: next };
      }
      qc.setQueryData<BoardSettings>(key, { swimlanes: patch.swimlanes ?? base.swimlanes, limits });
      return { prev };
    },
    onError: (e, _p, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); showError(e as Error); },
    onSuccess: (board) => qc.setQueryData(key, board),
  });
  return { settings: q.data ?? DEFAULT_BOARD, save: m.mutate };
}

// ---------------------------------------------------------------- column limit chip and menu

const LIMIT_PRESETS = [1, 2, 3, 5, 8, 13];

/** The count chip in a column header: "4 / 5", red with "Over limit" text past the max, amber under a min. */
export function LimitChip({ count, limit }: { count: number; limit?: ColumnLimit }) {
  const state = limitState(count, limit);
  return (
    <span data-testid="column-count" data-limit-state={state}
      className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11.5px] tabular-nums transition-colors duration-150 motion-reduce:transition-none",
        state === "over" ? "bg-[#D70015]/10 font-semibold text-[#D70015] dark:bg-[#FF6961]/15 dark:text-[#FF6961]"
          : state === "under" ? "bg-[#B25000]/10 text-[#B25000] dark:text-[#FFB340]"
          : state === "at" ? "bg-fill text-fg" : "text-subtle")}>
      {limitLabel(count, limit)}
      {state === "over" && <span className="text-[11px] font-medium">Over limit</span>}
      {state === "under" && <span className="sr-only">Under the minimum</span>}
    </span>
  );
}

/** Header menu: set or clear a column's maximum and minimum. One write per pick. */
export function LimitMenu({ title, limit, onSet }: { title: string; limit?: ColumnLimit; onSet: (v: { max?: number | null; min?: number | null }) => void }) {
  const [asking, setAsking] = useState<"max" | "min" | null>(null);
  const validate = (raw: string) => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 999 ? null : "Use a whole number from 1 to 999.";
  };
  return (
    <>
      <Menu align="end" label={`Limits for ${title}`} trigger={
        <button type="button" aria-label={`Set a limit for ${title}`} data-testid="column-limit-menu"
          className="grid h-11 w-11 place-items-center rounded-full text-subtle transition-colors hover:bg-elevated hover:text-fg sm:h-6 sm:w-6 sm:rounded"><IconGauge className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" /></button>
      }>
        <MenuLabel>Most cards in {title}</MenuLabel>
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {LIMIT_PRESETS.map((n) => (
            <button key={n} type="button" onClick={() => onSet({ max: n })} aria-pressed={limit?.max === n} data-testid={`limit-preset-${n}`} aria-label={`At most ${n}`}
              className={cn("h-8 min-w-8 rounded-lg border px-2 text-[13px] tabular-nums transition-colors duration-150", limit?.max === n ? "border-brand bg-brand text-white" : "border-line hover:bg-hover")}>{n}</button>
          ))}
        </div>
        <MenuItem onSelect={() => setAsking("max")}>Other maximum</MenuItem>
        <MenuItem onSelect={() => setAsking("min")}>{limit?.min ? `Minimum: ${limit.min}` : "Set a minimum"}</MenuItem>
        {(limit?.max !== undefined || limit?.min !== undefined) && <><div className="my-1 border-t border-line" /><MenuItem danger onSelect={() => onSet({ max: null, min: null })}>Remove limits</MenuItem></>}
      </Menu>
      <PromptDialog open={asking !== null} onClose={() => setAsking(null)} inputMode="numeric"
        title={asking === "min" ? `Fewest cards in ${title}` : `Most cards in ${title}`}
        label={asking === "min" ? "Minimum" : "Maximum"} hint="Leave empty for no limit. Cards can still go in; the column shows when it is over."
        initial={asking ? String(limit?.[asking] ?? "") : ""} validate={validate}
        onSubmit={(v) => { const side = asking!; setAsking(null); onSet({ [side]: v.trim() === "" ? null : Number(v) }); }} />
    </>
  );
}

/** Gentle note when a drop goes past a column's max. The card still moves. */
export function overLimitToast(colName: string, max: number) {
  toast(`Over the limit of ${max} for ${colName}`, { description: "The card moved. Finish something here to get back under.", duration: 4000 });
}

// ---------------------------------------------------------------- lanes

export type LaneTarget = { lane: string; col: string };
type LaneRow = Lane & { kind?: "agent" | "member" };

/** Lane rows for a mode. "No assignee", "No epic" and "No priority" always come last. */
/** "member:<id>" for a task's assignee; an optimistic update may hold the raw "member:<id>" string for a moment. */
export function assigneeKey(a: Task["assignee"] | string | null | undefined): string | null {
  if (!a) return null;
  if (typeof a === "string") return a;
  return `${a.type}:${a.id}`;
}

export function lanesFor(mode: Swimlanes, tasks: Task[], projects: Pick<Project, "id" | "name" | "color">[], people: AssigneeOption[] = []): LaneRow[] {
  if (mode === "assignee") {
    const seen = new Map<string, LaneRow>();
    for (const t of tasks) {
      const key = assigneeKey(t.assignee as Task["assignee"] | string | null);
      if (!key || seen.has(key)) continue;
      const a = typeof t.assignee === "object" ? t.assignee : null;
      const person = people.find((p) => p.id === key);
      const name = a?.name || person?.name || "Someone";
      const agent = a ? isAgentLike(a) : person ? person.type === "agent" || !!person.isAgent : false;
      seen.set(key, { id: key, name, kind: agent ? "agent" : "member" });
    }
    return [...[...seen.values()].sort((x, y) => x.name.localeCompare(y.name)), { id: NO_LANE, name: "No assignee" }];
  }
  if (mode === "epic") {
    const epics = tasks.filter((t) => t.type === "epic").sort((a, b) => a.position - b.position);
    return [...epics.map((e) => ({ id: e.id, name: e.title, color: "#5856d6" })), { id: NO_LANE, name: "No epic" }];
  }
  if (mode === "priority") return [...PRIORITY_LANES.map((p) => ({ id: p, name: PRIORITY_LABEL[p] })), { id: NO_LANE, name: "No priority" }];
  if (mode === "project") {
    const ids = new Set(tasks.map((t) => t.projectId));
    return projects.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, name: p.name, color: p.color }));
  }
  return [];
}

export function laneOf(mode: Swimlanes, t: Task, epicIds?: Set<string>): string {
  if (mode === "assignee") return assigneeKey(t.assignee as Task["assignee"] | string | null) ?? NO_LANE;
  if (mode === "epic") return t.parentId && epicIds?.has(t.parentId) ? t.parentId : NO_LANE;
  if (mode === "priority") return t.priority && t.priority !== "none" ? t.priority : NO_LANE;
  if (mode === "project") return t.projectId;
  return NO_LANE;
}

const collapseKey = (projectId: string, mode: Swimlanes) => `multies.board.lanes.${projectId}.${mode}`;
function readCollapsed(k: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(k) ?? "[]") as string[]); } catch { return new Set(); }
}

function LaneIcon({ mode, lane }: { mode: Swimlanes; lane: LaneRow }) {
  if (lane.id === NO_LANE) return <span className="grid h-6 w-6 place-items-center rounded-full border border-dashed border-line-strong text-subtle"><IconUserRound className="h-3.5 w-3.5" aria-hidden /></span>;
  if (mode === "assignee") return lane.kind === "agent"
    ? <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-brand-hover"><IconAgent className="h-3.5 w-3.5" aria-hidden /></span>
    : <Avatar label={initials(lane.name)} className="h-6 w-6 text-[10px]" />;
  if (mode === "epic") return <IconMountain className="h-4 w-4" style={{ color: lane.color }} aria-hidden />;
  if (mode === "priority") return <IconFlag className="h-4 w-4 text-subtle" aria-hidden />;
  return <IconBoardFolder className="h-4 w-4" style={{ color: lane.color }} aria-hidden />;
}

const Cell = memo(function Cell({ lane, col, cards, onOpen, over }: { lane: string; col: string; cards: Task[]; onOpen: (id: string) => void; over: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: cellId(lane, col) });
  const listRef = useRef<HTMLUListElement | null>(null);
  return (
    <ul ref={(el) => { setNodeRef(el); listRef.current = el; }} data-testid="lane-cell" data-lane={lane} data-col={col}
      className={cn("flex min-h-[64px] w-[min(280px,80vw)] shrink-0 flex-col gap-2 rounded-xl border border-transparent bg-surface/60 p-2 transition-colors duration-150 motion-reduce:transition-none",
        isOver && "border-brand/40 bg-brand-soft/30", over && "border-t-[#D70015]/60")}>
      {/* R44: a cell with many cards windows them like a board column (the page scrolls a lane board). */}
      <ColumnCards list={cards} onOpen={onOpen} listRef={listRef} activeId={null} />
    </ul>
  );
});

/**
 * Swimlanes x status columns. onMove gets the card, its target lane and column and a position; the page turns
 * that into one task update (status plus the lane's field).
 */
export function LaneBoard({ project, tasks: allTasks, mode, projects, people = [], limits, onSetLimit, onOpen, onMove, collapseSignal }: {
  project: Project; tasks: Task[]; mode: Exclude<Swimlanes, "none">; projects: Pick<Project, "id" | "name" | "color">[]; people?: AssigneeOption[];
  limits: BoardSettings["limits"]; onSetLimit?: (col: string, v: { max?: number | null; min?: number | null }) => void;
  onOpen: (id: string) => void; onMove: (id: string, to: LaneTarget, position: number) => void;
  /** Bumped by the page's "collapse all lanes" key: odd collapses every lane, even opens them. */
  collapseSignal?: number;
}) {
  const tasks = useMemo(() => mode === "epic" ? allTasks.filter((t) => t.type !== "epic") : allTasks, [mode, allTasks]);
  const epicIds = useMemo(() => new Set(allTasks.filter((t) => t.type === "epic").map((t) => t.id)), [allTasks]);
  const lanes = useMemo(() => lanesFor(mode, allTasks, projects, people), [mode, allTasks, projects, people]);
  const cols = project.statuses;
  const colIds = useMemo(() => cols.map((c) => c.id), [cols]);
  const [overrides, setOverrides] = useState<Record<string, LaneTarget>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const placeOf = useCallback((t: Task): LaneTarget => overrides[t.id] ?? { lane: laneOf(mode, t, epicIds), col: t.statusId }, [overrides, mode, epicIds]);
  const buckets = useMemo(() => bucketLanes(tasks, lanes, colIds, (t) => placeOf(t).lane, (t) => placeOf(t).col), [tasks, lanes, colIds, placeOf]);
  const totals = useMemo(() => columnTotals(buckets, colIds), [buckets, colIds]);

  const ck = collapseKey(project.id, mode);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(ck));
  useEffect(() => { setCollapsed(readCollapsed(ck)); }, [ck]);
  const persist = useCallback((s: Set<string>) => { setCollapsed(s); try { localStorage.setItem(ck, JSON.stringify([...s])); } catch { /* private mode */ } }, [ck]);
  const toggle = (id: string) => { const s = new Set(collapsed); if (s.has(id)) s.delete(id); else s.add(id); persist(s); };
  useEffect(() => {
    if (!collapseSignal) return;
    persist(collapseSignal % 2 === 1 ? new Set(lanes.map((l) => l.id)) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const targetOf = (overId: string | number): LaneTarget | undefined => {
    const cell = parseCellId(String(overId));
    if (cell) return cell;
    const t = tasks.find((x) => x.id === String(overId));
    return t ? placeOf(t) : undefined;
  };
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const to = targetOf(e.over.id);
    const t = tasks.find((x) => x.id === String(e.active.id));
    if (!to || !t) return;
    const from = placeOf(t);
    if (mode === "project" && to.lane !== from.lane) return; // a card does not change project by a lane drag
    if (to.lane !== from.lane || to.col !== from.col) setOverrides((o) => ({ ...o, [t.id]: to }));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    setActiveId(null);
    let to = e.over ? targetOf(e.over.id) : undefined;
    const t = tasks.find((x) => x.id === id);
    setOverrides({});
    if (!to || !t) return;
    const home = { lane: laneOf(mode, t, epicIds), col: t.statusId };
    if (mode === "project") to = { lane: home.lane, col: to.col };
    const list = (buckets[to.lane]?.[to.col] ?? []).filter((x) => x.id !== id);
    let index = list.length;
    if (e.over && !parseCellId(String(e.over.id))) {
      const overIndex = list.findIndex((x) => x.id === String(e.over!.id));
      if (overIndex >= 0) index = overIndex;
    }
    const position = positionBetween(list[index - 1]?.position, list[index]?.position);
    const moved = home.lane !== to.lane || home.col !== to.col;
    if (!moved && Math.abs(t.position - position) <= 1e-9) return;
    if (home.col !== to.col) {
      // Totals already count the card in its hovered column (overrides), so count it once.
      const others = Object.values(buckets).reduce((n, byCol) => n + (byCol[to!.col] ?? []).filter((x) => x.id !== id).length, 0);
      const max = limits[to.col]?.max;
      if (max !== undefined && wouldExceed(others + 1, limits[to.col])) overLimitToast(cols.find((c) => c.id === to!.col)?.name ?? "this column", max);
    }
    onMove(id, to, position);
  };
  const active = tasks.find((x) => x.id === activeId);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); setOverrides({}); }}>
      <div className="h-full overflow-auto overscroll-contain pb-4" data-testid="lane-board" data-swimlanes={mode}>
        <div className="inline-flex min-w-full flex-col gap-1">
          <div className="sticky top-0 z-10 flex gap-2 bg-canvas/85 pb-2 backdrop-blur">
            {cols.map((c) => {
              const lim = limits[c.id];
              const over = limitState(totals[c.id] ?? 0, lim) === "over";
              return (
                <div key={c.id} data-testid={`lane-col-${c.name}`} data-over={over ? "true" : undefined}
                  className={cn("flex w-[min(280px,80vw)] shrink-0 items-center gap-2 rounded-xl border border-line border-t-2 bg-surface/80 px-3 py-2 transition-colors duration-150 motion-reduce:transition-none", over ? "border-t-[#D70015]" : "border-t-transparent")}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
                  <span className="truncate text-[13px] font-semibold text-fg">{c.name}</span>
                  <LimitChip count={totals[c.id] ?? 0} limit={lim} />
                  <span className="ml-auto">{onSetLimit && <LimitMenu title={c.name} limit={lim} onSet={(v) => onSetLimit(c.id, v)} />}</span>
                </div>
              );
            })}
          </div>
          {lanes.map((l) => {
            const isCollapsed = collapsed.has(l.id);
            const count = colIds.reduce((n, c) => n + (buckets[l.id]?.[c]?.length ?? 0), 0);
            return (
              <section key={l.id} aria-label={`${l.name} lane`} data-testid="lane" data-lane={l.id} data-lane-name={l.name} className="border-t border-line/60 pt-1.5 first-of-type:border-t-0">
                <button type="button" onClick={() => toggle(l.id)} aria-expanded={!isCollapsed} data-testid="lane-toggle"
                  className="sticky left-0 mb-1.5 flex min-h-9 items-center gap-2 rounded-lg px-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/50">
                  <IconChevronRight className={cn("h-4 w-4 text-subtle transition-transform duration-200 motion-reduce:transition-none", !isCollapsed && "rotate-90")} aria-hidden />
                  <LaneIcon mode={mode} lane={l} />
                  <span className="text-[13.5px] font-semibold text-fg">{l.name}</span>
                  <span className="rounded-full bg-fill px-1.5 text-[11.5px] tabular-nums text-muted" aria-label={`${count} tasks`}>{count}</span>
                </button>
                <div className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none", isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}>
                  <div className="overflow-hidden">
                    {!isCollapsed && (
                      <div className="flex gap-2 pb-1.5">
                        {cols.map((c) => <Cell key={c.id} lane={l.id} col={c.id} cards={buckets[l.id]?.[c.id] ?? []} onOpen={onOpen} over={limitState(totals[c.id] ?? 0, limits[c.id]) === "over"} />)}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <DragOverlay>{active ? <TaskCard t={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
