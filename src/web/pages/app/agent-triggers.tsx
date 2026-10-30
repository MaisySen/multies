/**
 * R28 (DF-3 slice 3): an agent member's triggers, opened from its row in People. Admins see each trigger with an
 * on/off switch, the next run, the last fire and the fire count, add a schedule or webhook trigger, fire one now,
 * rotate a webhook secret and delete. A webhook's URL and secret show once, right after it is made or rotated.
 * R29: Edit reuses the Add form (kind stays fixed), and History lists the trigger's recent fires and refusals.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCalendarClock, IconEdit, IconHistory, IconPlay, IconPlus, IconRefresh, IconTrash, IconWebhook, IconZap } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo, zonedDateTime } from "@/web/lib/format";
import { Badge, CopyButton, EmptyState, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea, TimeInput } from "@/web/components/ui/input";
import { TriggerHistory } from "./agent-trigger-history";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30

type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export interface AgentTriggerView {
  id: string; name: string; kind: "schedule" | "webhook"; enabled: boolean;
  agent: { userId: string; name: string; active: boolean };
  task: { id: string; ref: string; title: string } | null;
  project: { id: string; name: string } | null;
  titleTemplate: string | null; instructions: string | null;
  schedule: { everyHours: number; timezone: string } | { dailyAt: string; days: Day[] | null; timezone: string } | null;
  webhook: { url: string; secretHint: string | null; signatureHeader: string; timestampHeader: string } | null;
  nextRunAt: string | null; lastFiredAt: string | null; fireCount: number;
}
const DAY_LABEL: Record<Day, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
const DAY_ORDER: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "Every 6 hours", "Daily at 09:00, Mon to Fri", "Webhook". */
export function describeTrigger(t: Pick<AgentTriggerView, "kind" | "schedule">) {
  if (t.kind === "webhook" || !t.schedule) return "Webhook";
  if ("everyHours" in t.schedule) return t.schedule.everyHours === 1 ? "Every hour" : `Every ${t.schedule.everyHours} hours`;
  const days = t.schedule.days;
  const which = !days || days.length === 7 ? "every day"
    : days.length === 5 && !days.includes("sat") && !days.includes("sun") ? "weekdays"
      : DAY_ORDER.filter((d) => days.includes(d)).map((d) => DAY_LABEL[d]).join(", ");
  return `Daily at ${t.schedule.dailyAt}, ${which}`;
}

const key = (agentUserId: string) => ["agent-triggers", agentUserId];

export function AgentTriggersDialog({ agentUserId, agentName, onClose }: { agentUserId: string; agentName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: key(agentUserId), queryFn: async () => (await api.get<{ triggers: AgentTriggerView[]; limit: number }>(`/agent-triggers?agentUserId=${encodeURIComponent(agentUserId)}`)) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentTriggerView | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key(agentUserId) });
  const triggers = list.data?.triggers ?? [];
  return (
    <Dialog open onClose={onClose} title={`Triggers for ${agentName}`} className="sm:max-w-xl"
      description="A trigger queues a run for this agent on a schedule or when a signed webhook arrives. The agent picks queued runs up with its own key."
      footer={<><Button variant="secondary" onClick={onClose}>Done</Button>{!adding && !editing && <Button onClick={() => setAdding(true)}><IconPlus className="h-4 w-4" />Add trigger</Button>}</>}>
      {secret && (
        <div className="mb-4 rounded-xl border border-brand/30 bg-brand/5 p-3 text-sm" data-testid="trigger-secret">
          <div className="font-medium">Copy the webhook secret now. It won't be shown again.</div>
          <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate font-mono text-xs">{secret.url}</code><CopyButton value={secret.url} label="Copy URL" /></div>
          <div className="mt-1.5 flex items-center gap-2"><code className="min-w-0 flex-1 truncate font-mono text-xs">{secret.secret}</code><CopyButton value={secret.secret} label="Copy secret" /></div>
          <p className="mt-2 text-xs text-muted">Sign each POST: X-Multies-Timestamp is unix seconds, X-Multies-Signature is sha256= and the HMAC-SHA256 of "timestamp.body" with this secret.</p>
        </div>
      )}
      {adding && <TriggerForm agentUserId={agentUserId} onCancel={() => setAdding(false)} onSaved={(r) => { setAdding(false); refresh(); if (r.secret && r.trigger.webhook) setSecret({ url: r.trigger.webhook.url, secret: r.secret }); }} />}
      {editing && <TriggerForm key={editing.id} agentUserId={agentUserId} initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {list.isLoading ? <SkeletonRows rows={2} rowHeight={64} label="Loading triggers" /> : triggers.length === 0 && !adding ? (
        <EmptyState className="py-8" icon={<IconZap />} title="No triggers yet" body="Add one to queue a run every morning, every few hours, or when another system calls a webhook." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Triggers">
          {triggers.map((t) => <TriggerRow key={t.id} t={t} onChanged={refresh} onSecret={setSecret} onEdit={() => { setAdding(false); setEditing(t); }} />)}
        </ul>
      )}
      {list.data && <p className="mt-2 text-xs text-subtle tabular-nums">Up to {list.data.limit} triggers per workspace. An agent holds at most 3 queued runs.</p>}
    </Dialog>
  );
}

