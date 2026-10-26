/**
 * R38: dependencies round 2 on the web.
 * - ClashScope + ClashBadge: a small red "Date clash" badge on list rows and board cards. One read per view
 *   (GET /api/tasks/dependencies/check, the same query key the timeline uses, so the cache is shared), no per row request.
 * - ScheduleRules: the project's "Working days only" switch and how waiting tasks move ("Just enough" or "Same days").
 * - LagChip: the lead or lag on one link ("Waits 2 days", "Starts 1 day early"), edited in place.
 * - TodayLine: a thin #0071E3 line with a "Today" cap, drawn inside the timeline's own scrolling area.
 * Server: services/suite/dependency-schedule-r37.ts and schedule-settings-r38.ts.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Switch } from "@/web/components/ui/misc";
import { IconCheck, IconHourglass, IconWarning } from "@/web/components/ui/icon";

interface Brief { id: string; ref: string; title: string; start: string | null; due: string | null }
export interface ClashInfo { from: string; to: string; lag?: number; overlapDays: number; fix: { taskId: string; start: string | null; due: string | null }; blocker: Brief; blocked: Brief }
export interface ScheduleRulesValue { projectId: string; workingDaysOnly: boolean; daysOff: number[]; strict: boolean }
interface CheckShape { links: { from: string; to: string; lag?: number }[]; conflicts: ClashInfo[]; settings?: ScheduleRulesValue }

const fmt = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : "no date");
export const dayWord = (n: number) => (Math.abs(n) === 1 ? "1 day" : `${Math.abs(n)} days`);
export const scheduleKey = (projectId?: string) => ["task-schedule", projectId ?? ""];
export const checkPath = (projectId?: string) => `/tasks/dependencies/check${projectId ? `?projectId=${projectId}` : ""}`;

// ---------------------------------------------------------------- clash badge

const ClashCtx = createContext<Map<string, ClashInfo> | null>(null);

/** Wrap a list or board: one check for the whole view. */
export function ClashScope({ projectId, enabled = true, children }: { projectId?: string; enabled?: boolean; children: ReactNode }) {
  const q = useQuery({ queryKey: scheduleKey(projectId), queryFn: () => api.get<CheckShape>(checkPath(projectId)), enabled, staleTime: 30_000 });
  const map = useMemo(() => {
    const m = new Map<string, ClashInfo>();
    for (const c of q.data?.conflicts ?? []) if (!m.has(c.to)) m.set(c.to, c); // the server sorts the biggest clash first
    return m;
  }, [q.data]);
  return <ClashCtx.Provider value={enabled ? map : null}>{children}</ClashCtx.Provider>;
}

export function clashText(c: ClashInfo) {
  const lag = c.lag ? (c.lag > 0 ? ` plus a ${dayWord(c.lag)} wait` : ` less a ${dayWord(c.lag)} lead`) : "";
  return `Waits on ${c.blocker.ref} ${c.blocker.title}, which ends ${fmt(c.blocker.due ?? c.blocker.start)}${lag}. Start ${fmt(c.fix.start ?? c.fix.due)} or later to fix it.`;
}

