/**
 * R95 time tracking upgrades (flag tasksPlus): the idle prompt on the running timer, the week's submit and approve
 * bar, the admin's approval list, a day timeline, tags and the billable switch on entries, and the CSV export.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button, buttonClass } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { IconCheck, IconClipboardCheck, IconDownload, IconTag, IconUndo } from "@/web/components/ui/icon";
import { useConfig, useMe } from "@/web/lib/queries";
import { tone } from "@/web/components/app-bits";
import { cleanTags, dropStopAt, idleAway, IDLE_AFTER_MS } from "@/shared/tasks-plus-r95";
import type { TimeEntry } from "./time";

export const useTasksPlus = () => !!useConfig().data?.tasksPlus;
const hm = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };

/** The idle threshold; e2e sets a short one in localStorage. */
function idleMs() {
  try { const v = Number(localStorage.getItem("r95-idle-ms")); return v > 0 ? v : IDLE_AFTER_MS; } catch { return IDLE_AFTER_MS; }
}

/**
 * Idle prompt (in the app only, nothing outside the browser tab is watched): while a timer runs, a gap with no
 * pointer, key or scroll activity longer than the threshold asks on return whether to keep the away time.
 */
export function IdlePrompt({ entry, onDone }: { entry: TimeEntry | null | undefined; onDone: () => void }) {
  const last = useRef(Date.now());
  const [away, setAway] = useState<{ from: number; seconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!entry?.running) return;
    const start = Date.parse(entry.startedAt);
    const seen = () => {
      const now = Date.now();
      const secs = idleAway(last.current, now, { running: true, timerStartMs: start, thresholdMs: idleMs() });
      if (secs && !away) setAway({ from: Math.max(last.current, start), seconds: secs });
      last.current = now;
    };
    const vis = () => { if (document.visibilityState === "visible") seen(); };
    const opts = { passive: true } as const;
    window.addEventListener("pointerdown", seen, opts); window.addEventListener("pointermove", seen, opts); window.addEventListener("keydown", seen, opts); window.addEventListener("wheel", seen, opts);
    document.addEventListener("visibilitychange", vis);
    return () => { window.removeEventListener("pointerdown", seen); window.removeEventListener("pointermove", seen); window.removeEventListener("keydown", seen); window.removeEventListener("wheel", seen); document.removeEventListener("visibilitychange", vis); };
  }, [entry?.running, entry?.id, entry?.startedAt, away]);
  const drop = async (keepGoing: boolean) => {
    if (!entry || !away) return;
    setBusy(true);
    try {
      await api.post("/time/stop", { at: dropStopAt(away.from, Date.parse(entry.startedAt)).toISOString() });
      if (keepGoing && entry.taskId) await api.post("/time/start", { taskId: entry.taskId });
      toast(keepGoing ? "Dropped the time away. The timer is running again." : "Dropped the time away and stopped the timer.");
      setAway(null); onDone();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const mins = away ? Math.max(1, Math.round(away.seconds / 60)) : 0;
  return (
    <Dialog open={!!away} onClose={() => setAway(null)} title={`You were away for ${mins} min`}
      description={`The timer on ${entry?.task?.ref ?? "this task"} kept running. Keep that time, or drop it?`}
      footer={<>
        <Button variant="ghost" onClick={() => setAway(null)} data-testid="idle-keep">Keep it</Button>
        <Button variant="secondary" onClick={() => void drop(false)} loading={busy}>Drop it and stop</Button>
        <Button onClick={() => void drop(true)} loading={busy} data-testid="idle-drop">Drop it and keep going</Button>
      </>} />
  );
}

interface Sheet { week: string; person: { id: string; name: string }; status: "open" | "submitted" | "approved" | "returned"; note: string; submittedAt: string | null; decidedAt: string | null; decidedBy: string | null; version: number }
const weekLabel = (w: string) => new Date(`${w}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The person's own week: submit it, take it back, or see who approved or returned it. */
export function WeekStatus({ week, total }: { week: string; total: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["timesheet-week", week], queryFn: async () => (await api.get<{ sheet: Sheet }>(`/timesheets/week?week=${week}`)).sheet });
  const step = useMutation({
    mutationFn: (action: "submit" | "withdraw") => api.post<{ sheet: Sheet }>(`/timesheets/${action}`, { week, version: q.data?.version || undefined }),
    onSuccess: (r) => { qc.setQueryData(["timesheet-week", week], r.sheet); void qc.invalidateQueries({ queryKey: ["timesheet-queue"] }); toast(r.sheet.status === "submitted" ? "Week submitted for approval" : "Week taken back"); },
    onError: (e) => showError(e as Error),
  });
  if (q.isPending) return <Skeleton className="mb-4 h-14" />;
  if (q.isError || !q.data) return null;
  const s = q.data;
  const tone2 = s.status === "approved" ? "border-ok/30 bg-ok-soft" : s.status === "returned" ? "border-warn/30 bg-warn-soft" : s.status === "submitted" ? "border-brand/30 bg-brand/5" : "border-line bg-surface";
  return (
    <div className={cn("mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-[13px]", tone2)} data-testid="week-status" role="status">
      <IconClipboardCheck className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {s.status === "open" && `Your week of ${weekLabel(s.week)}: ${hm(total)}`}
          {s.status === "submitted" && `Submitted ${hm(total)}. Waiting for an admin to approve it.`}
          {s.status === "approved" && `Approved by ${s.decidedBy ?? "an admin"}. This week's time is locked.`}
          {s.status === "returned" && `Returned by ${s.decidedBy ?? "an admin"}. Fix it and submit again.`}
        </p>
        {s.note && s.status !== "open" && <p className="mt-0.5 truncate text-muted">"{s.note}"</p>}
      </div>
      {(s.status === "open" || s.status === "returned") && <Button size="sm" onClick={() => step.mutate("submit")} loading={step.isPending} disabled={!total} data-testid="week-submit"><IconCheck className="h-4 w-4" />Submit week</Button>}
      {s.status === "submitted" && <Button size="sm" variant="secondary" onClick={() => step.mutate("withdraw")} loading={step.isPending} data-testid="week-withdraw"><IconUndo className="h-4 w-4" />Take back</Button>}
    </div>
  );
}

