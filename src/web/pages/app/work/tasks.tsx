import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PHONE_SORTS, parseSortValue, sortValue } from "@/web/lib/task-sort-par1"; // PAR1
import { toast } from "sonner";
import { PhoneFilters } from "@/web/components/phone-filters-r40"; // R40 (MB-209)
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMediaQuery } from "@/web/lib/use-compact";
import { PHONE_QUERY } from "@/web/lib/phone";
import { PhoneTaskList } from "./tasks-phone-r41";
import { SaveViewDialog, TagsDialog, ViewTabs, WorkspaceFieldsDialog } from "./tasks-r84"; // R84
import { GROUP_LABEL, isGroupBy, type GroupBy } from "@/web/lib/task-groups-r84"; // R84
import { IconListTree, IconAssign, IconBoard, IconMore, IconBookmark, IconCalendarDays, IconChevronDown, IconChevronUp, IconClose, IconList, IconMountain, IconPlus, IconSettings2, IconSliders, IconSprint, IconTeam, IconTimeline, IconTrash, IconTag, IconRows, type IconComponent } from "@/web/components/ui/icon";

import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)
import { retryFailedLoads } from "@/web/lib/load-errors-t1g"; // F13b (MB-320)
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
import { useConfig } from "@/web/lib/queries"; // R95
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { Popover } from "@/web/components/ui/popover"; // R75
import { ChipSelect } from "@/web/components/ui/chip-select"; // R79
import { useLayout } from "@/web/lib/layout-prefs"; // R79
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
import { PRIORITY_LABEL, sk, useAssignees, useFields, useProjects, useTaskMutations, useTasks, useViews, useTags, useWorkspaceFields, type CustomField, type SavedView, type Category, type Priority, type Project, type ViewKind, type Task, isAgentLike } from "./data";
import { tone } from "@/web/components/app-bits";
import { isPhoneWidth, pickTaskView, readStoredTaskView, storeTaskView } from "@/web/lib/phone";
import { ShareButton } from "./share-sheet"; // R26 (MB-87)
import { LaneBoard, SWIMLANE_LABEL, assigneeKey, useBoardSettings, type LaneTarget } from "./board-lanes"; // R34 (MB-186)
import { NO_LANE, SWIMLANES, boardViewKeys, lanesFrom, type Swimlanes } from "@/shared/board-lanes";
import { ClashScope } from "./schedule-r38"; // R38: clash badges on list rows and board cards
import { lazyPage } from "@/web/components/lazy-page";
import { ReferencesPanel } from "@/web/components/mentions-td5"; // POL2
import { tr, tl } from "@/web/i18n"; // R104
import { TriageWaiting } from "./triage-waiting-nav1"; // MPT-11 (NAV1 slice 2)

const TaskCalendar = lazyPage(() => import("./calendar"), "TaskCalendar");
const PlannedTimeline = lazyPage(() => import("./timeline-plan-r37"), "default"); // R37: timeline with dependency planning
const SprintsView = lazyPage(() => import("./sprints"), "SprintsView");
const WorkloadView = lazyPage(() => import("./workload"), "WorkloadView");
const MindMapView = lazyPage(() => import("./mindmap-r95"), "MindMapView"); // R95

const BASE_VIEWS: { id: ViewKind; label: string; icon: IconComponent }[] = [
  { id: "board", get label() { return tl("taskview", "Board"); }, icon: IconBoard },
  { id: "list", get label() { return tl("taskview", "List"); }, icon: IconList },
  { id: "calendar", get label() { return tl("taskview", "Calendar"); }, icon: IconCalendarDays },
  { id: "timeline", get label() { return tl("taskview", "Timeline"); }, icon: IconTimeline },
  { id: "sprints", get label() { return tl("taskview", "Sprints"); }, icon: IconSprint },
  { id: "workload", get label() { return tl("taskview", "Workload"); }, icon: IconTeam },
];
const MINDMAP_VIEW: { id: ViewKind; label: string; icon: IconComponent } = { id: "mindmap", get label() { return tl("taskview", "Mind map"); }, icon: IconListTree }; // R95
const FILTER_KEYS = ["q", "assignee", "priority", "label", "status", "type"] as const;

