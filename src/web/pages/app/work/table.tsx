/**
 * Round 21 (R21.2): the list view as a real table. Every cell edits in place (click or Enter, Escape
 * cancels, Enter or leaving the cell saves), arrow keys move between cells, Space selects a row,
 * Shift+click selects a range and Cmd or Ctrl+A selects every visible row. Picked rows show the bulk
 * bar at the bottom, which sends one request per action (POST /api/tasks/bulk).
 *
 * Columns live in TABLE_COLUMNS: adding one (a Type or Points column) is one entry there.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { DateInput, Select } from "@/web/components/ui/input"; // R67 (MB-250), R84 shared Select
import { useQueryClient } from "@tanstack/react-query";
import { SwipeTr } from "@/web/components/ui/swipe-row";
import { useRevealRow, useWindowedList } from "@/web/lib/use-windowed-list"; // R43 (MB-210)
import { IconAgent, IconArrowDown, IconArrowUp, IconCalendarDays, IconCheck, IconCircleDot, IconClose, IconMail, IconMove, IconShapes, IconSprint, IconTag, IconTrash, IconUserRound, IconCheckCircle, IconMore, IconFlag, IconPlus, IconTable } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { tone } from "@/web/components/app-bits";
import { dueLabel, isOverdue, PRIORITY_COLOR, PRIORITY_LABEL, sk, type AssigneeOption, type CustomField, type FieldValue, type Priority, type Project, type Status, type Task, isAgentLike } from "./data";
import { FieldCell } from "./fields";
import { TASK_TYPES, TYPE_META, TypeIcon, typeOf, type TaskType } from "./task-type";
import { useSprints } from "./sprint-fields";
import { ClashBadge } from "./schedule-r38"; // R38: date clash badge
import { ChecklistChip } from "./task-checklist"; // R26 (MB-85)
import { AvatarStack, TagChips, TagChip } from "./tasks-r84"; // R84
import { collapsedKey, groupTasks, type GroupBy, type GroupContext, type TaskGroup } from "@/web/lib/task-groups-r84"; // R84
import { useTags } from "./data";

const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low", "none"];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** What a column needs to draw and edit a cell. */
export interface TableContext {
  projects: Map<string, Project>;
  people: AssigneeOption[];
  statusesFor: (t: Task) => Status[];
}

type EditorKind = "text" | "status" | "assignee" | "priority" | "date" | "labels" | "type" | "points";

export interface TableColumn {
  id: string;
  header: string;
  /** Tailwind width class for the column. */
  width?: string;
  sortKey?: (t: Task, c: TableContext) => string | number;
  render: (t: Task, c: TableContext) => ReactNode;
  /** How the cell edits; no editor means read only. */
  editor?: EditorKind;
  /** The task field the editor reads and writes. */
  field?: "title" | "due" | "start";
  hideOnPhone?: boolean;
}

/** The table's columns, in order. Add a column here (the R21 merge adds Type and Points). */
export const TABLE_COLUMNS: TableColumn[] = [
  {
    id: "key", header: "Key", width: "w-[88px]", sortKey: (t) => `${t.ref.split("-")[0]}-${String(t.number).padStart(8, "0")}`,
    render: (t) => <span className="whitespace-nowrap font-mono text-[11.5px] text-subtle">{t.ref}</span>,
  },
  {
    id: "type", header: "Type", width: "w-[96px]", editor: "type", hideOnPhone: true, sortKey: (t) => TASK_TYPES.indexOf(typeOf(t)),
    render: (t) => <span className="flex items-center gap-1.5 whitespace-nowrap text-muted"><TypeIcon type={t.type} />{TYPE_META[typeOf(t)].label}</span>,
  },
  {
    id: "title", header: "Title", sortKey: (t) => t.title.toLowerCase(), editor: "text", field: "title",
    render: (t) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("truncate font-medium", t.status === "done" && "text-subtle line-through")}>{t.title}</span>
        {t.source && <IconMail className="h-3 w-3 shrink-0 text-subtle" aria-label="From email" />}
        <span className="shrink-0 text-[11.5px] text-subtle"><ChecklistChip checklist={t.checklist} /></span>
        <ClashBadge id={t.id} />
      </span>
    ),
  },
  {
    id: "status", header: "Status", width: "w-[140px]", editor: "status",
    sortKey: (t, c) => `${["todo", "doing", "done"].indexOf(t.status)}${String(c.statusesFor(t).findIndex((s) => s.id === t.statusId)).padStart(3, "0")}`,
    render: (t) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-2 w-2 rounded-full" style={{ background: tone(t.statusColor) }} />{t.statusName}</span>,
  },
  {
    id: "assignee", header: "Assignee", width: "w-[150px]", editor: "assignee", hideOnPhone: true, sortKey: (t) => t.assignee?.name.toLowerCase() ?? "\uffff",
    render: (t) => t.assignee && (t.assignees?.length ?? 0) > 1
      ? <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"><AvatarStack people={t.assignees!} /><span className="truncate">{t.assignee.name}</span><span className="text-subtle">+{t.assignees!.length - 1}</span></span>
      : t.assignee
      ? <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">{isAgentLike(t.assignee) && <IconAgent className="h-3.5 w-3.5 shrink-0 text-brand-hover" />}<span className="truncate">{t.assignee.name}</span></span>
      : <span className="inline-flex items-center" title="Nobody"><IconUserRound className="mm-faint h-4 w-4" aria-hidden /><span className="sr-only">Nobody</span></span>, // R79: a faint icon, not a word
  },
  {
    id: "priority", header: "Priority", width: "w-[110px]", editor: "priority", hideOnPhone: true, sortKey: (t) => PRIORITY_RANK[t.priority],
    render: (t) => t.priority === "none" ? <span className="inline-flex items-center" title="No priority"><IconFlag className="mm-faint h-4 w-4" aria-hidden /><span className="sr-only">No priority</span></span> : <span className={PRIORITY_COLOR[t.priority]}>{PRIORITY_LABEL[t.priority]}</span>,
  },
  {
    id: "due", header: "Due", width: "w-[96px]", editor: "date", field: "due", sortKey: (t) => t.due ?? "9999",
    render: (t) => t.due ? <span className={cn("whitespace-nowrap", isOverdue(t) && "text-bad")}>{dueLabel(t.due) ?? ""}</span> : <span className="inline-flex items-center" title="No due date"><IconCalendarDays className="mm-faint h-4 w-4" aria-hidden /><span className="sr-only">No due date</span></span>,
  },
  {
    id: "labels", header: "Tags", width: "w-[180px]", editor: "labels", hideOnPhone: true, sortKey: (t) => t.labels.join(",").toLowerCase() || "\uffff",
    render: (t) => <TagChips labels={t.labels} max={2} oneLine />,
  },
  {
    id: "start", header: "Start", width: "w-[96px]", editor: "date", field: "start", hideOnPhone: true, sortKey: (t) => t.start ?? "9999",
    render: (t) => <span className="whitespace-nowrap text-muted">{dueLabel(t.start) ?? ""}</span>,
  },
  {
    id: "points", header: "Estimate", width: "w-[84px]", editor: "points", hideOnPhone: true, sortKey: (t) => t.points ?? -1,
    render: (t) => <span className="tabular-nums text-muted">{t.points ?? ""}</span>,
  },
];

