import { IconAgent, IconChevronRight, IconFlag } from "@/web/components/ui/icon";
import { Avatar } from "@/web/components/ui/misc";
import { initials } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { tone } from "@/web/components/app-bits";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, isAgentLike, type Project, type Task } from "./data";
import { TypeIcon } from "./task-type";
import { useRef } from "react";
import { useWindowedList } from "@/web/lib/use-windowed-list"; // R43 (MB-210)

/**
 * R41 (MB-226): the Tasks list on a phone. Below the sm breakpoint each task is one card row, the way native task apps
 * set a list: the title on up to two lines, then the ref, a status pill, the due chip and the priority flag, with the
 * assignee on the right. The whole row is one 64 px+ tap target that opens the task. Larger screens keep the table.
 */
export function PhoneTaskList({ tasks, projects, onOpen }: { tasks: Task[]; projects: Project[]; onOpen: (id: string) => void }) {
  const name = (id: string) => projects.find((p) => p.id === id)?.name;
  const multi = new Set(tasks.map((t) => t.projectId)).size > 1;
  // R43 (MB-210): a long list keeps only the cards on screen in the DOM; spacers hold the scroll height.
  const listRef = useRef<HTMLUListElement>(null);
  const win = useWindowedList({ count: tasks.length, estimate: 77, listRef });
  return (
    <ul ref={listRef} className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-[var(--shadow-e1)]" aria-label="Tasks" data-testid="phone-task-list">
      {win.padTop > 0 && <li aria-hidden="true" style={{ height: win.padTop }} />}
      {tasks.slice(win.start, win.end).map((t, i) => {
        const overdue = isOverdue(t);
        const n = win.start + i;
        return (
          <li key={t.id} className="border-b border-line last:border-b-0" data-win-row={n} data-task-id={t.id} aria-setsize={tasks.length} aria-posinset={n + 1}>
            <button type="button" onClick={() => onOpen(t.id)} data-testid="phone-task-row"
              className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 active:bg-hover motion-reduce:transition-none">
              <span className="min-w-0 flex-1">
                <span className={cn("line-clamp-2 text-[15px] font-medium leading-snug", t.status === "done" ? "text-muted line-through decoration-line-strong" : "text-fg")}>{t.title}</span>
                <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-subtle">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap"><TypeIcon type={t.type} /><span className="font-mono">{t.ref}</span></span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11.5px] font-medium text-fg/80">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone(t.statusColor) }} aria-hidden />{t.statusName}
                  </span>
                  {t.due && <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", overdue ? "bg-bad-soft text-bad" : "bg-fill text-muted")}>{overdue ? "Overdue " : ""}{dueLabel(t.due)}</span>}
                  {t.priority !== "none" && <span className={cn("inline-flex items-center", PRIORITY_COLOR[t.priority])} aria-label={`${PRIORITY_LABEL[t.priority]} priority`} title={PRIORITY_LABEL[t.priority]}><IconFlag className="h-3.5 w-3.5" /></span>}
                  {multi && name(t.projectId) && <span className="truncate">{name(t.projectId)}</span>}
                </span>
              </span>
              {t.assignee && (isAgentLike(t.assignee)
                ? <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-hover" aria-label={`${t.assignee.name} (agent)`}><IconAgent className="h-3.5 w-3.5" /></span>
                : <span className="shrink-0" aria-label={`Assigned to ${t.assignee.name}`}><Avatar label={initials(t.assignee.name)} className="h-7 w-7 text-[10.5px]" /></span>)}
              <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
            </button>
          </li>
        );
      })}
      {win.padBottom > 0 && <li aria-hidden="true" style={{ height: win.padBottom }} />}
    </ul>
  );
}
