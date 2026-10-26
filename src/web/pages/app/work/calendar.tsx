import { useMemo } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventDropArg } from "@fullcalendar/core";
import type { Task } from "./data";
import { tone } from "@/web/components/app-bits";
import { useNavigate } from "react-router";
import { CalendarDays } from "lucide-react";
import { emptyTasksCopy } from "@/web/lib/empty-states"; // R30
import { OtherCalendarsBar, useOtherCalendars } from "./calendar-other";

/** Month calendar of due dates (FullCalendar Standard, MIT). Drag a task to another day to move its due date. */
export function TaskCalendar({ tasks, onOpen, onDue }: { tasks: Task[]; onOpen: (id: string) => void; onDue: (id: string, due: string) => void }) {
  const events = useMemo(() => tasks.filter((t) => t.due || t.start).map((t) => ({
    id: t.id, title: `${t.ref} ${t.title}`, start: (t.start ?? t.due)!.slice(0, 10),
    end: t.start && t.due && t.due > t.start ? new Date(new Date(t.due).getTime() + 86_400_000).toISOString().slice(0, 10) : undefined,
    allDay: true, backgroundColor: t.status === "done" ? "var(--color-fill)" : tone(t.statusColor), borderColor: "transparent", textColor: t.status === "done" ? "var(--color-subtle)" : "#111113",
  })), [tasks]);
  const other = useOtherCalendars();
  const navigate = useNavigate();
  const onDrop = (e: EventDropArg) => {
    const t = tasks.find((x) => x.id === e.event.id);
    if (!t || !e.event.start) return;
    const shift = e.delta.days;
    const base = t.due ?? t.start!;
    onDue(t.id, new Date(new Date(base).getTime() + shift * 86_400_000).toISOString().slice(0, 10));
  };
  return (
    <div className="mm-calendar rounded-xl border border-line bg-surface p-3" data-testid="task-calendar">
      <OtherCalendarsBar layer={other} />
      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]} initialView="dayGridMonth" locale="en-au" firstDay={1} height="auto"
        events={[...events, ...other.events]} datesSet={(r) => other.setRange({ from: r.start.toISOString(), to: r.end.toISOString() })} editable eventStartEditable eventDurationEditable={false} dayMaxEvents={4}
        headerToolbar={{ left: "title", center: "", right: "today prev,next" }} buttonText={{ today: "Today" }}
        eventClick={(e) => { e.jsEvent.preventDefault(); const href = e.event.extendedProps.href as string | null | undefined; if (href) navigate(href); else if (!e.event.extendedProps.readOnly) onOpen(e.event.id); }} eventDrop={onDrop}
      />
      {events.length === 0 && (
        <div className="mx-2 mt-3 flex items-center gap-3 rounded-lg bg-fill px-3 py-2.5" data-testid="calendar-empty">
          <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <p className="text-[13px] text-muted"><span className="font-medium text-fg">{emptyTasksCopy("calendar", false).title}.</span> {emptyTasksCopy("calendar", false).body}</p>
        </div>
      )}
    </div>
  );
}