/** The project column shows only when the table spans projects. */
const PROJECT_COLUMN: TableColumn = {
  id: "project", header: "Project", width: "w-[130px]", hideOnPhone: true, sortKey: (t, c) => c.projects.get(t.projectId)?.name ?? "",
  render: (t, c) => <span className="whitespace-nowrap text-muted">{c.projects.get(t.projectId)?.name ?? ""}</span>,
};

function fieldColumn(f: CustomField): TableColumn {
  return { id: `field:${f.id}`, header: f.name, width: "w-[130px]", hideOnPhone: true, render: (t, c) => <FieldCell field={f} value={t.fields?.[f.id]} people={c.people} error={t.fieldErrors?.[f.id]} /> };
}

// ---------------------------------------------------------------- data: optimistic edits with rollback

type Display = (t: Task) => Task;

function useTableWrites() {
  const qc = useQueryClient();
  const apply = useCallback(async (ids: Set<string>, display: Display) => {
    await qc.cancelQueries({ queryKey: ["tasks"] });
    const snapshots = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
    for (const [key, list] of snapshots) if (list) qc.setQueryData<Task[]>(key, list.map((t) => (ids.has(t.id) ? display(t) : t)));
    return snapshots;
  }, [qc]);
  const settle = useCallback((snapshots: [readonly unknown[], Task[] | undefined][], err?: unknown) => {
    if (err) { for (const [key, list] of snapshots) qc.setQueryData(key, list); showError(err as Error); }
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["task"] });
    void qc.invalidateQueries({ queryKey: sk.projects });
  }, [qc]);
  const edit = useCallback(async (t: Task, patch: Record<string, unknown>, display: Display) => {
    const snaps = await apply(new Set([t.id]), display);
    try { await api.patch(`/tasks/${t.id}`, patch); settle(snaps); } catch (e) { settle(snaps, e); }
  }, [apply, settle]);
  const bulk = useCallback(async (ids: string[], patch: Record<string, unknown>, display: Display) => {
    const snaps = await apply(new Set(ids), display);
    try { await api.post("/tasks/bulk", { ids, patch }); settle(snaps); return true; } catch (e) { settle(snaps, e); return false; }
  }, [apply, settle]);
  const remove = useCallback(async (ids: string[]) => {
    const set = new Set(ids);
    await qc.cancelQueries({ queryKey: ["tasks"] });
    const snaps = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
    for (const [key, list] of snaps) if (list) qc.setQueryData<Task[]>(key, list.filter((t) => !set.has(t.id)));
    try { await api.post("/tasks/bulk-delete", { ids }); settle(snaps); return true; } catch (e) { settle(snaps, e); return false; }
  }, [qc, settle]);
  return { edit, bulk, remove };
}

const assigneeDisplay = (people: AssigneeOption[], id: string | null) => (t: Task): Task => {
  const p = id ? people.find((x) => x.id === id) : null;
  return { ...t, assigneeId: p ? p.id : null, assignee: p ? { type: p.type, id: p.id.split(":")[1], name: p.name, email: p.email } : null };
};
const statusDisplay = (s: Status) => (t: Task): Task => ({ ...t, statusId: s.id, statusName: s.name, statusColor: s.color, status: s.category });
const dateIso = (v: string) => (v ? `${v}T00:00:00.000Z` : null);

// ---------------------------------------------------------------- cell editors

function OptionList<T extends string>({ options, current, onPick, onCancel, label }: { options: { value: T; label: ReactNode }[]; current: T; onPick: (v: T) => void; onCancel: () => void; label: string }) {
  const [i, setI] = useState(Math.max(0, options.findIndex((o) => o.value === current)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onCancel(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onCancel]);
  const onKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(options.length - 1, x + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[i]) onPick(options[i].value); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  return (
    <div ref={ref} role="listbox" aria-label={label} tabIndex={-1} onKeyDown={onKey}
      className="absolute left-0 top-full z-30 mt-1 max-h-64 min-w-48 animate-pop-in overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-pop outline-none">
      {options.map((o, n) => (
        <div key={o.value} role="option" aria-selected={o.value === current} onMouseEnter={() => setI(n)} onMouseDown={(e) => { e.preventDefault(); onPick(o.value); }}
          className={cn("flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]", n === i && "bg-hover")}>
          <span className="flex min-w-0 flex-1 items-center gap-2">{o.label}</span>
          {o.value === current && <IconCheck className="h-3.5 w-3.5 text-brand" />}
        </div>
      ))}
    </div>
  );
}

function TextEditor({ value, onSave, onCancel, label, type = "text" }: { value: string; onSave: (v: string) => void; onCancel: () => void; label: string; type?: "text" | "date" | "number" }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save && v !== value) onSave(v); else onCancel(); };
  // R67 (MB-250): dates are typed in the workspace's order.
  const Box = type === "date" ? DateInput : "input";
  return (
    <Box autoFocus aria-label={label} type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
      className="h-7 w-full min-w-0 rounded-md border border-brand bg-surface px-1.5 text-[13px] outline-none ring-2 ring-brand/20" />
  );
}

