import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Button } from "@/web/components/ui/button";
import { IconPlus, IconTrash } from "@/web/components/ui/icon";
import {
  ACTION_LABEL, CONDITION_OPS, FLOW_ACTIONS, FLOW_TRIGGERS, KIND_LABEL, OP_LABEL, TASK_ONLY_ACTIONS, TASK_TRIGGERS, TRIGGER_FIELDS, TRIGGER_LABEL,
  type ConditionRule, type FlowAction, type FlowNode, type FlowTrigger,
} from "@/shared/flows";
import { useProjects, useAssignees } from "../work/data";
import { useChannels, useEndpoints, useForms } from "./api";

type Cfg = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** The settings of one step, used by the side panel on desktop and the sheet on phones. */
export function StepForm({ node, trigger, onChange, onDelete, readOnly }: {
  node: FlowNode; trigger: FlowTrigger; onChange: (patch: { config?: Cfg; label?: string }) => void; onDelete?: () => void; readOnly?: boolean;
}) {
  const c = node.config;
  const set = (patch: Cfg) => onChange({ config: { ...c, ...patch } });
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <legend className="sr-only">{KIND_LABEL[node.kind]} settings</legend>
      {node.kind !== "trigger" && (
        <Field label="Name on the canvas" hint="Optional. A short name helps in the run log.">{(fp) => <Input {...fp} value={node.label ?? ""} maxLength={80} onChange={(e) => onChange({ label: e.target.value })} placeholder={KIND_LABEL[node.kind]} />}</Field>
      )}
      {node.kind === "trigger" && <TriggerFields c={c} set={set} />}
      {node.kind === "condition" && <ConditionFields c={c} set={set} trigger={trigger} />}
      {node.kind === "wait" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait for">{(fp) => <Input {...fp} type="number" min={1} max={720} value={s(c.amount)} onChange={(e) => set({ amount: Number(e.target.value) })} />}</Field>
          <Field label="Unit">{(fp) => <Select {...fp} value={s(c.unit) || "hours"} onChange={(e) => set({ unit: e.target.value })}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></Select>}</Field>
          <p className="col-span-2 text-[12px] text-subtle">Up to 30 days. The run carries on by itself when the time is up.</p>
        </div>
      )}
      {node.kind === "approval" && <ApprovalFields c={c} set={set} />}
      {node.kind === "action" && <ActionFields c={c} set={set} trigger={trigger} />}
      {node.kind === "stop" && <p className="text-[13px] text-muted">The run ends here. Use it on a branch that should do nothing.</p>}
      {onDelete && node.kind !== "trigger" && !readOnly && (
        <Button variant="danger" size="sm" onClick={onDelete}><IconTrash className="h-4 w-4" />Delete step</Button>
      )}
    </fieldset>
  );
}

