/**
 * R37: dependencies that plan for you, on the timeline. Wraps the timeline with:
 * - a schedule bar: "Dates line up" or "2 date clashes" (opens the clash sheet), and (R75) the "Auto shift dependent tasks" switch in the Schedule panel
 *   (remembered on this device, on by default);
 * - clashing bars drawn in red;
 * - dragging a bar that pushes into the tasks waiting on it opens a sheet with each task's old and new dates:
 *   "Move all" (Enter) or "Only this one";
 * - the clash sheet: each clash with Fix (moves the late task, and the chain after it, to start the day after), and Fix all.
 * Server: GET /api/tasks/dependencies/check and POST /api/tasks/:id/reschedule (services/suite/dependency-schedule-r37.ts).
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useCommandHandlers } from "@/web/lib/commands/use-commands";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Switch } from "@/web/components/ui/misc";
import { IconArrowRight, IconCalendarDays, IconCheckCircle, IconInfo, IconSettings2, IconWarning } from "@/web/components/ui/icon";
import { TaskTimeline, ZOOM_LABEL, defaultZoom, savedZoom, storeZoom, type Zoom } from "./timeline";
import { Popover } from "@/web/components/ui/popover"; // R75
import { cn } from "@/web/lib/cn";
import { LagChip, MoveMode, ScheduleRules, clashText, useScheduleRules } from "./schedule-r38"; // R38
import type { Task } from "./data";

interface Brief { id: string; ref: string; title: string; start: string | null; due: string | null }
export interface Clash { from: string; to: string; lag?: number; overlapDays: number; fix: { taskId: string; start: string | null; due: string | null }; blocker: Brief; blocked: Brief }
interface Check { links: { from: string; to: string; lag?: number }[]; conflicts: Clash[] }
interface Moved { id: string; ref: string; title: string; from: { start: string | null; due: string | null }; to: { start: string | null; due: string | null }; days: number }
interface Plan { preview: boolean; task: Moved; moved: Moved[]; mode?: "strict" | "flexible"; workingDaysOnly?: boolean }

const PREF = "mm.timeline.moveDependents";
const DATES_PREF = "mm.timeline.datesColumn";
/** Days from the first dated task's start to the last one's end (for the default zoom). */
export function spanOf(tasks: Pick<Task, "start" | "due">[]): number {
  const t = tasks.flatMap((x) => [x.start, x.due]).filter(Boolean).map((d) => new Date(d!).getTime());
  return t.length ? Math.round((Math.max(...t) - Math.min(...t)) / 86_400_000) + 1 : 0;
}
const fmt = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : "No date");
const range = (x: { start: string | null; due: string | null }) => (x.start && x.due && x.start.slice(0, 10) !== x.due.slice(0, 10) ? `${fmt(x.start)} to ${fmt(x.due)}` : fmt(x.due ?? x.start));
const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export function usePlanPref(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(PREF) !== "off"; } catch { return true; } });
  return [on, (v) => { setOn(v); try { localStorage.setItem(PREF, v ? "on" : "off"); } catch { /* private mode */ } }];
}