function TriggerRow({ t, onChanged, onSecret, onEdit }: { t: AgentTriggerView; onChanged: () => void; onSecret: (s: { url: string; secret: string }) => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const refreshHistory = () => qc.invalidateQueries({ queryKey: ["agent-trigger-history", t.id] });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.patch(`/agent-triggers/${t.id}`, { enabled }), onSuccess: onChanged, onError: (e) => showError(e) });
  const run = useMutation({ mutationFn: () => api.post(`/agent-triggers/${t.id}/run`, {}), onSuccess: () => { onChanged(); refreshHistory(); toast.success(`Queued a run for ${t.agent.name}`); }, onError: (e) => { refreshHistory(); showError(e); } });
  const rotate = useMutation({ mutationFn: () => api.post<{ secret: string; trigger: AgentTriggerView }>(`/agent-triggers/${t.id}/rotate-secret`, {}), onSuccess: (r) => { onChanged(); if (r.trigger.webhook) onSecret({ url: r.trigger.webhook.url, secret: r.secret }); }, onError: (e) => showError(e) });
  const del = useMutation({ mutationFn: () => api.del(`/agent-triggers/${t.id}`), onSuccess: () => { onChanged(); toast.success(`${t.name} deleted`); }, onError: (e) => showError(e) });
  const Icon = t.kind === "webhook" ? IconWebhook : IconCalendarClock;
  return (
    <li className="px-4 py-3" data-testid="agent-trigger">
     <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand" aria-hidden><Icon className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{t.name}</span>
          <Badge>{describeTrigger(t)}</Badge>
          {!t.agent.active && <Badge tone="warn">Agent paused</Badge>}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{t.task ? `On ${t.task.ref} ${t.task.title}` : t.project ? `New task in ${t.project.name}` : "Target removed"}</div>
        <div className="mt-0.5 text-xs text-subtle" data-testid="trigger-times">
          {t.nextRunAt ? `Next run ${zonedDateTime(t.nextRunAt)}` : t.kind === "schedule" ? "Off" : t.webhook ? `Secret ends in ${t.webhook.secretHint ?? "????"}` : ""}
          {" · "}{t.lastFiredAt ? `Last fired ${timeAgo(t.lastFiredAt)} (${t.fireCount})` : "Never fired"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`History of ${t.name}`} aria-expanded={showHistory} title="History" onClick={() => setShowHistory((v) => !v)}><IconHistory className="h-4 w-4" /></button>
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Edit ${t.name}`} title="Edit" onClick={onEdit}><IconEdit className="h-4 w-4" /></button>
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-40" aria-label={`Run ${t.name} now`} title="Run now" disabled={!t.enabled || run.isPending} onClick={() => run.mutate()}><IconPlay className="h-4 w-4" /></button>
        {t.kind === "webhook" && <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Rotate the secret of ${t.name}`} title="New secret" onClick={() => rotate.mutate()}><IconRefresh className="h-4 w-4" /></button>}
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-bad" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => del.mutate()}><IconTrash className="h-4 w-4" /></button>
        <Switch checked={t.enabled} onChange={(v) => toggle.mutate(v)} label={`${t.name} on`} />
      </div>
     </div>
      {showHistory && <TriggerHistory triggerId={t.id} />}
    </li>
  );
}

