import { useMemo, useState } from "react";
import FullCalendar, { type EventDropInfo } from "@fullcalendar/react";
// R35: FullCalendar 7. Day grid and drag live inside the React package; v7 injects no CSS, so the skeleton and the
// classic theme are imported here and themed through --fc-classic-* in index.css (.mm-calendar).
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import type { Task } from "./data";
import { tone } from "@/web/components/app-bits";
import { useNavigate } from "react-router";
import { IconCalendarDays, IconChevronRight } from "@/web/components/ui/icon";
import { useMediaQuery } from "@/web/lib/use-compact";
import { PHONE_QUERY } from "@/web/lib/phone";
import { cn } from "@/web/lib/cn";
import { agendaDays } from "./calendar-agenda";
import { emptyTasksCopy } from "@/web/lib/empty-states"; // R30
import { OtherCalendarsBar, useOtherCalendars } from "./calendar-other";
import { tr, uiLocale, tl } from "@/web/i18n"; // R104

/** Month calendar of due dates (FullCalendar Standard, MIT). Drag a task to another day to move its due date. */
export function TaskCalendar({ tasks, onOpen, onDue }: { tasks: Task[]; onOpen: (id: string) => void; onDue: (id: string, due: string) => void }) {
  const events = useMemo(() => tasks.filter((t) => t.due || t.start).map((t) => ({
    id: t.id, title: `${t.ref} ${t.title}`, start: (t.start ?? t.due)!.slice(0, 10),
    end: t.start && t.due && t.due > t.start ? new Date(new Date(t.due).getTime() + 86_400_000).toISOString().slice(0, 10) : undefined,
    allDay: true, color: t.status === "done" ? "var(--color-fill)" : tone(t.statusColor), contrastColor: t.status === "done" ? "var(--color-subtle)" : "#111113",
  })), [tasks]);
  const other = useOtherCalendars();
  const navigate = useNavigate();
  const onDrop = (e: EventDropInfo) => {
    const t = tasks.find((x) => x.id === e.event.id);
    if (!t || !e.event.start) return;
    const shift = e.delta.days;
    const base = t.due ?? t.start!;
    onDue(t.id, new Date(new Date(base).getTime() + shift * 86_400_000).toISOString().slice(0, 10));
  };
  // R48 mobile web: a phone opens on the agenda (a list by day); Month stays one tap away. Desktop is unchanged.
  const phone = useMediaQuery(PHONE_QUERY);
  const [mode, setMode] = useState<"agenda" | "month">("agenda");
  const agenda = phone && mode === "agenda";
  return (
    <div className={cn("mm-calendar rounded-xl border border-line bg-surface p-3", phone && "max-sm:border-0 max-sm:bg-transparent max-sm:p-0")} data-testid="task-calendar">
      {phone && (
        <div role="tablist" aria-label={tr("calendar.calendar_layout")} className="mb-3 grid grid-cols-2 rounded-[10px] bg-fill p-0.5" data-testid="calendar-mode">
          {(["agenda", "month"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={cn("h-11 rounded-[8px] text-[15px] font-medium transition-colors duration-150 motion-reduce:transition-none", mode === m ? "bg-surface text-fg shadow-card" : "text-muted")}>
              {m === "agenda" ? tr("calendar.agenda") : tr("calendar.month")}
            </button>
          ))}
        </div>
      )}
      {agenda ? <PhoneAgenda tasks={tasks} onOpen={onOpen} /> : <>
      <OtherCalendarsBar layer={other} />
      <FullCalendar
        plugins={[classicThemePlugin, dayGridPlugin, interactionPlugin]} initialView="dayGridMonth" locale={uiLocale()?.toLowerCase() ?? "en-au"} firstDay={1} height="auto"
        events={[...events, ...other.events]} datesSet={(r) => other.setRange({ from: r.start.toISOString(), to: r.end.toISOString() })} editable eventStartEditable eventDurationEditable={false} dayMaxEvents={4}
        headerToolbar={{ start: "title", center: "", end: "today prev,next" }} buttons={{ today: { text: tr("myday.today"), hint: tr("myday.today") } }}
        toolbarTitleClass="mm-fc-title" dayHeaderInnerClass="mm-fc-muted" dayCellTopInnerClass="mm-fc-muted" eventClass="mm-fc-event"
        eventDidMount={(a) => { const src = a.event.extendedProps.sourceColor as string | undefined; if (src) a.el.style.setProperty("--mm-src", src); }}
        eventClick={(e) => { e.jsEvent.preventDefault(); const href = e.event.extendedProps.href as string | null | undefined; if (href) navigate(href); else if (!e.event.extendedProps.readOnly) onOpen(e.event.id); }} eventDrop={onDrop}
      />
      </>}
      {events.length === 0 && !agenda && (
        <div className="mx-2 mt-3 flex items-center gap-3 rounded-lg bg-fill px-3 py-2.5" data-testid="calendar-empty">
          <IconCalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <p className="text-[13px] text-muted"><span className="font-medium text-fg">{emptyTasksCopy("calendar", false).title}.</span> {emptyTasksCopy("calendar", false).body}</p>
        </div>
      )}
    </div>
  );
}

/** R48 mobile web: tasks by day, Overdue first, 56 px rows that open the task. */
function PhoneAgenda({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const days = useMemo(() => agendaDays(tasks, new Date()), [tasks]);
  return (
    <div className="space-y-5" data-testid="calendar-agenda">
      {days.map((d) => (
        <section key={d.key} aria-label={d.label}>
          <h2 className={cn("mb-1.5 px-1 text-[13px] font-semibold uppercase tracking-[0.04em]", d.overdue ? "text-bad" : d.label === "Today" ? "text-brand-hover" : "text-subtle")}>
            {d.label}{d.items.length > 0 && <span className="ml-1.5 font-normal normal-case tracking-normal text-subtle">{d.items.length}</span>}
          </h2>
          {d.items.length === 0
            ? <p className="rounded-[14px] border border-line bg-surface px-4 py-3.5 text-[15px] text-muted">{tr("calendar.nothing_due_today")}</p>
            : (
              <ul className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
                {d.items.map((t, i) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => onOpen(t.id)} data-testid="agenda-row"
                      className="flex min-h-14 w-full items-center gap-3 pl-4 pr-3 text-left transition-colors duration-150 active:bg-hover">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.status === "done" ? "var(--color-subtle)" : tone(t.statusColor) }} aria-hidden />
                      <span className={cn("flex min-h-14 min-w-0 flex-1 items-center gap-2", i > 0 && "border-t border-line")}>
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[16px]", t.status === "done" && "text-muted line-through")}>{t.title}</span>
                          <span className="block truncate text-[13px] text-subtle">{t.ref} · {tl("taskstatus", t.statusName)}{d.overdue && t.due ? ` · ${tr("calendar.due_short")} ${t.due.slice(8, 10)}/${t.due.slice(5, 7)}` : ""}</span>
                        </span>
                        <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      ))}
    </div>
  );
}
