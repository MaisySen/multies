import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Zap } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, EmptyState, Meter, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { useAssignees, useProjects } from "./data";

type Trigger = "email_received" | "status_changed" | "due_soon";
interface Rule { id: string; name: string; trigger: Trigger; conditions: Record<string, unknown>; action: "create_task" | "notify"; actionConfig: Record<string, unknown>; enabled: boolean; runCount: number; lastRunAt: string | null; lastError: string | null }
interface Recipe extends Omit<Rule, "id" | "enabled" | "runCount" | "lastRunAt" | "lastError"> { key: string }

const TRIGGER: Record<Trigger, string> = { email_received: "When an email arrives", status_changed: "When a task changes status", due_soon: "Before a task is due" };

function describe(r: Pick<Rule, "trigger" | "conditions" | "action" | "actionConfig">) {
  const c = r.conditions as Record<string, string>;
  const when = r.trigger === "email_received" ? `Email ${[c.from && `from ${c.from}`, c.subjectContains && `with "${c.subjectContains}" in the subject`].filter(Boolean).join(" and ") || "arrives"}`
    : r.trigger === "status_changed" ? `A task moves to ${c.toCategory === "done" ? "Done" : c.toCategory === "doing" ? "a doing status" : c.toCategory === "todo" ? "a to do status" : "a new status"}`
    : `${c.hoursBefore ?? 24} hours before a task is due`;
  const a = r.actionConfig as Record<string, string | number>;
  const then = r.action === "create_task" ? `make a task${a.priority ? `, ${a.priority} priority` : ""}${a.dueInDays ? `, due in ${a.dueInDays} days` : ""}` : `notify ${a.to === "assignee" ? "the assignee" : a.to === "creator" ? "whoever made the task" : a.to === "admins" ? "the admins" : "a teammate"}`;
  return `${when}, ${then}.`;
}

