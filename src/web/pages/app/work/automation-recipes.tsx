/**
 * R24.4 The Recipes tab on the automations page: ready rules grouped by category, searchable.
 * "Turn on" makes the rules at once when a recipe has no blanks, or opens a small sheet for the
 * blanks (channel, project, people, a word). Recipes already added show On with a switch and
 * "Edit as rule". Also the fields the rule dialog shows for the newer triggers and actions.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAssign, IconBellRing, IconBug, IconChatPlus, IconChatText, IconCheckCircle, IconCheckDouble, IconChecklist, IconDue, IconEye, IconFlag, IconHourglass, IconMailPlus, IconMailWarning, IconMails, IconMegaphone, IconMessageWarning, IconReceipt, IconRepeat, IconRocket, IconSearch, IconSiren, IconSnooze, IconTag, IconTimerOff, IconUserCheck, IconUserCog, IconVideo, IconZap, type IconComponent } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import type { AutomationRecipe, RecipeBlank } from "@/shared/automation-recipes";
import { useAssignees, useProjects } from "./data";

const ICONS: Record<string, IconComponent> = {
  AlarmClock: IconSnooze, BellRing: IconBellRing, Bug: IconBug, CalendarCheck: IconDue, CheckCheck: IconCheckDouble, CircleCheck: IconCheckCircle, Eye: IconEye, Flag: IconFlag, Hourglass: IconHourglass, ListChecks: IconChecklist, Mails: IconMails, MailPlus: IconMailPlus, MailWarning: IconMailWarning, Megaphone: IconMegaphone,
  MessageCircleWarning: IconMessageWarning, MessageSquarePlus: IconChatPlus, MessageSquareText: IconChatText, Receipt: IconReceipt, Repeat: IconRepeat, Rocket: IconRocket, Siren: IconSiren, Tag: IconTag, TimerOff: IconTimerOff, UserCheck: IconUserCheck, UserCog: IconUserCog, UserPlus: IconAssign, Video: IconVideo,
};

type Listed = AutomationRecipe & { added: boolean; on: boolean; automationIds: string[] };
interface RuleLike { id: string; trigger: string; conditions: Record<string, unknown>; action: string; actionConfig: Record<string, unknown>; enabled: boolean; name: string }

/** Plain words for the newer triggers and actions, for the rule list. */
export const R24_TRIGGER_LABEL: Record<string, string> = {
  task_created: "When a task is created", assignee_changed: "When a task is assigned", due_passed: "When a due date passes",
  meeting_ended: "When a meeting ends", chat_message_posted: "When a chat message has a word",
};
export const R24_ACTION_LABEL: Record<string, string> = {
  post_to_channel: "post in a channel", assign_task: "assign the task", set_status: "move the task", add_label: "add a label",
  set_priority: "set the priority", create_subtask_checklist: "add a checklist", notify: "notify someone", create_task: "make a task",
};

export function useChannels() {
  return useQuery({ queryKey: ["chat", "channels"], queryFn: async () => (await api.get<{ channels: { id: string; name: string; kind?: string; isPrivate?: boolean; archived?: boolean }[] }>("/chat/channels")).channels });
}

