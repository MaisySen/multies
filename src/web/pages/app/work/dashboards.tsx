/**
 * R24.3 Dashboards: a list, and a dashboard as a grid of widget cards (counts, bar, donut and line
 * charts, task lists). Drag a card by its handle to reorder; the order, the name, sharing and the
 * widgets are saved together in one write. Every widget's data comes from one request,
 * GET /api/dashboards/:id/data, computed when it is read. Charts reuse the Reports page's recharts.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDown, ArrowUp, ChevronLeft, GripVertical, LayoutDashboard, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Users, X } from "lucide-react";
import { moveWidget } from "./dashboard-move";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { useProjects, useViews } from "./data";

type WidgetType = "count" | "breakdown" | "due" | "completed" | "burndown" | "goals" | "reply_times" | "mail_volume" | "workload";
type Chart = "number" | "bar" | "donut" | "line" | "table";
interface Source { savedViewId?: string; projectId?: string; filters?: Record<string, string>; mailboxId?: string }
export interface Widget { id: string; type: WidgetType; title: string; source: Source; groupBy: string | null; chart: Chart; size: 1 | 2; position: number }
export interface DashboardDoc { id: string; name: string; shared: boolean; mine: boolean; widgets: Widget[]; version: number; updatedAt: string }
interface DashboardRow { id: string; name: string; shared: boolean; mine: boolean; widgetCount: number; updatedAt: string }
interface DataResp { dashboard: DashboardDoc; timeZone: string; weekStart: string; widgets: { id: string; type: WidgetType; data: unknown; error: string | null }[] }

const BRAND = "#0071E3";
const GREYS = ["#0071E3", "#5AC8FA", "#34C759", "#FF9F0A", "#AF52DE", "#FF375F", "#8E8E93", "#64D2FF", "#30B0C7", "#A2845E"];
const axis = { stroke: "var(--color-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { contentStyle: { background: "var(--color-elevated)", border: "1px solid var(--color-line)", borderRadius: 10, fontSize: 12, color: "var(--color-fg)", boxShadow: "var(--shadow-pop)" }, labelStyle: { color: "var(--color-fg)" }, itemStyle: { color: "var(--color-fg)" }, cursor: { fill: "var(--color-fill)" } } as const;
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const shortDay = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const hours = (ms: number | null) => (ms == null ? "No replies yet" : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export const WIDGET_CHOICES: { type: WidgetType; label: string; charts: Chart[] }[] = [
  { type: "count", label: "Task count", charts: ["number"] },
  { type: "breakdown", label: "Tasks grouped by", charts: ["bar", "donut", "table"] },
  { type: "due", label: "Due this week and overdue", charts: ["table"] },
  { type: "completed", label: "Completed per week", charts: ["line", "bar"] },
  { type: "burndown", label: "Sprint burndown", charts: ["line"] },
  { type: "goals", label: "Goal progress", charts: ["table"] },
  { type: "reply_times", label: "Reply times", charts: ["table"] },
  { type: "mail_volume", label: "Mail per day", charts: ["line", "bar"] },
  { type: "workload", label: "Workload per person", charts: ["bar", "table"] },
];
const GROUPS: [string, string][] = [["status", "Status"], ["assignee", "Person"], ["priority", "Priority"], ["project", "Project"], ["sprint", "Sprint"], ["type", "Type"], ["label", "Label"]];

const dk = { list: ["dashboards"] as const, one: (id: string) => ["dashboard", id] as const, data: (id: string) => ["dashboard-data", id] as const };

export function DashboardsPage() {
  const { id } = useParams();
  return id ? <DashboardView id={id} /> : <DashboardList />;
}

function DashboardList() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: dk.list, queryFn: async () => (await api.get<{ dashboards: DashboardRow[] }>("/dashboards")).dashboards });
  const [naming, setNaming] = useState(false);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ dashboard: DashboardDoc }>("/dashboards", body),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: dk.list }); nav(`/app/dashboards/${r.dashboard.id}`); },
    onError: (e) => showError(e as Error),
  });
  const starter = <Button variant="secondary" onClick={() => create.mutate({ starter: "team" })} disabled={create.isPending}><Sparkles className="h-4 w-4" />Team overview</Button>;
  return (
    <div data-testid="dashboards">
      <PageHeader title="Dashboards" description="Your numbers in one place: tasks by status and person, what is due, work done per week, sprints, goals and mail. Worked out fresh each time you open one."
        actions={<div className="flex gap-2">{starter}<Button onClick={() => setNaming(true)}><Plus className="h-4 w-4" />New dashboard</Button></div>} />
      {list.isPending ? <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        : !list.data?.length ? (
          <EmptyState icon={<LayoutDashboard className="h-6 w-6" />} title="No dashboards yet"
            body="Start with Team overview (tasks by status and by person, what is due this week and work done per week), or make your own from the widgets you pick."
            action={<div className="flex justify-center gap-2">{starter}<Button variant="secondary" onClick={() => setNaming(true)}>New dashboard</Button></div>} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.data.map((d) => (
              <Link key={d.id} to={`/app/dashboards/${d.id}`} data-testid="dashboard-link" className="group">
                <Card className="p-4 transition-shadow group-hover:shadow-pop">
                  <div className="flex items-center gap-2"><LayoutDashboard className="h-4 w-4 text-brand" /><span className="truncate font-medium">{d.name}</span>
                    {d.shared && <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted"><Users className="h-3.5 w-3.5" />Shared</span>}</div>
                  <p className="mt-1.5 text-[12.5px] text-muted">{d.widgetCount === 1 ? "1 widget" : `${d.widgetCount} widgets`}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      <NameDialog open={naming} title="New dashboard" initial="" onClose={() => setNaming(false)} onSave={(name) => { setNaming(false); create.mutate({ name }); }} />
    </div>
  );
}

function NameDialog({ open, title, initial, onClose, onSave }: { open: boolean; title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>Save</Button></>}>
      <Field label="Name">{(f) => <Input {...f} autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(name.trim()); }} />}</Field>
    </Dialog>
  );
}

function DashboardView({ id }: { id: string }) {
  const { confirm, dialogs } = useDialogs();
  const qc = useQueryClient();
  const nav = useNavigate();
  const tz = zone();
  const doc = useQuery({ queryKey: dk.one(id), queryFn: async () => (await api.get<{ dashboard: DashboardDoc }>(`/dashboards/${id}`)).dashboard });
  const data = useQuery({ queryKey: dk.data(id), queryFn: () => api.get<DataResp>(`/dashboards/${id}/data?tz=${encodeURIComponent(tz)}`), refetchInterval: 60_000 });
  const [order, setOrder] = useState<Widget[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setOrder(null); }, [doc.data?.version]);
  const widgets = order ?? doc.data?.widgets ?? [];
  const byId = useMemo(() => new Map((data.data?.widgets ?? []).map((w) => [w.id, w])), [data.data]);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<{ dashboard: DashboardDoc }>(`/dashboards/${id}`, patch),
    onSuccess: async (r) => {
      qc.setQueryData(dk.one(id), r.dashboard);
      await Promise.all([qc.invalidateQueries({ queryKey: dk.data(id) }), qc.invalidateQueries({ queryKey: dk.list })]);
    },
    onError: (e) => { setOrder(null); showError(e as Error); },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/dashboards/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: dk.list }); nav("/app/dashboards"); },
    onError: (e) => showError(e as Error),
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = widgets.findIndex((w) => w.id === e.active.id), to = widgets.findIndex((w) => w.id === e.over!.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(widgets, from, to);
    setOrder(next);
    save.mutate({ widgets: next });
  };
  const d = doc.data;
  if (doc.isError) return <EmptyState icon={<LayoutDashboard className="h-6 w-6" />} title="Dashboard not found" body="It was removed, or it is private to someone else." action={<Link to="/app/dashboards" className="text-brand-hover hover:underline">All dashboards</Link>} />;
  return (
    <div data-testid="dashboard-view">
      {dialogs}
      <Link to="/app/dashboards" className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg"><ChevronLeft className="h-3.5 w-3.5" />Dashboards</Link>
      <PageHeader title={d?.name ?? ""}
        actions={d && <div className="flex items-center gap-3">
          <Switch checked={d.shared} label="Shared with the workspace" disabled={!d.mine} onChange={(v) => save.mutate({ shared: v })} />
          <span className="text-[12.5px] text-muted">{d.shared ? "Shared" : "Only you"}</span>
          <Button onClick={() => setAdding(true)} disabled={widgets.length >= 24}><Plus className="h-4 w-4" />Add widget</Button>
          <Menu trigger={<Button variant="secondary" size="sm" aria-label="More"><MoreHorizontal className="h-4 w-4" /></Button>}>
            <MenuItem icon={<Pencil className="h-4 w-4" />} onSelect={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem danger icon={<Trash2 className="h-4 w-4" />} onSelect={async () => { if (await confirm({ title: `Remove the dashboard ${d.name}?`, description: "The widgets go with it; your tasks and mail stay as they are.", confirmLabel: "Remove dashboard" })) remove.mutate(); }}>Remove dashboard</MenuItem>
          </Menu>
        </div>} />
      {!d ? <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-60" />)}</div>
        : !widgets.length ? (
          <EmptyState icon={<LayoutDashboard className="h-6 w-6" />} title="No widgets yet" body="Add a widget to see a count, a chart or a list. Each one can use a saved view or a project." action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add widget</Button>} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
              <div className="grid gap-4 md:grid-cols-2" data-testid="widget-grid">
                {widgets.map((w, i) => (
                  <WidgetCard key={w.id} w={w} result={byId.get(w.id)} loading={data.isPending}
                    onMove={(dir) => { const next = moveWidget(widgets, w.id, dir); if (next === widgets) return; setOrder(next); save.mutate({ widgets: next }); }}
                    canUp={i > 0} canDown={i < widgets.length - 1}
                    onRemove={() => { const next = widgets.filter((x) => x.id !== w.id); setOrder(next); save.mutate({ widgets: next }); }} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      <AddWidgetDialog open={adding} onClose={() => setAdding(false)} onAdd={(w) => { setAdding(false); save.mutate({ widgets: [...widgets, w] }); }} />
      <NameDialog open={renaming} title="Rename dashboard" initial={d?.name ?? ""} onClose={() => setRenaming(false)} onSave={(name) => { setRenaming(false); save.mutate({ name }); }} />
    </div>
  );
}

function WidgetCard({ w, result, loading, onRemove, onMove, canUp, canDown }: { w: Widget; result?: DataResp["widgets"][number]; loading: boolean; onRemove: () => void; onMove: (dir: -1 | 1) => void; canUp: boolean; canDown: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(w.size === 2 && "md:col-span-2", isDragging && "z-10 opacity-80")}>
      <Card className="flex h-full flex-col p-4" data-testid="widget" data-title={w.title}>
        <div className="mb-3 flex items-center gap-1.5">
          <button type="button" {...attributes} {...listeners} aria-label={`Move ${w.title}`} className="-ml-1 cursor-grab rounded p-0.5 text-subtle hover:bg-hover hover:text-fg active:cursor-grabbing"><GripVertical className="h-4 w-4" /></button>
          <h2 className="truncate text-[13px] font-semibold">{w.title}</h2>
          <div className="ml-auto flex items-center">
            <Menu trigger={<button type="button" aria-label={`Options for ${w.title}`} className="rounded p-0.5 text-subtle hover:bg-hover hover:text-fg"><MoreHorizontal className="h-4 w-4" /></button>}>
              {canUp && <MenuItem icon={<ArrowUp className="h-4 w-4" />} onSelect={() => onMove(-1)}>Move up</MenuItem>}
              {canDown && <MenuItem icon={<ArrowDown className="h-4 w-4" />} onSelect={() => onMove(1)}>Move down</MenuItem>}
              <MenuItem danger icon={<Trash2 className="h-4 w-4" />} onSelect={onRemove}>Remove widget</MenuItem>
            </Menu>
            <button type="button" onClick={onRemove} aria-label={`Remove ${w.title}`} className="rounded p-0.5 text-subtle hover:bg-hover hover:text-fg"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {loading || !result ? <Skeleton className="h-40" /> : result.error ? <p className="py-10 text-center text-[13px] text-muted">{result.error}</p> : <WidgetBody w={w} data={result.data} />}
        </div>
      </Card>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <p className="py-12 text-center text-[13px] text-muted">{text}</p>;
const Big = ({ value, sub }: { value: string | number; sub?: string }) => (
  <div className="py-6 text-center"><div className="text-4xl font-semibold tabular-nums text-fg" data-testid="widget-number">{value}</div>{sub && <div className="mt-1 text-[12.5px] text-muted">{sub}</div>}</div>
);

function Bars({ rows, x, y, horizontal }: { rows: Record<string, unknown>[]; x: string; y: string; horizontal?: boolean }) {
  return horizontal ? (
    <div className="h-56"><ResponsiveContainer><BarChart data={rows} layout="vertical" margin={{ left: 8, right: 12 }}>
      <CartesianGrid horizontal={false} stroke="var(--color-line)" /><XAxis type="number" {...axis} allowDecimals={false} /><YAxis type="category" dataKey={x} {...axis} width={110} /><Tooltip {...tip} />
      <Bar dataKey={y} name="Tasks" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={26} isAnimationActive={false} />
    </BarChart></ResponsiveContainer></div>
  ) : (
    <div className="h-56"><ResponsiveContainer><BarChart data={rows} margin={{ left: -20, right: 8 }}>
      <CartesianGrid vertical={false} stroke="var(--color-line)" /><XAxis dataKey={x} {...axis} interval={0} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} />
      <Bar dataKey={y} name="Tasks" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false}>{rows.map((r, i) => <Cell key={i} fill={(r.color as string) || BRAND} />)}</Bar>
    </BarChart></ResponsiveContainer></div>
  );
}

function Donut({ rows }: { rows: { label: string; count: number; color?: string }[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="flex h-56 items-center gap-4">
      <div className="relative h-full flex-1"><ResponsiveContainer><PieChart>
        <Pie data={rows} dataKey="count" nameKey="label" innerRadius="58%" outerRadius="86%" paddingAngle={2} stroke="none" isAnimationActive={false}>{rows.map((r, i) => <Cell key={r.label} fill={r.color || GREYS[i % GREYS.length]} />)}</Pie>
        <Tooltip {...tip} />
      </PieChart></ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center"><div className="text-center"><div className="text-2xl font-semibold tabular-nums">{total}</div><div className="text-[11px] text-muted">tasks</div></div></div>
      </div>
      <ul className="w-40 space-y-1.5 text-[12.5px]">{rows.map((r, i) => <li key={r.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color || GREYS[i % GREYS.length] }} /><span className="truncate">{r.label}</span><span className="ml-auto tabular-nums text-muted">{r.count}</span></li>)}</ul>
    </div>
  );
}

function Lines({ rows, x, lines }: { rows: Record<string, unknown>[]; x: string; lines: { key: string; name: string; color: string; dash?: boolean }[] }) {
  return (
    <div className="h-56"><ResponsiveContainer><LineChart data={rows} margin={{ left: -20, right: 12, top: 6 }}>
      <CartesianGrid vertical={false} stroke="var(--color-line)" /><XAxis dataKey={x} {...axis} tickFormatter={shortDay} minTickGap={20} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} labelFormatter={(v) => shortDay(String(v))} />
      {lines.map((l) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2} strokeDasharray={l.dash ? "4 4" : undefined} dot={{ r: 2.5, strokeWidth: 0, fill: l.color }} connectNulls={false} isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer></div>
  );
}

function Table({ rows }: { rows: { label: string; value: string | number; muted?: string }[] }) {
  return <ul className="divide-y divide-line text-[13px]">{rows.map((r, i) => <li key={i} className="flex items-center gap-2 py-2"><span className="truncate">{r.label}</span>{r.muted && <span className="text-[12px] text-subtle">{r.muted}</span>}<span className="ml-auto tabular-nums text-muted">{r.value}</span></li>)}</ul>;
}

function WidgetBody({ w, data }: { w: Widget; data: unknown }) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const d = data as any;
  switch (w.type) {
    case "count": return <Big value={d.value} sub={d.value === d.open ? "all open" : `${d.open} open`} />;
    case "breakdown": {
      const rows = d.groups as { label: string; count: number; color?: string }[];
      if (!rows.length) return <Empty text="No tasks match this widget yet." />;
      if (w.chart === "donut") return <Donut rows={rows} />;
      if (w.chart === "table") return <Table rows={rows.map((r) => ({ label: r.label, value: r.count }))} />;
      return <Bars rows={rows} x="label" y="count" horizontal={w.groupBy === "assignee" || rows.length > 6} />;
    }
    case "due": {
      const list = d.tasks as { id: string; ref: string; title: string; due: string | null; overdue: boolean; assignee: string | null }[];
      return (
        <div>
          <div className="mb-2 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-fill px-3 py-2"><div className={cn("text-2xl font-semibold tabular-nums", d.overdue && "text-warn")} data-testid="due-overdue">{d.overdue}</div><div className="text-[12px] text-muted">Overdue</div></div>
            <div className="rounded-xl bg-fill px-3 py-2"><div className="text-2xl font-semibold tabular-nums" data-testid="due-week">{d.dueThisWeek}</div><div className="text-[12px] text-muted">Due this week</div></div>
          </div>
          {!list.length ? <Empty text="Nothing is due this week." /> : (
            <ul className="divide-y divide-line text-[13px]">{list.map((t) => (
              <li key={t.id}><Link to={`/app/tasks?view=list&task=${t.id}`} className="flex items-center gap-2 py-2 hover:text-fg">
                <span className="font-mono text-[12px] text-subtle">{t.ref}</span><span className="truncate">{t.title}</span>
                <span className={cn("ml-auto shrink-0 text-[12px]", t.overdue ? "text-warn" : "text-muted")}>{t.due ? new Date(t.due).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
              </Link></li>
            ))}</ul>
          )}
        </div>
      );
    }
    case "completed": {
      const rows = d.weeks as { week: string; count: number }[];
      if (!d.total) return <Empty text="Nothing completed in the last 8 weeks." />;
      return w.chart === "bar" ? <Bars rows={rows.map((r) => ({ ...r, label: shortDay(r.week) }))} x="label" y="count" /> : <Lines rows={rows} x="week" lines={[{ key: "count", name: "Completed", color: BRAND }]} />;
    }
    case "burndown": {
      if (!d.sprint) return <Empty text="No active sprint in this project." />;
      const rows = (d.burndown.days as { date: string; remaining: number | null; ideal: number }[]);
      return <div><p className="mb-1 text-[12.5px] text-muted">{d.sprint.name}: {d.burndown.remaining} of {d.burndown.scope} {d.burndown.unit} left</p><Lines rows={rows} x="date" lines={[{ key: "ideal", name: "Ideal", color: "#8E8E93", dash: true }, { key: "remaining", name: "Remaining", color: BRAND }]} /></div>;
    }
    case "goals": {
      const gs = d.goals as { id: string; name: string; progress: number }[];
      if (!gs.length) return <Empty text="No goals yet. Add them on the Goals page." />;
      return <ul className="space-y-3 text-[13px]">{gs.map((g) => <li key={g.id}><div className="flex justify-between"><span className="truncate">{g.name}</span><span className="tabular-nums text-muted">{g.progress}%</span></div><div className="mt-1 h-1.5 rounded-full bg-fill"><div className="h-full rounded-full" style={{ width: `${g.progress}%`, background: BRAND }} /></div></li>)}</ul>;
    }
    case "reply_times": {
      const rows = d.rows as { key: string; label: string | null; replied: number; medianFirstResponseMs: number | null; medianResolutionMs: number | null }[];
      if (!rows.length) return <Empty text="No new conversations in the last 30 days." />;
      return <Table rows={rows.map((r) => ({ label: r.label ?? "Nobody", value: hours(r.medianFirstResponseMs), muted: r.medianResolutionMs != null ? `resolved in ${hours(r.medianResolutionMs)}` : undefined }))} />;
    }
    case "mail_volume": {
      if (!d.received && !d.sent) return <Empty text="No mail in the last 14 days." />;
      return <Lines rows={d.days} x="day" lines={[{ key: "received", name: "Received", color: BRAND }, { key: "sent", name: "Sent", color: "#8E8E93" }]} />;
    }
    case "workload": {
      const ps = d.people as { name: string; count: number; load: number; over: boolean }[];
      if (!ps.length) return <Empty text="No open tasks with dates in the next 4 weeks." />;
      if (w.chart === "table") return <Table rows={ps.map((p) => ({ label: p.name, value: `${p.load} ${d.unit}`, muted: `${p.count} tasks` }))} />;
      return <Bars rows={ps.map((p) => ({ label: p.name, count: p.count }))} x="label" y="count" horizontal />;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function AddWidgetDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (w: Partial<Widget> & { type: WidgetType }) => void }) {
  const views = useViews();
  const projects = useProjects();
  const [type, setType] = useState<WidgetType>("breakdown");
  const [groupBy, setGroupBy] = useState("status");
  const [source, setSource] = useState("");
  const [chart, setChart] = useState<Chart>("bar");
  const [title, setTitle] = useState("");
  const [wide, setWide] = useState(false);
  const choice = WIDGET_CHOICES.find((c) => c.type === type)!;
  useEffect(() => { if (open) { setType("breakdown"); setGroupBy("status"); setSource(""); setChart("bar"); setTitle(""); setWide(false); } }, [open]);
  useEffect(() => { if (!choice.charts.includes(chart)) setChart(choice.charts[0]); }, [type, choice, chart]);
  const needsProject = type === "burndown";
  const taskSource = !["goals", "reply_times", "mail_volume"].includes(type);
  const src: Source = source.startsWith("view:") ? { savedViewId: source.slice(5) } : source.startsWith("project:") ? { projectId: source.slice(8) } : {};
  const ok = !needsProject || !!src.projectId || !!src.savedViewId;
  return (
    <Dialog open={open} onClose={onClose} title="Add widget" description="Pick what to show and where the tasks come from."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ok} onClick={() => onAdd({ type, groupBy: type === "breakdown" ? groupBy : null, chart, source: src, title: title.trim() || undefined, size: wide ? 2 : 1 } as never)}>Add</Button></>}>
      <div className="space-y-4">
        <Field label="Widget">{(f) => <Select {...f} value={type} onChange={(e) => setType(e.target.value as WidgetType)}>{WIDGET_CHOICES.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}</Select>}</Field>
        {type === "breakdown" && <Field label="Group by">{(f) => <Select {...f} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>}
        {taskSource && (
          <Field label={needsProject ? "Project" : "Tasks from"}>{(f) => (
            <Select {...f} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{needsProject ? "Pick a project" : "All tasks"}</option>
              {!!views.data?.length && !needsProject && <optgroup label="Saved views">{views.data.map((v) => <option key={v.id} value={`view:${v.id}`}>{v.name}</option>)}</optgroup>}
              <optgroup label="Projects">{(projects.data ?? []).map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}</optgroup>
            </Select>
          )}</Field>
        )}
        {choice.charts.length > 1 && <Field label="Chart">{(f) => <Select {...f} value={chart} onChange={(e) => setChart(e.target.value as Chart)}>{choice.charts.map((c) => <option key={c} value={c}>{c === "donut" ? "Donut" : c === "bar" ? "Bars" : c === "line" ? "Line" : c === "table" ? "List" : "Number"}</option>)}</Select>}</Field>}
        <Field label="Title" hint="Leave empty for a title that says what it shows.">{(f) => <Input {...f} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Switch checked={wide} onChange={setWide} label="Full width" />
      </div>
    </Dialog>
  );
}
