import { IconAgent, IconChevronRight, IconFlag } from "@/web/components/ui/icon";
import { Avatar } from "@/web/components/ui/misc";
import { initials } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { tone } from "@/web/components/app-bits";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, isAgentLike, useTags, type AssigneeOption, type CustomField, type Project, type Task } from "./data";
import { TypeIcon } from "./task-type";
import { useEffect, useMemo, useRef, useState } from "react";
import { collapsedKey, groupTasks, type GroupBy } from "@/web/lib/task-groups-r84"; // R84
import { AvatarStack, TagChips } from "./tasks-r84"; // R84
import { useWindowedList } from "@/web/lib/use-windowed-list"; // R43 (MB-210)
import { sortTasks } from "@/web/lib/task-sort-par1"; // PAR1
import { TABLE_COLUMNS, type TableContext } from "./table"; // PAR1: the same sort keys as the table

/**
 * R41 (MB-226): the Tasks list on a phone. Below the sm breakpoint each task is one card row, the way native task apps
 * set a list: the title on up to two lines, then the ref, a status pill, the due chip and the priority flag, with the
 * assignee on the right. The whole row is one 64 px+ tap target that opens the task. Larger screens keep the table.
 */
export function PhoneTaskList({ tasks: given, projects, onOpen, groupBy, fields = [], people = [], sort = null }: {
  tasks: Task[]; projects: Project[]; onOpen: (id: string) => void;
  /** PAR1: the same sort as the list's column headers on a computer. */
  sort?: { id: string; desc: boolean } | null;
  /** R84: the same grouping as the list on a computer, as sections with a header you can fold. */
  groupBy?: GroupBy | null; fields?: CustomField[]; people?: AssigneeOption[];
}) {
  const tagList = useTags();
  const tasks = useMemo(() => {
    const pmap = new Map(projects.map((p) => [p.id, p]));
    const ctx: TableContext = { projects: pmap, people, statusesFor: (t) => pmap.get(t.projectId)?.statuses ?? [] };
    return sortTasks(given, sort, (id) => { const col = TABLE_COLUMNS.find((c) => c.id === id); return col?.sortKey ? (t: Task) => col.sortKey!(t, ctx) : null; });
  }, [given, sort, projects, people]);
  const groups = useMemo(() => (groupBy ? groupTasks(tasks, groupBy, { projects, tags: tagList.data ?? [], fields, people: people.map((p) => ({ id: p.id, name: p.name })) }) : null), [groupBy, tasks, projects, tagList.data, fields, people]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!groupBy) return;
    try { setCollapsed(new Set(JSON.parse(localStorage.getItem(collapsedKey(groupBy)) ?? "[]") as string[])); } catch { setCollapsed(new Set()); }
  }, [groupBy]);
  const fold = (key: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(key)) n.delete(key); else n.add(key);
    try { if (groupBy) localStorage.setItem(collapsedKey(groupBy), JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  if (groups) {
    return (
      <div className="space-y-3" data-testid="phone-task-groups">
        {groups.map((g) => {
          const open = !collapsed.has(g.key);
          return (
            <section key={g.key} aria-label={g.label}>
              <button type="button" aria-expanded={open} onClick={() => fold(g.key)} data-testid="group-header" className="flex min-h-11 w-full items-center gap-2 px-1 text-left text-[13px] font-semibold text-fg">
                <IconChevronRight className={cn("h-4 w-4 text-muted transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                {g.color && <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: g.key.startsWith("status:") ? tone(g.color) : g.color }} />}
                {g.label}<span className="font-normal text-subtle">{g.tasks.length}</span>
              </button>
              {open && <PhoneTaskRows tasks={g.tasks} projects={projects} onOpen={onOpen} plain />}
            </section>
          );
        })}
        {!groups.length && <p className="px-1 py-6 text-center text-[13px] text-muted">No tasks match these filters.</p>}
      </div>
    );
  }
  return <PhoneTaskRows tasks={tasks} projects={projects} onOpen={onOpen} />;
}

function PhoneTaskRows({ tasks, projects, onOpen, plain }: { tasks: Task[]; projects: Project[]; onOpen: (id: string) => void; plain?: boolean }) {
  const name = (id: string) => projects.find((p) => p.id === id)?.name;
  const multi = new Set(tasks.map((t) => t.projectId)).size > 1;
  // R43 (MB-210): a long list keeps only the cards on screen in the DOM; spacers hold the scroll height.
  const listRef = useRef<HTMLUListElement>(null);
  const win = useWindowedList({ count: tasks.length, estimate: 77, listRef, ...(plain ? { minCount: Number.MAX_SAFE_INTEGER } : {}) });
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
                  {t.labels.length > 0 && <TagChips labels={t.labels} max={2} />}
                </span>
              </span>
              {(t.assignees?.length ?? 0) > 1 ? <span className="shrink-0"><AvatarStack people={t.assignees!} size="md" max={2} /></span> : t.assignee && (isAgentLike(t.assignee)
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