export function RecipesTab({ rules, onEditRule }: { rules: RuleLike[]; onEditRule: (r: RuleLike) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["automations", "recipes"], queryFn: () => api.get<{ categories: string[]; recipes: Listed[]; canManage: boolean }>("/automations/recipes") });
  const [term, setTerm] = useState("");
  const [filling, setFilling] = useState<Listed | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["automations"] })]);
  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return (q.data?.recipes ?? []).filter((r) => !t || `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(t));
  }, [q.data, term]);
  const enable = async (r: Listed, blanks: Record<string, unknown> = {}) => {
    setBusy(r.key);
    try { await api.post(`/automations/recipes/${r.key}/enable`, { blanks }); setFilling(null); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const toggle = async (r: Listed) => {
    setBusy(r.key);
    try { for (const id of r.automationIds) await api.patch(`/automations/${id}`, { enabled: !r.on }); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  if (q.isPending) return <Skeleton className="h-40" />;
  if (!q.data) return null;
  return (
    <div>
      <div className="relative mb-5 max-w-sm">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input aria-label="Search recipes" placeholder="Search recipes" value={term} onChange={(e) => setTerm(e.target.value)} className="pl-9" />
      </div>
      {!shown.length && <Card><EmptyState icon={<IconZap />} title="No recipes match" body="Try another word, or write your own rule." /></Card>}
      {q.data.categories.map((cat) => {
        const list = shown.filter((r) => r.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat} aria-label={cat} className="mb-6">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">{cat}</h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((r) => {
                const Icon = ICONS[r.icon] ?? IconZap;
                const rule = rules.find((x) => r.automationIds.includes(x.id));
                return (
                  <li key={r.key} data-recipe={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><Icon className="h-4.5 w-4.5" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium leading-5">{r.name}</div>
                        <p className="mt-1 text-[13px] text-muted">{r.description}</p>
                      </div>
                    </div>
                    <div className="mt-auto flex items-center gap-2 pt-4">
                      {r.added ? (
                        <>
                          {r.on ? <Badge tone="ok" dot>On</Badge> : <Badge>Off</Badge>}
                          <span className="flex-1" />
                          {rule && <Button size="sm" variant="ghost" onClick={() => onEditRule(rule)}>Edit as rule</Button>}
                          <Switch checked={r.on} disabled={!q.data!.canManage || busy === r.key} onChange={() => void toggle(r)} label={`Turn ${r.name} ${r.on ? "off" : "on"}`} />
                        </>
                      ) : (
                        <>
                          <span className="text-[12px] text-subtle">{r.blanks.length ? `${r.blanks.length} ${r.blanks.length === 1 ? "thing" : "things"} to pick` : "Ready as is"}</span>
                          <span className="flex-1" />
                          <Button size="sm" disabled={!q.data!.canManage} loading={busy === r.key} onClick={() => (r.blanks.length ? setFilling(r) : void enable(r))}>Turn on</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {filling && <BlanksSheet recipe={filling} busy={busy === filling.key} onClose={() => setFilling(null)} onSave={(b) => void enable(filling, b)} />}
    </div>
  );
}

function BlanksSheet({ recipe, busy, onClose, onSave }: { recipe: Listed; busy: boolean; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const ready = recipe.blanks.every((b) => { const v = vals[b.key]; return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== ""; });
  return (
    <Dialog open onClose={onClose} title={recipe.name} description={recipe.description}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={busy} onClick={() => onSave(vals)}>Turn on</Button></>}>
      <div className="space-y-3">
        {recipe.blanks.map((b) => <BlankField key={b.key} blank={b} value={vals[b.key]} onChange={(v) => setVals({ ...vals, [b.key]: v })} />)}
      </div>
    </Dialog>
  );
}

function BlankField({ blank, value, onChange }: { blank: RecipeBlank; value: unknown; onChange: (v: unknown) => void }) {
  const channels = useChannels();
  const projects = useProjects();
  const people = useAssignees();
  const members = (people.data ?? []).filter((p) => p.type === "member").map((p) => ({ id: p.id.slice(7), name: p.name }));
  if (blank.kind === "channel") return (
    <Field label={blank.label}>{(f) => <Select {...f} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a channel</option>
      {(channels.data ?? []).filter((c) => c.kind !== "dm" && !c.isPrivate && !c.archived).map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
    </Select>}</Field>
  );
  if (blank.kind === "project") return (
    <Field label={blank.label}>{(f) => <Select {...f} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a project</option>
      {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>}</Field>
  );
  if (blank.kind === "member") return (
    <Field label={blank.label}>{(f) => <Select {...f} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a person</option>
      {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </Select>}</Field>
  );
  if (blank.kind === "members") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">{blank.label}</legend>
        <div className="max-h-48 space-y-1 overflow-auto rounded-lg border border-line p-2">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-hover">
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => onChange(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />{m.name}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return <Field label={blank.label}>{(f) => <Input {...f} value={String(value ?? "")} placeholder={blank.placeholder} onChange={(e) => onChange(e.target.value)} />}</Field>;
}

/** Rule dialog fields for the newer triggers and actions ("Edit as rule"). */
export function R24RuleFields({ trigger, action, conditions, actionConfig, onConditions, onActionConfig }: {
  trigger: string; action: string; conditions: Record<string, unknown>; actionConfig: Record<string, unknown>;
  onConditions: (c: Record<string, unknown>) => void; onActionConfig: (a: Record<string, unknown>) => void;
}) {
  const channels = useChannels();
  const projects = useProjects();
  const c = conditions; const a = actionConfig;
  const setC = (k: string, v: unknown) => onConditions({ ...c, [k]: v === "" ? undefined : v });
  const setA = (k: string, v: unknown) => onActionConfig({ ...a, [k]: v === "" ? undefined : v });
  const taskTrigger = ["task_created", "assignee_changed", "due_passed", "status_changed"].includes(trigger);
  return (
    <div className="space-y-3">
      {taskTrigger && <div className="grid grid-cols-2 gap-3">
        <Field label="In project">{(f) => <Select {...f} value={String(c.projectId ?? "")} onChange={(e) => setC("projectId", e.target.value)}><option value="">Any project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <Field label="Priority">{(f) => <Select {...f} value={String(c.priority ?? "")} onChange={(e) => setC("priority", e.target.value)}><option value="">Any</option>{["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select>}</Field>
        <Field label="Type">{(f) => <Select {...f} value={String(c.type ?? "")} onChange={(e) => setC("type", e.target.value)}><option value="">Any</option>{["task", "story", "bug", "epic"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select>}</Field>
        <Field label="Has label">{(f) => <Input {...f} value={String(c.label ?? "")} onChange={(e) => setC("label", e.target.value)} />}</Field>
      </div>}
      {trigger === "chat_message_posted" && <Field label="Word to look for">{(f) => <Input {...f} value={String(c.keyword ?? "")} onChange={(e) => setC("keyword", e.target.value)} placeholder="todo" />}</Field>}
      {action === "post_to_channel" && <>
        <Field label="Channel">{(f) => <Select {...f} value={String(a.channelId ?? "")} onChange={(e) => setA("channelId", e.target.value)}><option value="">Pick a channel</option>{(channels.data ?? []).filter((x) => x.kind !== "dm" && !x.isPrivate).map((x) => <option key={x.id} value={x.id}>#{x.name}</option>)}</Select>}</Field>
        <Field label="Message" hint="You can use {task.title}, {task.ref}, {task.url}, {assignee} and {project}.">{(f) => <Input {...f} value={String(a.message ?? "")} onChange={(e) => setA("message", e.target.value)} />}</Field>
      </>}
      {action === "set_priority" && <Field label="Priority">{(f) => <Select {...f} value={String(a.priority ?? "")} onChange={(e) => setA("priority", e.target.value)}><option value="" disabled>Pick a priority</option>{["none", "low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select>}</Field>}
      {action === "add_label" && <Field label="Label">{(f) => <Input {...f} value={String(a.label ?? "")} onChange={(e) => setA("label", e.target.value)} />}</Field>}
      {action === "set_status" && <Field label="Status name">{(f) => <Input {...f} value={String(a.statusName ?? "")} onChange={(e) => setA("statusName", e.target.value)} placeholder="In review" />}</Field>}
      {action === "assign_task" && <Field label="Assign to">{(f) => <Select {...f} value={String(a.mode ?? "")} onChange={(e) => setA("mode", e.target.value)}><option value="" disabled>Pick who</option><option value="lead">The project lead</option><option value="member">One person</option><option value="round_robin">People in turn</option></Select>}</Field>}
    </div>
  );
}
