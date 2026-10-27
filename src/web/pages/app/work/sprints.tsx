/**
 * Round 21 (R21.1): the Sprints view of a project. The current sprint with its tasks, goal, dates,
 * totals and burndown on the left; the backlog on the right. Start and Complete (with the carry over
 * choice), plan and edit sprints, and "Move to sprint" on every row. The chart is a plain inline SVG.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowRightLeft, IconCalendarRange, IconCheckCircle, IconCircle, IconEdit, IconFlag, IconPlay, IconPlus, IconTarget } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Kbd, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";
import type { Project, Task } from "./data";
import { useSprints, type Sprint } from "./sprint-fields";
import { NoSprintsArt } from "@/web/components/illustrations"; // R36
import { useWindowedList } from "@/web/lib/use-windowed-list"; // R44 (MB-210 follow up)
import { listKey, selectionMessage } from "@/web/lib/list-keys";
import { ListCapNotice } from "@/web/components/list-cap-notice"; // R45b
import { listIsCapped } from "@/shared/task-list-limit"; // R45: backlog keyboard selection

export type { Sprint };

export interface Burndown { unit: "points" | "tasks"; timeZone: string; start: number; days: { date: string; remaining: number | null; ideal: number }[]; scope: number; done: number; remaining: number }
interface SprintDetail { sprint: Sprint; unit: "points" | "hours"; tasks: Task[]; burndown: Burndown }

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const dateInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** A date field means that whole day in the person's own zone: midnight to the last millisecond. */
const fromDateInput = (v: string, end = false) => {
  const [y, m, d] = v.split("-").map(Number);
  return end ? new Date(y, m - 1, d, 23, 59, 59, 999).toISOString() : new Date(y, m - 1, d).toISOString();
};
export const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const sprintKeys = {
  one: (id: string) => ["sprint", id] as const,
  backlog: (projectId: string) => ["sprint-backlog", projectId] as const,
};

function useRefreshSprints(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["sprints", projectId] });
    void qc.invalidateQueries({ queryKey: ["sprint"] });
    void qc.invalidateQueries({ queryKey: ["sprint-backlog", projectId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["task"] });
  };
}