function LabelEditor({ value, onSave, onCancel }: { value: string[]; onSave: (v: string[]) => void; onCancel: () => void }) {
  const [list, setList] = useState(value);
  const [draft, setDraft] = useState("");
  const done = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim() ? [...new Set([...list, draft.trim().slice(0, 40)])] : list;
    if (save && next.join("\u0000") !== value.join("\u0000")) onSave(next); else onCancel();
  };
  return (
    <div ref={ref} onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) finish(true); }}
      className="flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md border border-brand bg-surface px-1 py-0.5 ring-2 ring-brand/20">
      {list.map((l) => (
        <span key={l} className="inline-flex items-center gap-0.5 rounded-md bg-fill px-1.5 text-[11.5px] text-muted">
          {l}
          <button type="button" aria-label={`Remove ${l}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setList(list.filter((x) => x !== l))} className="text-subtle hover:text-fg"><IconClose className="h-3 w-3" /></button>
        </span>
      ))}
      <input autoFocus aria-label="Add a label" value={draft} placeholder={list.length ? "" : "Add label"} onChange={(e) => setDraft(e.target.value.replace(",", ""))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if ((e.key === "Enter" || e.key === ",") && draft.trim()) { e.preventDefault(); setList([...new Set([...list, draft.trim().slice(0, 40)])]); setDraft(""); }
          else if (e.key === "Enter") { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") { e.preventDefault(); finish(false); }
          else if (e.key === "Backspace" && !draft && list.length) setList(list.slice(0, -1));
        }}
        className="h-6 min-w-12 flex-1 bg-transparent text-[13px] outline-none" />
    </div>
  );
}

// ---------------------------------------------------------------- the table

interface Cell { r: number; c: number }

export function TaskTable({ tasks, projects, onOpen, fields = [], people = [], projectId, onAdd, groupBy, sort: sortProp, onSort }: {
  tasks: Task[]; projects: Project[]; onOpen: (id: string) => void; fields?: CustomField[]; people?: AssigneeOption[]; projectId?: string;
  /** R79: the "+ Add task" row under the list. */
  onAdd?: () => void;
  /** R84: group the rows under collapsible headers (one table, so selection and the bulk bar work across groups). */
  groupBy?: GroupBy | null;
  /** R84: the sort, owned by the page so a saved view keeps it. */
  sort?: { id: string; desc: boolean } | null; onSort?: (s: { id: string; desc: boolean } | null) => void;
}) {
  const writes = useTableWrites();
  const pmap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const ctx = useMemo<TableContext>(() => ({ projects: pmap, people, statusesFor: (t) => pmap.get(t.projectId)?.statuses ?? [] }), [pmap, people]);
  const columns = useMemo(() => [...TABLE_COLUMNS, ...(projectId ? [] : [PROJECT_COLUMN]), ...fields.map(fieldColumn)], [projectId, fields]);
  const [ownSort, setOwnSort] = useState<{ id: string; desc: boolean } | null>(null);
  const sort = onSort ? (sortProp ?? null) : ownSort;
  const setSort = (fn: (s: { id: string; desc: boolean } | null) => { id: string; desc: boolean } | null) => (onSort ? onSort(fn(sort)) : setOwnSort(fn));
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.id);
    if (!col?.sortKey) return tasks;
    const key = col.sortKey;
    return [...tasks].sort((a, b) => { const x = key(a, ctx), y = key(b, ctx); const n = x < y ? -1 : x > y ? 1 : 0; return sort!.desc ? -n : n; });
  }, [tasks, sort, columns, ctx]);
  // R84: groups. Collapsed groups are remembered on this device for each grouping.
  const tagList = useTags();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!groupBy) return;
    try { setCollapsed(new Set(JSON.parse(localStorage.getItem(collapsedKey(groupBy)) ?? "[]") as string[])); } catch { setCollapsed(new Set()); }
  }, [groupBy]);
  const toggleGroup = (key: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(key)) n.delete(key); else n.add(key);
    try { if (groupBy) localStorage.setItem(collapsedKey(groupBy), JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  const groups = useMemo<TaskGroup<Task>[] | null>(() => {
    if (!groupBy) return null;
    const gctx: GroupContext = { projects, tags: tagList.data ?? [], fields, people: people.map((p) => ({ id: p.id, name: p.name })) };
    return groupTasks(sorted, groupBy, gctx);
  }, [groupBy, sorted, projects, tagList.data, fields, people]);
  // rows: the tasks in display order (collapsed groups left out); headersAt: the group headers drawn before row i.
  const { rows, headersAt } = useMemo(() => {
    if (!groups) return { rows: sorted, headersAt: new Map<number, TaskGroup<Task>[]>() };
    const out: Task[] = [];
    const at = new Map<number, TaskGroup<Task>[]>();
    for (const g of groups) {
      at.set(out.length, [...(at.get(out.length) ?? []), g]);
      if (!collapsed.has(g.key)) out.push(...g.tasks);
    }
    return { rows: out, headersAt: at };
  }, [groups, sorted, collapsed]);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<Cell | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Drop picks of tasks no longer in view (deleted, filtered out).
  useEffect(() => {
    const visible = new Set(tasks.map((t) => t.id));
    setSelected((s) => { const n = new Set([...s].filter((id) => visible.has(id))); return n.size === s.size ? s : n; });
  }, [tasks]);

  const toggleSort = (id: string) => setSort((s) => (s?.id !== id ? { id, desc: false } : s.desc ? null : { id, desc: true }));
  const toggleRow = (index: number, range: boolean) => {
    const id = rows[index]?.id;
    if (!id) return;
    // Read the anchor now: the updater below runs later, after the anchor has moved.
    const from = anchor.current;
    setSelected((s) => {
      const n = new Set(s);
      if (range && from !== null) {
        const [a, b] = [Math.min(from, index), Math.max(from, index)];
        for (let i = a; i <= b; i++) n.add(rows[i].id);
      } else if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    anchor.current = index;
  };
  const stopEditing = () => { setEditing(null); requestAnimationFrame(() => gridRef.current?.focus()); };

  const save = (t: Task, col: TableColumn, value: unknown) => {
    stopEditing();
    if (col.editor === "text") { const title = String(value).trim(); if (title && title !== t.title) void writes.edit(t, { title }, (x) => ({ ...x, title })); return; }
    if (col.editor === "date") { const v = String(value); void writes.edit(t, { [col.field!]: v || null }, (x) => ({ ...x, [col.field!]: dateIso(v) })); return; }
    if (col.editor === "labels") { const labels = value as string[]; void writes.edit(t, { labels }, (x) => ({ ...x, labels })); return; }
    if (col.editor === "priority") { const priority = value as Priority; if (priority !== t.priority) void writes.edit(t, { priority }, (x) => ({ ...x, priority })); return; }
    if (col.editor === "assignee") { const id = value === "none" ? null : String(value); if (id !== t.assigneeId) void writes.edit(t, { assignee: id }, assigneeDisplay(people, id)); return; }
    if (col.editor === "type") { const type = value as TaskType; if (type !== typeOf(t)) void writes.edit(t, { type }, (x) => ({ ...x, type })); return; }
    if (col.editor === "points") { const raw = String(value).trim(); const points = raw === "" ? null : Number(raw); if (points !== null && (!Number.isFinite(points) || points < 0 || points > 1000)) return; if (points !== (t.points ?? null)) void writes.edit(t, { points }, (x) => ({ ...x, points })); return; }
    if (col.editor === "status") { const s = ctx.statusesFor(t).find((x) => x.id === value); if (s && s.id !== t.statusId) void writes.edit(t, { statusId: s.id }, statusDisplay(s)); }
  };

  const editor = (t: Task, col: TableColumn): ReactNode => {
    const cancel = stopEditing;
    switch (col.editor) {
      case "text": return <TextEditor label="Title" value={t.title} onSave={(v) => save(t, col, v)} onCancel={cancel} />;
      case "date": return <TextEditor label={col.header} type="date" value={day(col.field === "start" ? t.start : t.due)} onSave={(v) => save(t, col, v)} onCancel={cancel} />;
      case "labels": return <LabelEditor value={t.labels} onSave={(v) => save(t, col, v)} onCancel={cancel} />;
      case "priority": return <OptionList label="Priority" current={t.priority} onCancel={cancel} onPick={(v) => save(t, col, v)}
        options={PRIORITIES.map((p) => ({ value: p, label: <span className={PRIORITY_COLOR[p]}>{PRIORITY_LABEL[p]}</span> }))} />;
      case "assignee": return <OptionList label="Assignee" current={t.assigneeId ?? "none"} onCancel={cancel} onPick={(v) => save(t, col, v)}
        options={[{ value: "none", label: <span className="text-muted">Nobody</span> }, ...people.map((p) => ({ value: p.id, label: <>{isAgentLike(p) ? <IconAgent className="h-3.5 w-3.5 text-brand-hover" /> : <IconUserRound className="h-3.5 w-3.5 text-subtle" />}{p.name}</> }))]} />;
      case "status": return <OptionList label="Status" current={t.statusId} onCancel={cancel} onPick={(v) => save(t, col, v)}
        options={ctx.statusesFor(t).map((s) => ({ value: s.id, label: <><span className="h-2 w-2 rounded-full" style={{ background: tone(s.color) }} />{s.name}</> }))} />;
      case "type": return <OptionList label="Type" current={typeOf(t)} onCancel={cancel} onPick={(v) => save(t, col, v)}
        options={TASK_TYPES.map((k) => ({ value: k, label: <><TypeIcon type={k} />{TYPE_META[k].label}</> }))} />;
      case "points": return <TextEditor label="Estimate" type="number" value={t.points == null ? "" : String(t.points)} onSave={(v) => save(t, col, v)} onCancel={cancel} />;
      default: return null;
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(rows.map((t) => t.id))); return; }
    if (e.key === "Escape" && selected.size) { e.preventDefault(); setSelected(new Set()); return; }
    if (!rows.length) return;
    const f = focus ?? { r: 0, c: 1 };
    const move = (r: number, c: number) => { e.preventDefault(); setFocus({ r: Math.max(0, Math.min(rows.length - 1, r)), c: Math.max(0, Math.min(columns.length - 1, c)) }); };
    if (e.key === "ArrowDown") move(f.r + 1, f.c);
    else if (e.key === "ArrowUp") move(f.r - 1, f.c);
    else if (e.key === "ArrowRight") move(f.r, f.c + 1);
    else if (e.key === "ArrowLeft") move(f.r, f.c - 1);
    else if (e.key === " ") { e.preventDefault(); toggleRow(f.r, e.shiftKey); setFocus(f); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const col = columns[f.c];
      if (col.editor) setEditing(f); else onOpen(rows[f.r].id);
      setFocus(f);
    }
  };

  // R43 (MB-210): long lists render only the rows on screen; arrow keys and J/K bring a row in before focusing it.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const win = useWindowedList({ count: rows.length, estimate: 41, listRef: bodyRef, scrollRef: gridRef, ...(groups ? { minCount: Number.MAX_SAFE_INTEGER } : {}) });
  const rowIds = useMemo(() => rows.map((t) => t.id), [rows]);
  useRevealRow(rowIds, win, bodyRef);
  const { windowed, scrollToIndex } = win;
  useEffect(() => { if (windowed && focus) scrollToIndex(focus.r); }, [windowed, focus, scrollToIndex]);
  const span = columns.length + 1;

  const allPicked = rows.length > 0 && rows.every((t) => selected.has(t.id));
  // R84: a row's aria-rowindex counts the group headers above it.
  const headersBefore = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (let i = 0; i <= rows.length; i++) { n += headersAt.get(i)?.length ?? 0; out.push(n); }
    return out;
  }, [rows.length, headersAt]);
  const groupHeader = (g: TaskGroup<Task>) => {
    const open = !collapsed.has(g.key);
    const ids = g.tasks.map((t) => t.id);
    const all = ids.length > 0 && ids.every((id) => selected.has(id));
    return (
      <tr key={`g:${g.key}`} data-testid="group-header" className="bg-surface">
        <td className="border-b border-line px-3 py-1.5">
          <input type="checkbox" aria-label={`Select all in ${g.label}`} checked={all} onChange={() => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (all) n.delete(id); else n.add(id); } return n; })} className="h-3.5 w-3.5 accent-[var(--color-brand)]" />
        </td>
        <td colSpan={span - 1} className="border-b border-line px-1 py-1">
          <button type="button" aria-expanded={open} onClick={() => toggleGroup(g.key)} className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-[12.5px] font-semibold text-fg hover:bg-hover max-sm:min-h-11">
            <svg aria-hidden viewBox="0 0 16 16" className={cn("h-3.5 w-3.5 text-muted transition-transform motion-reduce:transition-none", open && "rotate-90")}><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {g.color && <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: g.key.startsWith("status:") ? tone(g.color) : g.color }} />}
            <span>{g.label}</span>
            <span className="font-normal tabular-nums text-subtle">{g.tasks.length}</span>
          </button>
        </td>
      </tr>
    );
  };
  const picked = rows.filter((t) => selected.has(t.id));

  return (
    <div className="relative">
      {/* R79 (axe): the grid role sits on the table itself; the scroller is a labelled region that takes focus. */}
      <div ref={gridRef} role="region" aria-label="Tasks table" tabIndex={0} onKeyDown={onKeyDown}
        onFocus={(e) => { if (e.target === gridRef.current && !focus && rows.length) setFocus({ r: 0, c: 1 }); }}
        className="max-h-[calc(100dvh-13rem)] overflow-auto rounded-xl border border-line outline-none focus-visible:ring-2 focus-visible:ring-brand/30" data-testid="task-table">
        <table role="grid" aria-label="Tasks" aria-multiselectable="true" aria-rowcount={rows.length + 1 + (headersBefore[rows.length] ?? 0)} className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="text-left text-[12px] text-subtle">
            <tr>
              <th className="sticky top-0 z-20 w-9 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur">
                <input type="checkbox" aria-label="Select all tasks" checked={allPicked} onChange={() => setSelected(allPicked ? new Set() : new Set(rows.map((t) => t.id)))} className="h-3.5 w-3.5 accent-[var(--color-brand)]" />
              </th>
              {columns.map((col) => (
                <th key={col.id} className={cn("sticky top-0 z-20 border-b border-line bg-surface/95 px-3 py-2 font-medium backdrop-blur", col.width, col.hideOnPhone && "hidden md:table-cell")}
                  aria-sort={sort?.id === col.id ? (sort.desc ? "descending" : "ascending") : undefined}>
                  {col.sortKey ? (
                    <button type="button" tabIndex={-1} className="inline-flex items-center gap-1 hover:text-fg" onClick={() => toggleSort(col.id)}>
                      {col.header}
                      {sort?.id === col.id ? (sort.desc ? <IconArrowDown className="h-3 w-3" /> : <IconArrowUp className="h-3 w-3" />) : null}
                    </button>
                  ) : col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {win.padTop > 0 && <tr aria-hidden="true" data-testid="win-pad-top" style={{ height: win.padTop }}><td colSpan={span} className="p-0" /></tr>}
            {rows.slice(win.start, win.end).map((t, i) => {
              const r = win.start + i;
              const isPicked = selected.has(t.id);
              const doneStatus = ctx.statusesFor(t).find((s) => s.category === "done");
              return (
                <Fragment key={t.id}>
                {headersAt.get(r)?.map(groupHeader)}
                <SwipeTr aria-selected={isPicked} aria-rowindex={r + 2 + (headersBefore[r] ?? 0)} data-win-row={String(r)} data-task={t.ref} data-task-id={t.id} className={cn("group", isPicked ? "bg-brand/[0.06]" : "hover:bg-hover")}
                  disabled={selected.size > 0 || editing !== null}
                  right={doneStatus && t.status !== "done" ? { label: "Done", icon: IconCheckCircle, tone: "green", onCommit: () => void writes.edit(t, { statusId: doneStatus.id }, statusDisplay(doneStatus)) } : undefined}
                  left={{ label: "More", icon: IconMore, tone: "grey", onCommit: () => onOpen(t.id) }}
                  edge={(edge) => (<>
                  <td className="relative border-b border-line px-3 py-2">
                    {edge}
                    <input type="checkbox" aria-label={`Select ${t.title}`} checked={isPicked} readOnly
                      onClick={(e) => { e.stopPropagation(); toggleRow(r, e.shiftKey); }} className="h-3.5 w-3.5 accent-[var(--color-brand)]" />
                  </td>
                  {columns.map((col, c) => {
                    const isFocus = focus?.r === r && focus.c === c;
                    const isEdit = editing?.r === r && editing.c === c;
                    const inlineEditor = col.editor === "text" || col.editor === "date" || col.editor === "labels" || col.editor === "points";
                    return (
                      <td key={col.id} role="gridcell"
                        onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); /* shift click picks a range of rows, not text */ }}
                        onClick={(e) => {
                          if (e.shiftKey) { toggleRow(r, true); return; }
                          setFocus({ r, c });
                          if (col.id === "key") onOpen(t.id);
                          else if (col.editor && !isEdit) setEditing({ r, c });
                        }}
                        className={cn("relative border-b border-line px-3 py-1.5", col.width, col.hideOnPhone && "hidden md:table-cell", col.id === "title" && "max-w-[420px] md:min-w-[240px]" /* R84F: the title keeps room beside the clash badge */,
                          col.id === "key" && "cursor-pointer hover:text-brand", col.editor && "cursor-text",
                          isFocus && !isEdit && "shadow-[inset_0_0_0_2px_#0071E3] rounded-[4px]")}>
                        {isEdit && inlineEditor ? editor(t, col) : (
                          <div className="flex min-h-7 items-center">{col.render(t, ctx)}</div>
                        )}
                        {isEdit && !inlineEditor && editor(t, col)}
                      </td>
                    );
                  })}
                  </>)} />
                </Fragment>
              );
            })}
            {groups && headersAt.get(rows.length)?.map(groupHeader)}
            {win.padBottom > 0 && <tr aria-hidden="true" data-testid="win-pad-bottom" style={{ height: win.padBottom }}><td colSpan={span} className="p-0" /></tr>}
            {rows.length === 0 && !groups?.length && <tr><td colSpan={columns.length + 1} className="px-3 py-10 text-center text-muted">No tasks match these filters.</td></tr>}
            {onAdd && <tr><td colSpan={columns.length + 1} className="p-0">
              <button type="button" onClick={onAdd} data-testid="table-add-task" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand motion-reduce:transition-none">
                <IconPlus className="h-3.5 w-3.5" aria-hidden />Add task</button>
            </td></tr>}
          </tbody>
        </table>
      </div>
      {picked.length > 0 && <BulkBar tasks={picked} projects={projects} people={people} fields={fields.filter((f) => f.type !== "formula" && f.type !== "rollup")} writes={writes} onClear={() => setSelected(new Set())} />}
    </div>
  );
}

// ---------------------------------------------------------------- the bulk bar

type Pop = "status" | "assignee" | "due" | "labels" | "type" | "sprint" | "project" | "field" | null;

function BulkBar({ tasks, projects, people, fields, writes, onClear }: { tasks: Task[]; projects: Project[]; people: AssigneeOption[]; fields: CustomField[]; writes: ReturnType<typeof useTableWrites>; onClear: () => void }) {
  const [assignMode, setAssignMode] = useState<"set" | "add">("set"); // R84: replace the main assignee, or add people beside
  const tagList = useTags();
  const [pop, setPop] = useState<Pop>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [due, setDue] = useState("");
  const barRef = useRef<HTMLDivElement>(null);
  const ids = tasks.map((t) => t.id);
  const one = new Set(tasks.map((t) => t.projectId)).size === 1 ? projects.find((p) => p.id === tasks[0].projectId) : undefined;
  // Round 21: plan a sprint from the table. Sprint moves go through the sprint routes, which date
  // the change for the burndown; tasks from several projects can't share one sprint.
  const qc = useQueryClient();
  const sprints = useSprints(one?.id);
  const openSprints = (sprints.data?.sprints ?? []).filter((s) => s.status !== "completed");
  const toSprint = async (sprintId: string | null) => {
    setPop(null); setBusy(true);
    try {
      if (sprintId) await api.post(`/sprints/${sprintId}/tasks`, { taskIds: ids });
      else {
        const bySprint = new Map<string, string[]>();
        for (const t of tasks) if (t.sprintId) bySprint.set(t.sprintId, [...(bySprint.get(t.sprintId) ?? []), t.id]);
        for (const [sid, taskIds] of bySprint) await api.post(`/sprints/${sid}/tasks/remove`, { taskIds });
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["tasks"] }), qc.invalidateQueries({ queryKey: ["sprints"] })]);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => { if (!barRef.current?.contains(e.target as Node)) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [pop]);
  const run = async (patch: Record<string, unknown>, display: Display) => {
    setPop(null); setBusy(true);
    await writes.bulk(ids, patch, display);
    setBusy(false);
  };
  const item = (key: string, children: ReactNode, onSelect: () => void) => (
    <button key={key} type="button" role="menuitem" onClick={onSelect} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">{children}</button>
  );
  const panel = (children: ReactNode, label: string) => (
    <div role="menu" aria-label={label} className="absolute bottom-full left-0 mb-2 max-h-72 min-w-52 animate-pop-in overflow-y-auto rounded-xl border border-line bg-elevated p-1 text-fg shadow-pop">{children}</div>
  );
  const barButton = (id: Exclude<Pop, null>, icon: ReactNode, text: string) => (
    <button type="button" aria-haspopup="menu" aria-expanded={pop === id} onClick={() => setPop(pop === id ? null : id)}
      className={cn("inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] text-fg/90 transition-colors hover:bg-hover max-sm:px-2", pop === id && "bg-hover")}>
      {icon}<span className="max-md:hidden">{text}</span>
    </button>
  );
  const categories: { value: "todo" | "doing" | "done"; name: string }[] = [{ value: "todo", name: "To do" }, { value: "doing", name: "Doing" }, { value: "done", name: "Done" }];

  return (
    <>
      <div ref={barRef} role="toolbar" aria-label="Bulk actions" data-testid="bulk-bar"
        className="fixed bottom-[calc(1.5rem+var(--tabbar-h,0px))] left-1/2 z-40 flex -translate-x-1/2 animate-pop-in items-center gap-1 rounded-2xl border border-line bg-elevated/95 p-1.5 pl-3.5 shadow-pop backdrop-blur-xl max-sm:w-[calc(100vw-1rem)] max-sm:flex-wrap max-sm:justify-center max-sm:pl-1.5">
        <span className="mr-1 whitespace-nowrap text-[13px] font-medium tabular-nums" aria-live="polite">{tasks.length} selected</span>
        <span className="mx-1 h-5 w-px bg-line" />
        <div className="relative">
          {barButton("status", <IconCircleDot className="h-4 w-4" />, "Set status")}
          {pop === "status" && panel(one
            ? one.statuses.map((s) => item(s.id, <><span className="h-2 w-2 rounded-full" style={{ background: tone(s.color) }} />{s.name}</>, () => void run({ statusId: s.id }, statusDisplay(s))))
            : categories.map((c) => item(c.value, c.name, () => void run({ status: c.value }, (t) => ({ ...t, status: c.value })))), "Set status")}
        </div>
        <div className="relative">
          {barButton("assignee", <IconUserRound className="h-4 w-4" />, "Assign to")}
          {pop === "assignee" && panel([
            <div key="mode" role="group" aria-label="How to assign" className="mb-1 grid grid-cols-2 gap-1 rounded-lg bg-fill p-0.5 text-[12px]">
              {(["set", "add"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={assignMode === m} onClick={() => setAssignMode(m)} className={cn("rounded-md px-2 py-1 font-medium max-sm:py-2", assignMode === m ? "bg-surface text-fg shadow-sm" : "text-muted")}>{m === "set" ? "Assign to" : "Add person"}</button>
              ))}
            </div>,
            ...(assignMode === "set" ? [item("none", <span className="text-muted">Nobody</span>, () => void run({ assignee: null }, assigneeDisplay(people, null)))] : []),
            ...people.map((p) => item(p.id, <>{isAgentLike(p) ? <IconAgent className="h-3.5 w-3.5 text-brand-hover" /> : <IconUserRound className="h-3.5 w-3.5 text-subtle" />}{p.name}</>, () => void (assignMode === "set"
              ? run({ assignee: p.id }, assigneeDisplay(people, p.id))
              : run({ addAssignees: [p.id] }, (t) => {
                const who = { type: p.type, id: p.id.split(":")[1]!, name: p.name, email: p.email };
                if (!t.assignee) return { ...t, assigneeId: p.id, assignee: who, assignees: [who] };
                const list = t.assignees ?? [t.assignee];
                return list.some((a) => `${a.type}:${a.id}` === p.id) ? t : { ...t, assignees: [...list, who] };
              })))),
          ], "Assign to")}
        </div>
        <div className="relative">
          {barButton("due", <IconCalendarDays className="h-4 w-4" />, "Due date")}
          {pop === "due" && panel(
            <div className="space-y-2 p-2">
              <DateInput aria-label="Due date for the selected tasks" value={due} onChange={(e) => setDue(e.target.value)} className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]" />
              <div className="flex gap-1.5">
                <Button size="sm" disabled={!due} onClick={() => void run({ dueAt: due }, (t) => ({ ...t, due: dateIso(due) }))}>Set</Button>
                <Button size="sm" variant="secondary" onClick={() => void run({ dueAt: null }, (t) => ({ ...t, due: null }))}>Clear due date</Button>
              </div>
            </div>, "Due date")}
        </div>
        <div className="relative">
          {barButton("labels", <IconTag className="h-4 w-4" />, "Tags")}
          {pop === "labels" && panel(
            <div className="space-y-2 p-2">
              <input autoFocus aria-label="Tag" placeholder="Find or type a tag" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40}
                onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) { const l = label.trim(); setLabel(""); void run({ addLabels: [l] }, (t) => ({ ...t, labels: t.labels.includes(l) ? t.labels : [...t.labels, l] })); } }}
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]" />
              <div className="flex gap-1.5">
                <Button size="sm" disabled={!label.trim()} onClick={() => { const l = label.trim(); setLabel(""); void run({ addLabels: [l] }, (t) => ({ ...t, labels: t.labels.includes(l) ? t.labels : [...t.labels, l] })); }}>Add tag</Button>
                <Button size="sm" variant="secondary" disabled={!label.trim()} onClick={() => { const l = label.trim(); setLabel(""); void run({ removeLabels: [l] }, (t) => ({ ...t, labels: t.labels.filter((x) => x !== l) })); }}>Remove</Button>
              </div>
              {(() => {
                const add = (l: string) => void run({ addLabels: [l] }, (t) => ({ ...t, labels: t.labels.includes(l) ? t.labels : [...t.labels, l] }));
                const drop = (l: string) => void run({ removeLabels: [l] }, (t) => ({ ...t, labels: t.labels.filter((x) => x !== l) }));
                const used = [...new Set(tasks.flatMap((t) => t.labels))];
                const colourOf = (l: string) => tagList.data?.find((x) => x.name.toLowerCase() === l.toLowerCase())?.color ?? "#8a8f98";
                const quick = (tagList.data ?? []).filter((x) => x.name.toLowerCase().includes(label.trim().toLowerCase())).slice(0, 12);
                return (<>
                  {quick.length > 0 && <div className="border-t border-line pt-2"><p className="mb-1 text-[11px] text-subtle">Add a tag</p><div className="flex flex-wrap gap-1">
                    {quick.map((x) => <button key={x.id} type="button" onClick={() => add(x.name)} aria-label={`Add tag ${x.name}`} className="rounded-full"><TagChip name={x.name} color={x.color} /></button>)}
                  </div></div>}
                  {used.length > 0 && <div className="border-t border-line pt-2"><p className="mb-1 text-[11px] text-subtle">On these tasks</p><div className="flex flex-wrap gap-1">
                    {used.slice(0, 12).map((l) => <TagChip key={l} name={l} color={colourOf(l)} onRemove={() => drop(l)} />)}
                  </div></div>}
                </>);
              })()}
            </div>, "Tags")}
        </div>
        {fields.length > 0 && (
          <div className="relative">
            {barButton("field", <IconTable className="h-4 w-4" />, "Field")}
            {pop === "field" && panel(<BulkFieldPanel fields={fields} people={people} onSet={(id, v) => void run({ fields: { [id]: v } }, (t) => ({ ...t, fields: { ...(t.fields ?? {}), [id]: v as FieldValue } }))} />, "Set a field")}
          </div>
        )}
        <div className="relative">
          {barButton("type", <IconShapes className="h-4 w-4" />, "Type")}
          {pop === "type" && panel((["task", "story", "bug"] as const).map((k) => item(k, <><TypeIcon type={k} />{TYPE_META[k].label}</>, () => void run({ type: k }, (t) => ({ ...t, type: k })))), "Set type")}
        </div>
        {one && openSprints.length > 0 && (
          <div className="relative">
            {barButton("sprint", <IconSprint className="h-4 w-4" />, "Sprint")}
            {pop === "sprint" && panel([
              ...openSprints.map((s) => item(s.id, <>{s.name}<span className="ml-auto text-xs text-subtle">{s.status === "active" ? "Active" : "Planned"}</span></>, () => void toSprint(s.id))),
              item("backlog", <span className="text-muted">Backlog</span>, () => void toSprint(null)),
            ], "Move to sprint")}
          </div>
        )}
        <div className="relative">
          {barButton("project", <IconMove className="h-4 w-4" />, "Move to")}
          {pop === "project" && panel(projects.filter((p) => !p.archived).map((p) => item(p.id, <><span className="h-2 w-2 rounded-full" style={{ background: tone(p.color) }} />{p.name}</>, () => void run({ projectId: p.id }, (t) => ({ ...t, projectId: p.id })))), "Move to project")}
        </div>
        <button type="button" onClick={() => { setPop(null); setConfirm(true); }} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] text-bad transition-colors hover:bg-bad-soft">
          <IconTrash className="h-4 w-4" /><span className="max-md:hidden">Delete</span>
        </button>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" aria-label="Clear selection" onClick={onClear} disabled={busy} className="grid h-8 w-8 place-items-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg">
          <IconClose className="h-4 w-4" />
        </button>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}?`}
        description="Their subtasks go too. This can't be undone from here."
        footer={<>
          <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { setConfirm(false); if (await writes.remove(ids)) onClear(); }}>Delete</Button>
        </>} />
    </>
  );
}

