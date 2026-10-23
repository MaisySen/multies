import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, CalendarDays, ChevronDown, ChevronUp, GanttChart, KanbanSquare, List, Plus, Settings2, Trash2, X } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";
import { Board } from "./board";
import { TaskList } from "./list";
import { TaskPanel } from "./task-panel";
import { PRIORITY_LABEL, sk, useAssignees, useProjects, useTaskMutations, useTasks, useViews, type Category, type Priority, type Project, type Task, type ViewKind } from "./data";

const TaskCalendar = lazy(() => import("./calendar").then((m) => ({ default: m.TaskCalendar })));
const TaskTimeline = lazy(() => import("./timeline").then((m) => ({ default: m.TaskTimeline })));

const VIEWS: { id: ViewKind; label: string; icon: typeof List }[] = [
  { id: "board", label: "Board", icon: KanbanSquare },
  { id: "list", label: "List", icon: List },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline", icon: GanttChart },
];
const FILTER_KEYS = ["q", "assignee", "priority", "label", "status"] as const;

export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const people = useAssignees();
  const views = useViews();
  const qc = useQueryClient();
  const { update, create } = useTaskMutations();
  const view = (params.get("view") as ViewKind) || "board";
  const list = projects.data ?? [];
  // The board needs one project: by default the one with the most open work.
  const busiest = [...list].sort((a, b) => (b.counts.todo + b.counts.doing) - (a.counts.todo + a.counts.doing))[0];
  const projectId = params.get("project") ?? (view === "board" ? busiest?.id : undefined) ?? "";
  const project = list.find((p) => p.id === projectId);
  const openId = params.get("task");
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined])) as Record<(typeof FILTER_KEYS)[number], string | undefined>;
  const tasks = useTasks({ projectId: projectId || undefined, ...filters }, { enabled: !projects.isPending });
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  }, [setParams]);
  const open = useCallback((id: string) => set({ task: id }), [set]);
  const toggle = useCallback((t: Task) => update.mutate({ id: t.id, patch: { status: t.status === "done" ? "todo" : "done" } }), [update]);
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
        <h1 className="mr-2 text-xl font-semibold tracking-tight sm:text-[22px]">Tasks</h1>
        <Select aria-label="Project" value={projectId} onChange={(e) => set({ project: e.target.value || null })} className="h-9 w-auto! min-w-[160px] text-[13px]">
          {view !== "board" && <option value="">All projects</option>}
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {project && <Button variant="ghost" size="icon" aria-label="Project settings" title="Statuses and project settings" onClick={() => setEditing(project)}><Settings2 className="h-4 w-4" /></Button>}
        <Button variant="ghost" size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Project</Button>
        <div className="ml-auto flex items-center gap-2">
          <div role="tablist" aria-label="View" className="flex rounded-lg border border-line bg-surface p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => set({ view: v.id })}
                className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px]", view === v.id ? "bg-elevated font-medium text-fg" : "text-muted hover:text-fg")}>
                <v.icon className="h-3.5 w-3.5" /><span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>
          <Button onClick={() => setNewTask({})}><Plus className="h-4 w-4" />New task</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Filters">
        <Input aria-label="Search tasks" placeholder="Search tasks" defaultValue={filters.q ?? ""} onKeyDown={(e) => { if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value || null }); }} className="h-8 w-44! text-[13px]" />
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
        {activeFilters.length > 0 && <Button variant="ghost" size="sm" onClick={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}><X className="h-3.5 w-3.5" />Clear</Button>}
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

      <div className="min-h-0 flex-1">
        {!list.length ? (
          <EmptyState icon={<KanbanSquare />} title="No projects yet" body="Make a task from any email, or start a project. Your first project is set up for you." action={<Button onClick={() => setNewTask({})}>New task</Button>} />
        ) : tasks.isPending ? <Skeleton className="h-64" /> : view === "board" && project ? (
          <Board project={project} tasks={tasks.data ?? []} onOpen={open} onAdd={(statusId) => setNewTask({ statusId })}
            onMove={(id, statusId, position) => update.mutate({ id, patch: { statusId, position, status: project.statuses.find((s) => s.id === statusId)?.category, statusName: project.statuses.find((s) => s.id === statusId)?.name } })} />
        ) : view === "list" || (view === "board" && !project) ? (
          <TaskList tasks={tasks.data ?? []} projects={list} onOpen={open} onToggle={toggle} />
        ) : (
          <Suspense fallback={<Skeleton className="h-96" />}>
            {view === "calendar"
              ? <TaskCalendar tasks={tasks.data ?? []} onOpen={open} onDue={(id, due) => update.mutate({ id, patch: { due } })} />
              : <TaskTimeline tasks={tasks.data ?? []} onOpen={open} onDates={(id, start, due) => update.mutate({ id, patch: { start, due } })} />}
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
  const [busy, setBusy] = useState(false);
  const p = projects.find((x) => x.id === pid);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await onCreate({ title, projectId: pid || undefined, statusId: sid || undefined, assignee: assignee || null, due: due || null, priority }); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New task" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!title.trim()} onClick={submit}>Create task</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Title">{(f) => <Input {...f} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />}</Field>
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

const SWATCHES = ["#8a8f98", "#3b82f6", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#22c55e", "#ef4444"];

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
  const move = (i: number, d: number) => setStatuses((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const valid = useMemo(() => name.trim() && statuses.length && statuses.some((s) => s.category === "done") && statuses.every((s) => s.name.trim()), [name, statuses]);
  const save = async () => {
    setBusy(true); setError(null);
    const body = { name, statuses: statuses.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, category: s.category, color: s.color })) };
    try {
      const r = project ? await api.patch<{ project: Project }>(`/projects/${project.id}`, body) : await api.post<{ project: Project }>("/projects", body);
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
                <Menu align="start" trigger={<button className="h-5 w-5 shrink-0 rounded-full border border-line-strong" style={{ background: s.color }} aria-label={`Colour for ${s.name}`} />}>
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
      </div>
    </Dialog>
  );
}
