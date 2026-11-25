import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBack, IconChevronRight, IconClock, IconPause, IconPlay, IconPlus, IconTimer, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { useProjects, useTasks } from "./data";
import { tone } from "@/web/components/app-bits";
import { ApprovalQueue, DayTimeline, EntryExtras, ExportLink, useTasksPlus, WeekStatus } from "./time-plus-r95"; // R95
import { useMe } from "@/web/lib/queries";
import { cleanTags } from "@/shared/tasks-plus-r95";
import { LoadError } from "@/web/components/load-error-t1g";
import { clockText, hoursText, useElapsed, useRunningTimer, useTimerActions, type TimeEntry } from "./time-core";

interface Sheet { from: string; to: string; days: string[]; rows: { person: TimeEntry["person"]; project: TimeEntry["project"]; days: Record<string, number>; total: number; billable: number }[]; dayTotals: Record<string, number>; total: number; entries: TimeEntry[] }

// The timer helpers live in ./time-core so the app frame's timer chip does not load this page.
export { clockText, hoursText, useElapsed, useRunningTimer, useTimerActions, type TimeEntry } from "./time-core";
const today = () => new Date().toLocaleDateString("en-CA");

/** Time on one task, in the task panel: start or stop the timer, log time by hand, see who logged what. */
export function TaskTime({ taskId, total, entries, onChange }: { taskId: string; total: number; entries: TimeEntry[]; onChange: () => void }) {
  const running = useRunningTimer();
  const { start, stop } = useTimerActions();
  const mine = running.data?.taskId === taskId ? running.data : null;
  const secs = useElapsed(mine);
  const [adding, setAdding] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const add = async () => {
    try { await api.post("/time", { taskId, minutes: Number(minutes), date, note: note || undefined }); setAdding(false); setNote(""); onChange(); } catch (e) { showError(e as Error); }
  };
  const del = async (id: string) => { try { await api.del(`/time/${id}`); onChange(); } catch (e) { showError(e as Error); } };
  const shownTotal = total + (mine ? secs - mine.seconds : 0);
  return (
    <section className="mt-6" aria-label="Time">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconClock className="h-3.5 w-3.5" />Time <span className="font-normal normal-case">{hoursText(shownTotal)} logged</span></h3>
        <button className="text-[12.5px] text-brand-hover hover:underline" onClick={() => setAdding((v) => !v)}>Log time</button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {mine ? (
          <Button size="sm" variant="secondary" onClick={() => stop.mutate(undefined, { onSuccess: onChange })} loading={stop.isPending} data-testid="timer-stop"><IconPause className="h-3.5 w-3.5" />Stop <span className="font-mono tabular-nums">{clockText(secs)}</span></Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => start.mutate(taskId, { onSuccess: onChange })} loading={start.isPending} data-testid="timer-start"><IconPlay className="h-3.5 w-3.5" />Start timer</Button>
        )}
        {running.data && !mine && <span className="text-[12px] text-subtle">Starting here stops the timer on {running.data.task?.ref}.</span>}
      </div>
      {adding && (
        <form className="mt-2 grid grid-cols-[80px_140px_1fr_auto] gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input aria-label="Minutes" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="h-8 text-[13px]" />
          <Input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 text-[13px]" />
          <Input aria-label="Note" placeholder="What you did (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-[13px]" />
          <Button size="sm" type="submit">Add</Button>
        </form>
      )}
      {entries.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12.5px]">
          {entries.slice(0, 8).map((e) => (
            <li key={e.id} className="group flex items-center gap-2 text-muted">
              <span className="w-16 shrink-0 font-mono tabular-nums text-fg">{e.running ? "running" : hoursText(e.seconds)}</span>
              <span className="truncate">{e.person.name}{e.note && ` · ${e.note}`}</span>
              <span className="ml-auto shrink-0 text-subtle">{new Date(e.startedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
              {e.billed ? <span className="rounded-full border border-line px-1.5 text-[11px] text-muted" title="On an invoice. Delete or void that invoice to change it.">Billed</span> : !e.running && <button className="opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete time entry" onClick={() => void del(e.id)}><IconTrash className="h-3.5 w-3.5" /></button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const startOfWeek = (d: Date) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; };
const ymd = (d: Date) => d.toLocaleDateString("en-CA");
const dayHead = (s: string) => { const d = new Date(`${s}T00:00:00`); return { dow: d.toLocaleDateString("en-AU", { weekday: "short" }), dm: d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) }; };

/** Timesheet: a week per person and project, with the entries behind it. */
export function TimesheetPage() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [person, setPerson] = useState("");
  const [projectId, setProjectId] = useState("");
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const plus = useTasksPlus(); // R95
  const me = useMe();
  const [mode, setMode] = useState<"week" | "day">("week");
  const [tag, setTag] = useState("");
  const [dayPick, setDayPick] = useState("");
  const from = ymd(week), to = ymd(new Date(week.getTime() + 6 * 86_400_000));
  const qs = new URLSearchParams({ from, to, ...(person ? { person } : {}), ...(projectId ? { projectId } : {}), ...(plus && tag.trim() ? { tag: tag.trim() } : {}) }).toString();
  const q = useQuery({ queryKey: ["timesheet", qs], queryFn: () => api.get<Sheet>(`/time/timesheet?${qs}`) });
  const projects = useProjects();
  const running = useRunningTimer();
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of q.data?.entries ?? []) m.set(e.personId, e.person.name);
    return [...m.entries()];
  }, [q.data]);
  const del = async (id: string) => { try { await api.del(`/time/${id}`); void qc.invalidateQueries({ queryKey: ["timesheet"] }); } catch (e) { showError(e as Error); } };
  const thisWeek = ymd(startOfWeek(new Date())) === from;
  const myId = me.data?.user.id ? `member:${me.data.user.id}` : "";
  const myTotal = (q.data?.entries ?? []).filter((e) => e.personId === myId).reduce((s, e) => s + e.seconds, 0);
  const shownDay = dayPick && q.data?.days.includes(dayPick) ? dayPick : (q.data?.days.includes(today()) ? today() : q.data?.days[0] ?? from);
  const refreshSheet = () => void qc.invalidateQueries({ queryKey: ["timesheet"] });
  return (
    <div>
      <PageHeader title="Timesheet" description="Time logged on tasks, per person and project. Start a timer from any task, or log time by hand." actions={<div className="flex items-center gap-2">{plus && <ExportLink qs={qs} />}<Button onClick={() => setAdding(true)}><IconPlus className="h-4 w-4" />Log time</Button></div>} />
      {plus && <ApprovalQueue onOpen={(w, pid) => { setWeek(startOfWeek(new Date(`${w}T12:00:00`))); setPerson(`member:${pid}`); }} />}
      {plus && myId && <WeekStatus week={from} total={myTotal} />}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line">
          <button className="p-2 text-muted hover:text-fg" aria-label="Previous week" onClick={() => setWeek(new Date(week.getTime() - 7 * 86_400_000))}><IconBack className="h-4 w-4" /></button>
          <span className="min-w-[150px] text-center text-[13px] font-medium" data-testid="timesheet-week">{dayHead(from).dm} to {dayHead(to).dm}</span>
          <button className="p-2 text-muted hover:text-fg" aria-label="Next week" onClick={() => setWeek(new Date(week.getTime() + 7 * 86_400_000))}><IconChevronRight className="h-4 w-4" /></button>
        </div>
        {!thisWeek && <Button size="sm" variant="ghost" onClick={() => setWeek(startOfWeek(new Date()))}>This week</Button>}
        <Select aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} className="h-9 w-auto text-[13px]">
          <option value="">Everyone</option><option value="me">Me</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
        <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 w-auto text-[13px]">
          <option value="">All projects</option>
          {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {plus && <Input aria-label="Tag" placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="h-9 w-32 text-[13px]" data-testid="tag-filter" />}
        {plus && (
          <div className="flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Show">
            {(["week", "day"] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("min-h-8 rounded-md px-2.5 text-[12.5px] max-sm:min-h-11", mode === m ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-fg")}>{m === "week" ? "Week" : "Day"}</button>)}
          </div>
        )}
        {plus && mode === "day" && q.data && (
          <Select aria-label="Day" value={shownDay} onChange={(e) => setDayPick(e.target.value)} className="h-9 w-auto text-[13px]">
            {q.data.days.map((d) => <option key={d} value={d}>{dayHead(d).dow} {dayHead(d).dm}</option>)}
          </Select>
        )}
        {running.data && <span className="ml-auto text-[12.5px] text-muted">Timer running on {running.data.task?.ref} {running.data.task?.title}</span>}
      </div>
      {q.isPending ? <Skeleton className="h-48" /> : !q.data ? <Card><LoadError onRetry={() => q.refetch()} /></Card> /* F12 (MB-298) */ : !q.data.rows.length ? (
        <Card><EmptyState icon={<IconTimer />} title="No time this week" body="Open a task and press Start timer, or log time by hand. Agents can log time through the API and MCP too." /></Card>
      ) : (
        <>
          {plus && mode === "day" ? <DayTimeline entries={q.data!.entries} day={shownDay} /> : (
          <Card className="overflow-x-auto" tabIndex={0} role="region" aria-label="Timesheet">
            <table className="w-full min-w-[720px] text-[13px]" data-testid="timesheet">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-subtle">
                  <th className="px-4 py-2.5 font-medium">Person</th><th className="px-2 py-2.5 font-medium">Project</th>
                  {q.data!.days.map((d) => <th key={d} className="px-2 py-2.5 text-right font-medium"><div>{dayHead(d).dow}</div><div className="font-normal">{dayHead(d).dm}</div></th>)}
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.rows.map((r) => (
                  <tr key={`${r.person.id}-${r.project?.id}`} className="border-b border-line/60">
                    <td className="px-4 py-2.5">{r.person.name}{r.person.type === "agent" && <span className="ml-1 text-[11px] text-subtle">agent</span>}</td>
                    <td className="px-2 py-2.5"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: tone(r.project?.color) }} />{r.project?.name ?? "No project"}</span></td>
                    {q.data!.days.map((d) => <td key={d} className={cn("px-2 py-2.5 text-right tabular-nums", !r.days[d] && "text-subtle")}>{r.days[d] ? hoursText(r.days[d]) : ""}</td>)}
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{hoursText(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-[12.5px] font-medium">
                  <td className="px-4 py-2.5" colSpan={2}>Total</td>
                  {q.data!.days.map((d) => <td key={d} className="px-2 py-2.5 text-right tabular-nums">{q.data!.dayTotals[d] ? hoursText(q.data!.dayTotals[d]) : ""}</td>)}
                  <td className="px-4 py-2.5 text-right tabular-nums" data-testid="timesheet-total">{hoursText(q.data!.total)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
          )}
          <h2 className="mb-2 mt-6 text-[13px] font-semibold">Entries</h2>
          <Card className="divide-y divide-line">
            {q.data!.entries.map((e) => (
              <div key={e.id} className="group flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="w-20 shrink-0 font-mono tabular-nums">{e.running ? "running" : hoursText(e.seconds)}</span>
                <span className="min-w-0 flex-1 truncate">{e.task ? <><span className="font-mono text-[12px] text-subtle">{e.task.ref}</span> {e.task.title}</> : <span className="text-muted">{e.project?.name ?? "No project"}</span>}{e.note && <span className="text-muted"> · {e.note}</span>}</span>
                <span className="hidden text-muted sm:inline">{e.person.name}</span>
                {plus && <EntryExtras entry={e} onChange={refreshSheet} />}
                <span className="w-20 text-right text-subtle">{new Date(e.startedAt).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</span>
                {e.billed ? <span className="rounded-full border border-line px-1.5 text-[11px] text-muted" title="On an invoice. Delete or void that invoice to change it.">Billed</span> : !e.running && <button className="text-subtle opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100" aria-label="Delete entry" onClick={() => void del(e.id)}><IconTrash className="h-4 w-4" /></button>}
              </div>
            ))}
          </Card>
        </>
      )}
      <LogTimeDialog open={adding} onClose={() => setAdding(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["timesheet"] })} />
    </div>
  );
}

function LogTimeDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const tasks = useTasks({}, { enabled: open });
  const [taskId, setTaskId] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const plus = useTasksPlus(); // R95: tags and billable
  const [tags, setTags] = useState("");
  const [billable, setBillable] = useState(true);
  const save = async () => {
    setSaving(true);
    try { await api.post("/time", { taskId, minutes: Number(minutes), date, note: note || undefined, ...(plus ? { tags: cleanTags(tags.split(",")), billable } : {}) }); onSaved(); onClose(); } catch (e) { showError(e as Error); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Log time" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={saving} disabled={!taskId}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Task">{(fp) => (<Select {...fp} data-autofocus="" value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="Task">{/* F13b (MB-305): opens on the task, not Close */}
          <option value="">Pick a task</option>
          {tasks.data?.filter((t) => t.status !== "done").map((t) => <option key={t.id} value={t.id}>{t.ref} {t.title}</option>)}
        </Select>)}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minutes">{(fp) => (<Input {...fp} type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />)}</Field>
          <Field label="Date">{(fp) => (<Input {...fp} type="date" value={date} onChange={(e) => setDate(e.target.value)} />)}</Field>
        </div>
        <Field label="Note">{(fp) => (<Input {...fp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />)}</Field>
        {plus && <Field label="Tags">{(fp) => (<Input {...fp} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="client a, design" />)}</Field>}
        {plus && <label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />Billable</label>}
      </div>
    </Dialog>
  );
}
