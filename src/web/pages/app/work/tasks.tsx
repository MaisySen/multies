import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, CalendarDays, ChevronDown, ChevronUp, GanttChart, KanbanSquare, List, Mountain, Plus, Settings2, SlidersHorizontal, Trash2, UserPlus, X } from "lucide-react";
import { IterationCw, Users } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";
import { Board, NO_VALUE } from "./board";
import { describeFilter, FieldFilterPicker, FieldsDialog } from "./fields";
import { isComputed, ProjectRollups, taskFields } from "./computed-fields";
import { GuestsDialog } from "./guests";
import { TaskTable } from "./table";
import { TaskPanel } from "./task-panel";
import { TaskQueryBox } from "./task-query-box"; // R26 (MB-86)
import { EpicsDialog, TYPE_META, TASK_TYPES, TypePicker, type TaskType } from "./task-type";
import { PRIORITY_LABEL, sk, useAssignees, useFields, useProjects, useTaskMutations, useTasks, useViews, type Category, type Priority, type Project, type ViewKind } from "./data";
import { tone } from "@/web/components/app-bits";
import { isPhoneWidth, pickTaskView, readStoredTaskView, storeTaskView } from "@/web/lib/phone";

const TaskCalendar = lazy(() => import("./calendar").then((m) => ({ default: m.TaskCalendar })));
const TaskTimeline = lazy(() => import("./timeline").then((m) => ({ default: m.TaskTimeline })));
const SprintsView = lazy(() => import("./sprints").then((m) => ({ default: m.SprintsView })));
const WorkloadView = lazy(() => import("./workload").then((m) => ({ default: m.WorkloadView })));

const VIEWS: { id: ViewKind; label: string; icon: typeof List }[] = [
  { id: "board", label: "Board", icon: KanbanSquare },
  { id: "list", label: "List", icon: List },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline", icon: GanttChart },
  { id: "sprints", label: "Sprints", icon: IterationCw },
  { id: "workload", label: "Workload", icon: Users },
];
const FILTER_KEYS = ["q", "assignee", "priority", "label", "status", "type"] as const;