export function SprintsView({ project, onOpen }: { project: Project; onOpen: (id: string) => void }) {
  const list = useSprints(project.id);
  const refresh = useRefreshSprints(project.id);
  const sprints = useMemo(() => list.data?.sprints ?? [], [list.data]);
  // MB-62: ?sprint=<id> in the address opens that sprint (the API gives each sprint this link).
  const [picked, setPicked] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("sprint")));
  const fallback = sprints.find((s) => s.status === "active") ?? sprints.find((s) => s.status === "planned") ?? sprints[sprints.length - 1];
  const current = sprints.find((s) => s.id === picked) ?? fallback;
  useEffect(() => { if (picked && !sprints.some((s) => s.id === picked)) setPicked(null); }, [picked, sprints]);
  const detail = useQuery({ queryKey: sprintKeys.one(current?.id ?? ""), enabled: !!current, refetchInterval: 20_000,
    queryFn: async () => api.get<SprintDetail>(`/sprints/${current!.id}?timeZone=${encodeURIComponent(tz() ?? "")}`) });
  const backlog = useQuery({ queryKey: sprintKeys.backlog(project.id), refetchInterval: 20_000,
    queryFn: async () => (await api.get<{ tasks: Task[] }>(`/sprints/backlog?projectId=${project.id}`)).tasks });
  const [editing, setEditing] = useState<Sprint | "new" | null>(null);
  const [completing, setCompleting] = useState(false);
  const unit = list.data?.unit ?? "points";
  const open = sprints.filter((s) => s.status !== "completed");
  const active = sprints.find((s) => s.status === "active");

  const move = async (taskIds: string[], to: string | null, from?: string | null) => {
    try {
      if (to) await api.post(`/sprints/${to}/tasks`, { taskIds });
      else if (from) await api.post(`/sprints/${from}/tasks/remove`, { taskIds });
      refresh();
    } catch (e) { showError(e as Error); }
  };
  const start = async (s: Sprint) => {
    try { await api.post(`/sprints/${s.id}/start`, {}); refresh(); } catch (e) { showError(e as Error); }
  };

  if (list.isPending) return <Skeleton className="h-64" />;
  if (!sprints.length) {
    return (
      <>
        <EmptyState icon={<IconCalendarRange />} art={<NoSprintsArt />} title="No sprints yet" body="Plan a sprint, move tasks in from the backlog and watch the burndown as work gets done."
          action={<Button onClick={() => setEditing("new")}><IconPlus className="h-4 w-4" />Plan a sprint</Button>} />
        <BacklogPanel tasks={backlog.data ?? []} sprints={open} unit={unit} onOpen={onOpen} onMove={(ids, to) => void move(ids, to)} className="mt-6" />
        {editing && <SprintDialog projectId={project.id} sprint={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(s) => { setPicked(s.id); refresh(); }} />}
      </>
    );
  }

  const d = detail.data;
  const sprint = d?.sprint ?? current!;
  const points = (t: Task) => t.points ?? 0;
  const total = d ? d.tasks.reduce((a, t) => a + points(t), 0) : 0;
  const donePts = d ? d.tasks.filter((t) => t.status === "done").reduce((a, t) => a + points(t), 0) : 0;
  const unfinished = d ? d.tasks.filter((t) => t.status !== "done").length : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Sprint" value={sprint.id} onChange={(e) => setPicked(e.target.value)} className="h-9 w-auto! min-w-[150px] text-[13px] font-medium">
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === "active" ? " (active)" : s.status === "completed" ? " (done)" : ""}</option>)}
            </Select>
            <StatusBadge status={sprint.status} />
            <span className="text-[13px] text-muted">{dayLabel(sprint.startAt)} to {dayLabel(sprint.endAt)}</span>
            <div className="ml-auto flex items-center gap-2">
              {sprint.status !== "completed" && <Button variant="ghost" size="sm" onClick={() => setEditing(sprint)}><IconEdit className="h-3.5 w-3.5" />Edit</Button>}
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}><IconPlus className="h-3.5 w-3.5" />Plan sprint</Button>
              {sprint.status === "planned" && (
                <Button size="sm" disabled={!!active} title={active ? `${active.name} is still running` : undefined} onClick={() => void start(sprint)}><IconPlay className="h-3.5 w-3.5" />Start sprint</Button>
              )}
              {sprint.status === "active" && <Button size="sm" onClick={() => setCompleting(true)}><IconFlag className="h-3.5 w-3.5" />Complete sprint</Button>}
            </div>
          </div>
          {sprint.goal && <p className="mt-3 flex items-start gap-2 text-[13.5px] text-fg/90"><IconTarget className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{sprint.goal}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2">
            <Stat label="Tasks" value={d ? `${d.tasks.filter((t) => t.status === "done").length} of ${d.tasks.length} done` : "..."} />
            <Stat label={unit === "hours" ? "Hours" : "Points"} value={d ? `${fmtNum(donePts)} of ${fmtNum(total)} done` : "..."} />
            <Stat label={sprint.status === "completed" ? "Carried over" : "Left"} value={sprint.status === "completed" ? String(sprint.carriedOver) : d ? fmtNum(d.burndown.remaining) : "..."} />
          </div>
          {d && <BurndownChart data={d.burndown} unitLabel={d.burndown.unit === "tasks" ? "tasks" : unit} className="mt-4" />}
        </Card>

        <SprintDrop enabled={sprint.status !== "completed"} name={sprint.name} onDrop={(ids) => void move(ids, sprint.id)}>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">In {sprint.name}</h2>
            <span className="text-[12px] text-subtle">{d?.tasks.length ?? 0} tasks</span>
          </div>
          {!d ? <Skeleton className="m-4 h-24" /> : d.tasks.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-subtle">No tasks yet. Drag a backlog task here, or use Move to sprint.</p>
          ) : (
            <WindowedRows label="Sprint tasks" tasks={d.tasks} render={(t, win) => (
              <TaskRow key={t.id} task={t} unit={unit} onOpen={onOpen} win={win} menu={sprint.status !== "completed" && (
                <MoveMenu sprints={open.filter((s) => s.id !== sprint.id)} onMove={(to) => void move([t.id], to, sprint.id)} backlog />
              )} />
            )} />
          )}
        </SprintDrop>
      </div>

      <BacklogPanel tasks={backlog.data ?? []} sprints={open} unit={unit} onOpen={onOpen} onMove={(ids, to) => void move(ids, to)}
        target={sprint.status !== "completed" ? sprint : undefined} />

      {editing && <SprintDialog projectId={project.id} sprint={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(s) => { setPicked(s.id); refresh(); }} />}
      {completing && (
        <CompleteDialog sprint={sprint} unfinished={unfinished} next={open.find((s) => s.status === "planned") ?? null}
          onClose={() => setCompleting(false)} onDone={(nextId) => { setCompleting(false); setPicked(nextId); refresh(); }} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Sprint["status"] }) {
  return status === "active" ? <Badge tone="brand" dot>Active</Badge> : status === "completed" ? <Badge tone="ok">Completed</Badge> : <Badge>Planned</Badge>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-fill px-3 py-2">
      <div className="text-[11.5px] text-subtle">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

type RowWin = { index: number; size: number } | undefined;

function TaskRow({ task: t, unit, onOpen, menu, compact, win, select, drag, rowIndex }: { task: Task; unit: string; onOpen: (id: string) => void; menu?: React.ReactNode; compact?: boolean;
  /** R45: the row's place in the whole list, for keyboard selection. */
  rowIndex?: number;
  /** R44: position in a windowed list. */
  win?: RowWin;
  /** R44: the backlog's selection box (Shift selects a run). */
  select?: { checked: boolean; onToggle: (shift: boolean) => void };
  /** R44: the task ids this row carries when dragged (the selection when the row is in it). */
  drag?: () => string[] }) {
  return (
    <li className={cn("group flex items-center gap-2.5 border-b border-line px-4 py-2 last:border-0 hover:bg-hover/60", select?.checked && "bg-brand/[0.06] hover:bg-brand/10", drag && "cursor-grab active:cursor-grabbing")}
      data-testid={select ? "backlog-row" : undefined} data-task-id={t.id} data-row-index={rowIndex}
      {...(win ? { "data-win-row": win.index, "aria-posinset": win.index + 1, "aria-setsize": win.size } : {})}
      draggable={drag ? true : undefined}
      onDragStart={drag ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag())); e.dataTransfer.setData("text/plain", t.ref ?? t.title); } : undefined}>
      {select && (
        <input type="checkbox" aria-label={`Select ${t.title}`} checked={select.checked} readOnly data-backlog-check=""
          onClick={(e) => select.onToggle(e.shiftKey)} className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded accent-[#0071E3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" />
      )}
      {t.status === "done" ? <IconCheckCircle className="h-4 w-4 shrink-0 text-ok" aria-label="Done" /> : <IconCircle className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
      <span className={cn("shrink-0 text-[12px] tabular-nums text-subtle", compact ? "w-12" : "w-14")}>{t.ref}</span>
      <button className={cn("min-w-0 flex-1 truncate text-left text-[13.5px]", t.status === "done" && "text-muted line-through")} onClick={() => onOpen(t.id)}>{t.title}</button>
      {!compact && <span className="hidden text-[12px] text-muted sm:inline">{t.statusName}</span>}
      <span className="w-14 text-right text-[12px] tabular-nums text-muted" title={unit === "hours" ? "Hours" : "Points"}>{t.points != null ? `${fmtNum(t.points)} ${unit === "hours" ? "h" : "pt"}` : ""}</span>
      {menu}
    </li>
  );
}