export function TasksPage() {
  const { prompt, confirm, dialogs } = useDialogs();
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const people = useAssignees();
  const views = useViews();
  const phone = useMediaQuery(PHONE_QUERY);
  // R79: on a desktop the task opens in the side panel beside the view (View menu: Task details), else over the page.
  const desktop = useMediaQuery("(min-width: 1024px)");
  const layoutPrefs = useLayout();
  const dockTask = desktop && layoutPrefs.taskDetails === "side";
  const qc = useQueryClient();
  const { update, create } = useTaskMutations();
  // Phones open the list: a board's second column runs off a narrow screen (dogfood finding).
  // R25 (DF-10): the address, then this device's last pick, then List on phones and Board elsewhere.
  const tasksPlus = !!useConfig().data?.tasksPlus; // R95: the mind map view
  const picked = pickTaskView({ param: params.get("view"), stored: readStoredTaskView(), phone: isPhoneWidth() }) as ViewKind;
  const view: ViewKind = picked === "mindmap" && !tasksPlus ? "list" : picked;
  const VIEWS = tasksPlus ? [...BASE_VIEWS, MINDMAP_VIEW] : BASE_VIEWS;
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
  // R84: in the all projects list the workspace fields are the columns, filters and bulk edit fields (their key is the id).
  const wsFields = useWorkspaceFields();
  const listFields: CustomField[] = project ? fields : (wsFields.data ?? []).map((f, i) => ({ id: f.key, projectId: "", name: f.name, type: f.type, options: f.options, position: i }));
  const tagList = useTags();
  const fieldFilters = [...params.entries()].filter(([k]) => k.startsWith("field."));
  // R84: list grouping and sort live in the address (?group=, ?sort=, ?dir=) so a saved view or a shared link keeps them.
  const groupParam = params.get("group");
  const listGroup: GroupBy | null = view === "list" && isGroupBy(groupParam) && (!groupParam.startsWith("field:") || listFields.some((f) => `field:${f.id}` === groupParam)) ? groupParam : null;
  const sortParam = params.get("sort");
  const listSort = sortParam ? { id: sortParam, desc: params.get("dir") === "desc" } : null;
  const activeViewId = params.get("v");
  const [saveOpen, setSaveOpen] = useState(false);
  const manage = params.get("manage");
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

  // R84: what a saved view keeps: the filters, field filters, and the list's sort and grouping (or the board's lanes and group).
  const viewFilters = () => ({
    ...Object.fromEntries(activeFilters.map((k) => [k, filters[k]!])),
    ...Object.fromEntries(fieldFilters),
    ...(view === "board" ? boardViewKeys(view, lanes, params.get("group")) : {}),
    ...(view === "list" && listGroup ? { group: listGroup } : {}),
    ...(view === "list" && listSort ? { sort: listSort.id, dir: listSort.desc ? "desc" : "asc" } : {}),
  });
  const viewSummary = (): string[] => {
    const out: string[] = [VIEWS.find((v) => v.id === view)?.label ?? view, project?.name ?? "All projects"];
    const n = activeFilters.length + fieldFilters.length;
    if (n) out.push(`${n} ${n === 1 ? "filter" : "filters"}`);
    if (listGroup) out.push(`Grouped by ${groupName(listGroup)}`);
    if (listSort) out.push(`Sorted by ${listSort.id.startsWith("field:") ? listFields.find((f) => `field:${f.id}` === listSort.id)?.name ?? "a field" : listSort.id}`);
    return out;
  };
  const groupOptions = [{ value: "", label: tr("tasks.none") }, ...(["status", "assignee", "priority", "due", "tag"] as const).map((g) => ({ value: g, label: tl("taskgroup", GROUP_LABEL[g]!) })),
    ...(project ? [] : [{ value: "project", label: tl("taskgroup", "Project") }]),
    ...listFields.filter((f) => ["select", "multiselect", "checkbox", "person", "text", "number", "date", "url", "currency"].includes(f.type)).map((f) => ({ value: `field:${f.id}`, label: f.name }))];
  const groupName = (g: string) => (g.startsWith("field:") ? listFields.find((f) => `field:${f.id}` === g)?.name ?? "field" : GROUP_LABEL[g] ?? g).toLowerCase();
  const saveView = async (v: { name: string; shared: boolean; pinned: boolean }) => {
    setSaving(true);
    try {
      const r = await api.post<{ view: SavedView }>("/tasks/views", { name: v.name, view, projectId: projectId || null, shared: v.shared, pinned: v.pinned, filters: viewFilters() });
      await qc.invalidateQueries({ queryKey: sk.views });
      if (r?.view?.id) set({ v: r.view.id });
      toast(`Saved ${v.name}`);
    } finally { setSaving(false); }
  };
  const activeView = (views.data ?? []).find((v) => v.id === activeViewId);
  const updateActiveView = async () => {
    if (!activeView) return;
    try { await api.patch(`/tasks/views/${activeView.id}`, { view, projectId: projectId || null, filters: viewFilters() }); await qc.invalidateQueries({ queryKey: sk.views }); toast(`Updated ${activeView.name}`); }
    catch (e) { showError(e as Error); }
  };
  const applyView = (v: SavedView) => {
    const clear = Object.fromEntries([...FILTER_KEYS.map((k) => [k, null]), ...fieldFilters.map(([k]) => [k, null]), ["lanes", null], ["group", null], ["sort", null], ["dir", null]]);
    const fromView = Object.fromEntries(Object.entries(v.filters).filter(([k]) => (FILTER_KEYS as readonly string[]).includes(k) || k.startsWith("field.") || ["lanes", "group", "sort", "dir"].includes(k)));
    storeTaskView(v.view);
    set({ ...clear, ...fromView, view: v.view, project: v.projectId, v: v.id });
  };
  const editView = async (v: SavedView, patch: Partial<Pick<SavedView, "shared" | "pinned" | "name">>) => {
    try { await api.patch(`/tasks/views/${v.id}`, patch); await qc.invalidateQueries({ queryKey: sk.views }); } catch (e) { showError(e as Error); }
  };
  const renameView = async (v: SavedView) => {
    const name = (await prompt({ title: "Rename view", label: "View name", initial: v.name, confirmLabel: "Rename", validate: requireText("a name") }))?.trim();
    if (name && name !== v.name) await editView(v, { name });
  };
  const deleteView = async (v: SavedView) => {
    if (!(await confirm({ title: `Delete the view ${v.name}?`, description: v.shared ? "It goes for everyone in the workspace. Tasks are not touched." : "Tasks are not touched.", confirmLabel: "Delete view" }))) return;
    try { await api.del(`/tasks/views/${v.id}`); await qc.invalidateQueries({ queryKey: sk.views }); if (activeViewId === v.id) set({ v: null }); } catch (e) { showError(e as Error); }
  };

  if (projects.isError && !projects.data) return <LoadError onRetry={() => Promise.all([projects.refetch(), retryFailedLoads(qc)])} />; // T1G (T1-8); F13b (MB-320): one Retry recovers every failed read on screen
  if (projects.isPending) return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col">
      {dialogs}
      {/* R46: on a phone, title with View and New task on one row, then the project picker with one More menu (no wrapping icon row). */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="tasks-header">
        <h1 className="mr-2 large-title max-sm:order-1 max-sm:mr-0 max-sm:min-w-0 max-sm:flex-1 max-sm:truncate">{tr("common.tasks")}</h1>
        <Select aria-label={tr("tasks.project")} value={projectId} onChange={(e) => set({ project: e.target.value || null })} className="h-9 w-auto! min-w-[160px] text-[13px] max-sm:order-3 max-sm:h-11 max-sm:min-w-0 max-sm:flex-1 max-sm:text-[15px]">
          {view !== "board" && view !== "sprints" && <option value="">{tr("tasks.all_projects")}</option>}
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {/* R75: project actions live in one menu on every width (the header was three rows of buttons). */}
        <div className="max-sm:order-3">
          <Menu label={tr("tasks.project_actions")} align="start" trigger={<Button variant="ghost" size="icon" aria-label={tr("tasks.project_actions")} title={tr("tasks.project_actions")} data-testid="project-actions"><IconMore className="h-5 w-5" /></Button>}>
            {project && <MenuItem icon={<IconSettings2 />} onSelect={() => setEditing(project)}>{tr("tasks.project_settings")}</MenuItem>}
            {project && <MenuItem icon={<IconSliders />} onSelect={() => setFieldsOpen(true)}>{tr("tasks.fields")}</MenuItem>}
            {project && <MenuItem icon={<IconAssign />} onSelect={() => setGuestsOpen(true)}>{tr("tasks.guests")}</MenuItem>}
            {project && <MenuItem icon={<IconMountain />} onSelect={() => setEpicsOpen(true)}>{tr("tasks.epics")}</MenuItem>}
            {project && <div className="my-1 border-t border-line" />}
            <MenuItem icon={<IconTag />} onSelect={() => set({ manage: "tags" })}>{tr("tasks.tags")}</MenuItem>
            <MenuItem icon={<IconRows />} onSelect={() => set({ manage: "fields" })}>{tr("tasks.workspace_fields")}</MenuItem>
            <div className="my-1 border-t border-line" />
            <MenuItem icon={<IconPlus />} onSelect={() => setEditing("new")}>{tr("tasks.new_project")}</MenuItem>
          </Menu>
        </div>
        {project && view === "board" && <span className="max-sm:order-3"><ShareButton kind="project_board" targetId={project.id} /></span>}
        <div className="ml-auto flex items-center gap-2 max-sm:order-2">
          {/* R41 (MB-226): on phones the six views fold into one View picker (a bottom sheet). */}
          <Select aria-label={tr("tasks.view")} data-testid="phone-view-select" value={view} onChange={(e) => { const v = e.target.value as ViewKind; storeTaskView(v); set({ view: v }); }} className="h-11! w-auto! min-w-[112px] text-[14px] sm:hidden">
            {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </Select>
          <div role="tablist" aria-label={tr("tasks.view")} className="flex rounded-lg bg-fill p-0.5 max-sm:hidden">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} aria-label={v.label} onClick={() => { storeTaskView(v.id); set({ view: v.id }); }}
                className={cn("inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] sm:min-h-0 sm:min-w-0", view === v.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
                <v.icon className="h-3.5 w-3.5" /><span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>
          <Button onClick={() => setNewTask({})} aria-label={tr("tasks.new_task")} className="min-h-10 min-w-10 sm:min-h-0 sm:min-w-0"><IconPlus className="h-4 w-4" /><span className="hidden min-[400px]:inline">{tr("tasks.new_task")}</span></Button>
        </div>
        <div aria-hidden className="hidden basis-full max-sm:order-2 max-sm:block" />
      </div>

      <ViewTabs views={(views.data ?? []).filter((v) => !v.projectId || !project || v.projectId === project.id)} activeId={activeViewId} onOpen={applyView}
        onAll={() => set({ v: null, ...Object.fromEntries([...FILTER_KEYS.map((k) => [k, null]), ...fieldFilters.map(([k]) => [k, null]), ["group", null], ["sort", null], ["dir", null], ["lanes", null]]) })}
        onEdit={(v, patch) => void editView(v, patch)} onDelete={(v) => void deleteView(v)} onRename={(v) => void renameView(v)} />
      {project && <ProjectRollups projectId={project.id} fields={allFields} />}
      {project && <TriageWaiting projectId={project.id} triageOn={!!(project as Project & { triage?: boolean }).triage} view={view} />}
      <div className="-mx-4 mb-4 flex items-center gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] max-sm:pr-10 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0" aria-label={tr("tasks.filters")}>
        <TaskQueryBox value={filters.q ?? ""} onApply={(q) => set({ q })} values={queryValues} />
        <PhoneFilters groups={[
          { key: "assignee", label: tr("common.assignee"), value: filters.assignee ?? "", onChange: (v) => set({ assignee: v || null }), options: [{ value: "", label: tr("tasks.anyone") }, { value: "me", label: tr("tasks.me") }, { value: "none", label: tr("tasks.nobody") }, ...(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))] },
          { key: "priority", label: tr("common.priority"), value: filters.priority ?? "", onChange: (v) => set({ priority: v || null }), options: [{ value: "", label: tr("tasks.any") }, ...(["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))] },
          { key: "status", label: tr("common.status"), value: filters.status ?? "", onChange: (v) => set({ status: v || null }), options: [{ value: "", label: tr("tasks.any") }, { value: "todo", label: tr("tasks.to_do") }, { value: "doing", label: tr("tasks.doing") }, { value: "done", label: tr("common.done") }] },
          { key: "type", label: tr("tasks.type"), value: filters.type ?? "", onChange: (v) => set({ type: v || null }), options: [{ value: "", label: tr("tasks.any") }, ...TASK_TYPES.map((k) => ({ value: k, label: TYPE_META[k].label }))] },
          { key: "label", label: tr("tasks.tag"), value: filters.label ?? "", onChange: (v) => set({ label: v || null }), options: [{ value: "", label: tr("tasks.any") }, ...(tagList.data ?? []).map((t) => ({ value: t.name, label: t.name }))] },
          ...(view === "list" ? [{ key: "group", label: tr("tasks.group"), value: listGroup ?? "", onChange: (v: string) => set({ group: v || null }), options: groupOptions }] : []),
          // PAR1: on a computer the list sorts from its column headers; a phone has no headers, so Sort sits with the filters.
          ...(view === "list" ? [{ key: "sort", label: tr("tasks.sort"), value: sortValue(listSort), onChange: (v: string) => set(parseSortValue(v)), options: PHONE_SORTS.map((o) => ({ ...o, label: tl("tasksort", o.label) })) }] : []),
        ]} />
        {/* R79: light toolbar controls that say their setting; colour only when a filter is on. */}
        <ChipSelect label={tr("common.assignee")} aria-label={tr("tasks.assignee_filter")} active={!!filters.assignee} value={filters.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || null })} className="max-sm:hidden">
          <option value="">{tr("tasks.anyone")}</option><option value="me">{tr("tasks.me")}</option><option value="none">{tr("tasks.nobody")}</option>
          {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{isAgentLike(p) ? " (agent)" : ""}</option>)}
        </ChipSelect>
        <ChipSelect label={tr("common.status")} aria-label={tr("tasks.status_filter")} active={!!filters.status} value={filters.status ?? ""} onChange={(e) => set({ status: e.target.value || null })} className="max-sm:hidden">
          <option value="">{tr("tasks.any")}</option><option value="todo">{tr("tasks.to_do")}</option><option value="doing">{tr("tasks.doing")}</option><option value="done">{tr("common.done")}</option>
        </ChipSelect>
        {(tagList.data?.length ?? 0) > 0 && (
          <ChipSelect label={tr("tasks.tag")} aria-label={tr("tasks.tag_filter")} active={!!filters.label} value={filters.label ?? ""} onChange={(e) => set({ label: e.target.value || null })} className="max-sm:hidden">
            <option value="">{tr("tasks.any")}</option>
            {tagList.data!.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </ChipSelect>
        )}
        {view === "list" && (
          <ChipSelect label={tr("tasks.group")} aria-label={tr("tasks.group_list_by")} data-testid="list-group-select" active={!!listGroup} value={listGroup ?? ""} onChange={(e) => set({ group: e.target.value || null })} className="max-sm:hidden">
            {groupOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </ChipSelect>
        )}
        {/* R75: the filters people reach for less often sit in one Filters panel, so the toolbar stays one row. */}
        <div className="max-sm:hidden">
          <Popover label={tr("tasks.more_filters")} testId="tasks-more-filters" className="w-[22rem]" button={({ open }) => (
            <span className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors", open || moreFilterCount ? "bg-brand-soft text-brand-hover" : "text-muted hover:bg-hover hover:text-fg")}>
              <IconSliders className="h-3.5 w-3.5" />{tr("tasks.filters")}{moreFilterCount ? <span className="ml-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[11px] font-semibold text-white">{moreFilterCount}</span> : null}
            