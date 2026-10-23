import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, CheckCircle2, CircleDot, Clock, Handshake } from "lucide-react";
import { api } from "@/web/lib/api";
import { Card, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Select } from "@/web/components/ui/input";
import { useProjects } from "./data";
import { hoursText } from "./time";

interface Dashboard {
  range: { days: number };
  tasks: {
    total: number; open: number; done: number; overdue: number; createdInRange: number; completedInRange: number;
    byStatus: { name: string; category: string; color: string; count: number }[];
    byAssignee: { assigneeId: string | null; name: string; open: number; overdue: number }[];
    overdueList: { id: string; ref: string; title: string; due: string | null; assignee: string | null; priority: string }[];
    completedByDay: { day: string; count: number }[];
  };
  time: { totalSeconds: number; byProject: { projectId: string | null; name: string; color: string; seconds: number }[] };
  deals: { currency: "AUD"; pipeline: { stage: string; name: string; count: number; value: number }[]; openValue: number; openCount: number; wonValue: number };
}

const aud = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const axis = { stroke: "#6b7079", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { contentStyle: { background: "#16181d", border: "1px solid #2a2d34", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#e6e7ea" }, cursor: { fill: "rgba(255,255,255,0.04)" } };
const STAGE_COLOR: Record<string, string> = { lead: "#8a8f98", qualified: "#3b82f6", proposal: "#f59e0b", won: "#22c55e", lost: "#ef4444" };

function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">{icon}{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-subtle">{sub}</div>}
    </Card>
  );
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return <Card className={`p-4 ${className ?? ""}`}><h2 className="mb-3 text-[13px] font-semibold">{title}</h2>{children}</Card>;
}