/** R44: drag data for backlog rows going into a sprint. */
const DRAG_TYPE = "application/x-multies-task-ids";

/**
 * R44 (MB-210 follow up): a sprint or backlog list that renders only the rows in view from 150 rows up, with spacer
 * rows for the rest (rows are one fixed height). Counts and totals are worked out by the callers over every task.
 */
function WindowedRows({ label, tasks, render, onKeyDown, reveal }: { label: string; tasks: Task[]; render: (t: Task, win: RowWin) => React.ReactNode;
  /** R45: keys on the rows (the backlog's keyboard selection). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLUListElement>) => void;
  /** R45: filled with a function that brings row i into view and focuses its checkbox. */
  reveal?: React.MutableRefObject<((i: number) => void) | null> }) {
  const ref = useRef<HTMLUListElement | null>(null);
  const win = useWindowedList({ count: tasks.length, estimate: 41, listRef: ref });
  const scrollTo = win.scrollToIndex;
  if (reveal) reveal.current = (i: number) => {
    const focusIt = () => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-row-index="${i}"] [data-backlog-check]`);
      if (el) { el.focus(); el.closest("li")?.scrollIntoView({ block: "nearest" }); }
      return !!el;
    };
    if (focusIt()) return;
    // Render the new window now, so the next key press already lands on the new row (fast key repeat).
    flushSync(() => scrollTo(i));
    if (focusIt()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!focusIt()) requestAnimationFrame(focusIt); }));
  };
  const rows: React.ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) rows.push(render(tasks[i], win.windowed ? { index: i, size: tasks.length } : undefined));
  return (
    <ul ref={ref} aria-label={label} onKeyDown={onKeyDown}>
      {win.start > 0 && <li aria-hidden style={{ height: win.padTop }} />}
      {rows}
      {win.end < tasks.length && <li aria-hidden style={{ height: win.padBottom }} />}
    </ul>
  );
}

/** R44: the sprint's task card takes backlog rows dropped on it; it lights up while a drag is over it. */
function SprintDrop({ enabled, name, onDrop, children }: { enabled: boolean; name: string; onDrop: (ids: string[]) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) => enabled && e.dataTransfer.types.includes(DRAG_TYPE);
  return (
    <Card className={cn("overflow-hidden transition-[box-shadow,border-color] duration-150 motion-reduce:transition-none", over && "border-brand/50 ring-2 ring-brand/30")}
      data-testid="sprint-drop" aria-label={`Tasks in ${name}`}
      onDragOver={(e) => { if (!accepts(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        try { const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as unknown; if (Array.isArray(ids) && ids.length) onDrop(ids.map(String)); } catch { /* not ours */ }
      }}>
      {children}
    </Card>
  );
}

function MoveMenu({ sprints, onMove, backlog }: { sprints: Sprint[]; onMove: (to: string | null) => void; backlog?: boolean }) {
  return (
    <Menu label="Move to sprint" trigger={<button type="button" className="rounded-md p-1 text-subtle hover:bg-elevated hover:text-fg" aria-label="Move to sprint" title="Move to sprint"><IconArrowRightLeft className="h-3.5 w-3.5" /></button>}>
      <MenuLabel>Move to sprint</MenuLabel>
      {sprints.map((s) => <MenuItem key={s.id} onSelect={() => onMove(s.id)}>{s.name}{s.status === "active" ? " (active)" : ""}</MenuItem>)}
      {!sprints.length && !backlog && <p className="px-2.5 py-1.5 text-[12.5px] text-subtle">Plan a sprint first</p>}
      {backlog && <MenuItem onSelect={() => onMove(null)}>Back to the backlog</MenuItem>}
    </Menu>
  );
}

function BacklogPanel({ tasks, sprints, unit, onOpen, onMove, className, target }: { tasks: Task[]; sprints: Sprint[]; unit: string; onOpen: (id: string) => void; onMove: (ids: string[], to: string) => void; className?: string;
  /** R44: the sprint on screen; selected rows move there in one go, and rows can be dragged onto it. */
  target?: Sprint }) {
  const pts = tasks.reduce((a, t) => a + (t.points ?? 0), 0);
  const capped = listIsCapped(tasks.length); // R45b: the backlog read came back full
  // R44: multi select. A click toggles one row, Shift with a click selects the run from the last clicked row.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  useEffect(() => { setPicked((p) => { if (!p.size) return p; const live = new Set(ids); const n = new Set([...p].filter((id) => live.has(id))); return n.size === p.size ? p : n; }); }, [ids]);
  // R45: keyboard selection state (focused row, the Shift run's anchor and what was picked before the run).
  const kb = useRef<{ anchor: number | null; base: Set<number> | null }>({ anchor: null, base: null });
  const reveal = useRef<((i: number) => void) | null>(null);
  const [moveFor, setMoveFor] = useState<{ ids: string[]; back: number } | null>(null);
  const toggle = (i: number, shift: boolean) => {
    kb.current = { anchor: null, base: null };
    const from = anchor.current; // read now: the state update below runs later
    setPicked((p) => {
      const n = new Set(p);
      if (shift && from != null) {
        const [a, b] = from < i ? [from, i] : [i, from];
        for (let k = a; k <= b; k++) n.add(ids[k]);
      } else if (n.has(ids[i])) n.delete(ids[i]); else n.add(ids[i]);
      return n;
    });
    anchor.current = i;
  };
  const pickedIds = ids.filter((id) => picked.has(id));
  const pickedPts = tasks.reduce((a, t) => a + (picked.has(t.id) ? t.points ?? 0 : 0), 0);
  const u = unit === "hours" ? "h" : "pt";
  const moveTo = (to: string, list: string[]) => { onMove(list, to); setPicked(new Set()); anchor.current = null; kb.current = { anchor: null, base: null }; };
  // R45: the move menu lists the sprint on screen first, then the other open sprints.
  const moveTargets = target ? [target, ...sprints.filter((x) => x.id !== target.id)] : sprints;
  const onKeys = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const el = e.target as HTMLElement;
    if (!el.hasAttribute("data-backlog-check") || e.altKey) return;
    if (e.key === " ") return; // the checkbox toggles itself (and keeps Shift click runs working)
    const focus = Number(el.closest<HTMLElement>("[data-row-index]")?.dataset.rowIndex ?? -1);
    if (focus < 0) return;
    const now = new Set<number>();
    ids.forEach((id, i) => { if (picked.has(id)) now.add(i); });
    const res = listKey({ focus, anchor: kb.current.anchor, base: kb.current.base ?? now, picked: now }, e.key, { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey }, ids.length);
    if (!res.handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (res.openMove) {
      if (!moveTargets.length) return;
      setMoveFor({ ids: pickedIds.length ? pickedIds : [ids[focus]], back: focus });
      return;
    }
    kb.current = { anchor: res.state.anchor, base: new Set(res.state.base) };
    if (res.state.picked !== now) {
      setPicked(new Set([...res.state.picked].map((i) => ids[i])));
      anchor.current = res.state.focus;
    }
    if (res.state.focus !== focus) reveal.current?.(res.state.focus);
  };
  return (
    <Card className={cn("relative h-fit overflow-hidden", className)} aria-label="Backlog">
      <div className="flex min-h-[45px] items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">Backlog</h2>
        <span className="text-[12px] tabular-nums text-subtle">{tasks.length}{capped ? "+" : ""} tasks{pts ? `, ${fmtNum(pts)} ${u}` : ""}</span>
      </div>
      {capped && <ListCapNotice what="backlog tasks" hint="Totals cover only these. Move some into a sprint to see the rest." className="mx-4 mt-3" />}
      {pickedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand/[0.05] px-4 py-2" role="toolbar" aria-label="Selected backlog tasks">
          <span className="text-[12.5px] font-medium tabular-nums">{pickedIds.length} selected{pickedPts ? `, ${fmtNum(pickedPts)} ${u}` : ""}</span>
          {moveTargets.length > 0 && <span className="hidden items-center gap-1 text-[11.5px] text-subtle sm:inline-flex" data-testid="backlog-move-hint"><Kbd>M</Kbd>move to a sprint</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => { setPicked(new Set()); anchor.current = null; }}>Clear</Button>
            {target ? (
              <Button size="sm" onClick={() => moveTo(target.id, pickedIds)}><IconArrowRightLeft className="h-3.5 w-3.5" />Move {pickedIds.length} to {target.name}</Button>
            ) : sprints.length > 0 && (
              <Button size="sm" onClick={() => moveTo(sprints[0].id, pickedIds)}><IconArrowRightLeft className="h-3.5 w-3.5" />Move {pickedIds.length} to {sprints[0].name}</Button>
            )}
          </div>
        </div>
      )}
      {tasks.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-subtle">Nothing waiting. Every open task is in a sprint.</p> : (
        <WindowedRows label="Backlog tasks" tasks={tasks} onKeyDown={onKeys} reveal={reveal} render={(t, win) => {
          const i = win ? win.index : ids.indexOf(t.id);
          return (
            <TaskRow key={t.id} task={t} unit={unit} onOpen={onOpen} compact win={win} rowIndex={i}
              select={{ checked: picked.has(t.id), onToggle: (shift) => toggle(i, shift) }}
              drag={sprints.length ? () => (picked.has(t.id) ? pickedIds : [t.id]) : undefined}
              menu={<MoveMenu sprints={sprints} onMove={(to) => to && moveTo(to, picked.has(t.id) ? pickedIds : [t.id])} />} />
          );
        }} />
      )}
      <span className="sr-only" aria-live="polite" data-testid="backlog-live">{pickedIds.length ? selectionMessage(pickedIds.length, tasks.length, pickedPts ? `${fmtNum(pickedPts)} ${u}` : undefined) : ""}</span>
      {moveFor && (
        <KeyMoveMenu count={moveFor.ids.length} sprints={moveTargets}
          onPick={(to) => { const back = moveFor.back; setMoveFor(null); moveTo(to, moveFor.ids); requestAnimationFrame(() => reveal.current?.(Math.min(back, Math.max(0, ids.length - 1)))); }}
          onClose={() => { const back = moveFor.back; setMoveFor(null); requestAnimationFrame(() => reveal.current?.(back)); }} />
      )}
    </Card>
  );
}

/**
 * R45: Move to sprint from the keyboard. M on a backlog row opens it for the selection (or that row); arrows pick a
 * sprint, Enter moves, Escape goes back to the row. A sheet over the backlog's header, so it works at 390 px too.
 */
function KeyMoveMenu({ count, sprints, onPick, onClose }: { count: number; sprints: Sprint[]; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); onClose(); }
    e.stopPropagation();
  };
  return (
    <div className="absolute inset-x-3 top-24 z-40 sm:left-auto sm:w-72" onKeyDown={onKeyDown}>
      <div ref={ref} role="menu" aria-label={`Move ${count} to sprint`} data-testid="backlog-move-menu"
        className="animate-pop-in overflow-hidden rounded-[var(--radius-r14)] border border-line bg-elevated p-1 shadow-pop motion-reduce:animate-none"
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(); }}>
        <p className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-subtle">Move {count === 1 ? "1 task" : `${count} tasks`} to</p>
        {sprints.map((x) => (
          <button key={x.id} type="button" role="menuitem" onClick={() => onPick(x.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-fg outline-none transition-colors duration-100 hover:bg-hover focus-visible:bg-brand focus-visible:text-white motion-reduce:transition-none">
            <IconTarget className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{x.name}</span>
            {x.status === "active" && <span className="text-[11.5px] opacity-70">Active</span>}
          </button>
        ))}
        <p className="flex items-center gap-1 px-2.5 pb-1.5 pt-1 text-[11px] text-subtle"><Kbd>Enter</Kbd>move<span className="ml-2" /><Kbd>Esc</Kbd>back</p>
      </div>
    </div>
  );
}

export function BurndownChart({ data, unitLabel, className }: { data: Burndown; unitLabel: string; className?: string }) {
  const W = 640, H = 200, L = 34, R = 10, T = 12, B = 26;
  const n = data.days.length;
  const max = Math.max(1, data.start, ...data.days.map((d) => Math.max(d.remaining ?? 0, d.ideal)));
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, n);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ideal = [`${x(0)},${y(data.start)}`, ...data.days.map((d, i) => `${x(i + 1)},${y(d.ideal)}`)].join(" ");
  const actualPts: [number, number][] = [[x(0), y(data.start)]];
  data.days.forEach((d, i) => { if (d.remaining != null) actualPts.push([x(i + 1), y(d.remaining)]); });
  const ticks = [0, Math.round(max / 2), Math.round(max)].filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <figure className={className} aria-label="Burndown">
      <div className="mb-1 flex items-center gap-4 text-[11.5px] text-muted">
        <span className="font-medium text-fg">Burndown</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-brand" />Remaining {unitLabel}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-subtle" />Ideal</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Burndown: ${data.remaining} ${unitLabel} left of ${data.scope}`}>
        {ticks.map((v) => (
          <Fragment key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} className="fill-subtle">{v}</text>
          </Fragment>
        ))}
        {data.days.map((d, i) => (i % every === 0 || i === n - 1) && (
          <text key={d.date} x={x(i + 1)} y={H - 8} textAnchor="middle" fontSize={10} className="fill-subtle">{dayLabel(`${d.date}T12:00:00`)}</text>
        ))}
        <polyline points={ideal} fill="none" stroke="currentColor" className="text-subtle" strokeWidth={1.5} strokeDasharray="4 4" />
        <polyline points={actualPts.map((p) => p.join(",")).join(" ")} fill="none" stroke="#0071E3" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        {actualPts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={2.75} fill="#0071E3" />)}
      </svg>
    </figure>
  );
}

