import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PhoneFilters } from "@/web/components/phone-filters-r40"; // R40 (MB-209)
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMediaQuery } from "@/web/lib/use-compact";
import { PHONE_QUERY } from "@/web/lib/phone";
import { PhoneTaskList } from "./tasks-phone-r41";
import { IconAssign, IconBoard, IconMore, IconBookmark, IconCalendarDays, IconChevronDown, IconChevronUp, IconClose, IconList, IconMountain, IconPlus, IconSettings2, IconSliders, IconSprint, IconTeam, IconTimeline, IconTrash, type IconComponent } from "@/web/components/ui/icon";

import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30
import { emptyTasksCopy, hasTaskFilters } from "@/web/lib/empty-states";
import { BoardSkeleton, TasksEmpty } from "./tasks-empty";
import { CalendarSkeleton, PanelListSkeleton, TimelineSkeleton } from "@/web/components/skeletons-r36"; // R36
import { api, ApiError, isTransientError } from "@/web/lib/api";
import { ErrorRetry } from "@/web/components/reconnecting-r40"; // R40 (MB-205)

import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { requireText, useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { Popover } from "@/web/components/ui/popover"; // R75
import { cn } from "@/web/lib/cn";
import { Board, ColumnComposer, NO_VALUE } from "./board";
import { describeFilter, FieldFilterPicker, FieldsDialog } from "./fields";
import { isComputed, ProjectRollups, taskFields } from "./computed-fields";
import { GuestsDialog } from "./guests";
import { TaskTable } from "./table";
import { TaskPanel } from "./task-panel";
import { useTaskListFocus } from "@/web/lib/commands/use-task-focus";
import { useCommandHandlers } from "@/web/lib/commands/use-commands"; // R34
import { TaskQueryBox } from "./task-query-box"; // R26 (MB-86)
import { EpicsDialog, TYPE_META, TASK_TYPES, TypePicker, type TaskType } from "./task-type";
import { PRIORITY_LABEL, sk, useAssignees, useFields, useProjects, useTaskMutations, useTasks, useViews, type Category, type Priority, type Project, type ViewKind, type Task, isAgentLike } from "./data";
import { tone } from "@/web/components/app-bits";
import { isPhoneWidth, pickTaskView, readStoredTaskView, storeTaskView } from "@/web/lib/phone";
import { ShareButton } from "./share-sheet"; // R26 (MB-87)
import { LaneBoard, SWIMLANE_LABEL, assigneeKey, useBoardSettings, type LaneTarget } from "./board-lanes"; // R34 (MB-186)
import { NO_LANE, SWIMLANES, boardViewKeys, lanesFrom, type Swimlanes } from "@/shared/board-lanes";
import { ClashScope } from "./schedule-r38"; // R38: clash badges on list rows and board cards
import { lazyPage } from "@/web/components/lazy-page";

const TaskCalendar = lazyPage(() => import("./calendar"), "TaskCalendar");
const PlannedTimeline = lazyPage(() => import("./timeline-plan-r37"), "default"); // R37: timeline with dependency planning
const SprintsView = lazyPage(() => import("./sprints"), "SprintsView");
const WorkloadView = lazyPage(() => import("./workload"), "WorkloadView");

const VIEWS: { id: ViewKind; label: string; icon: IconComponent }[] = [
  { id: "board", label: "Board", icon: IconBoard },
  { id: "list", label: "List", icon: IconList },
  { id: "calendar", label: "Calendar", icon: IconCalendarDays },
  { id: "timeline", label: "Timeline", icon: IconTimeline },
  { id: "sprints", label: "Sprints", icon: IconSprint },
  { id: "workload", label: "Workload", icon: IconTeam },
];
const FILTER_KEYS = ["q", "assignee", "priority", "label", "status", "type"] as const;

export function TasksPage() {
  const { prompt, dialogs } = useDialogs();
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const people = useAssignees();
  const views = useViews();
  const phone = useMediaQuery(PHONE_QUERY);
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
  // R34 (MB-186): swimlanes and WIP limits saved with the board (one read, one write per change).
  const board = useBoardSettings(view === "board" ? projectId || undefined : undefined);
  // R35: a saved view's own lanes (?lanes=) win over the board's setting while it is open.
  const lanesParam = params.get("lanes");
  const lanes = lanesFrom(lanesParam, board.settings.swimlanes);
  const setLanes = (v: Swimlanes) => { if (lanesParam) set({ lanes: v }); else board.save({ swimlanes: v }); };
  const lanesOn = view === "board" && !groupField && !groupEpic && lanes !== "none";
  const [laneCollapse, setLaneCollapse] = useState(0);
  useCommandHandlers({ "board-lanes-collapse": () => { setLaneCollapse((n) => n + 1); } }, lanesOn);
  const setLimit = useCallback((id: string, v: { max?: number | null; min?: number | null }) => board.save({ column: { id, ...v } }), [board]);
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
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  // R30: empty views say why and offer the way out (clear the filters, or add the first task).
  const filtered = hasTaskFilters(params.entries(), FILTER_KEYS);
  const clearFilters = () => setParams((p) => { const n = new URLSearchParams(p); for (const k of [...n.keys()]) if ((FILTER_KEYS as readonly string[]).includes(k) || k.startsWith("field.")) n.delete(k); return n; }, { replace: true });
  // R30: ?new=1 (from the command menu) opens New task once projects load.
  const wantsNew = params.get("new") === "1";
  useEffect(() => {
    if (!wantsNew || projects.isPending) return;
    setNewTask({});
    setParams((p) => { const n = new URLSearchParams(p); n.delete("new"); return n; }, { replace: true });
  }, [wantsNew, projects.isPending, setParams]);
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
  // R34 (MB-186): a drop in a lane board sets the status (column) and the lane's field in one update.
  const moveInLane = useCallback(async (id: string, to: LaneTarget, position: number) => {
    const t = (tasks.data ?? []).find((x) => x.id === id);
    if (!t || !project) return;
    const st = project.statuses.find((s) => s.id === to.col);
    const patch: Record<string, unknown> = { position };
    if (st && st.id !== t.statusId) Object.assign(patch, { statusId: st.id, status: st.category, statusName: st.name });
    const mode = lanes;
    const lane = to.lane === NO_LANE ? null : to.lane;
    if (mode === "assignee") {
      const cur = assigneeKey(t.assignee as never);
      if (cur !== lane) {
        // Sent as assigneeId ("member:<id>", null clears) so the optimistic merge keeps the assignee object the
        // cards render; the object is set here first from the people list.
        patch.assigneeId = lane;
        const p = (people.data ?? []).find((x) => x.id === lane);
        const obj = p ? { type: p.type, id: p.id.split(":")[1], name: p.name, email: p.email } : null;
        for (const [key, list] of qc.getQueriesData<Task[]>({ queryKey: ["tasks"] })) {
          if (Array.isArray(list)) qc.setQueryData<Task[]>(key, list.map((x) => (x.id === id ? { ...x, assignee: obj as Task["assignee"] } : x)));
        }
      }
    } else if (mode === "priority") {
      const cur = t.priority === "none" ? null : t.priority;
      if (cur !== lane) patch.priority = lane ?? "none";
    } else if (mode === "epic") {
      const isEpic = (pid: string | null | undefined) => !!pid && (tasks.data ?? []).some((x) => x.id === pid && x.type === "epic");
      const from = isEpic(t.parentId) ? t.parentId! : null;
      if (from !== lane) {
        try {
          if (lane) await api.post(`/epics/${lane}/items`, { ids: [id] });
          else if (from) await api.del(`/epics/${from}/items`, { ids: [id] });
        } catch (e) { showError(e as Error); return; }
        for (const [key, list] of qc.getQueriesData<Task[]>({ queryKey: ["tasks"] })) {
          if (Array.isArray(list)) qc.setQueryData<Task[]>(key, list.map((x) => (x.id === id ? { ...x, parentId: lane } : x)));
        }
      }
    }
    update.mutate({ id, patch: patch as never });
  }, [tasks.data, project, lanes, update, people.data, qc]);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  }, [setParams]);
  const open = useCallback((id: string) => set({ task: id }), [set]);
  // R31: J/K focus on the visible tasks; S, A, P, L and D act on the focused or open task (lib/commands).
  useTaskListFocus(useMemo(() => (tasks.data ?? []).map((t) => t.id), [tasks.data]), openId);
  const activeFilters = FILTER_KEYS.filter((k) => filters[k]);
  const moreFilterCount = (filters.priority ? 1 : 0) + (filters.type ? 1 : 0); // R75: shown on the Filters button

  const saveView = async () => {
    const name = (await prompt({ title: "Save view", label: "View name", initial: activeFilters.length ? activeFilters.map((k) => filters[k]).join(", ") : `${project?.name ?? "All tasks"} ${view}`, confirmLabel: "Save view", validate: requireText("a name") }))?.trim();
    if (!name) return;
    setSaving(true);
    try {
      await api.post("/tasks/views", { name, view, projectId: projectId || null, filters: { ...Object.fromEntries(activeFilters.map((k) => [k, filters[k]!])), ...boardViewKeys(view, lanes, params.get("group")) } });
      await qc.invalidateQueries({ queryKey: sk.views });
    } catch (e) { showError(e as Error); } finally { setSaving(false); }
  };

  if (projects.isPending) return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col">
      {dialogs}
      {/* R46: on a phone, title with View and New task on one row, then the project picker with one More menu (no wrapping icon row). */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="tasks-header">
        <h1 className="mr-2 large-title max-sm:order-1 max-sm:mr-0 max-sm:min-w-0 max-sm:flex-1 max-sm:truncate">Tasks</h1>
        <Select aria-label="Project" value={projectId} onChange={(e) => set({ project: e.target.value || null })} className="h-9 w-auto! min-w-[160px] text-[13px] max-sm:order-3 max-sm:h-11 max-sm:min-w-0 max-sm:flex-1 max-sm:text-[15px]">
          {view !== "board" && view !== "sprints" && <option value="">All projects</option>}
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {/* R75: project actions live in one menu on every width (the header was three rows of buttons). */}
        <div className="max-sm:order-3">
          <Menu label="Project actions" align="start" trigger={<Button variant="ghost" size="icon" aria-label="Project actions" title="Project actions" data-testid="project-actions"><IconMore className="h-5 w-5" /></Button>}>
            {project && <MenuItem icon={<IconSettings2 />} onSelect={() => setEditing(project)}>Project settings</MenuItem>}
            {project && <MenuItem icon={<IconSliders />} onSelect={() => setFieldsOpen(true)}>Fields</MenuItem>}
            {project && <MenuItem icon={<IconAssign />} onSelect={() => setGuestsOpen(true)}>Guests</MenuItem>}
            {project && <MenuItem icon={<IconMountain />} onSelect={() => setEpicsOpen(true)}>Epics</MenuItem>}
            {project && <div className="my-1 border-t border-line" />}
            <MenuItem icon={<IconPlus />} onSelect={() => setEditing("new")}>New project</MenuItem>
          </Menu>
        </div>
        {project && view === "board" && <span className="max-sm:order-3"><ShareButton kind="project_board" targetId={project.id} /></span>}
        <div className="ml-auto flex items-center gap-2 max-sm:order-2">
          {/* R41 (MB-226): on phones the six views fold into one View picker (a bottom sheet). */}
          <Select aria-label="View" data-testid="phone-view-select" value={view} onChange={(e) => { const v = e.target.value as ViewKind; storeTaskView(v); set({ view: v }); }} className="h-10! w-auto! min-w-[112px] text-[14px] sm:hidden">
            {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </Select>
          <div role="tablist" aria-label="View" className="flex rounded-lg bg-fill p-0.5 max-sm:hidden">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} aria-label={v.label} onClick={() => { storeTaskView(v.id); set({ view: v.id }); }}
                className={cn("inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] sm:min-h-0 sm:min-w-0", view === v.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
                <v.icon className="h-3.5 w-3.5" /><span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>
          <Button onClick={() => setNewTask({})} aria-label="New task" className="min-h-10 min-w-10 sm:min-h-0 sm:min-w-0"><IconPlus className="h-4 w-4" /><span className="hidden min-[400px]:inline">New task</span></Button>
        </div>
        <div aria-hidden className="hidden basis-full max-sm:order-2 max-sm:block" />
      </div>

      {project && <ProjectRollups projectId={project.id} fields={allFields} />}
      <div className="-mx-4 mb-4 flex items-center gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] max-sm:pr-10 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0" aria-label="Filters">
        <TaskQueryBox value={filters.q ?? ""} onApply={(q) => set({ q })} values={queryValues} />
        <PhoneFilters groups={[
          { key: "assignee", label: "Assignee", value: filters.assignee ?? "", onChange: (v) => set({ assignee: v || null }), options: [{ value: "", label: "Anyone" }, { value: "me", label: "Me" }, { value: "none", label: "Nobody" }, ...(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))] },
          { key: "priority", label: "Priority", value: filters.priority ?? "", onChange: (v) => set({ priority: v || null }), options: [{ value: "", label: "Any" }, ...(["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))] },
          { key: "status", label: "Status", value: filters.status ?? "", onChange: (v) => set({ status: v || null }), options: [{ value: "", label: "Any" }, { value: "todo", label: "To do" }, { value: "doing", label: "Doing" }, { value: "done", label: "Done" }] },
          { key: "type", label: "Type", value: filters.type ?? "", onChange: (v) => set({ type: v || null }), options: [{ value: "", label: "Any" }, ...TASK_TYPES.map((k) => ({ value: k, label: TYPE_META[k].label }))] },
        ]} />
        <Select aria-label="Assignee filter" value={filters.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || null })} className="h-8 w-auto! text-[13px] max-sm:hidden">
          <option value="">Anyone</option><option value="me">Me</option><option value="none">Nobody</option>
          {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{isAgentLike(p) ? " (agent)" : ""}</option>)}
        </Select>
        <Select aria-label="Status filter" value={filters.status ?? ""} onChange={(e) => set({ status: e.target.value || null })} className="h-8 w-auto! text-[13px] max-sm:hidden">
          <option value="">Any status</option><option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option>
        </Select>
        {/* R75: the filters people reach for less often sit in one Filters panel, so the toolbar stays one row. */}
        <div className="max-sm:hidden">
          <Popover label="More filters" testId="tasks-more-filters" className="w-[22rem]" button={({ open }) => (
            <span className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors", open || moreFilterCount ? "border-brand/40 bg-brand-soft text-brand-hover" : "border-line bg-surface text-fg/90 hover:bg-hover")}>
              <IconSliders className="h-3.5 w-3.5" />Filters{moreFilterCount ? <span className="ml-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[11px] font-semibold text-white">{moreFilterCount}</span> : null}
            </span>
          )}>
            <div className="grid gap-3">
              <Field label="Priority">{(p) => (
                <Select {...p} value={filters.priority ?? ""} onChange={(e) => set({ priority: e.target.value || null })} className="h-9 text-[13px]">
                  <option value="">Any priority</option>
                  {(["urgent", "high", "medium", "low"] as Priority[]).map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}
                </Select>
              )}</Field>
              <Field label="Type">{(p) => (
                <Select {...p} value={filters.type ?? ""} onChange={(e) => set({ type: e.target.value || null })} className="h-9 text-[13px]">
                  <option value="">Any type</option>
                  {TASK_TYPES.map((k) => <option key={k} value={k}>{TYPE_META[k].label}</option>)}
                </Select>
              )}</Field>
              {project && <div className="[&_[role=group]]:flex-wrap"><FieldFilterPicker fields={fields.filter((f) => !isComputed(f))} people={people.data ?? []} onAdd={(id, raw) => set({ [`field.${id}`]: raw })} /></div>}
            </div>
          </Popover>
        </div>
        {fieldFilters.map(([k, v]) => (
          <span key={k} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-elevated px-2 text-[12.5px]">
            {describeFilter(fields.find((f) => f.id === k.slice(6)), v, people.data ?? [])}
            <button aria-label="Remove this filter" onClick={() => set({ [k]: null })} className="text-subtle hover:text-fg"><IconClose className="h-3 w-3" /></button>
          </span>
        ))}
        {view === "board" && project && (
          <Select aria-label="Group board by" value={groupEpic ? "epic" : groupField?.id ?? ""} onChange={(e) => set({ group: e.target.value || null })} className="h-8 w-auto! text-[13px]">
            <option value="">Group by status</option>
            <option value="epic">Group by epic</option>
            {fields.filter((f) => f.type === "select").map((f) => <option key={f.id} value={f.id}>Group by {f.name}</option>)}
          </Select>
        )}
        {view === "board" && project && !groupField && !groupEpic && (
          <Select aria-label="Swimlanes" data-testid="swimlanes-select" value={lanes} onChange={(e) => setLanes(e.target.value as Swimlanes)} className="h-8 w-auto! text-[13px]">
            {SWIMLANES.map((s) => <option key={s} value={s}>{s === "none" ? "No swimlanes" : `Lanes: ${SWIMLANE_LABEL[s]}`}</option>)}
          </Select>
        )}
        {(activeFilters.length > 0 || fieldFilters.length > 0) && <Button variant="ghost" size="sm" onClick={() => set(Object.fromEntries([...FILTER_KEYS.map((k) => [k, null]), ...fieldFilters.map(([k]) => [k, null])]))}><IconClose className="h-3.5 w-3.5" />Clear</Button>}
        <div className="sm:ml-auto"><Menu align="end" trigger={<Button variant="ghost" size="sm"><IconBookmark className="h-3.5 w-3.5" />Saved views<IconChevronDown className="h-3.5 w-3.5" /></Button>}>
          <MenuLabel>Saved views</MenuLabel>
          {(views.data ?? []).map((v) => (
            <MenuItem key={v.id} onSelect={() => set({ view: v.view, project: v.projectId, ...Object.fromEntries(FILTER_KEYS.map((k) => [k, v.filters[k] ?? null])), lanes: v.filters.lanes ?? null, group: v.filters.group ?? null })}>{v.name}{v.filters.lanes && v.filters.lanes !== "none" ? <span className="ml-auto pl-3 text-[11.5px] text-subtle">Lanes: {SWIMLANE_LABEL[v.filters.lanes as Exclude<Swimlanes, "none">] ?? v.filters.lanes}</span> : null}</MenuItem>
          ))}
          {!views.data?.length && <p className="px-2.5 py-1.5 text-[12.5px] text-subtle">None yet</p>}
          <div className="my-1 border-t border-line" />
          <MenuItem icon={<IconPlus />} onSelect={() => void saveView()}>{saving ? "Saving" : "Save this view"}</MenuItem>
        </Menu></div>
      </div>

      {project && fieldsOpen && <FieldsDialog projectId={project.id} fields={allFields} open onClose={() => setFieldsOpen(false)} />}
      {project && guestsOpen && <GuestsDialog project={project} onClose={() => setGuestsOpen(false)} />}
      {project && epicsOpen && <EpicsDialog project={project} onClose={() => setEpicsOpen(false)} onOpen={(id) => { setEpicsOpen(false); open(id); }} />}
      <div className="min-h-0 flex-1">
        <ClashScope projectId={projectId || undefined} enabled={view === "list" || view === "board"}>{/* R38: one date clash check for the list or board */}
        {!list.length ? (
          <EmptyState icon={<IconBoard />} title="No projects yet" body="Make a task from any email, or start a project. Your first project is set up for you." action={<Button onClick={() => setNewTask({})}>New task</Button>} />
        ) : tasks.isPending ? (
          view === "board" && project ? <BoardSkeleton columns={Math.min(project.statuses.length || 4, 5)} /> : <SkeletonRows rows={8} rowHeight={41} label="Loading tasks" className="rounded-xl border border-line bg-surface" />
        ) : !(tasks.data ?? []).length && view !== "workload" && view !== "sprints" && (filtered || view === "list" || (view === "board" && !project)) ? (
          <TasksEmpty copy={emptyTasksCopy("list", filtered)} onClear={clearFilters} onNew={() => setNewTask({})} board={view === "board"} />
        ) : lanesOn && project ? (
          <LaneBoard project={project} tasks={tasks.data ?? []} mode={lanes as Exclude<Swimlanes, "none">} projects={list} people={people.data ?? []}
            limits={board.settings.limits} onSetLimit={setLimit} onOpen={open} collapseSignal={laneCollapse}
            onMove={(id, to, position) => void moveInLane(id, to, position)} />
        ) : view === "board" && project ? (
          <Board project={project} limits={board.settings.limits} onSetLimit={setLimit} tasks={tasks.data ?? []} onOpen={open} groupBy={groupField} byEpic={groupEpic} onAdd={(col) => setNewTask(groupField || groupEpic ? {} : { statusId: col })}
            onQuickAdd={async (col, title) => { await create.mutateAsync({ title, projectId: project.id, statusId: col }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }}
            onMove={(id, col, position) => groupEpic
              ? void moveToEpic(id, col, position)
              : groupField
              ? update.mutate({ id, patch: { position, fields: { [groupField.id]: col === NO_VALUE ? null : col } } })
              : update.mutate({ id, patch: { statusId: col, position, status: project.statuses.find((s) => s.id === col)?.category, statusName: project.statuses.find((s) => s.id === col)?.name } })} />
        ) : view === "workload" ? (
          <Suspense fallback={<PanelListSkeleton label="Loading workload" />}><WorkloadView projectId={projectId || undefined} onOpen={open} /></Suspense>
        ) : view === "sprints" && project ? (
          <Suspense fallback={<PanelListSkeleton label="Loading sprints" />}><SprintsView project={project} onOpen={open} /></Suspense>
        ) : view === "list" || ((view === "board" || view === "sprints") && !project) ? (
          <>
            {phone ? <PhoneTaskList tasks={tasks.data ?? []} projects={list} onOpen={open} /> /* R41 (MB-226) */
              : <TaskTable tasks={tasks.data ?? []} projects={list} onOpen={open} fields={project ? fields : []} people={people.data ?? []} projectId={projectId || undefined} />}
            {/* R42: the board's rapid add at the foot of the list; into the picked project, else the first one. */}
            {(project ?? list[0]) && <ColumnComposer variant="list" title={(project ?? list[0])!.name}
              onQuickAdd={async (title) => { await create.mutateAsync({ title, projectId: (project ?? list[0])!.id }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }} />}
          </>
        ) : (
          <Suspense fallback={view === "calendar" ? <CalendarSkeleton label="Loading the task calendar" /> : <TimelineSkeleton />}>
            {view === "calendar"
              ? <TaskCalendar tasks={tasks.data ?? []} onOpen={open} onDue={(id, due) => update.mutate({ id, patch: { due } })} />
              : <PlannedTimeline tasks={tasks.data ?? []} projectId={projectId || undefined} onOpen={open} onAdd={() => setNewTask({})} onDates={(id, start, due) => update.mutate({ id, patch: { start, due } })} />}
          </Suspense>
        )}
        </ClashScope>
      </div>

      {openId && <TaskPanel id={openId} onClose={() => set({ task: null })} />}
      {newTask && <NewTaskDialog projects={list} projectId={projectId || list[0]?.id} statusId={newTask.statusId} onClose={() => setNewTask(null)}
        onCreate={async (body, more) => { const r = await create.mutateAsync(body); if (more) { toast.success(`Added ${r.task.ref}`); return; } setNewTask(null); open(r.task.id); }} />}
      {editing && <ProjectDialog project={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(p) => { setEditing(null); set({ project: p.id }); }} />}
    </div>
  );
}

function NewTaskDialog({ projects, projectId, statusId, onClose, onCreate }: { projects: Project[]; projectId?: string; statusId?: string; onClose: () => void; onCreate: (b: Record<string, unknown>, more: boolean) => Promise<void> }) {
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
  const titleRef = useRef<HTMLInputElement>(null);
  // R40 (MB-208): "Add another" keeps the dialog open with the same project, column and fields, clears the title and
  // puts the cursor back, so five tasks in a row is type, Enter, type, Enter. Plain Create task opens the new task.
  const [keepGoing, setKeepGoing] = useState(!!statusId);
  const submit = async (more = keepGoing) => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onCreate({ title, projectId: pid || undefined, statusId: sid || undefined, assignee: assignee || null, due: due || null, priority, type }, more);
      if (more) { setTitle(""); requestAnimationFrame(() => titleRef.current?.focus()); }
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New task" footer={<>
      <label className="mr-auto inline-flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-muted"><input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={keepGoing} onChange={(e) => setKeepGoing(e.target.checked)} />Add another</label>
      <Button variant="secondary" onClick={onClose}>{keepGoing ? "Done" : "Cancel"}</Button><Button loading={busy} disabled={!title.trim()} onClick={() => void submit()}>{keepGoing ? "Add task" : "Create task"}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Title">{(f) => <Input {...f} ref={titleRef} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />}</Field>
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

type ProjectTemplate = "simple" | "kanban" | "sprint";
const PROJECT_TEMPLATES: { id: ProjectTemplate; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "simple", label: "Simple", hint: "To do and Done", icon: <IconList className="h-4 w-4" /> },
  { id: "kanban", label: "Kanban", hint: "A board in three columns", icon: <IconBoard className="h-4 w-4" /> },
  { id: "sprint", label: "Sprint", hint: "Backlog to review", icon: <IconSprint className="h-4 w-4" /> },
];
export function templateStatuses(t: ProjectTemplate): { id: string; name: string; category: Category; color: string; position: number }[] {
  const rows: [string, Category, string][] = t === "simple"
    ? [["To do", "todo", "#8a8f98"], ["Done", "done", "#22c55e"]]
    : t === "sprint"
      ? [["Backlog", "todo", "#6e6e73"], ["To do", "todo", "#8a8f98"], ["In progress", "doing", "#3b82f6"], ["In review", "doing", "#a855f7"], ["Done", "done", "#22c55e"]]
      : [["To do", "todo", "#8a8f98"], ["In progress", "doing", "#3b82f6"], ["Done", "done", "#22c55e"]];
  return rows.map(([name, category, color], position) => ({ id: "", name, category, color, position }));
}

const SWATCHES = ["#8e8e93", "#5b7fa6", "#4f8a8b", "#5e8c61", "#a3824a", "#a65e5e", "#7d6b9e", "#6e6e73"];

function ProjectDialog({ project, onClose, onSaved }: { project: Project | null; onClose: () => void; onSaved: (p: Project) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  // R33: the key is editable; a key another project uses (any case) is refused inline under the field.
  const [key, setKey] = useState(project?.key ?? "");
  const [keyError, setKeyError] = useState<string | null>(null);
  // R40 (MB-211): a new project starts from a template (name plus one choice); statuses, key and triage sit under
  // Customize. Project settings for an existing project show everything, as before.
  const [template, setTemplate] = useState<ProjectTemplate>("kanban");
  const [customize, setCustomize] = useState(!!project);
  const [statuses, setStatuses] = useState(project?.statuses.map((s) => ({ ...s })) ?? templateStatuses("kanban"));
  const pickTemplate = (t: ProjectTemplate) => { setTemplate(t); setStatuses(templateStatuses(t)); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R21: new mail and form tasks for this project wait in Triage.
  // R32: on by default for a new project (existing projects keep what they have).
  const [triage, setTriage] = useState(project ? !!(project as Project & { triage?: boolean }).triage : true);
  const move = (i: number, d: number) => setStatuses((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const valid = useMemo(() => name.trim() && statuses.length && statuses.some((s) => s.category === "done") && statuses.every((s) => s.name.trim()), [name, statuses]);
  const [failure, setFailure] = useState<unknown>(null);
  const save = async () => {
    setBusy(true); setError(null); setKeyError(null); setFailure(null);
    const k = key.trim().toUpperCase();
    const body = { name, ...(k && k !== project?.key ? { key: k } : {}), statuses: statuses.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, category: s.category, color: s.color })) };
    try {
      let r = project ? await api.patch<{ project: Project }>(`/projects/${project.id}`, { ...body, triage }) : await api.create<{ project: Project }>("/projects", body);
      if (!project && triage) r = await api.patch<{ project: Project }>(`/projects/${r.project.id}`, { triage });
      await qc.invalidateQueries({ queryKey: sk.projects }); await qc.invalidateQueries({ queryKey: ["tasks"] });
      onSaved(r.project);
    } catch (e) {
      if (e instanceof ApiError && e.code === "key_taken") setKeyError(e.message);
      else if (isTransientError(e)) setFailure(e); // R40 (MB-205): not a field error, a calm line with Retry
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={project ? "Project settings" : "New project"} description={project || customize ? "Statuses are the board's columns. Each belongs to a group: to do, doing or done." : "Pick how work moves. You can change it any time."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={save}>{project ? "Save" : "Create project"}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" error={error ?? undefined}>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client onboarding" autoFocus />}</Field>
        <ErrorRetry error={failure} onRetry={save} retrying={busy} />
        {!project && (
          <div role="radiogroup" aria-label="Template" className="grid grid-cols-3 gap-2">
            {PROJECT_TEMPLATES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={template === t.id} onClick={() => pickTemplate(t.id)} data-testid={`template-${t.id}`}
                className={cn("flex min-h-[88px] flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-[border-color,box-shadow,background-color] duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                  template === t.id ? "border-brand bg-brand/5 shadow-[0_0_0_1px_var(--color-brand,#0071E3)]" : "border-line bg-surface hover:border-line-strong")}>
                <span className={cn("grid h-7 w-7 place-items-center rounded-lg", template === t.id ? "bg-brand text-white" : "bg-elevated text-muted")}>{t.icon}</span>
                <span className="text-[13px] font-semibold leading-tight">{t.label}</span>
                <span className="text-[11.5px] leading-snug text-muted">{t.hint}</span>
              </button>
            ))}
          </div>
        )}
        {!project && (
          <button type="button" onClick={() => setCustomize((v) => !v)} aria-expanded={customize} className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-medium text-brand-hover hover:underline">
            {customize ? <IconChevronUp className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}Customize
          </button>
        )}
        {customize && <>
        <Field label="Key" hint={keyError ? undefined : "Shown before task numbers, like OPS-12. Letters and digits, up to 6."} error={keyError ?? undefined}>{(f) => <Input {...f} value={key} maxLength={6} onChange={(e) => { setKey(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()); setKeyError(null); }} placeholder={project ? "" : "Made from the name"} className="w-32 font-mono uppercase" data-testid="project-key" />}</Field>
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
                <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move up"><IconChevronUp className="h-4 w-4" /></button>
                <button disabled={i === statuses.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move down"><IconChevronDown className="h-4 w-4" /></button>
                <button disabled={statuses.length <= 1} onClick={() => setStatuses((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-subtle hover:text-bad disabled:opacity-30" aria-label={`Remove ${s.name}`}><IconTrash className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setStatuses((x) => [...x.slice(0, -1), { id: "", name: "", category: "doing", color: "#a855f7", position: x.length }, ...x.slice(-1)])}><IconPlus className="h-3.5 w-3.5" />Add status</Button>
          {project && <p className="mt-2 text-[12px] text-subtle">Removing a status moves its tasks to the first status in the same group.</p>}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
          <div><div className="text-[13px] font-medium">Send to triage</div><div className="text-[12px] text-muted">Tasks made from mail rules and forms wait in Triage until someone accepts them.</div></div>
          <Switch checked={triage} onChange={setTriage} label="Send to triage" />
        </div>
        </>}
      </div>
    </Dialog>
  );
}
