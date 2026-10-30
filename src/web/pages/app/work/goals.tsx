/** Goals and OKRs: goals with key results from numbers or tasks, progress that moves as work is done, and a roll-up. */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTarget } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { shortDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { HEALTH, type Health } from "./portfolio";

interface KeyResult { id: string; name: string; kind: "number" | "currency" | "percent" | "tasks"; unit: string; start: number; target: number; current: number; projectId: string | null; tasks: { total: number; done: number } | null; progress: number }
interface Goal { id: string; name: string; description: string; owner: { id: string; name: string } | null; parentId: string | null; due: string | null; health: Health | null; suggestedHealth: Health | null; progress: number; keyResults: KeyResult[]; children: Goal[] }
interface Tree { goals: Goal[]; summary: { goals: number; topLevel: number; keyResults: number; progress: number; health: Record<Health | "not_set", number> } }

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const val = (k: KeyResult, n: number) => (k.kind === "currency" ? aud.format(n) : k.kind === "percent" ? `${n}%` : `${n}${k.unit ? ` ${k.unit}` : ""}`);

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2" aria-label={label}>
      <div className="h-2 w-28 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-brand" style={{ width: `${value}%` }} />
      </div>
      <span className="w-10 text-right text-[12.5px] tabular-nums">{value}%</span>
    </div>
  );
}

/** A key result value: any number, decimals and negatives allowed. */
export const numberCheck = (v: string) => (v.trim() === "" ? "Enter a number." : Number.isNaN(Number(v)) ? "That is not a number. Use digits, like 42 or 3.5." : null);

