import { useMemo } from "react";
import { Gantt, WillowDark } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/style.css";
import type { Task } from "./data";

const DAY = 86_400_000;
const fmtMonth = (d: Date) => d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
const fmtDay = (d: Date) => String(d.getDate());

/**
 * Timeline (SVAR React Gantt core, MIT). A bar runs from start to due; a task with only a
 * due date shows as one day. Dragging or resizing a bar saves the new dates.
 */
export function TaskTimeline({ tasks, onOpen, onDates }: { tasks: Task[]; onOpen: (id: string) => void; onDates: (id: string, start: string, due: string) => void }) {
  const dated = tasks.filter((t) => t.due || t.start).sort((a, b) => (a.start ?? a.due ?? "").localeCompare(b.start ?? b.due ?? ""));
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const rows = useMemo(() => dated.map((t) => {
    const end = new Date(t.due ?? t.start!);
    const start = new Date(t.start ?? t.due!);
    return { id: t.id, text: `${t.ref} ${t.title}`, start, end: new Date(Math.max(end.getTime(), start.getTime()) + DAY), progress: t.status === "done" ? 100 : t.subtasks.total ? Math.round((t.subtasks.done / t.subtasks.total) * 100) : 0, type: "task" };
  }), [dated]);
  const min = rows.length ? new Date(Math.min(...rows.map((r) => r.start.getTime())) - (narrow ? 1 : 7) * DAY) : new Date(Date.now() - 7 * DAY);
  const max = rows.length ? new Date(Math.max(...rows.map((r) => r.end.getTime())) + 14 * DAY) : new Date(Date.now() + 30 * DAY);
  if (!rows.length) return <p className="rounded-xl border border-line bg-surface p-6 text-[13px] text-muted" data-testid="task-timeline">No tasks have dates yet. Give a task a start or due date and it shows on the timeline.</p>;
  return (
    <div className="mm-gantt h-[calc(100dvh-230px)] min-h-[360px] overflow-hidden rounded-xl border border-line" data-testid="task-timeline">
      <WillowDark fonts={false}>
        <Gantt
          tasks={rows} links={[]} start={min} end={max} cellWidth={36} cellHeight={36} scaleHeight={30}
          scales={[{ unit: "month", step: 1, format: fmtMonth }, { unit: "day", step: 1, format: fmtDay }]}
          columns={[{ id: "text", header: "Task", width: 300 }] as never} {...({ displayMode: narrow ? "chart" : "all" } as object)}
          init={(api) => {
            api.on("update-task", (ev: { id: string | number; task: { start?: Date; end?: Date }; inProgress?: boolean }) => {
              if (ev.inProgress || !ev.task.start || !ev.task.end) return;
              const start = ev.task.start.toISOString().slice(0, 10);
              const due = new Date(ev.task.end.getTime() - DAY).toISOString().slice(0, 10);
              onDates(String(ev.id), start, due < start ? start : due);
            });
            api.intercept("show-editor", (ev: { id?: string | number }) => { if (ev.id) onOpen(String(ev.id)); return false; });
          }}
        />
      </WillowDark>
    </div>
  );
}
