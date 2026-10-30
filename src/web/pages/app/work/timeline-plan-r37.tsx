/**
 * R37: dependencies that plan for you, on the timeline. Wraps the timeline with:
 * - a schedule bar: "Dates line up" or "2 date clashes" (opens the clash sheet), and the "Move tasks that wait" switch
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
import { IconArrowRight, IconCheckCircle, IconWarning } from "@/web/components/ui/icon";
import { TaskTimeline } from "./timeline";
import { LagChip, MoveMode, ScheduleRules, clashText, useScheduleRules } from "./schedule-r38"; // R38
import type { Task } from "./data";

interface Brief { id: string; ref: string; title: string; start: string | null; due: string | null }
export interface Clash { from: string; to: string; lag?: number; overlapDays: number; fix: { taskId: string; start: string | null; due: string | null }; blocker: Brief; blocked: Brief }
interface Check { links: { from: string; to: string; lag?: number }[]; conflicts: Clash[] }
interface Moved { id: string; ref: string; title: string; from: { start: string | null; due: string | null }; to: { start: string | null; due: string | null }; days: number }
interface Plan { preview: boolean; task: Moved; moved: Moved[]; mode?: "strict" | "flexible"; workingDaysOnly?: boolean }

const PREF = "mm.timeline.moveDependents";
const fmt = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : "No date");
const range = (x: { start: string | null; due: string | null }) => (x.start && x.due && x.start.slice(0, 10) !== x.due.slice(0, 10) ? `${fmt(x.start)} to ${fmt(x.due)}` : fmt(x.due ?? x.start));
const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export function usePlanPref(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(PREF) !== "off"; } catch { return true; } });
  return [on, (v) => { setOn(v); try { localStorage.setItem(PREF, v ? "on" : "off"); } catch { /* private mode */ } }];
}

export function PlannedTimeline({ tasks, projectId, onOpen, onDates }: { tasks: Task[]; projectId?: string; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void }) {
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
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2" data-testid="schedule-bar">
        {check.isPending ? <span className="h-7 w-32 animate-pulse rounded-full bg-fill motion-reduce:animate-none" aria-label="Checking dates" />
          : clashes.length ? (
            <button type="button" onClick={() => setClashesOpen(true)} data-testid="schedule-clash-pill"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-bad/20 bg-bad-soft px-3 text-[12.5px] font-medium text-bad shadow-sm transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none motion-reduce:hover:scale-100">
              <IconWarning className="h-3.5 w-3.5" />{clashes.length === 1 ? "1 date clash" : `${clashes.length} date clashes`}
            </button>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ok/20 bg-ok-soft px-3 text-[12.5px] font-medium text-ok" data-testid="schedule-ok-pill">
              <IconCheckCircle className="h-3.5 w-3.5" />{check.data?.links.length ? "Dates line up" : "No dependencies yet"}
            </span>
          )}
        <span className="hidden text-[12px] text-subtle md:inline">{check.data?.links.length ? `${check.data.links.length} ${check.data.links.length === 1 ? "link" : "links"}. Drag from the end of one bar to another to add one.` : "Drag from the end of one bar to another to make it wait."}</span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-3 gap-y-2 max-sm:ml-0 max-sm:w-full max-sm:justify-between">
          <ScheduleRules projectId={projectId} />
          <label className="inline-flex items-center gap-2 text-[12.5px] text-muted">
            <span>Move tasks that wait</span>
            <Switch checked={moveOn} onChange={setMoveOn} label="Move tasks that wait" />
          </label>
        </span>
      </div>
      <TaskTimeline tasks={tasks} links={check.data?.links ?? []} late={late} daysOff={rules?.workingDaysOnly ? rules.daysOff : undefined} onLink={(a, b) => void addLink(a, b)} onOpen={onOpen} onDates={(id, s, d) => void dragged(id, s, d)} />

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
