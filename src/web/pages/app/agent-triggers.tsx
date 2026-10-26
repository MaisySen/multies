/**
 * R28 (DF-3 slice 3): an agent member's triggers, opened from its row in People. Admins see each trigger with an
 * on/off switch, the next run, the last fire and the fire count, add a schedule or webhook trigger, fire one now,
 * rotate a webhook secret and delete. A webhook's URL and secret show once, right after it is made or rotated.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play, Plus, RefreshCw, Trash2, Webhook, Zap } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo, zonedDateTime } from "@/web/lib/format";
import { Badge, CopyButton, EmptyState, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";

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
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key(agentUserId) });
  const triggers = list.data?.triggers ?? [];
  return (
    <Dialog open onClose={onClose} title={`Triggers for ${agentName}`} className="sm:max-w-xl"
      description="A trigger queues a run for this agent on a schedule or when a signed webhook arrives. The agent picks queued runs up with its own key."
      footer={<><Button variant="secondary" onClick={onClose}>Done</Button>{!adding && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add trigger</Button>}</>}>
      {secret && (
        <div className="mb-4 rounded-xl border border-brand/30 bg-brand/5 p-3 text-sm" data-testid="trigger-secret">
          <div className="font-medium">Copy the webhook secret now. It won't be shown again.</div>
          <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate font-mono text-xs">{secret.url}</code><CopyButton value={secret.url} label="Copy URL" /></div>
          <div className="mt-1.5 flex items-center gap-2"><code className="min-w-0 flex-1 truncate font-mono text-xs">{secret.secret}</code><CopyButton value={secret.secret} label="Copy secret" /></div>
          <p className="mt-2 text-xs text-muted">Sign each POST: X-Multies-Timestamp is unix seconds, X-Multies-Signature is sha256= and the HMAC-SHA256 of "timestamp.body" with this secret.</p>
        </div>
      )}
      {adding && <AddTriggerForm agentUserId={agentUserId} onCancel={() => setAdding(false)} onCreated={(r) => { setAdding(false); refresh(); if (r.secret && r.trigger.webhook) setSecret({ url: r.trigger.webhook.url, secret: r.secret }); }} />}
      {list.isLoading ? <div className="py-6 text-center text-sm text-muted">Loading</div> : triggers.length === 0 && !adding ? (
        <EmptyState className="py-8" icon={<Zap />} title="No triggers yet" body="Add one to queue a run every morning, every few hours, or when another system calls a webhook." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Triggers">
          {triggers.map((t) => <TriggerRow key={t.id} t={t} onChanged={refresh} onSecret={setSecret} />)}
        </ul>
      )}
      {list.data && <p className="mt-2 text-xs text-subtle tabular-nums">Up to {list.data.limit} triggers per workspace. An agent holds at most 3 queued runs.</p>}
    </Dialog>
  );
}

function TriggerRow({ t, onChanged, onSecret }: { t: AgentTriggerView; onChanged: () => void; onSecret: (s: { url: string; secret: string }) => void }) {
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.patch(`/agent-triggers/${t.id}`, { enabled }), onSuccess: onChanged, onError: (e) => showError(e) });
  const run = useMutation({ mutationFn: () => api.post(`/agent-triggers/${t.id}/run`, {}), onSuccess: () => { onChanged(); toast.success(`Queued a run for ${t.agent.name}`); }, onError: (e) => showError(e) });
  const rotate = useMutation({ mutationFn: () => api.post<{ secret: string; trigger: AgentTriggerView }>(`/agent-triggers/${t.id}/rotate-secret`, {}), onSuccess: (r) => { onChanged(); if (r.trigger.webhook) onSecret({ url: r.trigger.webhook.url, secret: r.secret }); }, onError: (e) => showError(e) });
  const del = useMutation({ mutationFn: () => api.del(`/agent-triggers/${t.id}`), onSuccess: () => { onChanged(); toast.success(`${t.name} deleted`); }, onError: (e) => showError(e) });
  const Icon = t.kind === "webhook" ? Webhook : CalendarClock;
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid="agent-trigger">
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
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-40" aria-label={`Run ${t.name} now`} title="Run now" disabled={!t.enabled || run.isPending} onClick={() => run.mutate()}><Play className="h-4 w-4" /></button>
        {t.kind === "webhook" && <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Rotate the secret of ${t.name}`} title="New secret" onClick={() => rotate.mutate()}><RefreshCw className="h-4 w-4" /></button>}
        <button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-bad" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => del.mutate()}><Trash2 className="h-4 w-4" /></button>
        <Switch checked={t.enabled} onChange={(v) => toggle.mutate(v)} label={`${t.name} on`} />
      </div>
    </li>
  );
}

type Created = { trigger: AgentTriggerView; secret?: string };

function AddTriggerForm({ agentUserId, onCancel, onCreated }: { agentUserId: string; onCancel: () => void; onCreated: (r: Created) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"schedule" | "webhook">("schedule");
  const [mode, setMode] = useState<"daily" | "every">("daily");
  const [dailyAt, setDailyAt] = useState("09:00");
  const [weekdays, setWeekdays] = useState(true);
  const [everyHours, setEveryHours] = useState(6);
  const [target, setTarget] = useState<"project" | "task">("project");
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("{trigger} {date}");
  const [instructions, setInstructions] = useState("");
  const pid = projectId || projects.data?.[0]?.id || "";
  const add = useMutation({
    mutationFn: () => api.post<Created>("/agent-triggers", {
      agentUserId, kind, name,
      ...(target === "task" ? { taskId: taskId.trim() } : { projectId: pid, titleTemplate }),
      instructions: instructions.trim() || null,
      ...(kind === "schedule" ? (mode === "every" ? { everyHours } : { dailyAt, days: weekdays ? ["mon", "tue", "wed", "thu", "fri"] : null }) : {}),
    }),
    onSuccess: (r) => { toast.success(`${r.trigger.name} added`); onCreated(r); },
    onError: (e) => showError(e),
  });
  const ready = name.trim() && (target === "task" ? taskId.trim() : pid);
  return (
    <form className="mb-4 space-y-3 rounded-xl border border-line p-4" aria-label="New trigger" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={80} placeholder="Morning triage" onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Starts">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "schedule" | "webhook")}><option value="schedule">On a schedule</option><option value="webhook">From a webhook</option></Select>}</Field>
      </div>
      {kind === "schedule" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Repeat">{(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as "daily" | "every")}><option value="daily">Daily at a time</option><option value="every">Every few hours</option></Select>}</Field>
          {mode === "daily" ? (
            <Field label="Time (workspace time zone)">{(p) => <Input {...p} type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} />}</Field>
          ) : (
            <Field label="Every (hours)" hint="At least 1 hour.">{(p) => <Input {...p} type="number" min={1} max={744} value={everyHours} onChange={(e) => setEveryHours(Math.max(1, Number(e.target.value) || 1))} />}</Field>
          )}
          {mode === "daily" && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="accent-[#0071E3]" checked={weekdays} onChange={(e) => setWeekdays(e.target.checked)} />Weekdays only</label>}
        </div>
      )}
      {kind === "webhook" && <p className="text-xs text-muted">You get a URL and a signing secret after saving. The secret shows once.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Run on">{(p) => <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as "project" | "task")}><option value="project">A new task each time</option><option value="task">One existing task</option></Select>}</Field>
        {target === "project" ? (
          <Field label="Project">{(p) => <Select {...p} value={pid} onChange={(e) => setProjectId(e.target.value)}>{(projects.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        ) : (
          <Field label="Task" hint="A reference like MB-12.">{(p) => <Input {...p} value={taskId} placeholder="MB-12" onChange={(e) => setTaskId(e.target.value)} />}</Field>
        )}
      </div>
      {target === "project" && <Field label="Task title" hint="{trigger}, {date} and {datetime} are filled in.">{(p) => <Input {...p} value={titleTemplate} maxLength={200} onChange={(e) => setTitleTemplate(e.target.value)} />}</Field>}
      <Field label="Instructions for the agent">{(p) => <Textarea {...p} rows={3} value={instructions} maxLength={4000} placeholder="Read new support mail and file a task for each bug." onChange={(e) => setInstructions(e.target.value)} />}</Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={add.isPending} disabled={!ready}>Save trigger</Button>
      </div>
    </form>
  );
}