export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const people = useAssignees();
  const views = useViews();
  const qc = useQueryClient();
  const { update, create } = useTaskMutations();
  // Phones open the list: a board's second column runs off a narrow screen (dogfood finding).
  // R25 (DF-10): the address, then this device's last pick, then List on phones and Board elsewhere.
  const view = pickTaskView({ param: params.get("view"), stored: readStoredTaskView(), phone: isPhoneWidth() }) as ViewKind;
  const list = projects.data ?? [];
  // The board needs one project: by default the one with the most open work.
  const busiest = [...list].sort((a, b) => (b.counts.todo + b.counts.doing) - (a.counts.todo + a.counts.doing))[0];
  const projectId = params.get("project") ?? (view === "board" || view === "sprints" ? busiest?.id : undefined) ?? "";
  const project = list.find((p) => p.id === projectId);
  const openId = params.get("task");
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined])) as Record<(typeof FILTER_KEYS)[number], string | undefined>;
  const fieldDefs = useFields(projectId || undefined);
  const allFields = fieldDefs.data ?? [];
  const fields = taskFields(allFields); // R24.1: project rollups show in the header, not as columns
  const fieldFilters = [...params.entries()].filter(([k]) => k.startsWith("field."));
  const groupField = view === "board" ? fields.find((f) => f.id === params.get("group") && f.type === "select") : undefined;
  const groupEpic = view === "board" && params.get("group") === "epic";
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [epicsOpen, setEpicsOpen] = useState(false);
  const tasks = useTasks({ projectId: projectId || undefined, ...filters, ...Object.fromEntries(fieldFilters) }, { enabled: !projects.isPending });
  // R26 (MB-86): values the query box suggests: statuses, labels, people, projects and sprints.
  const sprintList = useQuery({ queryKey: ["sprints-for-query", projectId], enabled: !!projectId, queryFn: async () => (await api.get<{ sprints: { name: string }[] }>(`/sprints?projectId=${projectId}`)).sprints });
  const queryValues = useMemo(() => {
    const list = projects.data ?? [];
    return {
    status: [...new Set(list.flatMap((p) => p.statuses.map((s) => s.name)))],
    label: [...new Set((tasks.data ?? []).flatMap((t) => t.labels))].sort(),
    assignee: (people.data ?? []).map((p) => p.name),
    project: list.map((p) => p.key ?? p.name).filter(Boolean) as string[],
    sprint: (sprintList.data ?? []).map((s) => s.name),
    };
  }, [projects.data, tasks.data, people.data, sprintList.data]);
  const deps = useQuery({ queryKey: ["task-deps", projectId], enabled: view === "timeline", queryFn: async () => (await api.get<{ links: { from: string; to: string }[] }>(`/tasks/dependencies${projectId ? `?projectId=${projectId}` : ""}`)).links });
  const addLink = useCallback(async (blocker: string, blocked: string) => {
    try { await api.post(`/tasks/${blocked}/dependencies`, { blockedBy: blocker }); } catch (e) { showError(e as Error); }
    void deps.refetch();
  }, [deps]);
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  // Round 22: dragging a card between epic columns moves it into that epic (or out of its epic).
  const moveToEpic = useCallback(async (id: string, col: string, position: number) => {
    const t = (tasks.data ?? []).find((x) => x.id === id);
    if (!t) return;
    const from = t.parentId && (tasks.data ?? []).some((x) => x.id === t.parentId && x.type === "epic") ? t.parentId : null;
    const to = col === NO_VALUE ? null : col;
    try {
      if (to && to !== from) await api.post(`/epics/${to}/items`, { ids: [id] });
      else if (!to && from) await api.del(`/epics/${from}/items`, { ids: [id] });
      if (Math.abs(t.position - position) > 1e-9) await api.patch(`/tasks/${id}`, { position });
    } catch (e) { showError(e as Error); }
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  }, [tasks.data, qc]);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  }, [setParams]);
  const open = useCallback((id: string) => set({ task: id }), [set]);
  const activeFilters = FILTER_KEYS.filter((k) => filters[k]);

  const saveView = async () => {
    const name = window.prompt("Name this view", activeFilters.length ? activeFilters.map((k) => filters[k]).join(", ") : `${project?.name ?? "All tasks"} ${view}`);
    if (!name) return;
    setSaving(true);
    try {
      await api.post("/tasks/views", { name, view, projectId: projectId || null, filters: Object.fromEntries(activeFilters.map((k) => [k, filters[k]!])) });
      await qc.invalidateQueries({ queryKey: sk.views });
    } catch (e) { showError(e as Error); } finally { setSaving(false); }
  };

  if (projects.isPending) return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 large-title">Tasks</h1>
        <Select aria-label="Project" value={projectId} onChange={(e) => set({ project: e.target.value || null })} className="h-9 w-auto! min-w-[160px] text-[13px]">
          {view !== "board" && view !== "sprints" && <option value="">All projects</option>}
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {project && <Button variant="ghost" size="icon" aria-label="Project settings" title="Statuses and project settings" onClick={() => setEditing(project)}><Settings2 className="h-4 w-4" /></Button>}
        {project && <Button variant="ghost" size="sm" onClick={() => setFieldsOpen(true)}><SlidersHorizontal className="h-4 w-4" />Fields</Button>}
        {project && <Button variant="ghost" size="sm" onClick={() => setGuestsOpen(true)}><UserPlus className="h-4 w-4" />Guests</Button>}
        {project && <Button variant="ghost" size="sm" onClick={() => setEpicsOpen(true)}><Mountain className="h-4 w-4" />Epics</Button>}
        <Button variant="ghost" size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Project</Button>
        <div className="ml-auto flex items-center gap-2">
          <div role="tablist" aria-label="View" className="flex rounded-lg bg-fill p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} aria-label={v.label} onClick={() => { storeTaskView(v.id); set({ view: v.id }); }}
                className={cn("inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] sm:min-h-0 sm:min-w-0", view === v.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
                <v.icon className="h-3.5 w-3.5" /><span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>
          <Button onClick={() => setNewTask({})} aria-label="New task" className="min-h-10 min-w-10 sm:min-h-0 sm:min-w-0"><Plus className="h-4 w-4" /><span className="hidden min-[400px]:inline">New task</span></Button>
        </div>
      </div>

      {project && <ProjectRollups projectId={project.id} fields={allFields} />}
      <div className="-mx-4 mb-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0" aria-label="Filters">
        <TaskQueryBox value={filters.q ?? ""} onApply={(q) => set({ q })} values={queryValues} />
        <Select aria-label="Assignee filter" value={filters.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || null })} className="h-8 w-auto! text-[13px]">
          <option value="">Anyone</option><option value="me">Me</option><option value="none">Nobody</option>
          {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "agent" ? " (agent)" : ""}</option>)}
        </Select>
        <Select aria-label="Priority filter" value={filters.priority ?? ""} onChange={(e) => set({ priority: e.target.value || null })} className="h-8 w-auto! text-[13px]">
          <option value="">Any priority</option>
          {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </Select>
        <Select aria-label="Status filter" value={filters.status ?? ""} onChange={(e) => set({ status: e.target.value || null })} className="h-8 w-auto! text-[13px]">
          <option value="">Any status</option><option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option>
        </Select>
        <Select aria-label="Type filter" value={filters.type ?? ""} onChange={(e) => set({ type: e.target.value || null })} className="h-8 w-auto! text-[13px]">
          <option value="">Any type</option>
          {TASK_TYPES.map((k) => <option key={k} value={k}>{TYPE_META[k].label}</option>)}
        </Select>
        {fieldFilters.map(([k, v]) => (
          <span key={k} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-elevated px-2 text-[12.5px]">
            {describeFilter(fields.find((f) => f.id === k.slice(6)), v, people.data ?? [])}
            <button aria-label="Remove this filter" onClick={() => set({ [k]: null })} className="text-subtle hover:text-fg"><X className="h-3 w-3" /></button>
          </span>
        ))}
        {project && <FieldFilterPicker fields={fields.filter((f) => !isComputed(f))} people={people.data ?? []} onAdd={(id, raw) => set({ [`field.${id}`]: raw })} />}
        {view === "board" && project && (
          <Select aria-label="Group board by" value={groupEpic ? "epic" : groupField?.id ?? ""} onChange={(e) => set({ group: e.target.value || null })} className="h-8 w-auto! text-[13px]">
            <option value="">Group by status</option>
            <option value="epic">Group by epic</option>
            {fields.filter((f) => f.type === "select").map((f) => <option key={f.id} value={f.id}>Group by {f.name}</option>)}
          </Select>
        )}
        {(activeFilters.length > 0 || fieldFilters.length > 0) && <Button variant="ghost" size="sm" onClick={() => set(Object.fromEntries([...FILTER_KEYS.map((k) => [k, null]), ...fieldFilters.map(([k]) => [k, null])]))}><X className="h-3.5 w-3.5" />Clear</Button>}
        <Menu align="end" trigger={<Button variant="secondary" size="sm"><Bookmark className="h-3.5 w-3.5" />Saved views<ChevronDown className="h-3.5 w-3.5" /></Button>}>
          <MenuLabel>Saved views</MenuLabel>
          {(views.data ?? []).map((v) => (
            <MenuItem key={v.id} onSelect={() => set({ view: v.view, project: v.projectId, ...Object.fromEntries(FILTER_KEYS.map((k) => [k, v.filters[k] ?? null])) })}>{v.name}</MenuItem>
          ))}
          {!views.data?.length && <p className="px-2.5 py-1.5 text-[12.5px] text-subtle">None yet</p>}
          <div className="my-1 border-t border-line" />
          <MenuItem icon={<Plus />} onSelect={() => void saveView()}>{saving ? "Saving" : "Save this view"}</MenuItem>
        </Menu>
      </div>

      {project && fieldsOpen && <FieldsDialog projectId={project.id} fields={allFields} open onClose={() => setFieldsOpen(false)} />}
      {project && guestsOpen && <GuestsDialog project={project} onClose={() => setGuestsOpen(false)} />}
      {project && epicsOpen && <EpicsDialog project={project} onClose={() => setEpicsOpen(false)} onOpen={(id) => { setEpicsOpen(false); open(id); }} />}
      <div className="min-h-0 flex-1">
        {!list.length ? (
          <EmptyState icon={<KanbanSquare />} title="No projects yet" body="Make a task from any email, or start a project. Your first project is set up for you." action={<Button onClick={() => setNewTask({})}>New task</Button>} />
        ) : tasks.isPending ? <Skeleton className="h-64" /> : view === "board" && project ? (
          <Board project={project} tasks={tasks.data ?? []} onOpen={open} groupBy={groupField} byEpic={groupEpic} onAdd={(col) => setNewTask(groupField || groupEpic ? {} : { statusId: col })}
            onMove={(id, col, position) => groupEpic
              ? void moveToEpic(id, col, position)
              : groupField
              ? update.mutate({ id, patch: { position, fields: { [groupField.id]: col === NO_VALUE ? null : col } } })
              : update.mutate({ id, patch: { statusId: col, position, status: project.statuses.find((s) => s.id === col)?.category, statusName: project.statuses.find((s) => s.id === col)?.name } })} />
        ) : view === "workload" ? (
          <Suspense fallback={<Skeleton className="h-64" />}><WorkloadView projectId={projectId || undefined} onOpen={open} /></Suspense>
        ) : view === "sprints" && project ? (
          <Suspense fallback={<Skeleton className="h-64" />}><SprintsView project={project} onOpen={open} /></Suspense>
        ) : view === "list" || ((view === "board" || view === "sprints") && !project) ? (
          <TaskTable tasks={tasks.data ?? []} projects={list} onOpen={open} fields={project ? fields : []} people={people.data ?? []} projectId={projectId || undefined} />
        ) : (
          <Suspense fallback={<Skeleton className="h-96" />}>
            {view === "calendar"
              ? <TaskCalendar tasks={tasks.data ?? []} onOpen={open} onDue={(id, due) => update.mutate({ id, patch: { due } })} />
              : <TaskTimeline tasks={tasks.data ?? []} links={deps.data ?? []} onLink={(a, b) => void addLink(a, b)} onOpen={open} onDates={(id, start, due) => update.mutate({ id, patch: { start, due } })} />}
          </Suspense>
        )}
      </div>

      {openId && <TaskPanel id={openId} onClose={() => set({ task: null })} />}
      {newTask && <NewTaskDialog projects={list} projectId={projectId || list[0]?.id} statusId={newTask.statusId} onClose={() => setNewTask(null)}
        onCreate={async (body) => { const r = await create.mutateAsync(body); setNewTask(null); open(r.task.id); }} />}
      {editing && <ProjectDialog project={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(p) => { setEditing(null); set({ project: p.id }); }} />}
    </div>
  );
}