/** Admins: the weeks waiting for approval, with Approve and Return (with a note). */
export function ApprovalQueue({ onOpen }: { onOpen: (week: string, personId: string) => void }) {
  const me = useMe();
  const admin = ["owner", "admin"].includes(me.data?.organization?.role ?? "");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["timesheet-queue"], enabled: admin, queryFn: async () => (await api.get<{ sheets: Sheet[] }>("/timesheets")).sheets, refetchInterval: 60_000 });
  const [returning, setReturning] = useState<Sheet | null>(null);
  const [note, setNote] = useState("");
  const act = async (s: Sheet, action: "approve" | "return", n?: string) => {
    try {
      await api.post(`/timesheets/${action}`, { week: s.week, person: `member:${s.person.id}`, note: n, version: s.version });
      toast(action === "approve" ? `Approved ${s.person.name}'s week` : `Returned ${s.person.name}'s week`);
      void qc.invalidateQueries({ queryKey: ["timesheet-queue"] }); void qc.invalidateQueries({ queryKey: ["timesheet-week"] });
    } catch (e) { showError(e as Error); }
  };
  if (!admin || !q.data?.length) return null;
  return (
    <Card className="mb-4" data-testid="approval-queue">
      <div className="hairline-b flex items-center gap-2 px-4 py-2.5"><h2 className="text-[13px] font-semibold">Waiting for approval</h2><span className="rounded-full bg-brand/15 px-2 text-[12px] font-medium">{q.data.length}</span></div>
      <ul>
        {q.data.map((s, i) => (
          <li key={`${s.person.id}-${s.week}`} className={cn("flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]", i > 0 && "hairline-t")}>
            <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen(s.week, s.person.id)}>
              <span className="font-medium">{s.person.name}</span><span className="text-muted"> · week of {weekLabel(s.week)}</span>{s.note && <span className="text-muted"> · "{s.note}"</span>}
            </button>
            <Button size="sm" variant="ghost" onClick={() => { setReturning(s); setNote(""); }}>Return</Button>
            <Button size="sm" onClick={() => void act(s, "approve")} data-testid="approve-week">Approve</Button>
          </li>
        ))}
      </ul>
      <Dialog open={!!returning} onClose={() => setReturning(null)} title={`Return ${returning?.person.name ?? ""}'s week`} description="They can fix their time and submit it again."
        footer={<><Button variant="ghost" onClick={() => setReturning(null)}>Cancel</Button><Button onClick={() => { const s = returning!; setReturning(null); void act(s, "return", note.trim() || undefined); }} data-testid="return-confirm">Return week</Button></>}>
        <Field label="Note for them">{(fp) => <Input {...fp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to fix (optional)" maxLength={500} />}</Field>
      </Dialog>
    </Card>
  );
}

