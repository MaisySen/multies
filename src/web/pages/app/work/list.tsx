import { useMemo, useState } from "react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Bot, CheckCircle2, Circle, Mail } from "lucide-react";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { PRIORITY_COLOR, PRIORITY_LABEL, dueLabel, isOverdue, type AssigneeOption, type CustomField, type Priority, type Project, type Task } from "./data";
import { FieldCell, formatValue } from "./fields";
import { tone } from "@/web/components/app-bits";
import { TypeIcon } from "./task-type";

/** A sort key for a custom field value: numbers as numbers, select by option order, empty last. */
function fieldSortKey(f: CustomField, t: Task, people: AssigneeOption[]): string | number {
  const v = t.fields?.[f.id];
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return f.type === "number" || f.type === "currency" ? Number.MAX_SAFE_INTEGER : "\uffff";
  if (f.type === "number" || f.type === "currency" || typeof v === "number") return Number(v);
  if (f.type === "checkbox") return v ? 0 : 1;
  if (f.type === "select") return String(f.options.findIndex((o) => o.id === v)).padStart(3, "0");
  return formatValue(f, v, people).toLowerCase();
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** The list view: a sortable table (TanStack Table). */
export function TaskList({ tasks, projects, onOpen, onToggle, fields = [], people = [] }: { tasks: Task[]; projects: Project[]; onOpen: (id: string) => void; onToggle: (t: Task) => void; fields?: CustomField[]; people?: AssigneeOption[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const pname = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const columns = useMemo<ColumnDef<Task>[]>(() => [
    {
      id: "done", header: "", enableSorting: false, size: 36,
      cell: ({ row }) => (
        <button onClick={(e) => { e.stopPropagation(); onToggle(row.original); }} aria-label={row.original.status === "done" ? `Mark ${row.original.title} as not done` : `Mark ${row.original.title} as done`}>
          {row.original.status === "done" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted" />}
        </button>
      ),
    },
    {
      id: "title", header: "Task", accessorFn: (t) => t.title,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <TypeIcon type={row.original.type} />
          <span className="shrink-0 font-mono text-[11.5px] text-subtle">{row.original.ref}</span>
          <span className={cn("truncate font-medium", row.original.status === "done" && "text-subtle line-through")}>{row.original.title}</span>
          {row.original.source && <Mail className="h-3 w-3 shrink-0 text-subtle" aria-label="From email" />}
        </div>
      ),
    },
    {
      id: "status", header: "Status", accessorFn: (t) => `${pname.get(t.projectId)?.statuses.findIndex((s) => s.id === t.statusId) ?? 0}`,
      cell: ({ row }) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-2 w-2 rounded-full" style={{ background: tone(row.original.statusColor) }} />{row.original.statusName}</span>,
    },
    {
      id: "assignee", header: "Assignee", accessorFn: (t) => t.assignee?.name ?? "~",
      cell: ({ row }) => row.original.assignee ? <span className="inline-flex items-center gap-1 whitespace-nowrap">{row.original.assignee.type === "agent" && <Bot className="h-3.5 w-3.5 text-brand-hover" />}{row.original.assignee.name}</span> : <span className="text-subtle">Nobody</span>,
    },
    { id: "priority", header: "Priority", accessorFn: (t) => PRIORITY_RANK[t.priority], cell: ({ row }) => <span className={PRIORITY_COLOR[row.original.priority]}>{row.original.priority === "none" ? "" : PRIORITY_LABEL[row.original.priority]}</span> },
    { id: "due", header: "Due", accessorFn: (t) => t.due ?? "9999", cell: ({ row }) => <span className={cn("whitespace-nowrap", isOverdue(row.original) && "text-bad")}>{dueLabel(row.original.due) ?? ""}</span> },
    { id: "project", header: "Project", accessorFn: (t) => pname.get(t.projectId)?.name ?? "", cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{String(getValue())}</span> },
    ...fields.map<ColumnDef<Task>>((f) => ({
      id: `field:${f.id}`, header: f.name, sortUndefined: "last", accessorFn: (t) => fieldSortKey(f, t, people),
      cell: ({ row }) => <FieldCell field={f} value={row.original.fields?.[f.id]} people={people} error={row.original.fieldErrors?.[f.id]} fields={fields} />,
    })),
    { id: "updated", header: "Updated", accessorFn: (t) => t.updatedAt, cell: ({ row }) => <span className="whitespace-nowrap text-subtle">{timeAgo(row.original.updatedAt)}</span> },
  ], [pname, onToggle, fields, people]);
  // With a project picked (its fields showing), the Project column says the same thing on every row.
  const columnVisibility = useMemo(() => ({ project: fields.length === 0 }), [fields.length]);
  const table = useReactTable({ data: tasks, columns, state: { sorting, columnVisibility }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const hideOnPhone = new Set(["project", "updated", "assignee", "priority", ...fields.slice(2).map((f) => `field:${f.id}`)]);

  return (
    <div className="overflow-x-auto rounded-xl border border-line" data-testid="task-list">
      <table className="w-full text-[13px]">
        <thead className="border-b border-line bg-surface text-left text-[12px] text-subtle">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className={cn("px-3 py-2 font-medium", hideOnPhone.has(h.id) && "hidden md:table-cell", h.id === "done" && "w-9")}
                  aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : undefined}>
                  {h.column.getCanSort() ? (
                    <button className="inline-flex items-center gap-1 hover:text-fg" onClick={h.column.getToggleSortingHandler()}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted() === "asc" ? <ArrowUp className="h-3 w-3" /> : h.column.getIsSorted() === "desc" ? <ArrowDown className="h-3 w-3" /> : null}
                    </button>
                  ) : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} onClick={() => onOpen(r.original.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-hover">
              {r.getVisibleCells().map((c) => <td key={c.id} className={cn("px-3 py-2.5", hideOnPhone.has(c.column.id) && "hidden md:table-cell", c.column.id === "title" && "max-w-[420px]")}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
            </tr>
          ))}
          {tasks.length === 0 && <tr><td colSpan={table.getVisibleLeafColumns().length} className="px-3 py-10 text-center text-muted">No tasks match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
