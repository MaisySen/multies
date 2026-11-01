/**
 * R95 My Day: today's list plus a day column. Drag a task onto a time to block it, drag a block to move it, drag its
 * lower edge to change its length; every move snaps to 15 minutes and never overlaps (it slides to the nearest free
 * time). Keyboard and phone: each item has Schedule at, and each block has Earlier, Later, Longer, Shorter. Plan
 * tomorrow moves what is left, with undo.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { IconCalendarClock, IconCheck, IconChevronDown, IconChevronUp, IconClose, IconMinus, IconPlus, IconSunrise, IconUndo } from "@/web/components/ui/icon";
import { addDays, clampBlock, clockOf, fitBlock, minutesText, type Block } from "@/shared/tasks-plus-r95";
import { tone } from "@/web/components/app-bits";

interface PlanTask { id: string; ref: string; title: string; status: "todo" | "doing" | "done"; priority: string; due: string | null; project: { id: string; name: string; color: string } | null }
interface PlanItem { id: string; taskId: string; day: string; start: number | null; minutes: number; position: number; task: PlanTask }
interface DayData { day: string; timeZone: string; items: PlanItem[]; suggestions: PlanTask[] }
interface Undo { id: string; taskId: string; day: string; start: number | null; minutes: number }

export const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const localYmd = (d = new Date()) => d.toLocaleDateString("en-CA");
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const nowMinute = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/** Minute of the day under a pointer inside the day column. */
export function minuteAt(clientY: number, top: number, scrollTop = 0) {
  return Math.max(0, Math.min(1439, Math.round((clientY - top + scrollTop) / PX_PER_MIN)));
}

export function MyDay() {
  const qc = useQueryClient();
  const [day, setDay] = useState(localYmd());
  const today = localYmd();
  const tomorrow = addDays(today, 1);
  const key = ["my-day", day];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<DayData>(`/my-day?day=${day}&tz=${encodeURIComponent(zone())}`), staleTime: 15_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["my-day"] }); };
  const items = q.data?.items ?? [];
  const blocks: Block[] = items.filter((i) => i.start !== null).map((i) => ({ id: i.id, start: i.start!, minutes: i.minutes }));
  const unscheduled = items.filter((i) => i.start === null);
  const scheduled = items.filter((i) => i.start !== null).sort((a, b) => a.start! - b.start!);
  const [live, setLive] = useState("");

  const place = async (opts: { itemId?: string; taskId?: string; start: number | null; minutes?: number; title: string }) => {
    const minutes = opts.minutes ?? items.find((i) => i.id === opts.itemId)?.minutes ?? 30;
    let start = opts.start;
    if (start !== null) {
      const fit = fitBlock(blocks, { id: opts.itemId ?? "new", ...clampBlock(start, minutes) });
      if (fit === null) { toast.error("No free time left that long on this day."); return; }
      start = fit;
    }
    try {
      if (opts.itemId) await api.patch(`/my-day/${opts.itemId}`, { start, minutes });
      else await api.post("/my-day", { day, taskId: opts.taskId, start, minutes });
      setLive(start === null ? `${opts.title} is on the list.` : `${opts.title} blocked at ${clockOf(start)}.`);
      refresh();
    } catch (e) { showError(e as Error); refresh(); }
  };

  const remove = async (it: PlanItem) => {
    try {
      const r = await api.del<{ item: Undo }>(`/my-day/${it.id}`);
      refresh();
      toast(`Took ${it.task.title} off the day`, { action: { label: "Undo", onClick: () => void api.post("/my-day/restore", { items: [r.item] }).then(refresh, (e) => showError(e as Error)) } });
    } catch (e) { showError(e as Error); }
  };

  const finish = async (it: PlanItem) => {
    try { await api.patch(`/tasks/${it.taskId}`, { status: it.task.status === "done" ? "todo" : "done" }); refresh(); void qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch (e) { showError(e as Error); }
  };

  const planTomorrow = useMutation({
    mutationFn: () => api.post<{ moved: number; kept: number; undo: Undo[] }>("/my-day/plan-tomorrow", { day }),
    onSuccess: (r) => {
      refresh();
      toast(r.moved ? `Moved ${r.moved} to tomorrow${r.kept ? `, ${r.kept} at the same time` : ""}` : "Nothing left to move", r.moved ? { action: { label: "Undo", onClick: () => void api.post("/my-day/restore", { items: r.undo }).then(refresh, (e) => showError(e as Error)) } } : undefined);
    },
    onError: (e) => showError(e as Error),
  });

  const left = items.filter((i) => i.task.status !== "done").length;
  return (
    <section className="mb-6" aria-labelledby="myday-h" data-testid="my-day">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
        <h2 id="myday-h" className="text-[13px] font-semibold uppercase tracking-[0.04em] text-subtle">My day</h2>
        <div className="flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Day">
          {[{ d: today, label: "Today" }, { d: tomorrow, label: "Tomorrow" }].map((x) => (
            <button key={x.label} role="tab" aria-selected={day === x.d} onClick={() => setDay(x.d)}
              className={cn("min-h-8 rounded-md px-2.5 text-[12.5px] transition-colors duration-150 max-sm:min-h-10", day === x.d ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>{x.label}</button>
          ))}
        </div>
        <span className="text-[12.5px] text-muted">{q.data ? (items.length ? `${left} left of ${items.length}` : "") : ""}</span>
        {day === today && items.some((i) => i.task.status !== "done") && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => planTomorrow.mutate()} loading={planTomorrow.isPending} data-testid="plan-tomorrow">
            <IconSunrise className="h-4 w-4" />Plan tomorrow
          </Button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{live}</p>
      {q.isPending ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]"><Skeleton className="h-48" /><Skeleton className="h-72" /></div>
      ) : q.isError ? (
        <div className="elev-1 flex items-center gap-3 rounded-[var(--radius-r14)] bg-surface p-4 text-[13px]" role="alert">
          <span className="flex-1 text-muted">Your day plan didn't load.</span><Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Try again</Button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <DayList items={unscheduled} scheduled={scheduled} suggestions={q.data!.suggestions} onPlace={place} onRemove={remove} onFinish={finish} />
          <DayColumn day={day} isToday={day === today} items={scheduled} onPlace={place} onRemove={remove} onFinish={finish} />
        </div>
      )}
    </section>
  );
}