function NewTaskDialog({ projects, projectId, statusId, onClose, onCreate }: { projects: Project[]; projectId?: string; statusId?: string; onClose: () => void; onCreate: (b: Record<string, unknown>) => Promise<void> }) {
  const people = useAssignees();
  const [title, setTitle] = useState("");
  const [pid, setPid] = useState(projectId ?? "");
  const [sid, setSid] = useState(statusId ?? "");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [type, setType] = useState<TaskType>("task");
  const [busy, setBusy] = useState(false);
  const p = projects.find((x) => x.id === pid);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await onCreate({ title, projectId: pid || undefined, statusId: sid || undefined, assignee: assignee || null, due: due || null, priority, type }); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New task" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!title.trim()} onClick={submit}>Create task</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Title">{(f) => <Input {...f} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />}</Field>
        <TypePicker value={type} onChange={setType} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">{(f) => <Select {...f} value={pid} onChange={(e) => { setPid(e.target.value); setSid(""); }}>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          <Field label="Status">{(f) => <Select {...f} value={sid} onChange={(e) => setSid(e.target.value)}><option value="">{p?.statuses[0]?.name ?? "First status"}</option>{p?.statuses.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          <Field label="Assignee">{(f) => <Select {...f} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Nobody</option>{people.data?.map((x) => <option key={x.id} value={x.id}>{x.name}{x.type === "agent" ? " (agent)" : ""}</option>)}</Select>}</Field>
          <Field label="Due">{(f) => <Input {...f} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
          <Field label="Priority">{(f) => <Select {...f} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{(Object.keys(PRIORITY_LABEL) as Priority[]).map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}</Select>}</Field>
        </div>
      </form>
    </Dialog>
  );
}