/** The red badge. Renders nothing outside a ClashScope or when the task has no clash. */
export function ClashBadge({ id, compact }: { id: string; compact?: boolean }) {
  const map = useContext(ClashCtx);
  const c = map?.get(id);
  if (!c) return null;
  const text = clashText(c);
  return (
    <span className="group/clash relative inline-flex shrink-0" data-testid="clash-badge">
      <span tabIndex={0} aria-label={`Date clash. ${text}`}
        className="inline-flex h-5 items-center gap-1 rounded-full border border-bad/25 bg-bad-soft px-1.5 text-[11px] font-medium leading-none text-bad outline-none focus-visible:ring-2 focus-visible:ring-brand motion-safe:animate-[fadeIn_160ms_ease-out]">
        <IconWarning className="h-3 w-3" aria-hidden />{!compact && <span>Date clash</span>}
      </span>
      <span role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 w-64 rounded-lg border border-line bg-elevated px-2.5 py-2 text-[12px] font-normal leading-snug text-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover/clash:opacity-100 group-focus-within/clash:opacity-100 motion-reduce:transition-none">
        {text}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- project rules

export function useScheduleRules(projectId?: string) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task-schedule-rules", projectId ?? ""], enabled: !!projectId, queryFn: () => api.get<{ schedule: ScheduleRulesValue }>(`/projects/${projectId}/schedule`).then((r) => r.schedule) });
  const save = useMutation({
    mutationFn: (patch: Partial<Omit<ScheduleRulesValue, "projectId">>) => api.put<{ schedule: ScheduleRulesValue }>(`/projects/${projectId}/schedule`, patch).then((r) => r.schedule),
    onMutate: (patch) => { qc.setQueryData(["task-schedule-rules", projectId ?? ""], (old: ScheduleRulesValue | undefined) => (old ? { ...old, ...patch } : old)); },
    onError: (e) => { showError(e as Error); void q.refetch(); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["task-schedule"] }); },
  });
  return { rules: q.data, loading: q.isPending && !!projectId, save: (p: Partial<Omit<ScheduleRulesValue, "projectId">>) => save.mutate(p) };
}

/** A two option segmented control: how the tasks that wait on a moved task move. */
export function MoveMode({ strict, onChange, size = "md" }: { strict: boolean; onChange: (strict: boolean) => void; size?: "sm" | "md" }) {
  const opt = (v: boolean, label: string, hint: string) => (
    <button type="button" role="radio" aria-checked={strict === v} title={hint} onClick={() => onChange(v)} data-testid={v ? "move-mode-same" : "move-mode-enough"}
      className={cn("inline-flex items-center gap-1 rounded-md px-2.5 font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none",
        size === "sm" ? "h-7 text-[12px]" : "h-7 text-[12.5px]", strict === v ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
      {strict === v && <IconCheck className="h-3 w-3 text-brand" aria-hidden />}{label}
    </button>
  );
  return (
    <span role="radiogroup" aria-label="How waiting tasks move" className="inline-flex items-center gap-0.5 rounded-lg bg-fill p-0.5">
      {opt(false, "Just enough", "Tasks that wait move later only when they would start too early")}
      {opt(true, "Same days", "Tasks that wait move by the same number of days, earlier or later")}
    </span>
  );
}

/** Working days only, and the move rule, for one project (on the timeline's schedule bar). */
export function ScheduleRules({ projectId }: { projectId?: string }) {
  const { rules, loading, save } = useScheduleRules(projectId);
  if (!projectId) return null;
  if (loading || !rules) return <span className="h-7 w-56 animate-pulse rounded-lg bg-fill motion-reduce:animate-none" aria-label="Loading schedule rules" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-3" data-testid="schedule-rules">
      <label className="inline-flex items-center gap-2 text-[12.5px] text-muted">
        <span>Working days only</span>
        <Switch checked={rules.workingDaysOnly} onChange={(v) => save({ workingDaysOnly: v })} label="Working days only" />
      </label>
      <MoveMode strict={rules.strict} onChange={(v) => save({ strict: v })} />
    </span>
  );
}

// ---------------------------------------------------------------- lead and lag

export function lagLabel(n: number) {
  if (!n) return "No gap";
  return n > 0 ? `Waits ${dayWord(n)}` : `Starts ${dayWord(n)} early`;
}

/** The lead or lag on one link, edited in place: a chip that turns into a small number field (Enter saves, Escape cancels). */
export function LagChip({ blockedId, blockerId, lag, onSaved, workingDays }: { blockedId: string; blockerId: string; lag: number; onSaved?: () => void; workingDays?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(lag));
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  useEffect(() => { if (editing) { setVal(String(lag)); requestAnimationFrame(() => input.current?.select()); } }, [editing, lag]);
  const save = async () => {
    const n = Number(val);
    if (!Number.isInteger(n) || n < -365 || n > 365) { showError(new Error("Use a whole number of days from -365 to 365.")); return; }
    if (n === lag) { setEditing(false); return; }
    setBusy(true);
    try {
      await api.patch(`/tasks/${blockedId}/dependencies/${blockerId}`, { lagDays: n });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["task-schedule"] }); // clash badges, pills and bars follow the new gap
      onSaved?.();
    } catch (e) { showError(e as Error); }
    setBusy(false);
  };
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 motion-safe:animate-[fadeIn_150ms_ease-out]">
        <input ref={input} type="number" inputMode="numeric" min={-365} max={365} step={1} value={val} disabled={busy} aria-label="Days to wait after it ends (negative to start early)"
          onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} onBlur={() => void save()}
          className="h-6 w-14 rounded-md border border-line-strong bg-surface px-1.5 text-right text-[12px] tabular-nums text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand/25" data-testid="lag-input" />
        <span className="text-[11.5px] text-subtle">{workingDays ? "working days" : "days"}</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} data-testid="lag-chip" aria-label={`${lagLabel(lag)}. Change the gap`}
      className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium tabular-nums transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand motion-reduce:transition-none",
        lag ? "bg-brand-soft text-brand-hover hover:bg-brand/15" : "text-subtle opacity-70 hover:bg-hover hover:text-fg group-hover:opacity-100")}>
      <IconHourglass className="h-3 w-3" aria-hidden />{lag ? lagLabel(lag) : "Add gap"}
    </button>
  );
}