type Created = { trigger: AgentTriggerView; secret?: string };

const WEEKDAYS: Day[] = ["mon", "tue", "wed", "thu", "fri"];

/** R29: the trigger form's fields, shared by Add and Edit. */
export interface TriggerFormState {
  name: string; kind: "schedule" | "webhook"; mode: "daily" | "every"; dailyAt: string; days: Day[]; everyHours: number;
  timezone: string; target: "project" | "task"; projectId: string; taskId: string; titleTemplate: string; instructions: string;
}

/** The form's starting state: blank for Add, the trigger's own values for Edit. */
export function formStateFrom(t?: AgentTriggerView | null): TriggerFormState {
  const s = t?.schedule ?? null;
  return {
    name: t?.name ?? "", kind: t?.kind ?? "schedule",
    mode: s && "everyHours" in s ? "every" : "daily",
    dailyAt: s && "dailyAt" in s ? s.dailyAt : "09:00",
    days: s && "dailyAt" in s ? (s.days ?? []) : t ? [] : WEEKDAYS,
    everyHours: s && "everyHours" in s ? s.everyHours : 6,
    timezone: s?.timezone ?? "",
    target: t?.task ? "task" : "project",
    projectId: t?.project?.id ?? "", taskId: t?.task?.ref ?? "",
    titleTemplate: t?.titleTemplate ?? "{trigger} {date}", instructions: t?.instructions ?? "",
  };
}

/** The POST (Add) or PATCH (Edit) body for the form. Edit never sends kind or the agent. */
export function triggerFormBody(f: TriggerFormState, opts: { agentUserId: string; editing: boolean; projectId: string }) {
  const kind = f.kind;
  return {
    ...(opts.editing ? {} : { agentUserId: opts.agentUserId, kind }),
    name: f.name.trim(),
    ...(f.target === "task" ? { taskId: f.taskId.trim(), ...(opts.editing ? { projectId: null } : {}) } : { projectId: opts.projectId, titleTemplate: f.titleTemplate, ...(opts.editing ? { taskId: null } : {}) }),
    instructions: f.instructions.trim() || null,
    ...(kind === "schedule"
      ? { ...(f.mode === "every" ? { everyHours: f.everyHours } : { dailyAt: f.dailyAt, days: f.days.length ? DAY_ORDER.filter((d) => f.days.includes(d)) : null }), ...(f.timezone.trim() ? { timezone: f.timezone.trim() } : {}) }
      : {}),
  };
}

const zones = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; } })();