const SWATCHES = ["#8e8e93", "#5b7fa6", "#4f8a8b", "#5e8c61", "#a3824a", "#a65e5e", "#7d6b9e", "#6e6e73"];

function ProjectDialog({ project, onClose, onSaved }: { project: Project | null; onClose: () => void; onSaved: (p: Project) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  const [statuses, setStatuses] = useState(project?.statuses.map((s) => ({ ...s })) ?? [
    { id: "", name: "To do", category: "todo" as Category, color: "#8a8f98", position: 0 },
    { id: "", name: "In progress", category: "doing" as Category, color: "#3b82f6", position: 1 },
    { id: "", name: "Done", category: "done" as Category, color: "#22c55e", position: 2 },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R21: new mail and form tasks for this project wait in Triage.
  const [triage, setTriage] = useState(!!(project as (Project & { triage?: boolean }) | null)?.triage);
  const move = (i: number, d: number) => setStatuses((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const valid = useMemo(() => name.trim() && statuses.length && statuses.some((s) => s.category === "done") && statuses.every((s) => s.name.trim()), [name, statuses]);
  const save = async () => {
    setBusy(true); setError(null);
    const body = { name, statuses: statuses.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, category: s.category, color: s.color })) };
    try {
      let r = project ? await api.patch<{ project: Project }>(`/projects/${project.id}`, { ...body, triage }) : await api.post<{ project: Project }>("/projects", body);
      if (!project && triage) r = await api.patch<{ project: Project }>(`/projects/${r.project.id}`, { triage });
      await qc.invalidateQueries({ queryKey: sk.projects }); await qc.invalidateQueries({ queryKey: ["tasks"] });
      onSaved(r.project);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={project ? "Project settings" : "New project"} description="Statuses are the board's columns. Each belongs to a group: to do, doing or done."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={save}>{project ? "Save" : "Create project"}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" error={error ?? undefined}>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client onboarding" autoFocus />}</Field>
        <div>
          <p className="mb-2 text-[13px] font-medium">Statuses</p>
          <ul className="space-y-2">
            {statuses.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <Menu align="start" trigger={<button className="h-5 w-5 shrink-0 rounded-full border border-line-strong" style={{ background: tone(s.color) }} aria-label={`Colour for ${s.name}`} />}>
                  <div className="flex gap-1 p-2">{SWATCHES.map((c) => <button key={c} className="h-5 w-5 rounded-full" style={{ background: c }} aria-label={c} onClick={() => setStatuses((x) => x.map((y, j) => (j === i ? { ...y, color: c } : y)))} />)}</div>
                </Menu>
                <Input aria-label="Status name" value={s.name} onChange={(e) => setStatuses((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} className="h-8 text-[13px]" />
                <Select aria-label="Status group" value={s.category} onChange={(e) => setStatuses((x) => x.map((y, j) => (j === i ? { ...y, category: e.target.value as Category } : y)))} className="h-8 w-28! text-[13px]">
                  <option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option>
                </Select>
                <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move up"><ChevronUp className="h-4 w-4" /></button>
                <button disabled={i === statuses.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move down"><ChevronDown className="h-4 w-4" /></button>
                <button disabled={statuses.length <= 1} onClick={() => setStatuses((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-subtle hover:text-bad disabled:opacity-30" aria-label={`Remove ${s.name}`}><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setStatuses((x) => [...x.slice(0, -1), { id: "", name: "", category: "doing", color: "#a855f7", position: x.length }, ...x.slice(-1)])}><Plus className="h-3.5 w-3.5" />Add status</Button>
          {project && <p className="mt-2 text-[12px] text-subtle">Removing a status moves its tasks to the first status in the same group.</p>}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
          <div><div className="text-[13px] font-medium">Send to triage</div><div className="text-[12px] text-muted">Tasks made from mail rules and forms wait in Triage until someone accepts them.</div></div>
          <Switch checked={triage} onChange={setTriage} label="Send to triage" />
        </div>
      </div>
    </Dialog>
  );
}
