/**
 * R38 dashboards: the add widget picker (a searchable, grouped sheet with a drawn preview per type, arrow keys to
 * move and Enter to pick, then the settings for that type), the per widget chips (date range and where the tasks
 * come from), and the bodies of the seven R38 types: calculation, battery, pivot, created vs completed, task list,
 * time tracked and note. Teardown: files/teardowns/rea/clickup/dashboard-widgets-r38.md.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  IconArrowDown, IconArrowUp, IconBack, IconCalendarRange, IconFilter, IconFlag, IconProject, IconSearch, IconStickyNote, IconTimer,
} from "@/web/components/ui/icon";
import { SmallNoResultsArt } from "@/web/components/illustrations";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { cn } from "@/web/lib/cn";
import { useProjects, useViews } from "./data";

export type WidgetType = "count" | "breakdown" | "due" | "completed" | "burndown" | "goals" | "reply_times" | "mail_volume" | "workload"
  | "calculation" | "battery" | "pivot" | "created_completed" | "task_list" | "time_tracked" | "note" | "question";
export type Chart = "number" | "bar" | "donut" | "line" | "table";
export type Range = "7d" | "30d" | "90d" | "180d";
export interface Source { savedViewId?: string; projectId?: string; filters?: Record<string, string>; mailboxId?: string }
export interface WidgetSettings { range?: Range; metric?: "done" | "created" | "points" | "hours"; op?: "sum" | "avg"; goal?: number | null; columnBy?: string; sort?: "due" | "priority" | "updated"; text?: string }
export interface WidgetShape extends WidgetSettings { id: string; type: WidgetType; title: string; source: Source; groupBy: string | null; chart: Chart; size: 1 | 2; position: number }

const BRAND = "#0071E3";
const GREEN = "#34C759";
const axis = { stroke: "var(--color-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { contentStyle: { background: "var(--color-elevated)", border: "1px solid var(--color-line)", borderRadius: 10, fontSize: 12, color: "var(--color-fg)", boxShadow: "var(--shadow-pop)" }, labelStyle: { color: "var(--color-fg)" }, itemStyle: { color: "var(--color-fg)" }, cursor: { fill: "var(--color-fill)" } } as const;
const shortDay = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
export const RANGE_LABEL: Record<Range, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "180d": "Last 180 days" };
export const RANGE_TYPES: WidgetType[] = ["calculation", "created_completed", "time_tracked"];
const AXES: [string, string][] = [["status", "Status"], ["assignee", "Person"], ["priority", "Priority"], ["project", "Project"], ["type", "Type"]];
const GROUPS: [string, string][] = [["status", "Status"], ["assignee", "Person"], ["priority", "Priority"], ["project", "Project"], ["sprint", "Sprint"], ["type", "Type"], ["label", "Label"]];

// ---------------------------------------------------------------- the catalog

interface Choice { type: WidgetType; label: string; desc: string; group: string; charts: Chart[]; fresh?: boolean; keywords: string }
export const CATALOG: Choice[] = [
  { type: "count", label: "Task count", desc: "One number, open and done", group: "Numbers", charts: ["number"], keywords: "number total kpi" },
  { type: "calculation", label: "Calculation", desc: "Sum or average with a goal and trend", group: "Numbers", charts: ["number"], fresh: true, keywords: "sum average points hours goal trend metric kpi" },
  { type: "battery", label: "Battery", desc: "Done, in progress and to do as one bar", group: "Numbers", charts: ["bar"], fresh: true, keywords: "percent complete status progress" },
  { type: "breakdown", label: "Tasks grouped by", desc: "Bars, donut or list by any field", group: "Charts", charts: ["bar", "donut", "table"], keywords: "pie bar status person priority label" },
  { type: "pivot", label: "Pivot table", desc: "Counts by one field across another", group: "Charts", charts: ["table"], fresh: true, keywords: "two way matrix cross table grid" },
  { type: "created_completed", label: "Created vs completed", desc: "New work against finished work", group: "Charts", charts: ["bar"], fresh: true, keywords: "resolved over time flow trend" },
  { type: "completed", label: "Completed per week", desc: "Work done over 8 weeks", group: "Charts", charts: ["line", "bar"], keywords: "velocity throughput" },
  { type: "burndown", label: "Sprint burndown", desc: "The active sprint's remaining work", group: "Charts", charts: ["line"], keywords: "sprint scrum" },
  { type: "workload", label: "Workload per person", desc: "Who has how much over 4 weeks", group: "Charts", charts: ["bar", "table"], keywords: "capacity people" },
  { type: "task_list", label: "Task list", desc: "Tasks from a view, project or filter", group: "Lists", charts: ["table"], fresh: true, keywords: "list filter results table tasks" },
  { type: "due", label: "Due this week and overdue", desc: "What needs attention now", group: "Lists", charts: ["table"], keywords: "deadline late overdue" },
  { type: "goals", label: "Goal progress", desc: "Every goal with its progress", group: "Lists", charts: ["table"], keywords: "okr objectives" },
  { type: "time_tracked", label: "Time tracked", desc: "Hours per day and the top people", group: "Time and mail", charts: ["bar"], fresh: true, keywords: "timesheet hours timer" },
  { type: "mail_volume", label: "Mail per day", desc: "Received and sent, 14 days", group: "Time and mail", charts: ["line", "bar"], keywords: "email volume" },
  { type: "reply_times", label: "Reply times", desc: "First reply and resolution", group: "Time and mail", charts: ["table"], keywords: "email response sla" },
  { type: "note", label: "Note", desc: "A short text for the team", group: "Text", charts: ["table"], fresh: true, keywords: "text heading message intro" },
];
const GROUP_ORDER = ["Numbers", "Charts", "Lists", "Time and mail", "Text"];

/** A small drawing of each widget type, in the brand colour so it reads in light and dark. */
export function PreviewArt({ type }: { type: WidgetType }) {
  const C = "currentColor";
  const body: Record<WidgetType, ReactNode> = {
    count: <><rect x="14" y="12" width="36" height="14" rx="3" fill={C} opacity="0.85" /><rect x="20" y="30" width="24" height="4" rx="2" fill={C} opacity="0.3" /></>,
    calculation: <><circle cx="20" cy="22" r="10" fill="none" stroke={C} strokeOpacity="0.2" strokeWidth="4" /><path d="M20 12a10 10 0 0 1 9.5 13" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" /><rect x="36" y="14" width="18" height="8" rx="2" fill={C} opacity="0.85" /><path d="M37 30l5-4 4 3 6-5" fill="none" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></>,
    battery: <><rect x="6" y="15" width="52" height="12" rx="6" fill={C} opacity="0.12" /><rect x="6" y="15" width="24" height="12" rx="6" fill={GREEN} /><rect x="28" y="15" width="12" height="12" fill={C} opacity="0.85" /></>,
    breakdown: <>{[10, 22, 34, 46].map((x, i) => <rect key={x} x={x} y={34 - [18, 26, 12, 20][i]} width="8" height={[18, 26, 12, 20][i]} rx="2" fill={C} opacity={0.4 + i * 0.15} />)}</>,
    pivot: <>{[0, 1, 2].map((r) => [0, 1, 2, 3].map((k) => <rect key={`${r}${k}`} x={8 + k * 12} y={8 + r * 10} width="10" height="8" rx="2" fill={C} opacity={[0.15, 0.6, 0.3, 0.9, 0.45, 0.2][(r * 4 + k) % 6]} />))}</>,
    created_completed: <>{[8, 22, 36, 50].map((x, i) => <g key={x}><rect x={x} y={34 - [14, 22, 18, 26][i]} width="5" height={[14, 22, 18, 26][i]} rx="1.5" fill={C} opacity="0.85" /><rect x={x + 6} y={34 - [10, 16, 20, 18][i]} width="5" height={[10, 16, 20, 18][i]} rx="1.5" fill={GREEN} /></g>)}</>,
    completed: <path d="M6 30l12-8 10 4 12-14 18 6" fill="none" stroke={C} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />,
    burndown: <><path d="M6 8l52 26" stroke={C} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="3 3" /><path d="M6 8l14 6 8 0 12 12 18 6" fill="none" stroke={C} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></>,
    workload: <>{[0, 1, 2].map((i) => <rect key={i} x="8" y={9 + i * 9} width={[40, 26, 48][i]} height="6" rx="3" fill={C} opacity={0.5 + i * 0.2} />)}</>,
    task_list: <>{[0, 1, 2].map((i) => <g key={i}><circle cx="11" cy={11 + i * 9} r="3" fill={i ? C : GREEN} opacity={i ? 0.5 : 1} /><rect x="18" y={9 + i * 9} width={[34, 26, 30][i]} height="4" rx="2" fill={C} opacity="0.6" /></g>)}</>,
    due: <>{[0, 1, 2].map((i) => <g key={i}><rect x="8" y={9 + i * 9} width="30" height="4" rx="2" fill={C} opacity="0.6" /><rect x="44" y={9 + i * 9} width="12" height="4" rx="2" fill={i ? C : "#FF9F0A"} opacity={i ? 0.3 : 1} /></g>)}</>,
    goals: <>{[0, 1].map((i) => <g key={i}><rect x="8" y={12 + i * 12} width="48" height="5" rx="2.5" fill={C} opacity="0.15" /><rect x="8" y={12 + i * 12} width={[34, 22][i]} height="5" rx="2.5" fill={C} /></g>)}</>,
    time_tracked: <>{[8, 18, 28, 38, 48].map((x, i) => <rect key={x} x={x} y={34 - [10, 20, 16, 24, 8][i]} width="7" height={[10, 20, 16, 24, 8][i]} rx="2" fill={C} opacity="0.75" />)}</>,
    mail_volume: <><path d="M6 28l10-10 10 6 12-12 20 10" fill="none" stroke={C} strokeWidth="3" strokeLinecap="round" /><path d="M6 32l14-4 12 2 26-6" fill="none" stroke={C} strokeOpacity="0.35" strokeWidth="2.5" strokeLinecap="round" /></>,
    reply_times: <>{[0, 1, 2].map((i) => <g key={i}><rect x="8" y={9 + i * 9} width="24" height="4" rx="2" fill={C} opacity="0.6" /><rect x="42" y={9 + i * 9} width="14" height="4" rx="2" fill={C} opacity="0.3" /></g>)}</>,
    note: <><rect x="10" y="7" width="44" height="28" rx="5" fill={C} opacity="0.12" /><rect x="16" y="13" width="28" height="3.5" rx="1.75" fill={C} /><rect x="16" y="20" width="32" height="3" rx="1.5" fill={C} opacity="0.45" /><rect x="16" y="26" width="22" height="3" rx="1.5" fill={C} opacity="0.45" /></>,
  };
  return <svg width="64" height="42" viewBox="0 0 64 42" aria-hidden className="text-brand">{body[type]}</svg>;
}

