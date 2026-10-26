/**
 * R24.2 Workload: open tasks per person per week, with a load bar against a weekly capacity.
 * Drag a task chip to another person's row to reassign it, or to another week to move its due
 * date by whole weeks (the same weekday). Each chip's menu has "Move to" for the keyboard.
 * Reading the view writes nothing; a move is the normal task update.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { IconAgent, IconBack, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconGauge, IconMore, IconTeam, IconUserRound } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { initials } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Avatar, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { tone } from "@/web/components/app-bits";

type Unit = "points" | "hours";
export interface WorkloadChip { id: string; ref: string; title: string; projectId: string; project: string; projectColor: string; due: string | null; start: string | null; status: string; points: number | null; unit: Unit }
export interface WorkloadCell { count: number; points: number; hours: number; noEstimate: number; load: number; over: boolean; near: boolean; tasks: WorkloadChip[] }
export interface WorkloadPerson { id: string | null; type: "member" | "agent" | null; name: string; isAgent: boolean; capacity?: number; capacitySource?: "request" | "stored" | "default"; overdue: WorkloadCell; weeks: (WorkloadCell & { week: string })[]; total: { count: number } }
export interface WorkloadData { unit: Unit; capacity: number; timeZone: string; range: { from: string; to: string; weeks: { start: string; end: string }[] }; people: WorkloadPerson[]; taskCount: number; truncated: boolean }

const DAY = 86_400_000;
const OVERDUE = "overdue";
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
/** Monday of the local week holding d, as YYYY-MM-DD. */
function mondayOf(d: Date) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); }
const addWeeks = (s: string, n: number) => { const d = parseYmd(s); d.setDate(d.getDate() + n * 7); return ymd(d); };
const weeksBetween = (a: string, b: string) => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / (7 * DAY));
const weekLabel = (s: string) => parseYmd(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
/** The task's date moved by whole weeks, keeping the weekday and the time of day. */
export function shiftWeeks(isoDate: string, weeks: number) { const d = new Date(isoDate); d.setDate(d.getDate() + weeks * 7); return d.toISOString(); }
const fmtLoad = (n: number) => (Math.round(n * 10) / 10).toString();

function useWorkload(projectId: string | undefined, from: string, unit: Unit) {
  const tz = zone();
  return useQuery({
    queryKey: ["workload", projectId ?? "", from, unit, tz],
    queryFn: () => api.get<WorkloadData>(`/workload?from=${from}&weeks=4&unit=${unit}&tz=${encodeURIComponent(tz)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`),
  });
}

type Move = { chip: WorkloadChip; fromPerson: string; fromCol: string; toPerson: string; toCol: string };
const personKey = (p: WorkloadPerson) => p.id ?? "none";

/** Moves a chip in cached data, so the grid shows the change at once. */
function applyMove(d: WorkloadData, m: Move): WorkloadData {
  let cap = d.capacity;
  const strip = (c: WorkloadCell, chip: WorkloadChip, sign: 1 | -1): WorkloadCell => {
    const pts = chip.points ?? 0;
    const next = { ...c, count: c.count + sign, tasks: sign > 0 ? [...c.tasks, chip] : c.tasks.filter((t) => t.id !== chip.id) };
    if (chip.points == null) next.noEstimate += sign;
    else if (chip.unit === "hours") next.hours += sign * pts;
    else next.points += sign * pts;
    next.load = d.unit === "hours" ? next.hours : next.points;
    next.over = next.load > cap;
    next.near = !next.over && next.load >= cap * 0.8;
    return next;
  };
  const cellOf = (p: WorkloadPerson, col: string, fn: (c: WorkloadCell) => WorkloadCell): WorkloadPerson =>
    col === OVERDUE ? { ...p, overdue: fn(p.overdue) } : { ...p, weeks: p.weeks.map((w) => (w.week === col ? { ...w, ...fn(w) } : w)) };
  let people = d.people.map((p) => { if (personKey(p) !== m.fromPerson) return p; cap = p.capacity ?? d.capacity; return cellOf(p, m.fromCol, (c) => strip(c, m.chip, -1)); });
  people = people.map((p) => { if (personKey(p) !== m.toPerson) return p; cap = p.capacity ?? d.capacity; return cellOf(p, m.toCol, (c) => strip(c, m.chip, 1)); });
  return { ...d, people };
}

export function WorkloadView({ projectId, onOpen }: { projectId?: string; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(() => mondayOf(new Date()));
  const [unit, setUnit] = useState<Unit>("points");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const w = useWorkload(projectId, from, unit);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const data = w.data;
  const showOverdue = !!data?.people.some((p) => p.overdue.count > 0);
  const cols = useMemo(() => [...(showOverdue ? [OVERDUE] : []), ...(data?.range.weeks.map((x) => x.start) ?? [])], [data, showOverdue]);
  const people = data?.people ?? [];
  const me = useMe().data;
  const canEdit = (p: WorkloadPerson) => !!p.id && (me?.organization?.role === "owner" || me?.organization?.role === "admin" || p.id === `member:${me?.user.id}`);

  const move = useMutation({
    mutationFn: async (m: Move) => {
      const patch: Record<string, unknown> = {};
      if (m.toPerson !== m.fromPerson) patch.assignee = m.toPerson === "none" ? null : m.toPerson;
      if (m.toCol !== m.fromCol && m.toCol !== OVERDUE) {
        const base = m.chip.due ?? m.chip.start;
        if (base) {
          const n = weeksBetween(mondayOf(new Date(base)), m.toCol);
          if (n) patch[m.chip.due ? "due" : "start"] = shiftWeeks(base, n);
        }
      }
      if (!Object.keys(patch).length) return null;
      return api.patch(`/tasks/${m.chip.id}`, patch);
    },
    onMutate: async (m) => {
      const key = ["workload", projectId ?? "", from, unit, zone()];
      await qc.cancelQueries({ queryKey: ["workload"] });
      const before = qc.getQueryData<WorkloadData>(key);
      if (before) qc.setQueryData(key, applyMove(before, m));
      return { key, before };
    },
    onError: (e, _m, ctx) => { if (ctx?.before) qc.setQueryData(ctx.key, ctx.before); showError(e as Error); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["workload"] }); void qc.invalidateQueries({ queryKey: ["tasks"] }); },
  });

  const moveTo = (chip: WorkloadChip, fromPerson: string, fromCol: string, toPerson: string, toCol: string) => {
    if (toCol === OVERDUE && fromCol !== OVERDUE) toCol = fromCol; // Overdue takes no drops: it is where late work lands, not a week.
    if (toPerson === fromPerson && toCol === fromCol) return;
    move.mutate({ chip, fromPerson, fromCol, toPerson, toCol });
  };
  const onDragEnd = (e: DragEndEvent) => {
    const a = e.active.data.current as { chip: WorkloadChip; person: string; col: string } | undefined;
    const o = e.over?.data.current as { person: string; col: string } | undefined;
    if (a && o) moveTo(a.chip, a.person, a.col, o.person, o.col);
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      <div className="inline-flex items-center gap-1">
        <Button variant="secondary" size="sm" aria-label="Earlier weeks" onClick={() => setFrom(addWeeks(from, -4))}><IconBack className="h-3.5 w-3.5" /></Button>
        <Button variant="secondary" size="sm" onClick={() => setFrom(mondayOf(new Date()))}>This week</Button>
        <Button variant="secondary" size="sm" aria-label="Later weeks" onClick={() => setFrom(addWeeks(from, 4))}><IconChevronRight className="h-3.5 w-3.5" /></Button>
      </div>
      <div role="tablist" aria-label="Estimate unit" className="inline-flex rounded-lg bg-fill p-0.5">
        {(["points", "hours"] as Unit[]).map((u) => (
          <button key={u} role="tab" aria-selected={unit === u} onClick={() => setUnit(u)}
            className={cn("rounded-md px-2.5 py-1 text-[12.5px]", unit === u ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{u === "points" ? "Points" : "Hours"}</button>
        ))}
      </div>
      {data && <span className="text-[12.5px] text-muted">Default capacity {data.capacity} {unit} a person a week. Set a person's own on their row.</span>}
      {data?.truncated && <span className="text-[12.5px] text-warn">Showing the first 2,000 tasks</span>}
    </div>
  );

  if (w.isPending) return <div>{header}<Skeleton className="h-72" /></div>;
  if (w.isError) return <div>{header}<p className="text-[13px] text-muted">The workload could not load. Try again in a moment.</p></div>;
  if (!people.length) {
    return (
      <div>{header}
        <EmptyState icon={<IconTeam />} title="Nothing planned for these weeks" body="Open tasks with a due date or a start date in these weeks show here, one row per person. Give a task a due date and an assignee to see it." />
      </div>
    );
  }

  return (
    <div data-testid="workload">
      {header}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="w-48 px-3 py-2 font-medium">Person</th>
                {cols.map((c) => (
                  <th key={c} className="px-2 py-2 font-medium" data-week={c}>
                    {c === OVERDUE ? <span className="text-bad">Overdue</span> : <>Week of {weekLabel(c)}{c === mondayOf(new Date()) && <span className="ml-1.5 rounded bg-[#0071E3]/10 px-1.5 py-0.5 text-[11px] text-[#0071E3]">This week</span>}</>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const pk = personKey(p);
                const open = !collapsed[pk];
                return (
                  <tr key={pk} className="border-b border-line align-top last:border-b-0" data-person={p.name}>
                    <td className="px-3 py-2.5">
                      <button className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setCollapsed((s) => ({ ...s, [pk]: open }))}>
                        {p.id === null
                          ? <span className="grid h-7 w-7 place-items-center rounded-full bg-fill text-muted"><IconUserRound className="h-3.5 w-3.5" /></span>
                          : p.isAgent ? <span className="grid h-7 w-7 place-items-center rounded-full bg-[#0071E3]/10 text-[#0071E3]"><IconAgent className="h-3.5 w-3.5" /></span>
                          : <Avatar label={initials(p.name)} className="h-7 w-7 text-[10.5px]" />}
                        <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                        <IconChevronDown className={cn("h-3.5 w-3.5 text-subtle transition-transform", !open && "-rotate-90")} />
                      </button>
                      {p.id && <CapacityEditor person={p} unit={unit} fallback={data!.capacity} editable={canEdit(p)} />}
                    </td>
                    {cols.map((c) => {
                      const cell = c === OVERDUE ? p.overdue : p.weeks.find((x) => x.week === c)!;
                      return (
                        <Cell key={c} person={pk} col={c} cell={cell} capacity={p.capacity ?? data!.capacity} unit={unit} overdue={c === OVERDUE} open={open}
                          people={people} cols={cols} onOpen={onOpen} onMove={(chip, toPerson, toCol) => moveTo(chip, pk, c, toPerson, toCol)} />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DndContext>
      <p className="pt-2 text-[12px] text-subtle">Drag a task to another person to reassign it, or to another week to move its due date. Tasks with no estimate count toward the number, not the bar.</p>
    </div>
  );
}

function Cell({ person, col, cell, capacity, unit, overdue, open, people, cols, onOpen, onMove }: {
  person: string; col: string; cell: WorkloadCell; capacity: number; unit: Unit; overdue: boolean; open: boolean;
  people: WorkloadPerson[]; cols: string[]; onOpen: (id: string) => void; onMove: (chip: WorkloadChip, toPerson: string, toCol: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${person}|${col}`, data: { person, col } });
  const pct = Math.min(100, capacity ? (cell.load / capacity) * 100 : 0);
  const color = cell.over ? "#E5484D" : cell.near ? "#F5A524" : "#0071E3";
  return (
    <td ref={setNodeRef} data-cell={`${person}|${col}`} className={cn("px-2 py-2.5 transition-colors", isOver && "bg-[#0071E3]/5")}>
      {!overdue && (
        <div className="mb-1.5" title={`${fmtLoad(cell.load)} of ${capacity} ${unit}`}>
          <div className="flex items-baseline justify-between text-[11.5px] text-muted">
            <span data-testid="load" className={cn(cell.over && "font-medium text-bad")}>{fmtLoad(cell.load)} / {capacity} {unit === "points" ? "pts" : "h"}</span>
            <span>{cell.count} {cell.count === 1 ? "task" : "tasks"}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-fill" role="meter" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={cell.load} aria-label="Load">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
          </div>
        </div>
      )}
      {overdue && cell.count > 0 && <div className="mb-1.5 text-[11.5px] font-medium text-bad">{cell.count} overdue</div>}
      {open && (
        <div className="flex flex-col gap-1">
          {cell.tasks.map((t) => <Chip key={t.id} chip={t} person={person} col={col} people={people} cols={cols} onOpen={onOpen} onMove={onMove} />)}
        </div>
      )}
      {!open && cell.count > 0 && <div className="text-[11.5px] text-subtle">{cell.noEstimate > 0 ? `${cell.noEstimate} with no estimate` : ""}</div>}
    </td>
  );
}

function Chip({ chip, person, col, people, cols, onOpen, onMove }: {
  chip: WorkloadChip; person: string; col: string; people: WorkloadPerson[]; cols: string[]; onOpen: (id: string) => void; onMove: (chip: WorkloadChip, toPerson: string, toCol: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: chip.id, data: { chip, person, col } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} data-testid="chip" data-ref={chip.ref}
      className={cn("group flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1.5 text-[12.5px] shadow-card", isDragging && "z-10 opacity-80 shadow-pop")}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone(chip.projectColor) }} aria-hidden />
      <button {...listeners} {...attributes} onClick={() => onOpen(chip.id)} className="min-w-0 flex-1 cursor-grab truncate text-left active:cursor-grabbing" aria-label={`${chip.ref} ${chip.title}`}>
        <span className="text-subtle">{chip.ref}</span> {chip.title}
      </button>
      {chip.points != null && <span className="shrink-0 rounded bg-fill px-1 text-[11px] text-muted">{fmtLoad(chip.points)}{chip.unit === "hours" ? "h" : ""}</span>}
      <Menu align="end" label={`Move ${chip.ref}`} trigger={<button className="shrink-0 rounded p-0.5 text-subtle opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"><IconMore className="h-3.5 w-3.5" /></button>}>
        <MenuLabel>Move to person</MenuLabel>
        {people.filter((p) => (p.id ?? "none") !== person).map((p) => <MenuItem key={p.id ?? "none"} onSelect={() => onMove(chip, p.id ?? "none", col)}>{p.name}</MenuItem>)}
        <div className="my-1 border-t border-line" />
        <MenuLabel>Move to week</MenuLabel>
        {cols.filter((c) => c !== OVERDUE && c !== col).map((c) => <MenuItem key={c} onSelect={() => onMove(chip, person, c)}>Week of {weekLabel(c)}</MenuItem>)}
      </Menu>
    </div>
  );
}

/** A person's weekly capacity under their name; owners, admins and the person can change it. */
function CapacityEditor({ person, unit, fallback, editable }: { person: WorkloadPerson; unit: Unit; fallback: number; editable: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const value = person.capacity ?? fallback;
  const [draft, setDraft] = useState(String(value));
  const short = unit === "points" ? "pts" : "h";
  const save = useMutation({
    mutationFn: (n: number | null) => api.put("/workload/capacity", { person: person.id, [unit]: n }),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ["workload"] }); },
    onError: (e) => showError(e as Error),
  });
  const label = `${fmtLoad(value)} ${short} a week${person.capacitySource === "default" ? " (default)" : ""}`;
  if (!editing) {
    return editable
      ? <button data-testid="capacity" className="mt-1 ml-9 inline-flex items-center gap-1 rounded text-[11.5px] text-muted hover:text-[#0071E3]" aria-label={`Weekly capacity for ${person.name}: ${label}. Change`}
          onClick={() => { setDraft(String(value)); setEditing(true); }}><IconGauge className="h-3 w-3" />{label}</button>
      : <span data-testid="capacity" className="mt-1 ml-9 inline-flex items-center gap-1 text-[11.5px] text-subtle"><IconGauge className="h-3 w-3" />{label}</span>;
  }
  const n = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 10_000;
  return (
    <form className="mt-1 ml-9 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(n); }}>
      <input autoFocus inputMode="decimal" aria-label={`Weekly capacity in ${unit}`} value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        className="h-6 w-14 rounded-md border border-line bg-surface px-1.5 text-[12px] outline-none focus:border-[#0071E3]" />
      <span className="text-[11.5px] text-muted">{short}</span>
      <button type="submit" disabled={!valid || save.isPending} aria-label="Save capacity" className="grid h-6 w-6 place-items-center rounded-md text-[#0071E3] hover:bg-fill disabled:opacity-40"><IconCheck className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Cancel" onClick={() => setEditing(false)} className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-fill"><IconClose className="h-3.5 w-3.5" /></button>
      {person.capacitySource === "stored" && <button type="button" className="text-[11px] text-muted hover:text-fg" onClick={() => save.mutate(null)}>Use default</button>}
    </form>
  );
}