function TaskLine({ it, onFinish }: { it: PlanItem; onFinish: (it: PlanItem) => void }) {
  const done = it.task.status === "done";
  return (
    <>
      <button type="button" onClick={() => onFinish(it)} aria-label={done ? `Mark ${it.task.title} not done` : `Mark ${it.task.title} done`} aria-pressed={done}
        className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors duration-150 max-sm:h-6 max-sm:w-6", done ? "border-brand bg-brand text-brand-fg" : "border-line-strong hover:border-brand")}>
        {done && <IconCheck size={12} />}
      </button>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone(it.task.project?.color) }} aria-hidden />
      <Link to={`/app/tasks?task=${it.taskId}`} className={cn("min-w-0 flex-1 truncate text-[13.5px] hover:underline", done && "text-subtle line-through")}>{it.task.title}</Link>
    </>
  );
}

function ScheduleAt({ it, onPlace }: { it: PlanItem; onPlace: (o: { itemId: string; start: number | null; title: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(minutesText(it.start ?? Math.min(1380, Math.ceil(nowMinute() / 15) * 15)));
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Schedule ${it.task.title}`}><IconCalendarClock className="h-4 w-4" /><span className="max-sm:hidden">Schedule</span></Button>;
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const [h, m] = val.split(":").map(Number); setOpen(false); onPlace({ itemId: it.id, start: h * 60 + m, title: it.task.title }); }}>
      <Input type="time" step={900} value={val} onChange={(e) => setVal(e.target.value)} aria-label={`Start time for ${it.task.title}`} className="h-8 w-[108px] text-[13px] max-sm:h-11" autoFocus />
      <Button size="sm" type="submit">Set</Button>
    </form>
  );
}

function DayList({ items, scheduled, suggestions, onPlace, onRemove, onFinish }: {
  items: PlanItem[]; scheduled: PlanItem[]; suggestions: PlanTask[];
  onPlace: (o: { itemId?: string; taskId?: string; start: number | null; title: string }) => void; onRemove: (it: PlanItem) => void; onFinish: (it: PlanItem) => void;
}) {
  const drag = (e: DragEvent, it: PlanItem) => { e.dataTransfer.setData("text/x-plan-item", it.id); e.dataTransfer.setData("text/plain", it.task.title); e.dataTransfer.effectAllowed = "move"; };
  const dragTask = (e: DragEvent, t: PlanTask) => { e.dataTransfer.setData("text/x-task", t.id); e.dataTransfer.setData("text/plain", t.title); e.dataTransfer.effectAllowed = "copy"; };
  return (
    <div className="elev-1 rounded-[var(--radius-r14)] bg-surface" data-testid="my-day-list">
      <div className="hairline-b flex items-center justify-between px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">To do</h3>
        <span className="text-[12px] text-subtle max-sm:hidden">Drag onto the day to block time</span>
      </div>
      {!items.length && !scheduled.length && !suggestions.length ? (
        <div className="px-4 py-6 text-center">
          <p className="text-[14px] font-medium">Plan your day</p>
          <p className="mt-1 text-[13px] text-muted">Add tasks from any task with Add to My Day, then give them a time.</p>
        </div>
      ) : !items.length ? (
        <p className="px-4 py-3 text-[13px] text-muted">{scheduled.length ? "Everything on today's list has a time." : "Nothing on the list yet."}</p>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={it.id} draggable onDragStart={(e) => drag(e, it)} data-testid="my-day-item"
              className={cn("group flex min-h-11 cursor-grab items-center gap-2.5 px-4 py-1.5 hover:bg-hover active:cursor-grabbing", i > 0 && "hairline-t")}>
              <TaskLine it={it} onFinish={onFinish} />
              <ScheduleAt it={it} onPlace={(o) => onPlace(o)} />
              <button type="button" className="rounded-md p-1.5 text-subtle hover:bg-elevated hover:text-fg focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100" aria-label={`Take ${it.task.title} off the day`} onClick={() => onRemove(it)}><IconClose size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <div className="hairline-t px-4 pb-3 pt-2.5" data-testid="my-day-suggestions">
          <p className="mb-1.5 text-[12px] font-medium text-subtle">Due for you</p>
          <ul className="space-y-0.5">
            {suggestions.map((t) => (
              <li key={t.id} draggable onDragStart={(e) => dragTask(e, t)} className="flex min-h-10 items-center gap-2.5 rounded-lg px-1 text-[13px] hover:bg-hover">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone(t.project?.color) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {t.due && <span className={cn("shrink-0 text-[12px]", new Date(t.due).getTime() < Date.now() ? "text-bad" : "text-subtle")}>{new Date(t.due).getTime() < Date.now() ? "Overdue" : "Today"}</span>}
                <Button size="sm" variant="ghost" onClick={() => onPlace({ taskId: t.id, start: null, title: t.title })} aria-label={`Add ${t.title} to My Day`}><IconPlus className="h-4 w-4" />Add</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DayColumn({ day, isToday, items, onPlace, onRemove, onFinish }: {
  day: string; isToday: boolean; items: PlanItem[];
  onPlace: (o: { itemId?: string; taskId?: string; start: number | null; minutes?: number; title: string }) => void; onRemove: (it: PlanItem) => void; onFinish: (it: PlanItem) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<{ start: number; minutes: number } | null>(null);
  const [resize, setResize] = useState<{ id: string; minutes: number } | null>(null);
  const [now, setNow] = useState(nowMinute());
  useEffect(() => { const i = setInterval(() => setNow(nowMinute()), 60_000); return () => clearInterval(i); }, []);
  useEffect(() => { // open on the morning, or on the first block when it is earlier
    const first = items[0]?.start ?? 480;
    if (scroller.current) scroller.current.scrollTop = Math.max(0, Math.min(first, isToday ? Math.max(420, now - 60) : 420)) * PX_PER_MIN - 8;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);
  const at = (e: { clientY: number }) => minuteAt(e.clientY, grid.current!.getBoundingClientRect().top);
  const over = (e: DragEvent) => {
    if (![...e.dataTransfer.types].some((t) => t === "text/x-plan-item" || t === "text/x-task")) return;
    e.preventDefault();
    const s = clampBlock(at(e) - 15, 30);
    setGhost({ start: s.start, minutes: 30 });
  };
  const drop = (e: DragEvent) => {
    e.preventDefault(); setGhost(null);
    const itemId = e.dataTransfer.getData("text/x-plan-item"), taskId = e.dataTransfer.getData("text/x-task");
    const title = e.dataTransfer.getData("text/plain") || "Task";
    const start = clampBlock(at(e) - 15, 30).start;
    if (itemId) onPlace({ itemId, start, title }); else if (taskId) onPlace({ taskId, start, title });
  };
  const startResize = (e: ReactPointerEvent, it: PlanItem) => {
    e.preventDefault(); e.stopPropagation();
    const top = it.start!;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setResize({ id: it.id, minutes: clampBlock(top, at(ev) - top).minutes });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const minutes = clampBlock(top, at(ev) - top).minutes;
      setResize(null);
      if (minutes !== it.minutes) onPlace({ itemId: it.id, start: top, minutes, title: it.task.title });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => h), []);
  return (
    <div className="elev-1 overflow-hidden rounded-[var(--radius-r14)] bg-surface" data-testid="my-day-column">
      <div className="hairline-b flex items-center justify-between px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">{isToday ? "Today" : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</h3>
        <span className="text-[12px] text-subtle">{items.length ? `${items.length} blocked, ${Math.round(items.reduce((s, i) => s + i.minutes, 0) / 6) / 10}h` : "No time blocked"}</span>
      </div>
      <div ref={scroller} className="relative h-[460px] overflow-y-auto overscroll-contain rounded-b-[var(--radius-r14)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand max-sm:h-[380px]" tabIndex={0} role="region" aria-label={isToday ? "Today's schedule" : "Tomorrow's schedule"} data-testid="my-day-scroll">
        <div ref={grid} className="relative" style={{ height: 24 * HOUR_PX }} onDragOver={over} onDragLeave={() => setGhost(null)} onDrop={drop} data-testid="my-day-grid">
          {hours.map((h) => (
            <div key={h} className="absolute inset-x-0 flex" style={{ top: h * HOUR_PX, height: HOUR_PX }} aria-hidden>
              <span className="w-14 shrink-0 -translate-y-2 pr-2 text-right text-[11px] tabular-nums text-subtle">{h ? clockOf(h * 60).replace(":00", "") : ""}</span>
              <span className="hairline-t flex-1" />
            </div>
          ))}
          {isToday && <div className="pointer-events-none absolute left-12 right-0 z-10 flex items-center" style={{ top: now * PX_PER_MIN - 4 }} aria-hidden><span className="h-2 w-2 rounded-full bg-bad" /><span className="h-px flex-1 bg-bad" /></div>}
          {ghost && <div className="pointer-events-none absolute left-14 right-2 rounded-lg border-2 border-dashed border-brand/60 bg-brand/5" style={{ top: ghost.start * PX_PER_MIN, height: ghost.minutes * PX_PER_MIN }} aria-hidden />}
          <ol aria-label="Time blocks">
            {items.map((it) => {
              const minutes = resize?.id === it.id ? resize.minutes : it.minutes;
              const done = it.task.status === "done";
              const short = minutes < 45;
              return (
                <li key={it.id} draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-plan-item", it.id); e.dataTransfer.setData("text/plain", it.task.title); }}
                  data-testid="my-day-block" aria-label={`${it.task.title}, ${clockOf(it.start!)} to ${clockOf(it.start! + minutes)}`}
                  className={cn("group absolute left-14 right-2 overflow-hidden rounded-lg border-l-[3px] bg-brand/10 px-2 text-[12.5px] shadow-sm transition-[top,height] duration-150 motion-reduce:transition-none focus-within:ring-2 focus-within:ring-brand", done && "opacity-60")}
                  style={{ top: it.start! * PX_PER_MIN + 1, height: Math.max(minutes * PX_PER_MIN - 2, 14), borderLeftColor: tone(it.task.project?.color) }}>
                  <div className={cn("flex items-center gap-1.5", short ? "h-full" : "pt-1")}>
                    <TaskLine it={it} onFinish={onFinish} />
                    <span className="shrink-0 text-[11.5px] tabular-nums text-muted max-sm:hidden">{clockOf(it.start!)} to {clockOf(it.start! + minutes)}</span>
                  </div>
                  <div className={cn("absolute right-1 top-0.5 z-10 flex gap-0.5 rounded-md bg-surface/95 opacity-0 shadow-sm transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100", short && "top-0")}>
                    <IconBtn label={`Move ${it.task.title} earlier`} onClick={() => onPlace({ itemId: it.id, start: it.start! - 15, title: it.task.title })}><IconChevronUp size={13} /></IconBtn>
                    <IconBtn label={`Move ${it.task.title} later`} onClick={() => onPlace({ itemId: it.id, start: it.start! + 15, title: it.task.title })}><IconChevronDown size={13} /></IconBtn>
                    <IconBtn label={`Make ${it.task.title} longer`} onClick={() => onPlace({ itemId: it.id, start: it.start!, minutes: it.minutes + 15, title: it.task.title })}><IconPlus size={13} /></IconBtn>
                    <IconBtn label={`Make ${it.task.title} shorter`} onClick={() => onPlace({ itemId: it.id, start: it.start!, minutes: Math.max(15, it.minutes - 15), title: it.task.title })}><IconMinus size={13} /></IconBtn>
                    <IconBtn label={`Unschedule ${it.task.title}`} onClick={() => onPlace({ itemId: it.id, start: null, title: it.task.title })}><IconUndo size={13} /></IconBtn>
                    <IconBtn label={`Take ${it.task.title} off the day`} onClick={() => onRemove(it)}><IconClose size={13} /></IconBtn>
                  </div>
                  <div role="separator" aria-hidden onPointerDown={(e) => startResize(e, it)} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" data-testid="my-day-resize" />
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-hover hover:text-fg max-sm:h-9 max-sm:w-9">{children}</button>;
}

/** "Add to My Day" for the task panel: puts the task on today's list (or says it is there). */
export function AddToMyDay({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { await api.post("/my-day", { day: localYmd(), taskId, start: null }); toast("Added to My Day"); void qc.invalidateQueries({ queryKey: ["my-day"] }); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return <Button size="sm" variant="secondary" onClick={() => void add()} loading={busy} data-testid="add-to-my-day"><IconSunrise className="h-4 w-4" />Add to My Day</Button>;
}