export function ReportsPage() {
  const [days, setDays] = useState("30");
  const [projectId, setProjectId] = useState("");
  const projects = useProjects();
  const qs = new URLSearchParams({ days, ...(projectId ? { projectId } : {}) }).toString();
  const q = useQuery({ queryKey: ["report", qs], queryFn: () => api.get<Dashboard>(`/reports/dashboard?${qs}`) });
  const d = q.data;
  return (
    <div data-testid="reports">
      <PageHeader title="Reports" description="Where the work stands: tasks by status and person, what's overdue, time per project and the deals pipeline. Values in AUD, ex GST."
        actions={<div className="flex gap-2">
          <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 w-auto text-[13px]"><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select aria-label="Range" value={days} onChange={(e) => setDays(e.target.value)} className="h-9 w-auto text-[13px]"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></Select>
        </div>} />
      {!d ? <div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi icon={<CircleDot className="h-4 w-4" />} label="Open tasks" value={String(d.tasks.open)} sub={`${d.tasks.createdInRange} new in ${d.range.days} days`} />
            <Kpi icon={<AlertTriangle className="h-4 w-4" />} label="Overdue" value={String(d.tasks.overdue)} tone={d.tasks.overdue ? "text-warn" : ""} sub={d.tasks.overdue ? "Past their due date" : "Nothing late"} />
            <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="Done" value={String(d.tasks.completedInRange)} sub={`in the last ${d.range.days} days`} />
            <Kpi icon={<Clock className="h-4 w-4" />} label="Time logged" value={hoursText(d.time.totalSeconds)} sub={`in the last ${d.range.days} days`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Tasks by status">
              <div className="h-56" data-testid="chart-status"><ResponsiveContainer><BarChart data={d.tasks.byStatus} margin={{ left: -20, right: 8 }}>
                <CartesianGrid vertical={false} stroke="#24272e" /><XAxis dataKey="name" {...axis} interval={0} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} />
                <Bar dataKey="count" name="Tasks" radius={[4, 4, 0, 0]}>{d.tasks.byStatus.map((s) => <Cell key={s.name} fill={s.color} />)}</Bar>
              </BarChart></ResponsiveContainer></div>
            </Panel>
            <Panel title="Open tasks by person">
              <div className="h-56" data-testid="chart-assignee"><ResponsiveContainer><BarChart data={d.tasks.byAssignee} layout="vertical" margin={{ left: 10, right: 8 }}>
                <CartesianGrid horizontal={false} stroke="#24272e" /><XAxis type="number" {...axis} allowDecimals={false} /><YAxis type="category" dataKey="name" {...axis} width={110} /><Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="open" name="Open" stackId="a" fill="#3b82f6" /><Bar dataKey="overdue" name="Of which overdue" fill="#f59e0b" radius={[0, 4, 4, 0]} />
              </BarChart></ResponsiveContainer></div>
            </Panel>
            <Panel title="Tasks done per day">
              <div className="h-56"><ResponsiveContainer><BarChart data={d.tasks.completedByDay} margin={{ left: -20, right: 8 }}>
                <CartesianGrid vertical={false} stroke="#24272e" /><XAxis dataKey="day" {...axis} tickFormatter={(v: string) => new Date(`${v}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} minTickGap={24} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} />
                <Bar dataKey="count" name="Done" fill="#22c55e" radius={[3, 3, 0, 0]} />
              </BarChart></ResponsiveContainer></div>
            </Panel>
            <Panel title="Time per project">
              {!d.time.byProject.length ? <p className="py-16 text-center text-[13px] text-muted">No time logged in this range.</p> : (
                <div className="flex h-56 items-center gap-4" data-testid="chart-time">
                  <div className="h-full flex-1"><ResponsiveContainer><PieChart>
                    <Pie data={d.time.byProject} dataKey="seconds" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">{d.time.byProject.map((p) => <Cell key={p.name} fill={p.color} />)}</Pie>
                    <Tooltip {...tip} formatter={(v) => hoursText(Number(v))} />
                  </PieChart></ResponsiveContainer></div>
                  <ul className="w-44 space-y-1.5 text-[12.5px]">{d.time.byProject.map((p) => <li key={p.name} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} /><span className="truncate">{p.name}</span><span className="ml-auto tabular-nums text-muted">{hoursText(p.seconds)}</span></li>)}</ul>
                </div>
              )}
            </Panel>
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <Panel title="Deals pipeline (AUD)">
              <div className="mb-2 flex gap-6 text-[12.5px] text-muted"><span>Open <b className="text-fg tabular-nums">{aud(d.deals.openValue)}</b> in {d.deals.openCount} deals</span><span>Won <b className="text-ok tabular-nums">{aud(d.deals.wonValue)}</b></span></div>
              <div className="h-52" data-testid="chart-deals"><ResponsiveContainer><BarChart data={d.deals.pipeline} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} stroke="#24272e" /><XAxis dataKey="name" {...axis} /><YAxis {...axis} tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)} /><Tooltip {...tip} formatter={(v) => aud(Number(v))} />
                <Bar dataKey="value" name="Value" radius={[4, 4, 0, 0]}>{d.deals.pipeline.map((s) => <Cell key={s.stage} fill={STAGE_COLOR[s.stage] ?? "#8a8f98"} />)}</Bar>
              </BarChart></ResponsiveContainer></div>
              <Link to="/app/deals" className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-brand-hover hover:underline"><Handshake className="h-3.5 w-3.5" />Open the deals board</Link>
            </Panel>
            <Panel title="Overdue">
              {!d.tasks.overdueList.length ? <p className="py-10 text-center text-[13px] text-muted">Nothing is overdue.</p> : (
                <ul className="divide-y divide-line text-[13px]">
                  {d.tasks.overdueList.map((t) => (
                    <li key={t.id}><Link to={`/app/tasks?view=list&task=${t.id}`} className="flex items-center gap-2 py-2 hover:text-fg">
                      <span className="font-mono text-[12px] text-subtle">{t.ref}</span><span className="truncate">{t.title}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-warn">{t.due ? new Date(t.due).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }) : ""}</span>
                      <span className="hidden w-24 shrink-0 truncate text-right text-[12px] text-muted sm:inline">{t.assignee ?? "Nobody"}</span>
                    </Link></li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