function TriggerForm({ agentUserId, initial, onCancel, onSaved }: { agentUserId: string; initial?: AgentTriggerView | null; onCancel: () => void; onSaved: (r: Created) => void }) {
  const editing = !!initial;
  const projects = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const [f, setF] = useState<TriggerFormState>(() => formStateFrom(initial));
  const set = <K extends keyof TriggerFormState>(k: K, v: TriggerFormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const pid = f.projectId || projects.data?.[0]?.id || "";
  const save = useMutation({
    mutationFn: async (): Promise<Created> => {
      const body = triggerFormBody(f, { agentUserId, editing, projectId: pid });
      if (initial) return { trigger: (await api.patch<{ trigger: AgentTriggerView }>(`/agent-triggers/${initial.id}`, body)).trigger };
      return api.post<Created>("/agent-triggers", body);
    },
    onSuccess: (r) => { toast.success(editing ? `${r.trigger.name} saved` : `${r.trigger.name} added`); onSaved(r); },
    onError: (e) => showError(e),
  });
  const ready = f.name.trim() && (f.target === "task" ? f.taskId.trim() : pid);
  const toggleDay = (d: Day) => set("days", f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]);
  return (
    <form className="mb-4 space-y-3 rounded-xl border border-line p-4" aria-label={editing ? `Edit ${initial?.name}` : "New trigger"} onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">{(p) => <Input {...p} value={f.name} maxLength={80} placeholder="Morning triage" onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="Starts" hint={editing ? "A trigger's kind can't change." : undefined}>{(p) => <Select {...p} value={f.kind} disabled={editing} onChange={(e) => set("kind", e.target.value as "schedule" | "webhook")}><option value="schedule">On a schedule</option><option value="webhook">From a webhook</option></Select>}</Field>
      </div>
      {f.kind === "schedule" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Repeat">{(p) => <Select {...p} value={f.mode} onChange={(e) => set("mode", e.target.value as "daily" | "every")}><option value="daily">Daily at a time</option><option value="every">Every few hours</option></Select>}</Field>
          {f.mode === "daily" ? (
            <Field label="Time">{(p) => <TimeInput {...p} value={f.dailyAt} onChange={(e) => set("dailyAt", e.target.value)} />}</Field>
          ) : (
            <Field label="Every (hours)" hint="At least 1 hour.">{(p) => <Input {...p} type="number" min={1} max={744} value={f.everyHours} onChange={(e) => set("everyHours", Math.max(1, Number(e.target.value) || 1))} />}</Field>
          )}
          {f.mode === "daily" && (
            <div className="sm:col-span-2">
              <div className="mb-1 text-[13px] font-medium">Days</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                {DAY_ORDER.map((d) => (
                  <button key={d} type="button" aria-pressed={f.days.includes(d)} onClick={() => toggleDay(d)}
                    className={f.days.includes(d) ? "rounded-full border border-brand bg-brand px-2.5 py-1 text-xs font-medium text-white" : "rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-hover"}>
                    {DAY_LABEL[d]}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">{f.days.length ? "Runs on the days picked." : "No days picked: runs every day."}</p>
            </div>
          )}
          <div className="sm:col-span-2">
            <Field label="Time zone" hint="Leave empty for the workspace time zone.">{(p) => <Input {...p} list="trigger-zones" value={f.timezone} maxLength={64} placeholder="Australia/Sydney" onChange={(e) => set("timezone", e.target.value)} />}</Field>
            <datalist id="trigger-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </div>
        </div>
      )}
      {f.kind === "webhook" && <p className="text-xs text-muted">{editing ? "The URL stays the same. Use New secret on the trigger's row to replace its secret." : "You get a URL and a signing secret after saving. The secret shows once."}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Run on">{(p) => <Select {...p} value={f.target} onChange={(e) => set("target", e.target.value as "project" | "task")}><option value="project">A new task each time</option><option value="task">One existing task</option></Select>}</Field>
        {f.target === "project" ? (
          <Field label="Project">{(p) => <Select {...p} value={pid} onChange={(e) => set("projectId", e.target.value)}>{(projects.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        ) : (
          <Field label="Task" hint="A reference like MB-12.">{(p) => <Input {...p} value={f.taskId} placeholder="MB-12" onChange={(e) => set("taskId", e.target.value)} />}</Field>
        )}
      </div>
      {f.target === "project" && <Field label="Task title" hint="{trigger}, {date} and {datetime} are filled in.">{(p) => <Input {...p} value={f.titleTemplate} maxLength={200} onChange={(e) => set("titleTemplate", e.target.value)} />}</Field>}
      <Field label="Instructions for the agent">{(p) => <Textarea {...p} rows={3} value={f.instructions} maxLength={4000} placeholder="Read new support mail and file a task for each bug." onChange={(e) => set("instructions", e.target.value)} />}</Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={save.isPending} disabled={!ready}>{editing ? "Save changes" : "Save trigger"}</Button>
      </div>
    </form>
  );
}