function TriggerFields({ c, set }: { c: Cfg; set: (p: Cfg) => void }) {
  const t = (s(c.trigger) || "manual") as FlowTrigger;
  const forms = useForms();
  return (
    <>
      <Field label="What starts the flow">{(fp) => <Select {...fp} value={t} onChange={(e) => set({ trigger: e.target.value })}>
          {FLOW_TRIGGERS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
        </Select>}</Field>
      {(t === "page_changed" || t === "feed_item") && (
        <>
          <Field label={t === "page_changed" ? "Page address" : "Feed address"} hint={t === "page_changed" ? "A public web page. It is read the way a visitor sees it; sites that ask robots to stay away are left alone." : "An RSS or Atom feed. The first check learns what is there; only new items start the flow."}>{(fp) => <Input {...fp} type="url" inputMode="url" value={s(c.url)} placeholder="https://" onChange={(e) => set({ url: e.target.value })} />}</Field>
          {t === "page_changed" && (
            <Field label="Only this part of the page" hint="Optional, for example #price or .opening-hours. Leave empty to watch the whole page.">{(fp) => <Input {...fp} value={s(c.selector)} placeholder="#price" onChange={(e) => set({ selector: e.target.value })} />}</Field>
          )}
          <Field label="Check">{(fp) => <Select {...fp} value={s(c.every) || "360"} onChange={(e) => set({ every: Number(e.target.value) })}>
              <option value="60">Every hour</option><option value="360">Every 6 hours</option><option value="1440">Once a day</option>
            </Select>}</Field>
        </>
      )}
      {t === "form_submitted" && (
        <Field label="Form" hint="Leave on any form to run for every form.">{(fp) => <Select {...fp} value={s(c.formId)} onChange={(e) => set({ formId: e.target.value || undefined })}>
            <option value="">Any form</option>
            {(forms.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>}</Field>
      )}
      {t === "status_changed" && (
        <Field label="Only when it moves to">{(fp) => <Select {...fp} value={s(c.category)} onChange={(e) => set({ category: e.target.value || undefined })}>
            <option value="">Any status</option><option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option>
          </Select>}</Field>
      )}
      <p className="text-[12px] text-subtle">Hands on: {(TRIGGER_FIELDS[t] ?? []).map((f) => f.label.toLowerCase()).join(", ")}.</p>
    </>
  );
}

function ConditionFields({ c, set, trigger }: { c: Cfg; set: (p: Cfg) => void; trigger: FlowTrigger }) {
  const rules = (Array.isArray(c.rules) ? c.rules : []) as ConditionRule[];
  const fields = TRIGGER_FIELDS[trigger] ?? [];
  const put = (i: number, patch: Partial<ConditionRule>) => set({ rules: rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-3">
      <Field label="Go down Yes when">{(fp) => <Select {...fp} value={s(c.match) || "all"} onChange={(e) => set({ match: e.target.value })}><option value="all">All of these are true</option><option value="any">Any of these is true</option></Select>}</Field>
      {rules.map((r, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select aria-label={`Field ${i + 1}`} value={r.field} onChange={(e) => put(i, { field: e.target.value })}>
              {fields.map((f) => <option key={f.key} value={`trigger.${f.key}`}>{f.label}</option>)}
              {!fields.some((f) => `trigger.${f.key}` === r.field) && <option value={r.field}>{r.field}</option>}
            </Select>
            <Select aria-label={`Test ${i + 1}`} value={r.op} onChange={(e) => put(i, { op: e.target.value as ConditionRule["op"] })}>
              {CONDITION_OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
            </Select>
          </div>
          {r.op !== "is_empty" && r.op !== "is_not_empty" && <Input aria-label={`Value ${i + 1}`} value={s(r.value)} onChange={(e) => put(i, { value: e.target.value })} placeholder="Value" />}
          {rules.length > 1 && <button type="button" className="text-[12px] text-muted hover:text-bad max-sm:min-h-11" onClick={() => set({ rules: rules.filter((_, k) => k !== i) })}>Remove this test</button>}
        </div>
      ))}
      {rules.length < 8 && <Button type="button" variant="outline" size="sm" onClick={() => set({ rules: [...rules, { field: `trigger.${fields[0]?.key ?? "title"}`, op: "contains", value: "" }] })}><IconPlus className="h-4 w-4" />Add a test</Button>}
    </div>
  );
}

function ApprovalFields({ c, set }: { c: Cfg; set: (p: Cfg) => void }) {
  const people = useAssignees();
  const members = (people.data ?? []).filter((p) => (p as { type?: string }).type !== "agent");
  return (
    <>
      <Field label="Who approves">{(fp) => <Select {...fp} value={s(c.approver)} onChange={(e) => set({ approver: e.target.value || undefined })}>
          <option value="">Any admin</option>
          {members.map((p) => <option key={(p as { id: string }).id} value={(p as { id: string }).id}>{(p as { name: string }).name}</option>)}
        </Select>}</Field>
      <Field label="What they are asked" hint="Shown in Home, Approvals and in the notification. Placeholders like {trigger.title} work here.">{(fp) => <Textarea {...fp} rows={3} maxLength={500} value={s(c.note)} onChange={(e) => set({ note: e.target.value })} placeholder="OK to go ahead?" />}</Field>
      <p className="text-[12px] text-subtle">Approve carries on. Reject stops the run with the reason.</p>
    </>
  );
}

function ActionFields({ c, set, trigger }: { c: Cfg; set: (p: Cfg) => void; trigger: FlowTrigger }) {
  const action = (s(c.action) || "notify") as FlowAction;
  const projects = useProjects();
  const people = useAssignees();
  const channels = useChannels();
  const endpoints = useEndpoints();
  const taskTrigger = TASK_TRIGGERS.includes(trigger);
  const hint = `Placeholders: ${(TRIGGER_FIELDS[trigger] ?? []).slice(0, 3).map((f) => `{trigger.${f.key}}`).join(", ")}`;
  const projectList = ((projects.data as unknown as { id: string; name: string }[] | { projects?: { id: string; name: string }[] } | undefined) ?? []);
  const plist = Array.isArray(projectList) ? projectList : projectList.projects ?? [];
  return (
    <>
      <Field label="What this step does">{(fp) => <Select {...fp} value={action} onChange={(e) => set({ action: e.target.value })}>
          {FLOW_ACTIONS.filter((a) => taskTrigger || !TASK_ONLY_ACTIONS.includes(a) || a === action).map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
        </Select>}</Field>
      {action === "create_task" && (
        <>
          <Field label="Task title" hint={hint}>{(fp) => <Input {...fp} value={s(c.title)} maxLength={200} onChange={(e) => set({ title: e.target.value })} placeholder="Follow up: {trigger.title}" />}</Field>
          <Field label="Project">{(fp) => <Select {...fp} value={s(c.projectId)} onChange={(e) => set({ projectId: e.target.value || undefined })}><option value="">Default</option>{plist.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority">{(fp) => <Select {...fp} value={s(c.priority)} onChange={(e) => set({ priority: e.target.value || undefined })}><option value="">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}</Field>
            <Field label="Due in days">{(fp) => <Input {...fp} type="number" min={0} max={365} value={s(c.dueInDays)} onChange={(e) => set({ dueInDays: e.target.value ? Number(e.target.value) : undefined })} />}</Field>
          </div>
          <Field label="Notes">{(fp) => <Textarea {...fp} rows={3} value={s(c.notes)} maxLength={4000} onChange={(e) => set({ notes: e.target.value })} />}</Field>
        </>
      )}
      {action === "notify" && (
        <>
          <Field label="Who">{(fp) => <Select {...fp} value={s(c.to) || "admins"} onChange={(e) => set({ to: e.target.value })}>
            <option value="admins">Admins</option>{taskTrigger && <option value="assignee">The person on the task</option>}
            {(people.data ?? []).filter((p) => (p as { type?: string }).type !== "agent").map((p) => <option key={(p as { id: string }).id} value={(p as { id: string }).id}>{(p as { name: string }).name}</option>)}
          </Select>}</Field>
          <Field label="Message" hint={hint}>{(fp) => <Input {...fp} value={s(c.message)} maxLength={200} onChange={(e) => set({ message: e.target.value })} />}</Field>
        </>
      )}
      {action === "post_to_channel" && (
        <>
          <Field label="Channel" error={channels.data && !channels.data.length ? "No public channels yet. Make one in Chat." : undefined}>{(fp) => <Select {...fp} value={s(c.channelId)} onChange={(e) => set({ channelId: e.target.value })}><option value="">Pick a channel</option>{(channels.data ?? []).map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}</Select>}</Field>
          <Field label="Message" hint={hint}>{(fp) => <Textarea {...fp} rows={3} maxLength={4000} value={s(c.message)} onChange={(e) => set({ message: e.target.value })} />}</Field>
        </>
      )}
      {action === "send_webhook" && (
        <Field label="Webhook" hint="Sent signed, retried with backoff if the other side is down, and listed in the webhook delivery log." error={endpoints.data && !endpoints.data.length ? "No webhooks yet. Add one in Settings, Connections, Webhooks." : undefined}>{(fp) => <Select {...fp} value={s(c.endpointId)} onChange={(e) => set({ endpointId: e.target.value })}><option value="">Pick a webhook</option>{(endpoints.data ?? []).map((ep) => <option key={ep.id} value={ep.id} disabled={!ep.enabled}>{ep.description || ep.url}{ep.enabled ? "" : " (off)"}</option>)}</Select>}</Field>
      )}
      {action === "add_to_digest" && (
        <>
          <Field label="Send">{(fp) => <Select {...fp} value={s(c.every) || "daily"} onChange={(e) => set({ every: e.target.value })}><option value="daily">Every morning at 8</option><option value="weekly">Mondays at 8</option></Select>}</Field>
          <Field label="To">{(fp) => <Select {...fp} value={s(c.to) || "admins"} onChange={(e) => set({ to: e.target.value })}><option value="admins">Admins</option>{(people.data ?? []).filter((p) => (p as { type?: string }).type !== "agent").map((p) => <option key={(p as { id: string }).id} value={(p as { id: string }).id}>{(p as { name: string }).name}</option>)}</Select>}</Field>
          <Field label="Item title" hint={hint}>{(fp) => <Input {...fp} value={s(c.title)} onChange={(e) => set({ title: e.target.value })} placeholder="{trigger.title}" />}</Field>
          <Field label="Item link">{(fp) => <Input {...fp} value={s(c.link)} onChange={(e) => set({ link: e.target.value })} placeholder="{trigger.link}" />}</Field>
          <Field label="Mail subject" hint="Optional.">{(fp) => <Input {...fp} value={s(c.subject)} maxLength={160} onChange={(e) => set({ subject: e.target.value })} />}</Field>
        </>
      )}
      {action === "set_status" && (
        <Field label="Move the task to">{(fp) => <Select {...fp} value={s(c.category)} onChange={(e) => set({ category: e.target.value, statusName: undefined })}><option value="">Pick a stage</option><option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option></Select>}</Field>
      )}
      {action === "set_priority" && (
        <Field label="Priority">{(fp) => <Select {...fp} value={s(c.priority)} onChange={(e) => set({ priority: e.target.value })}><option value="">Pick one</option><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}</Field>
      )}
      {action === "add_label" && <Field label="Label">{(fp) => <Input {...fp} value={s(c.label)} maxLength={40} onChange={(e) => set({ label: e.target.value })} />}</Field>}
    </>
  );
}