function SprintDialog({ projectId, sprint, onClose, onSaved }: { projectId: string; sprint: Sprint | null; onClose: () => void; onSaved: (s: Sprint) => void }) {
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [startAt, setStart] = useState(sprint ? dateInput(sprint.startAt) : "");
  const [endAt, setEnd] = useState(sprint ? dateInput(sprint.endAt) : "");
  const [busy, setBusy] = useState(false);
  const bad = !!startAt && !!endAt && endAt < startAt;
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name || undefined, goal, startAt: startAt ? fromDateInput(startAt) : undefined, endAt: endAt ? fromDateInput(endAt, true) : undefined };
      const r = sprint ? await api.patch<{ sprint: Sprint }>(`/sprints/${sprint.id}`, body) : await api.post<{ sprint: Sprint }>("/sprints", { projectId, ...body });
      onSaved(r.sprint); onClose();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={sprint ? `Edit ${sprint.name}` : "Plan a sprint"} description={sprint ? undefined : "Leave the dates empty for two weeks from the day after the last sprint."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={bad} onClick={() => void save()}>{sprint ? "Save" : "Plan sprint"}</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(p) => <Input {...p} value={name} placeholder="Sprint 3" maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Goal">{(p) => <Textarea {...p} value={goal} rows={2} placeholder="What this sprint is for" onChange={(e) => setGoal(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">{(p) => <Input {...p} type="date" value={startAt} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="Ends" error={bad ? "Ends before it starts." : undefined}>{(p) => <Input {...p} type="date" value={endAt} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

function CompleteDialog({ sprint, unfinished, next, onClose, onDone }: { sprint: Sprint; unfinished: number; next: Sprint | null; onClose: () => void; onDone: (nextId: string | null) => void }) {
  const [to, setTo] = useState<"next" | "backlog">("next");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ carriedTo: { type: "sprint"; sprint: Sprint } | { type: "backlog" } }>(`/sprints/${sprint.id}/complete`, { carryOver: to, timeZone: tz() });
      onDone(r.carriedTo.type === "sprint" ? r.carriedTo.sprint.id : null);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const opt = (v: "next" | "backlog", title: string, body: string) => (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", to === v ? "border-brand bg-brand-soft" : "border-line hover:bg-hover")}>
      <input type="radio" name="carry" className="mt-1 accent-[#0071E3]" checked={to === v} onChange={() => setTo(v)} />
      <span><span className="block text-[13.5px] font-medium">{title}</span><span className="block text-[12.5px] text-muted">{body}</span></span>
    </label>
  );
  return (
    <Dialog open onClose={onClose} title={`Complete ${sprint.name}`}
      description={unfinished ? `${unfinished} ${unfinished === 1 ? "task isn't" : "tasks aren't"} done. Done tasks stay in this sprint.` : "Every task is done."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>Complete sprint</Button></>}>
      {unfinished > 0 ? (
        <div className="space-y-2" role="radiogroup" aria-label="Unfinished tasks">
          {opt("next", next ? `Move to ${next.name}` : "Move to a new sprint", next ? "The next planned sprint." : "A new two week sprint starts the day after this one ends.")}
          {opt("backlog", "Move to the backlog", "Plan them again later.")}
        </div>
      ) : <p className="text-[13.5px] text-muted">Nice work. The chart is kept with the sprint.</p>}
    </Dialog>
  );
}