// ---------------------------------------------------------------- Today line

const DAY = 86_400_000;
const localDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Draws the Today line inside the chart's scrolling area (`.wx-area`), so it scrolls with the bars. Its position comes
 * from a bar on screen (the bar's left edge is that task's first day), so it follows the chart's own day math.
 * Hidden when today is outside the chart's range.
 */
export function TodayLine({ root, anchor, cellWidth, version }: { root: React.RefObject<HTMLElement | null>; anchor?: { id: string; start: Date }; cellWidth: number; version: string }) {
  const [spot, setSpot] = useState<{ host: HTMLElement; x: number } | null>(null);
  useEffect(() => {
    if (!anchor) { setSpot(null); return; }
    let tries = 0, raf = 0;
    const place = () => {
      const el = root.current;
      const host = el?.querySelector<HTMLElement>(".wx-area");
      const bar = el?.querySelector<HTMLElement>(`.wx-bar[data-task-id=':${CSS.escape(anchor.id)}'], .wx-bar[data-task-id='${CSS.escape(anchor.id)}']`);
      if (!host || !bar) { if (tries++ < 40) raf = requestAnimationFrame(place); return; }
      const days = Math.round((localDay(new Date()) - localDay(anchor.start)) / DAY);
      const x = bar.offsetLeft + days * cellWidth + cellWidth / 2;
      setSpot(x < 0 || x > host.scrollWidth ? null : { host, x });
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { tries = 0; place(); }) : null;
    if (root.current && ro) ro.observe(root.current);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [root, anchor?.id, anchor?.start.getTime(), cellWidth, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!spot) return null;
  return createPortal(
    <div aria-hidden data-testid="timeline-today" className="pointer-events-none absolute inset-y-0 z-[5] motion-safe:animate-[fadeIn_200ms_ease-out]" style={{ left: spot.x - 1 }}>
      <div className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-[#0071E3] opacity-90 shadow-[0_0_0_1px_rgb(0_113_227/0.12)]" />
      <div className="absolute left-0 top-1 -translate-x-1/2 rounded-full bg-[#0071E3] px-1.5 py-px text-[10.5px] font-semibold leading-4 text-white shadow-sm">Today</div>
    </div>,
    spot.host,
  );
}