// ---------------------------------------------------------------- the picker

export function AddWidgetSheet({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (w: Partial<WidgetShape> & { type: WidgetType }) => void }) {
  const [picked, setPicked] = useState<WidgetType | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { if (open) { setPicked(null); setQ(""); } }, [open]);
  const choice = CATALOG.find((c) => c.type === picked);
  return (
    <Dialog open={open} onClose={onClose} title={choice ? choice.label : "Add widget"} className="sm:max-w-3xl"
      description={choice ? choice.desc : "Pick a widget. Arrow keys move, Enter picks."}>
      <div data-testid="widget-picker">
        {choice ? <WidgetSettingsForm choice={choice} onBack={() => setPicked(null)} onAdd={onAdd} /> : <PickerGrid q={q} setQ={setQ} onPick={setPicked} />}
      </div>
    </Dialog>
  );
}

function PickerGrid({ q, setQ, onPick }: { q: string; setQ: (s: string) => void; onPick: (t: WidgetType) => void }) {
  const grid = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? CATALOG.filter((c) => `${c.label} ${c.desc} ${c.keywords} ${c.group}`.toLowerCase().includes(s)) : CATALOG;
  }, [q]);
  const tiles = () => [...(grid.current?.querySelectorAll<HTMLButtonElement>("[data-tile]") ?? [])];
  const onKey = (e: KeyboardEvent) => {
    const list = tiles();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const cols = window.matchMedia("(min-width: 640px)").matches ? 3 : 2;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!step) return;
    e.preventDefault();
    if (i < 0) { list[0]?.focus(); return; }
    list[Math.max(0, Math.min(list.length - 1, i + step))]?.focus();
  };
  return (
    <div onKeyDown={onKey}>
      <label className="relative block">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input autoFocus aria-label="Search widgets" data-testid="picker-search" placeholder="Search widgets" value={q} className="pl-9"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { e.preventDefault(); onPick(shown[0].type); } }} />
      </label>
      <div ref={grid} className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pb-1 max-sm:max-h-[64vh]">
        {!shown.length && <div className="py-8 text-center"><SmallNoResultsArt /><p className="mt-2 text-[13px] text-muted">No widget matches "{q}".</p></div>}
        {GROUP_ORDER.map((g) => {
          const items = shown.filter((c) => c.group === g);
          if (!items.length) return null;
          return (
            <section key={g} aria-label={g}>
              <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-subtle">{g}</h3>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {items.map((c) => (
                  <button key={c.type} type="button" data-tile data-testid={`picker-tile-${c.type}`} aria-label={c.label} onClick={() => onPick(c.type)}
                    className="group relative flex flex-col items-start gap-2 rounded-[var(--radius-r14)] border border-line bg-surface p-3 text-left transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-px hover:border-brand/40 hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none motion-reduce:hover:translate-y-0">
                    <span className="grid h-[52px] w-full place-items-center rounded-[10px] bg-fill"><PreviewArt type={c.type} /></span>
                    <span className="flex w-full items-center gap-1.5"><span className="truncate text-[13px] font-semibold">{c.label}</span>
                      {c.fresh && <span className="ml-auto rounded-full bg-brand-soft px-1.5 py-px text-[10.5px] font-semibold text-brand">New</span>}</span>
                    <span className="line-clamp-2 text-[12px] leading-snug text-muted">{c.desc}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WidgetSettingsForm({ choice, onBack, onAdd }: { choice: Choice; onBack: () => void; onAdd: (w: Partial<WidgetShape> & { type: WidgetType }) => void }) {
  const views = useViews();
  const projects = useProjects();
  const type = choice.type;
  const [groupBy, setGroupBy] = useState(type === "pivot" ? "assignee" : "status");
  const [columnBy, setColumnBy] = useState("status");
  const [source, setSource] = useState("");
  const [chart, setChart] = useState<Chart>(choice.charts[0]);
  const [title, setTitle] = useState("");
  const [range, setRange] = useState<Range>("30d");
  const [metric, setMetric] = useState<NonNullable<WidgetSettings["metric"]>>("done");
  const [op, setOp] = useState<"sum" | "avg">("sum");
  const [goal, setGoal] = useState("");
  const [sort, setSort] = useState<NonNullable<WidgetSettings["sort"]>>("due");
  const [text, setText] = useState("");
  const [wide, setWide] = useState(["pivot", "created_completed", "time_tracked", "completed", "workload"].includes(type));
  const needsProject = type === "burndown";
  const taskSource = !["goals", "reply_times", "mail_volume", "note"].includes(type);
  const src: Source = source.startsWith("view:") ? { savedViewId: source.slice(5) } : source.startsWith("project:") ? { projectId: source.slice(8) } : {};
  const ok = (!needsProject || !!src.projectId || !!src.savedViewId) && (type !== "note" || !!text.trim()) && (type !== "pivot" || groupBy !== columnBy);
  const submit = () => {
    if (!ok) return;
    const g = Number(goal);
    onAdd({
      type, chart, source: src, title: title.trim() || undefined, size: wide ? 2 : 1,
      groupBy: type === "breakdown" || type === "pivot" ? groupBy : null,
      ...(type === "pivot" ? { columnBy } : {}),
      ...(RANGE_TYPES.includes(type) ? { range } : {}),
      ...(type === "calculation" ? { metric, op, goal: goal.trim() && Number.isFinite(g) && g > 0 ? g : null } : {}),
      ...(type === "task_list" ? { sort } : {}),
      ...(type === "note" ? { text: text.trim() } : {}),
    } as never);
  };
  return (
    <div>
      <div className="mb-4 flex items-center gap-3 rounded-[var(--radius-r14)] bg-fill p-2.5">
        <span className="grid h-[52px] w-[76px] shrink-0 place-items-center rounded-[10px] bg-surface"><PreviewArt type={type} /></span>
        <p className="text-[13px] text-muted">{choice.desc}</p>
      </div>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {type === "note" && <Field label="Text">{(f) => <textarea {...f} autoFocus maxLength={2000} rows={4} value={text} onChange={(e) => setText(e.target.value)}
          className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" />}</Field>}
        {type === "calculation" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Measure">{(f) => <Select {...f} value={metric} onChange={(e) => setMetric(e.target.value as never)}><option value="done">Tasks done</option><option value="created">Tasks created</option><option value="points">Points done</option><option value="hours">Hours tracked</option></Select>}</Field>
            <Field label="Show">{(f) => <Select {...f} value={op} onChange={(e) => setOp(e.target.value as never)}><option value="sum">Total</option><option value="avg">Average per day</option></Select>}</Field>
            <Field label="Goal" hint="Optional. Shows a ring with progress.">{(f) => <Input {...f} inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="None" />}</Field>
          </div>
        )}
        {RANGE_TYPES.includes(type) && <Field label="Date range">{(f) => <Select {...f} value={range} onChange={(e) => setRange(e.target.value as Range)}>{(Object.keys(RANGE_LABEL) as Range[]).map((r) => <option key={r} value={r}>{RANGE_LABEL[r]}</option>)}</Select>}</Field>}
        {type === "breakdown" && <Field label="Group by">{(f) => <Select {...f} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>}
        {type === "pivot" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rows">{(f) => <Select {...f} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{AXES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
            <Field label="Columns" hint={groupBy === columnBy ? "Pick a different field from the rows." : undefined}>{(f) => <Select {...f} value={columnBy} onChange={(e) => setColumnBy(e.target.value)}>{AXES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          </div>
        )}
        {type === "task_list" && <Field label="Sort by">{(f) => <Select {...f} value={sort} onChange={(e) => setSort(e.target.value as never)}><option value="due">Due date</option><option value="priority">Priority</option><option value="updated">Last changed</option></Select>}</Field>}
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
        <div className="-mx-6 -mb-5 flex items-center justify-between gap-2 border-t border-line px-6 py-4">
          <Button type="button" variant="secondary" onClick={onBack}><IconBack className="h-4 w-4" />All widgets</Button>
          <Button type="submit" disabled={!ok}>Add widget</Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- chips on a card

const FILTER_LABEL: Record<string, string> = { assignee: "Person", status: "Status", priority: "Priority", label: "Label", type: "Type", q: "Search", due: "Due" };
const FILTER_VALUE: Record<string, string> = { todo: "To do", doing: "In progress", done: "Done", overdue: "Overdue", week: "This week", none: "None", me: "Me" };

export function WidgetChips({ w, onChange }: { w: WidgetShape; onChange: (patch: Partial<WidgetShape>) => void }) {
  const projects = useProjects();
  const views = useViews();
  const chips: { key: string; icon: ReactNode; label: string }[] = [];
  if (w.source.savedViewId) chips.push({ key: "view", icon: <IconFilter className="h-3 w-3" />, label: views.data?.find((v) => v.id === w.source.savedViewId)?.name ?? "Saved view" });
  if (w.source.projectId) chips.push({ key: "project", icon: <IconProject className="h-3 w-3" />, label: projects.data?.find((p) => p.id === w.source.projectId)?.name ?? "Project" });
  for (const [k, v] of Object.entries(w.source.filters ?? {})) if (v) chips.push({ key: k, icon: <IconFilter className="h-3 w-3" />, label: `${FILTER_LABEL[k] ?? k}: ${FILTER_VALUE[v] ?? (k === "assignee" ? "Someone" : v)}` });
  const hasRange = RANGE_TYPES.includes(w.type);
  if (!hasRange && !chips.length) return null;
  const chip = "inline-flex h-6 items-center gap-1 rounded-full bg-fill px-2 text-[11.5px] text-muted";
  return (
    <div className="-mt-1.5 mb-3 flex flex-wrap items-center gap-1.5" data-testid="widget-chips">
      {hasRange && (
        <Menu trigger={<button type="button" className={cn(chip, "transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand")} aria-label={`Date range for ${w.title}: ${RANGE_LABEL[w.range ?? "30d"]}`} data-testid="range-chip">
          <IconCalendarRange className="h-3 w-3" />{RANGE_LABEL[w.range ?? "30d"]}</button>}>
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => <MenuItem key={r} onSelect={() => onChange({ range: r })}>{RANGE_LABEL[r]}</MenuItem>)}
        </Menu>
      )}
      {chips.map((c) => <span key={c.key} className={chip}>{c.icon}<span className="max-w-[10rem] truncate">{c.label}</span></span>)}
    </div>
  );
}

// ---------------------------------------------------------------- bodies

export function WidgetEmpty({ text }: { text: string }) {
  return <div className="py-8 text-center"><SmallNoResultsArt /><p className="mt-2 text-[13px] text-muted">{text}</p></div>;
}
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const per = (r?: string) => RANGE_LABEL[(r as Range) ?? "30d"].toLowerCase();

function Trend({ change, previous }: { change: number | null; previous: number }) {
  if (change === null) return <span className="text-[12px] text-subtle" data-testid="widget-trend">Nothing in the period before</span>;
  const up = change > 0, flat = change === 0;
  return (
    <span data-testid="widget-trend" className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium", flat ? "bg-fill text-muted" : up ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn")}>
      {!flat && (up ? <IconArrowUp className="h-3 w-3" /> : <IconArrowDown className="h-3 w-3" />)}{flat ? "Same" : `${Math.abs(change)}%`}<span className="font-normal opacity-80">vs {fmt(previous)} before</span>
    </span>
  );
}

function Ring({ progress }: { progress: number }) {
  const r = 26, len = 2 * Math.PI * r;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" className="shrink-0 -rotate-90 text-brand" role="img" aria-label={`${progress}% of the goal`}>
      <circle cx="34" cy="34" r={r} fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke={progress >= 100 ? GREEN : "currentColor"} strokeWidth="7" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - progress / 100)}
        className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none" />
      <text x="34" y="38" textAnchor="middle" className="rotate-90 fill-fg text-[12px] font-semibold" style={{ transformOrigin: "34px 34px" }}>{progress}%</text>
    </svg>
  );
}

const STATUS_DOT: Record<string, string> = { todo: "#8E8E93", doing: BRAND, done: GREEN };
const UNIT: Record<string, string> = { tasks: "tasks", points: "points", hours: "hours" };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function R38WidgetBody({ w, data }: { w: WidgetShape; data: any }): ReactNode {
  const d = data;
  switch (w.type) {
    case "calculation":
      return (
        <div className="flex items-center gap-5 py-2">
          {d.progress != null && <Ring progress={d.progress} />}
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5"><span className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="widget-number">{fmt(d.value)}</span>
              <span className="text-[13px] text-muted">{UNIT[d.unit]}{d.op === "avg" ? " a day" : ""}</span></div>
            <div className="mt-0.5 text-[12px] text-subtle">{per(d.range)}{d.goal ? `, goal ${fmt(d.goal)}` : ""}</div>
            <div className="mt-2"><Trend change={d.change} previous={d.previous} /></div>
          </div>
        </div>
      );
    case "battery": {
      if (!d.total) return <WidgetEmpty text="No tasks match this widget yet." />;
      return (
        <div className="py-1">
          <div className="flex items-baseline gap-2"><span className="text-3xl font-semibold tabular-nums" data-testid="widget-number">{d.donePercent}%</span><span className="text-[13px] text-muted">done, {d.done} of {d.total}</span></div>
          <div className="mt-3 flex h-3.5 overflow-hidden rounded-full bg-fill" data-testid="battery-bar" role="img" aria-label={d.segments.map((s: any) => `${s.label} ${s.count}`).join(", ")}>
            {d.segments.map((s: any) => s.count > 0 && <div key={s.key} style={{ width: `${(s.count / d.total) * 100}%`, background: s.color }} className="h-full transition-[width] duration-200 ease-out first:rounded-l-full last:rounded-r-full motion-reduce:transition-none" />)}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">{d.segments.map((s: any) => <li key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.label}<span className="tabular-nums text-muted">{s.count}</span></li>)}</ul>
        </div>
      );
    }
    case "pivot": {
      if (!d.total) return <WidgetEmpty text="No tasks match this widget yet." />;
      const max = Math.max(1, ...d.rows.flatMap((r: any) => Object.values(r.cells) as number[]));
      return (
        <div className="-mx-1 overflow-x-auto" data-testid="pivot-table">
          <table className="w-full border-separate border-spacing-0 text-[12.5px]">
            <thead><tr><th className="sticky left-0 bg-surface px-2 py-1.5 text-left font-medium text-subtle" scope="col"><span className="sr-only">Rows</span></th>
              {d.columns.map((c: any) => <th key={c.key} scope="col" className="whitespace-nowrap px-2 py-1.5 text-right font-medium text-muted">{c.label}</th>)}
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Total</th></tr></thead>
            <tbody>{d.rows.map((r: any) => (
              <tr key={r.key} className="group">
                <th scope="row" className="sticky left-0 max-w-[11rem] truncate bg-surface px-2 py-1.5 text-left font-normal" title={r.label}>{r.label}</th>
                {d.columns.map((c: any) => { const n = r.cells[c.key] ?? 0; return (
                  <td key={c.key} className="px-0.5 py-0.5 text-right tabular-nums">
                    <span className={cn("block rounded-md px-1.5 py-1", !n && "text-subtle")} style={n ? { background: `rgb(0 113 227 / ${0.08 + 0.42 * (n / max)})` } : undefined}>{n || "0"}</span>
                  </td>
                ); })}
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{r.total}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th scope="row" className="sticky left-0 border-t border-line bg-surface px-2 py-1.5 text-left font-semibold">Total</th>
              {d.columns.map((c: any) => <td key={c.key} className="border-t border-line px-2 py-1.5 text-right font-semibold tabular-nums">{c.total}</td>)}
              <td className="border-t border-line px-2 py-1.5 text-right font-semibold tabular-nums" data-testid="pivot-total">{d.total}</td></tr></tfoot>
          </table>
        </div>
      );
    }
    case "created_completed": {
      if (!d.created && !d.completed) return <WidgetEmpty text={`Nothing created or completed in the ${per(d.range)}.`} />;
      const rows = d.points.map((p: any) => ({ ...p, label: shortDay(p.start) }));
      return (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[12.5px]">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BRAND }} />Created <b className="tabular-nums">{d.created}</b></span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: GREEN }} />Completed <b className="tabular-nums">{d.completed}</b></span>
            <span data-testid="net-chip" className={cn("ml-auto rounded-full px-2 py-0.5 font-medium", d.net > 0 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>{d.net > 0 ? `Backlog grew by ${d.net}` : d.net < 0 ? `Backlog shrank by ${-d.net}` : "Backlog held steady"}</span>
          </div>
          <div className="h-52"><ResponsiveContainer><BarChart data={rows} margin={{ left: -20, right: 8 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--color-line)" /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} />
            <Bar dataKey="created" name="Created" fill={BRAND} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            <Bar dataKey="completed" name="Completed" fill={GREEN} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart></ResponsiveContainer></div>
        </div>
      );
    }
    case "task_list": {
      if (!d.tasks.length) return <WidgetEmpty text="No tasks match this widget yet." />;
      return (
        <div>
          <ul className="divide-y divide-line text-[13px]" data-testid="task-list">{d.tasks.map((t: any) => (
            <li key={t.id}><Link to={`/app/tasks?view=list&task=${t.id}`} className="flex items-center gap-2 rounded-md py-2 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_DOT[t.status] }} aria-label={t.status === "done" ? "Done" : t.status === "doing" ? "In progress" : "To do"} />
              <span className="font-mono text-[12px] text-subtle">{t.ref}</span>
              <span className={cn("line-clamp-2 [overflow-wrap:anywhere]", t.status === "done" && "text-muted line-through")} title={t.title}>{t.title}</span>
              {(t.priority === "urgent" || t.priority === "high") && <IconFlag className={cn("h-3.5 w-3.5 shrink-0", t.priority === "urgent" ? "text-bad" : "text-warn")} aria-label={t.priority === "urgent" ? "Urgent" : "High priority"} />}
              <span className={cn("ml-auto shrink-0 text-[12px]", t.overdue ? "text-warn" : "text-muted")}>{t.due ? new Date(t.due).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : t.assignee ?? ""}</span>
            </Link></li>
          ))}</ul>
          {d.total > d.tasks.length && <p className="pt-2 text-[12px] text-subtle">{d.total - d.tasks.length} more</p>}
        </div>
      );
    }
    case "time_tracked": {
      if (!d.hours) return <WidgetEmpty text={`No time tracked in the ${per(d.range)}.`} />;
      const rows = d.points.map((p: any) => ({ ...p, label: shortDay(p.start) }));
      return (
        <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
          <div>
            <div className="mb-1 flex items-baseline gap-1.5"><IconTimer className="h-4 w-4 self-center text-brand" /><span className="text-2xl font-semibold tabular-nums" data-testid="widget-number">{fmt(d.hours)}</span><span className="text-[13px] text-muted">hours</span></div>
            <div className="h-44"><ResponsiveContainer><BarChart data={rows} margin={{ left: -20, right: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--color-line)" /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} /><Tooltip {...tip} />
              <Bar dataKey="hours" name="Hours" fill={BRAND} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart></ResponsiveContainer></div>
          </div>
          <ul className="space-y-2 self-center text-[12.5px]">{d.people.map((p: any) => (
            <li key={p.key}><div className="flex justify-between gap-2"><span className="truncate" title={p.name}>{p.name}</span><span className="tabular-nums text-muted">{fmt(p.hours)} h</span></div>
              <div className="mt-1 h-1.5 rounded-full bg-fill"><div className="h-full rounded-full" style={{ width: `${(p.hours / d.people[0].hours) * 100}%`, background: BRAND }} /></div></li>
          ))}</ul>
        </div>
      );
    }
    case "note":
      return d.text ? <div className="flex gap-2.5 rounded-xl bg-brand-soft/60 px-4 py-3" data-testid="widget-note"><IconStickyNote className="mt-0.5 h-4 w-4 shrink-0 text-brand" /><p className="whitespace-pre-wrap text-[14px] leading-relaxed">{d.text}</p></div>
        : <WidgetEmpty text="Nothing written yet." />;
    default:
      return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
export const isR38 = (t: WidgetType) => ["calculation", "battery", "pivot", "created_completed", "task_list", "time_tracked", "note"].includes(t);
export const SKELETON_H: Partial<Record<WidgetType, string>> = { calculation: "h-24", battery: "h-20", note: "h-16", count: "h-24" };