/** R84: set one custom field on every picked task (or clear it). */
function BulkFieldPanel({ fields, people, onSet }: { fields: CustomField[]; people: AssigneeOption[]; onSet: (fieldId: string, value: unknown) => void }) {
  const [id, setId] = useState(fields[0]?.id ?? "");
  const [value, setValue] = useState<string>("");
  const f = fields.find((x) => x.id === id) ?? fields[0];
  if (!f) return null;
  const selCls = "h-8 w-full text-[13px] max-sm:h-11 max-sm:text-base";
  const cls = "h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] max-sm:h-11 max-sm:text-base";
  const parsed = (): unknown => {
    if (f.type === "number" || f.type === "currency") return value === "" ? null : Number(value);
    if (f.type === "checkbox") return value === "yes";
    if (f.type === "multiselect") return value ? [value] : [];
    return value || null;
  };
  return (
    <div className="w-64 space-y-2 p-2">
      <Select aria-label="Field" value={f.id} onChange={(e) => { setId(e.target.value); setValue(""); }} className={selCls}>
        {fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </Select>
      {f.type === "select" || f.type === "multiselect" ? (
        <Select aria-label={`Value for ${f.name}`} value={value} onChange={(e) => setValue(e.target.value)} className={selCls}>
          <option value="">Pick an option</option>
          {f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
      ) : f.type === "checkbox" ? (
        <Select aria-label={`Value for ${f.name}`} value={value} onChange={(e) => setValue(e.target.value)} className={selCls}>
          <option value="">Pick one</option><option value="yes">Ticked</option><option value="no">Not ticked</option>
        </Select>
      ) : f.type === "person" ? (
        <Select aria-label={`Value for ${f.name}`} value={value} onChange={(e) => setValue(e.target.value)} className={selCls}>
          <option value="">Pick a person</option>
          {people.filter((p) => p.type === "member").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      ) : f.type === "date" ? (
        <DateInput aria-label={`Value for ${f.name}`} value={value} onChange={(e) => setValue(e.target.value)} className={cls} />
      ) : (
        <input aria-label={`Value for ${f.name}`} value={value} onChange={(e) => setValue(e.target.value)} inputMode={f.type === "number" || f.type === "currency" ? "decimal" : f.type === "url" ? "url" : undefined}
          placeholder={f.type === "url" ? "https://" : f.type === "number" || f.type === "currency" ? "0" : "Value"} className={cls}
          onKeyDown={(e) => { if (e.key === "Enter" && value !== "") onSet(f.id, parsed()); }} />
      )}
      <div className="flex gap-1.5">
        <Button size="sm" disabled={value === ""} onClick={() => onSet(f.id, parsed())}>Set {f.name}</Button>
        <Button size="sm" variant="secondary" onClick={() => onSet(f.id, null)}>Clear</Button>
      </div>
    </div>
  );
}