/** Download the filtered entries as a CSV file. */
export function ExportLink({ qs }: { qs: string }) {
  return <a className={buttonClass("secondary", "md")} href={`/api/time/export.csv?${qs}`} download data-testid="time-export"><IconDownload className="h-4 w-4" />Export CSV</a>;
}

/** Billable switch and tags on one entry. */
export function EntryExtras({ entry, onChange }: { entry: TimeEntry & { tags?: string[] }; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState((entry.tags ?? []).join(", "));
  const save = async (patch: Record<string, unknown>) => { try { await api.patch(`/time/${entry.id}`, patch); onChange(); } catch (e) { showError(e as Error); } };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {(entry.tags ?? []).map((t) => <span key={t} className="hidden rounded-full bg-fill px-2 py-0.5 text-[11.5px] text-muted md:inline">{t}</span>)}
      {editing ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setEditing(false); void save({ tags: cleanTags(text.split(",")) }); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="Tags, separated by commas" className="h-8 w-40 text-[12.5px]" autoFocus placeholder="client a, design" />
          <Button size="sm" type="submit">Save</Button>
        </form>
      ) : (
        <button type="button" className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label="Edit tags" title="Tags" onClick={() => setEditing(true)} disabled={entry.running}><IconTag className="h-4 w-4" /></button>
      )}
      <button type="button" aria-pressed={entry.billable} onClick={() => void save({ billable: !entry.billable })} disabled={entry.running}
        className={cn("min-h-7 rounded-full px-2 text-[11.5px] font-medium transition-colors duration-150 max-sm:min-h-10", entry.billable ? "bg-ok-soft text-ok" : "bg-fill text-subtle")} data-testid="entry-billable">
        {entry.billable ? "Billable" : "Not billable"}
      </button>
    </span>
  );
}

/** A day of time as bars on a 24 hour line, one row per person. */
export function DayTimeline({ entries, day }: { entries: (TimeEntry & { tags?: string[] })[]; day: string }) {
  const start = new Date(`${day}T00:00:00`).getTime();
  const mine = entries.filter((e) => { const t = Date.parse(e.startedAt); return t >= start && t < start + 86_400_000; });
  const people = [...new Map(mine.map((e) => [e.personId, e.person.name])).entries()];
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  if (!mine.length) return <Card className="px-4 py-8 text-center text-[13px] text-muted" data-testid="day-timeline-empty">No time on this day.</Card>;
  return (
    <Card className="overflow-x-auto" data-testid="day-timeline" tabIndex={0} role="region" aria-label="Day timeline">
      <div className="min-w-[640px] px-4 py-3">
        <div className="relative ml-28 h-5 text-[11px] text-subtle" aria-hidden>
          {hours.map((h) => <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>{new Date(start + h * 3600_000).toLocaleTimeString(undefined, { hour: "numeric" })}</span>)}
        </div>
        {people.map(([pid, name]) => {
          const rows = mine.filter((e) => e.personId === pid);
          const total = rows.reduce((s, e) => s + e.seconds, 0);
          return (
            <div key={pid} className="flex items-center gap-2 py-1.5">
              <div className="shrink-0 truncate text-[12.5px]" style={{ width: 104 }}><span className="font-medium">{name}</span><span className="block text-[11.5px] text-subtle">{hm(total)}</span></div>
              <ol className="relative h-8 flex-1 rounded-md bg-fill" aria-label={`${name}'s time`}>
                {rows.map((e) => {
                  const s = Math.max(0, (Date.parse(e.startedAt) - start) / 86_400_000);
                  const w = Math.max(0.004, e.seconds / 86_400);
                  return <li key={e.id} className="absolute inset-y-1 overflow-hidden rounded border border-line border-l-[3px] bg-elevated px-1 text-[11px] leading-5 text-fg shadow-sm" title={`${e.task?.title ?? e.project?.name ?? "Time"}, ${hm(e.seconds)}`}
                    style={{ left: `${s * 100}%`, width: `${Math.min(w, 1 - s) * 100}%`, borderLeftColor: tone(e.project?.color) }}>
                    <span className="sr-only">{new Date(e.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}, {hm(e.seconds)}, </span>{e.task?.title ?? e.project?.name ?? "Time"}
                  </li>;
                })}
              </ol>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