export function AutomationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["automations"], queryFn: () => api.get<{ automations: Rule[]; recipes: Recipe[]; usage: { used: number; limit: number } }>("/automations") });
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["automations"] });
  const toggle = async (r: Rule) => { try { await api.patch(`/automations/${r.id}`, { enabled: !r.enabled }); await refresh(); } catch (e) { showError(e as Error); } };
  const remove = async (r: Rule) => { try { await api.del(`/automations/${r.id}`); await refresh(); } catch (e) { showError(e as Error); } };
  return (
    <div>
      <PageHeader title="Automations" description="Simple rules that run inside Multies. They make tasks and notify your team; they never email anyone outside the business." actions={<Button onClick={() => setEditing({ trigger: "email_received", action: "create_task", conditions: {}, actionConfig: {} })}><Plus className="h-4 w-4" />New rule</Button>} />
      {q.isPending ? <Skeleton className="h-40" /> : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            {!q.data!.automations.length ? <Card><EmptyState icon={<Zap />} title="No rules yet" body="Start from a recipe on the right, or write your own." /></Card> : (
              <Card className="divide-y divide-line">
                {q.data!.automations.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 p-4">
                    <Switch checked={r.enabled} onChange={() => void toggle(r)} label={`Turn ${r.name} ${r.enabled ? "off" : "on"}`} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(r)}>
                      <div className="text-[14px] font-medium">{r.name}</div>
                      <p className="mt-0.5 text-[13px] text-muted">{describe(r)}</p>
                      <p className="mt-1 text-[12px] text-subtle">Ran {r.runCount} {r.runCount === 1 ? "time" : "times"}{r.lastRunAt && `, last ${timeAgo(r.lastRunAt)}`}{r.lastError && <span className="text-bad"> · {r.lastError}</span>}</p>
                    </button>
                    <button onClick={() => void remove(r)} className="rounded p-1 text-subtle hover:text-bad" aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </Card>
            )}
          </div>
          <aside aria-label="Usage and recipes" className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center justify-between text-[13px]"><span className="font-medium">Runs this month</span><span className="tabular-nums text-muted">{q.data!.usage.used.toLocaleString("en-AU")} of {q.data!.usage.limit.toLocaleString("en-AU")}</span></div>
              <Meter className="mt-2" value={q.data!.usage.used} max={q.data!.usage.limit} />
            </Card>
            <div>
              <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Recipes</h2>
              <ul className="space-y-2">
                {q.data!.recipes.map((r) => (
                  <li key={r.key}><button onClick={() => setEditing({ ...r })} className="w-full rounded-lg border border-line bg-surface p-3 text-left text-[13px] hover:border-line-strong">
                    <span className="flex items-center gap-1.5 font-medium"><Zap className="h-3.5 w-3.5 text-brand-hover" />{r.name}</span>
                  </button></li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      )}
      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
    </div>
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: Partial<Rule>; onClose: () => void; onSaved: () => void }) {
  const projects = useProjects();
  const people = useAssignees();
  const [r, setR] = useState<Partial<Rule>>({ name: "", conditions: {}, actionConfig: {}, ...rule });
  const [busy, setBusy] = useState(false);
  const c = (r.conditions ?? {}) as Record<string, string | number>;
  const a = (r.actionConfig ?? {}) as Record<string, string | number>;
  const setC = (k: string, v: string | number | undefined) => setR({ ...r, conditions: { ...c, [k]: v === "" ? undefined : v } });
  const setA = (k: string, v: string | number | undefined) => setR({ ...r, actionConfig: { ...a, [k]: v === "" ? undefined : v } });
  const save = async () => {
    setBusy(true);
    const body = { name: r.name || describe(r as Rule).slice(0, 100), trigger: r.trigger, conditions: r.conditions, action: r.trigger === "due_soon" ? "notify" : r.action, actionConfig: r.actionConfig, enabled: r.enabled ?? true };
    try { if (r.id) await api.patch(`/automations/${r.id}`, body); else await api.post("/automations", body); onSaved(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={r.id ? "Edit rule" : "New rule"} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save rule</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(f) => <Input {...f} value={r.name ?? ""} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Client emails become tasks" />}</Field>
        <Field label="When">{(f) => <Select {...f} value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value as Trigger, conditions: {}, action: e.target.value === "due_soon" ? "notify" : r.action })}>{(Object.keys(TRIGGER) as Trigger[]).map((t) => <option key={t} value={t}>{TRIGGER[t]}</option>)}</Select>}</Field>
        {r.trigger === "email_received" && <div className="grid grid-cols-2 gap-3">
          <Field label="From (address or @domain)">{(f) => <Input {...f} value={String(c.from ?? "")} onChange={(e) => setC("from", e.target.value)} placeholder="@client.com.au" />}</Field>
          <Field label="Subject contains">{(f) => <Input {...f} value={String(c.subjectContains ?? "")} onChange={(e) => setC("subjectContains", e.target.value)} placeholder="invoice" />}</Field>
        </div>}
        {r.trigger === "status_changed" && <Field label="Moves to">{(f) => <Select {...f} value={String(c.toCategory ?? "")} onChange={(e) => setC("toCategory", e.target.value)}><option value="">Any status</option><option value="todo">A to do status</option><option value="doing">A doing status</option><option value="done">Done</option></Select>}</Field>}
        {r.trigger === "due_soon" && <Field label="Hours before due">{(f) => <Input {...f} inputMode="numeric" value={String(c.hoursBefore ?? 24)} onChange={(e) => setC("hoursBefore", Number(e.target.value) || 24)} />}</Field>}
        {r.trigger !== "due_soon" && <Field label="Then">{(f) => <Select {...f} value={r.action} onChange={(e) => setR({ ...r, action: e.target.value as Rule["action"], actionConfig: {} })}><option value="create_task">Make a task</option><option value="notify">Notify someone</option></Select>}</Field>}
        {(r.action === "create_task" && r.trigger !== "due_soon") ? <div className="grid grid-cols-2 gap-3">
          <Field label="Project">{(f) => <Select {...f} value={String(a.projectId ?? "")} onChange={(e) => setA("projectId", e.target.value)}><option value="">First project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
          <Field label="Assign to">{(f) => <Select {...f} value={String(a.assignee ?? "")} onChange={(e) => setA("assignee", e.target.value)}><option value="">Nobody</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "agent" ? " (agent)" : ""}</option>)}</Select>}</Field>
          <Field label="Priority">{(f) => <Select {...f} value={String(a.priority ?? "")} onChange={(e) => setA("priority", e.target.value)}><option value="">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}</Field>
          <Field label="Due in days">{(f) => <Input {...f} inputMode="numeric" value={String(a.dueInDays ?? "")} onChange={(e) => setA("dueInDays", Number(e.target.value) || undefined)} />}</Field>
        </div> : <Field label="Notify">{(f) => <Select {...f} value={String(a.to ?? "assignee")} onChange={(e) => setA("to", e.target.value)}><option value="assignee">The assignee</option><option value="creator">Whoever made the task</option><option value="admins">Workspace admins</option>{people.data?.filter((p) => p.type === "member").map((p) => <option key={p.id} value={p.id.slice(7)}>{p.name}</option>)}</Select>}</Field>}
      </div>
    </Dialog>
  );
}