export function GoalsPage() {
  const { prompt, dialogs } = useDialogs();
  const qc = useQueryClient();
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [addingKr, setAddingKr] = useState<Goal | null>(null);
  const q = useQuery({ queryKey: ["goals"], queryFn: () => api.get<Tree>("/goals") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["goals"] });
  const setCurrent = async (k: KeyResult) => {
    const v = await prompt({ title: "Update progress", label: `Current value for ${k.name}`, initial: String(k.current), inputMode: "numeric", validate: numberCheck });
    if (v === null || v.trim() === "" || Number.isNaN(Number(v))) return;
    try { await api.patch(`/key-results/${k.id}`, { current: Number(v) }); await refresh(); } catch (e) { showError(e as Error); }
  };
  const setHealth = async (g: Goal, h: string) => { try { await api.patch(`/goals/${g.id}`, { health: h || null }); await refresh(); } catch (e) { showError(e as Error); } };
  const goal = (g: Goal, depth: number) => {
    const h = g.health ?? g.suggestedHealth;
    return (
      <li key={g.id} className={cn(depth > 0 && "ml-1 border-l border-line pl-3 sm:ml-4 sm:pl-4")} data-testid="goal">
        <Card className="mb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold">{g.name}</h2>
              <p className="text-[12.5px] text-subtle">{g.owner ? `${g.owner.name} · ` : ""}{g.due ? `due ${shortDate(g.due)}` : "no due date"}{!g.health && g.suggestedHealth ? " · health suggested from the dates" : ""}</p>
            </div>
            <div className="flex items-center gap-3">
              <Select bare aria-label={`Health of ${g.name}`} value={g.health ?? ""} onChange={(e) => void setHealth(g, e.target.value)}
                className={cn("h-10 rounded-md border-0 px-2 text-[12.5px] font-medium sm:h-7", h ? HEALTH[h].cls : "bg-fill text-muted")}
                phoneClassName={cn("inline-flex h-10 max-w-[10rem] items-center rounded-md px-3 text-left text-[13px] font-medium", h ? HEALTH[h].cls : "bg-fill text-muted")}>
                <option value="">{g.suggestedHealth ? `${HEALTH[g.suggestedHealth].label} (suggested)` : "Not set"}</option>
                {(Object.keys(HEALTH) as Health[]).map((x) => <option key={x} value={x}>{HEALTH[x].label}</option>)}
              </Select>
              <Bar value={g.progress} label={`${g.name} progress`} />
            </div>
          </div>
          {g.keyResults.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {g.keyResults.map((k) => (
                <li key={k.id} data-testid="key-result" className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 rounded-md bg-fill/60 px-3 py-2 text-[13.5px] sm:flex sm:flex-wrap sm:justify-between">
                  <span className="col-span-2 min-w-0 break-words sm:flex-1" data-testid="key-result-name">{k.name}</span>
                  <span className="text-[12.5px] text-muted">{k.kind === "tasks" ? `${k.tasks?.done ?? 0} of ${k.tasks?.total ?? 0} tasks done` : k.target < k.start || (k.target === k.start && k.current > k.target) ? `${val(k, k.current)}, down to ${val(k, k.target)}` : `${val(k, k.current)} of ${val(k, k.target)}`}</span>
                  {k.kind !== "tasks" && <Button variant="ghost" size="sm" onClick={() => void setCurrent(k)}>Update</Button>}
                  <div className="col-span-2 sm:col-span-1"><Bar value={k.progress} label={`${k.name} progress`} /></div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAddingKr(g)}><IconPlus className="h-3.5 w-3.5" />Key result</Button>
            <Button variant="ghost" size="sm" onClick={() => setCreating({ parentId: g.id })}>Add a goal under this</Button>
          </div>
        </Card>
        {g.children.length > 0 && <ul>{g.children.map((c) => goal(c, depth + 1))}</ul>}
      </li>
    );
  };
  const s = q.data?.summary;
  return (
    <div>
      {dialogs}
      <PageHeader title="Goals" description="Set goals with key results. Progress moves on its own as linked tasks are done, and rolls up into bigger goals."
        actions={<Button size="sm" onClick={() => setCreating({})}><IconPlus className="h-4 w-4" />New goal</Button>} />
      {q.isPending ? <Skeleton className="h-64" /> : !q.data?.goals.length ? (
        <EmptyState icon={<IconTarget />} title="No goals yet" body="Try one goal for this quarter with two or three key results, for example monthly revenue in AUD and a project's tasks." action={<Button size="sm" onClick={() => setCreating({})}>New goal</Button>} />
      ) : (
        <>
          {s && (
            <Card className="mb-5 flex flex-wrap items-center gap-6" data-testid="goals-summary">
              <div><p className="text-[12px] text-subtle">Overall progress</p><Bar value={s.progress} label="Overall progress" /></div>
              <p className="text-[13.5px]">{s.goals} goals, {s.keyResults} key results</p>
              <div className="flex flex-wrap gap-2 text-[12.5px]">{(Object.keys(HEALTH) as Health[]).map((h) => <span key={h} className={cn("rounded-full px-2.5 py-1 font-medium", HEALTH[h].cls)}>{s.health[h]} {HEALTH[h].label.toLowerCase()}</span>)}</div>
            </Card>
          )}
          <ul>{q.data.goals.map((g) => goal(g, 0))}</ul>
        </>
      )}
      <GoalDialog open={!!creating} parentId={creating?.parentId} onClose={() => setCreating(null)} onDone={() => { setCreating(null); void refresh(); }} />
      <KrDialog goal={addingKr} onClose={() => setAddingKr(null)} onDone={() => { setAddingKr(null); void refresh(); }} />
    </div>
  );
}

function GoalDialog({ open, parentId, onClose, onDone }: { open: boolean; parentId?: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(""); const [due, setDue] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api.post("/goals", { name, due: due || null, parentId: parentId ?? null }); setName(""); setDue(""); onDone(); } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={parentId ? "New goal under this one" : "New goal"}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label="Goal">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Grow repeat customers this quarter" required />}</Field>
        <Field label="Due date (optional)">{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create goal</Button></div>
      </form>
    </Dialog>
  );
}

function KrDialog({ goal, onClose, onDone }: { goal: Goal | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(""); const [kind, setKind] = useState<KeyResult["kind"]>("number");
  const [start, setStart] = useState("0"); const [target, setTarget] = useState("100"); const [current, setCurrent] = useState("0");
  const [projectId, setProjectId] = useState(""); const [refs, setRefs] = useState(""); const [busy, setBusy] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], enabled: !!goal, queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!goal) return; setBusy(true);
    const body = kind === "tasks"
      ? { name, kind, projectId: projectId || undefined, taskIds: refs.split(/[\s,]+/).filter(Boolean) }
      : { name, kind, start: Number(start), target: Number(target), current: Number(current) };
    try { await api.post(`/goals/${goal.id}/key-results`, body); setName(""); setRefs(""); onDone(); } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!goal} onClose={onClose} title="Add a key result" description="Measure a number (also in AUD or as a percentage), or a set of tasks.">
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label="Key result">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly revenue" required />}</Field>
        <Field label="Measured by">{(p) => (
          <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as KeyResult["kind"])}>
            <option value="number">A number</option><option value="currency">An amount in AUD</option><option value="percent">A percentage</option><option value="tasks">Tasks done</option>
          </Select>
        )}</Field>
        {kind === "tasks" ? (
          <>
            <Field label="Every top level task in a project (optional)">{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">None</option>{(projects.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
            <Field label="Or task refs, separated by commas" hint="For example OPS-3, OPS-7">{(p) => <Input {...p} value={refs} onChange={(e) => setRefs(e.target.value)} />}</Field>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Start">{(p) => <Input {...p} type="number" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Field label="Target">{(p) => <Input {...p} type="number" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
            <Field label="Now">{(p) => <Input {...p} type="number" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          </div>
        )}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Add</Button></div>
      </form>
    </Dialog>
  );
}