export function PlannedTimeline({ tasks, projectId, onOpen, onDates, onAdd }: { tasks: Task[]; projectId?: string; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void; onAdd?: () => void }) {
  // R75: zoom (remembered on this device; Week by default, Month for long plans), the Today button, the dates column.
  const [zoom, setZoom] = useState<Zoom>(() => savedZoom() ?? defaultZoom(spanOf(tasks)));
  const [todaySignal, setTodaySignal] = useState(0);
  const [showDates, setShowDates] = useState(() => { try { return localStorage.getItem(DATES_PREF) === "on"; } catch { return false; } });
  const qc = useQueryClient();
  const check = useQuery({ queryKey: ["task-schedule", projectId ?? ""], queryFn: () => api.get<Check>(`/tasks/dependencies/check${projectId ? `?projectId=${projectId}` : ""}`) });
  const [moveOn, setMoveOn] = usePlanPref();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [clashesOpen, setClashesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { rules } = useScheduleRules(projectId); // R38: working days only, and how waiting tasks move
  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: ["tasks"] }); void qc.invalidateQueries({ queryKey: ["task"] }); void qc.invalidateQueries({ queryKey: ["task-schedule"] }); }, [qc]);
  useCommandHandlers({ "timeline-clashes": () => setClashesOpen(true) }, true);

  const clashes = useMemo(() => check.data?.conflicts ?? [], [check.data]);
  const late = useMemo(() => new Set(clashes.map((c) => c.to)), [clashes]);

  const addLink = useCallback(async (blocker: string, blocked: string) => {
    try { await api.post(`/tasks/${blocked}/dependencies`, { blockedBy: blocker }); } catch (e) { showError(e as Error); }
    void qc.invalidateQueries({ queryKey: ["task-schedule"] });
  }, [qc]);

  // A drag: with the switch off, save as before. With it on, ask the server what else would move.
  const dragged = useCallback(async (id: string, start: string, due: string) => {
    if (!moveOn) { onDates(id, start, due); void qc.invalidateQueries({ queryKey: ["task-schedule"] }); return; }
    try {
      const p = await api.post<Plan>(`/tasks/${id}/reschedule`, { start, due, preview: true });
      if (!p.moved.length) { onDates(id, start, due); void qc.invalidateQueries({ queryKey: ["task-schedule"] }); return; }
      setPlan(p);
    } catch (e) { showError(e as Error); refresh(); }
  }, [moveOn, onDates, qc, refresh]);

  const apply = async (all: boolean) => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await api.post<Plan>(`/tasks/${plan.task.id}/reschedule`, { start: plan.task.to.start, due: plan.task.to.due, moveDependents: all, strict: plan.mode === "strict" });
      toast.success(all ? `Moved ${r.moved.length + 1} tasks` : `Moved ${plan.task.ref}`);
    } catch (e) { showError(e as Error); }
    setBusy(false); setPlan(null); refresh();
  };
  const cancelPlan = () => { setPlan(null); refresh(); }; // puts the dragged bar back
  // R38: switch the rule for this move only, or change a gap, and see the plan again.
  const replan = async (strict: boolean) => {
    if (!plan) return;
    try { setPlan(await api.post<Plan>(`/tasks/${plan.task.id}/reschedule`, { start: plan.task.to.start, due: plan.task.to.due, preview: true, strict })); } catch (e) { showError(e as Error); }
  };
  const linkInto = (id: string) => (check.data?.links ?? []).find((l) => l.to === id && (l.from === plan?.task.id || plan?.moved.some((m) => m.id === l.from)));

  const fix = async (c: Clash) => {
    await api.post(`/tasks/${c.fix.taskId}/reschedule`, { start: c.fix.start, due: c.fix.due });
  };
  const fixOne = async (c: Clash) => { setBusy(true); try { await fix(c); toast.success(`${c.blocked.ref} now starts ${fmt(c.fix.start ?? c.fix.due)}`); } catch (e) { showError(e as Error); } setBusy(false); refresh(); };
  const fixAll = async () => {
    setBusy(true);
    try {
      // One clash at a time from a fresh check: fixing one can clear or move the next.
      for (let i = 0; i < 25; i++) {
        const now = await api.get<Check>(`/tasks/dependencies/check${projectId ? `?projectId=${projectId}` : ""}`);
        if (!now.conflicts.length) break;
        await fix(now.conflicts[0]);
      }
      toast.success("Dates line up");
      setClashesOpen(false);
    } catch (e) { showError(e as Error); }
    setBusy(false); refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {/* R75: one toolbar row. Zoom and Today on the left; on the right only what needs attention (a clash), a short
          hint behind an info button, and the schedule settings in one panel. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="schedule-bar">
        <div role="radiogroup" aria-label="Zoom" className="inline-flex rounded-lg bg-fill p-0.5" data-testid="timeline-zoom">
          {(["day", "week", "month"] as Zoom[]).map((z) => (
            <button key={z} type="button" role="radio" aria-checked={zoom === z} onClick={() => { setZoom(z); storeZoom(z); }} data-testid={`timeline-zoom-${z}`}
              className={cn("h-8 rounded-md px-3 text-[13px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none max-sm:h-11", zoom === z ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{ZOOM_LABEL[z]}</button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setTodaySignal((n) => n + 1)} data-testid="timeline-today-btn"><IconCalendarDays className="h-3.5 w-3.5" />Today</Button>
        <span className="ml-auto inline-flex flex-wrap items-center gap-2 max-sm:ml-0">
          {check.isPending ? <span className="h-8 w-28 animate-pulse rounded-full bg-fill motion-reduce:animate-none" aria-label="Checking dates" />
            : clashes.length ? (
              <button type="button" onClick={() => setClashesOpen(true)} data-testid="schedule-clash-pill"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-bad/20 bg-bad-soft px-3 text-[12.5px] font-medium text-bad transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none motion-reduce:hover:scale-100">
                <IconWarning className="h-3.5 w-3.5" />{clashes.length === 1 ? "1 date clash" : `${clashes.length} date clashes`}
              </button>
            ) : check.data?.links.length ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-ok" data-testid="schedule-ok-pill">
                <IconCheckCircle className="h-3.5 w-3.5" />Dates line up
              </span>
            ) : null}
          <span className="group relative inline-flex">
            <button type="button" aria-label="How dependencies work" aria-describedby="timeline-dep-hint" className="grid h-8 w-8 place-items-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" data-testid="timeline-dep-info"><IconInfo className="h-4 w-4" /></button>
            <span id="timeline-dep-hint" role="tooltip" className="pointer-events-none invisible absolute right-0 top-full z-50 mt-2 w-64 rounded-[var(--radius-r14)] border border-line bg-elevated p-3 text-[12.5px] leading-5 text-muted opacity-0 shadow-pop transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
              {check.data?.links.length ? `${check.data.links.length} ${check.data.links.length === 1 ? "task waits" : "tasks wait"} on another. ` : "No task waits on another yet. "}
              To make one task wait for another, drag from the end of its bar to the start of the next.
            </span>
          </span>
          <Popover label="Schedule settings" align="end" testId="timeline-settings" className="w-80" button={({ open }) => (
            <span className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors", open ? "border-brand/40 bg-brand-soft text-brand-hover" : "border-line bg-surface text-fg/90 hover:bg-hover")}><IconSettings2 className="h-3.5 w-3.5" />Schedule</span>
          )}>
            <div className="grid gap-4">
              <label className="flex items-start justify-between gap-3">
                <span className="text-[13px]"><span className="block font-medium text-fg">Auto shift dependent tasks</span><span className="mt-0.5 block text-[12px] leading-5 text-muted">When you move a task, the tasks waiting on it move with it so the order still holds.</span></span>
                <Switch checked={moveOn} onChange={setMoveOn} label="Auto shift dependent tasks" />
              </label>
              <div className="border-t border-line pt-3"><ScheduleRules projectId={projectId} /></div>
              <label className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px] max-sm:hidden">
                <span className="font-medium text-fg">Show dates column</span>
                <Switch checked={showDates} onChange={(v) => { setShowDates(v); try { localStorage.setItem(DATES_PREF, v ? "on" : "off"); } catch { /* private mode */ } }} label="Show dates column" />
              </label>
            </div>
          </Popover>
        </span>
      </div>
      <TaskTimeline tasks={tasks} links={check.data?.links ?? []} late={late} daysOff={rules?.workingDaysOnly ? rules.daysOff : undefined} zoom={zoom} todaySignal={todaySignal} showDates={showDates} onAdd={onAdd} onLink={(a, b) => void addLink(a, b)} onOpen={onOpen} onDates={(id, s, d) => void dragged(id, s, d)} />

      <Dialog open={!!plan} onClose={cancelPlan} title={plan ? (plan.moved.length === 1 ? `Move 1 task that waits on ${plan.task.ref}?` : `Move ${plan.moved.length} tasks that wait on ${plan.task.ref}?`) : ""}
        description={plan ? (plan.mode === "strict"
          ? `${plan.task.ref} now runs ${range(plan.task.to)}. Every task that waits on it moves by the same ${plan.workingDaysOnly ? "working " : ""}days, keeping its length.`
          : `${plan.task.ref} now runs ${range(plan.task.to)}. The tasks after it would start too early, so they move later by just enough, keeping their length.`) + (plan.workingDaysOnly ? " Weekends are skipped." : "") : undefined}
        footer={plan && <>
          <Button variant="secondary" onClick={() => void apply(false)} disabled={busy}>Only {plan.task.ref}</Button>
          <Button onClick={() => void apply(true)} loading={busy} autoFocus data-testid="schedule-move-all">Move all {plan.moved.length + 1}</Button>
        </>}>
        {plan && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-fill/60 px-2.5 py-2" data-testid="schedule-move-mode">
            <span className="text-[12px] text-muted">{plan.mode === "strict" ? "Same days is on" : "Just enough is on"}{rules && (rules.strict ? plan.mode !== "strict" : plan.mode === "strict") ? " for this move" : " for this project"}</span>
            <MoveMode size="sm" strict={plan.mode === "strict"} onChange={(v) => void replan(v)} />
          </div>
        )}
        {plan && <MoveList rows={plan.moved} workingDays={!!plan.workingDaysOnly} linkInto={linkInto} onLag={() => { void qc.invalidateQueries({ queryKey: ["task-schedule"] }).then(() => replan(plan.mode === "strict")); }} />}
      </Dialog>

      <Dialog open={clashesOpen} onClose={() => setClashesOpen(false)} title={clashes.length ? (clashes.length === 1 ? "1 date clash" : `${clashes.length} date clashes`) : "Dates line up"}
        description={clashes.length ? "A task starts before the task it waits on is finished. Fix moves it, and anything after it, to start the day after." : "Every task starts after the tasks it waits on."}
        footer={<>
          <Button variant="secondary" onClick={() => setClashesOpen(false)}>Close</Button>
          {clashes.length > 1 && <Button onClick={() => void fixAll()} loading={busy} data-testid="schedule-fix-all">Fix all</Button>}
        </>}>
        <ul className="divide-y divide-line" data-testid="schedule-clash-list">
          {clashes.map((c) => (
            <li key={`${c.from}-${c.to}`} className="flex items-center gap-3 py-3 motion-safe:animate-[fadeIn_160ms_ease-out]">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bad-soft text-bad"><IconWarning className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <button type="button" className="block max-w-full text-left text-[13.5px] font-medium leading-snug text-fg line-clamp-2 [overflow-wrap:anywhere] hover:underline" title={`${c.blocked.ref} ${c.blocked.title}`} onClick={() => { setClashesOpen(false); onOpen(c.blocked.id); }}>{c.blocked.ref} {c.blocked.title}</button>
                <p className="line-clamp-2 text-[12px] text-muted">{clashText(c)}</p>
              </div>
              <span className="hidden shrink-0 rounded-full bg-fill px-2 py-0.5 text-[11.5px] tabular-nums text-muted sm:inline">{days(c.overlapDays)} over</span>
              <Button size="sm" variant="secondary" onClick={() => void fixOne(c)} disabled={busy} aria-label={`Fix ${c.blocked.ref}`}>Fix</Button>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function MoveList({ rows, workingDays, linkInto, onLag }: { rows: Moved[]; workingDays?: boolean; linkInto?: (id: string) => { from: string; to: string; lag?: number } | undefined; onLag?: () => void }) {
  return (
    <ul className="max-h-[50vh] divide-y divide-line overflow-auto" data-testid="schedule-move-list">
      {rows.map((m) => (
        <li key={m.id} className="group flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]" title={`${m.ref} ${m.title}`}>{m.ref} {m.title}</p>
            <p className="flex items-center gap-1.5 text-[12px] text-muted"><span className="line-through decoration-subtle/60">{range(m.from)}</span><IconArrowRight className="h-3 w-3 text-subtle" /><span className="text-fg">{range(m.to)}</span></p>
          </div>
          {linkInto?.(m.id) && <LagChip blockedId={m.id} blockerId={linkInto(m.id)!.from} lag={linkInto(m.id)!.lag ?? 0} workingDays={workingDays} onSaved={onLag} />}
          <span className={m.days < 0 ? "shrink-0 rounded-full bg-fill px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-muted" : "shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-brand-hover"}>{m.days < 0 ? "-" : "+"}{days(Math.abs(m.days))}</span>
        </li>
      ))}
    </ul>
  );
}

export default PlannedTimeline;
