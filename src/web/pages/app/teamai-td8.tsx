/**
 * TD8 Team AI (flag TEAMAI_TD8): Settings > Team AI. What the assistant remembers (visible and editable), saved
 * instruction sets, routines on a schedule or a trigger, and the run log. Uses the workspace's own AI key only; when the
 * workspace turned AI off, nothing is sent to an AI provider and the page says so.
 */
import { useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { quickRetry } from "@/web/lib/quick-retry-pol1";
import { api, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { useDialogs } from "@/web/components/ui/confirm";
import {
  REASON_TEXT, ROUTINE_TRIGGERS, TEAMAI_CAPS, TRIGGER_LABEL, WEEKDAYS, describeSchedule, whenInZone,
  type InstructionSet, type MemoryEntry, type Routine, type RoutineOutput, type RoutineTrigger, type RunEntry, type TeamAiState,
} from "@/shared/teamai-td8";

const qk = {
  state: ["team-ai", "state"] as const,
  memory: ["team-ai", "memory"] as const,
  instructions: ["team-ai", "instructions"] as const,
  routines: ["team-ai", "routines"] as const,
  runs: ["team-ai", "runs"] as const,
};
const TABS = [["memory", "Memory"], ["instructions", "Instructions"], ["routines", "Routines"], ["runs", "Run log"]] as const;
type Tab = (typeof TABS)[number][0];
/** POL2 (HQ MB-328): the header names the AI source actually in use, never "own key" on built in AI. */
export const aiSourceLine = (source: "own_key" | "built_in" | "none" | undefined) =>
  source === "own_key" ? " It uses your workspace's own AI key." : source === "built_in" ? " It runs on free built in AI until you add your own key." : "";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

function Loading({ label }: { label: string }) {
  return <div className="space-y-2" role="status" aria-busy="true" aria-label={label}><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>;
}

export function TeamAiPage() {
  const config = useConfig();
  const on = !!config.data?.teamaiTd8;
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? "memory") as Tab;
  const state = useQuery({ queryKey: qk.state, queryFn: () => api.get<TeamAiState>("/team-ai/state"), enabled: on, ...quickRetry });
  if (config.data && !on) {
    return <EmptyState title="Team AI is not available yet" body="It is coming to your workspace soon." />;
  }
  const s = state.data;
  const go = (t: Tab) => setParams(t === "memory" ? {} : { tab: t }, { replace: true });
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
    go(next);
    document.getElementById(`teamai-tab-${next}`)?.focus();
  };
  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="teamai-page">
      <PageHeader title="Team AI" description={`What the assistant remembers, instructions your team reuses, and routines that write drafts or chat messages.${aiSourceLine(s?.ai.source)}`} />
      {state.isError && !s ? <LoadError onRetry={() => state.refetch()} /> : !s ? <Loading label="Loading Team AI" /> : (
        <>
          <AiStatus s={s} />
          <div role="tablist" aria-label="Team AI sections" className="mb-4 inline-flex max-w-full overflow-x-auto rounded-lg bg-fill p-0.5">
            {TABS.map(([t, l], i) => (
              <button key={t} id={`teamai-tab-${t}`} role="tab" type="button" aria-selected={tab === t} aria-controls={`teamai-panel-${t}`} tabIndex={tab === t ? 0 : -1}
                onClick={() => go(t)} onKeyDown={(e) => onKey(e, i)} data-testid={`teamai-tab-${t}`}
                className={cn("min-h-9 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors", tab === t ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>{l}</button>
            ))}
          </div>
          <div role="tabpanel" id={`teamai-panel-${tab}`} aria-labelledby={`teamai-tab-${tab}`}>
            {tab === "memory" && <MemoryTab s={s} />}
            {tab === "instructions" && <InstructionsTab s={s} />}
            {tab === "routines" && <RoutinesTab s={s} />}
            {tab === "runs" && <RunsTab s={s} />}
          </div>
        </>
      )}
    </div>
  );
}

function AiStatus({ s }: { s: TeamAiState }) {
  if (!s.ai.on) {
    return (
      <Card className="mb-4 border-warning/40 p-4" data-testid="teamai-off" role="status">
        <p className="text-[14px] font-semibold text-fg">AI is off for this workspace</p>
        <p className="mt-1 text-[13px] text-muted">Nothing is sent to an AI provider. Routines and chat answers pause and the run log says why. You can still keep notes and instruction sets{s.isAdmin ? ", and turn AI back on in Settings" : "; an admin can turn AI back on"}.</p>
      </Card>
    );
  }
  if (s.ai.source === "built_in") {
    const left = Math.max(0, s.ai.freeLimit - s.ai.freeUsed);
    const when = s.ai.freePeriod === "week" ? "this week" : "today";
    return (
      <Card className="mb-4 p-4" data-testid="teamai-built-in" role="status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[14px] font-semibold text-fg">Ready on free built in AI</p>
          <Badge tone={left === 0 ? "warn" : "neutral"}>{left} of {s.ai.freeLimit} free runs left {when}</Badge>
        </div>
        <p className="mt-1 text-[13px] text-muted">Your workspace has no AI key of its own, so Team AI uses free built in AI with a {s.ai.freePeriod === "week" ? "weekly" : "daily"} limit. It is never charged. Ask in any channel: type <span className="font-mono text-fg">@assistant</span> and your question.{left === 0 ? (s.ai.freePeriod === "week" ? " This week's free runs are used up; they come back on Monday." : " Today's free runs are used up; they come back tomorrow.") : ""}</p>
        {s.isAdmin && <Link to="/app/settings" className="mt-2 inline-flex min-h-9 items-center text-[13px] font-medium text-brand-hover hover:underline">Add your own key for unlimited use</Link>}
      </Card>
    );
  }
  if (!s.ai.key) {
    return (
      <Card className="mb-4 p-4" data-testid="teamai-no-key" role="status">
        <p className="text-[14px] font-semibold text-fg">Connect your own AI key</p>
        <p className="mt-1 text-[13px] text-muted">Team AI runs only on your workspace's own key (OpenAI, Anthropic, OpenRouter or Groq). Until one is connected, nothing runs and nothing is charged.</p>
        {s.isAdmin && <Link to="/app/settings" className="mt-2 inline-flex min-h-9 items-center text-[13px] font-medium text-brand-hover hover:underline">Add a key in Settings</Link>}
      </Card>
    );
  }
  return (
    <Card className="mb-4 flex flex-wrap items-center justify-between gap-2 p-4" data-testid="teamai-ready">
      <p className="text-[13px] text-muted"><span className="font-medium text-fg">Ready</span> on your {s.ai.provider ?? "AI"} key. Ask in any channel: type <span className="font-mono text-fg">@assistant</span> and your question. It answers in the thread from items everyone in the channel can open.</p>
      <Badge tone={s.usedToday >= s.caps.runsPerDay ? "warn" : "neutral"}>{s.usedToday} of {s.caps.runsPerDay} runs today</Badge>
    </Card>
  );
}

// ---------------------------------------------------------------- memory

function MemoryTab({ s }: { s: TeamAiState }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.memory, queryFn: () => api.get<{ memory: MemoryEntry[] }>("/team-ai/memory"), ...quickRetry });
  const [text, setText] = useState("");
  const { confirm, prompt, dialogs } = useDialogs();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.memory });
  const add = useMutation({
    mutationFn: () => api.create<MemoryEntry>("/team-ai/memory", { text }),
    // POL2 (HQ MB-327): focus stays in the note box (the button goes disabled once the box is empty).
    onSuccess: async (m) => { setText(""); document.querySelector<HTMLElement>("[data-testid='memory-input']")?.focus(); await refresh(); toast.success(m.status === "active" ? "Note added" : "Suggestion sent to your admins"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); await refresh(); toast.success(done); } catch (e) { toast.error(errorMessage(e)); } };
  const edit = async (m: MemoryEntry) => {
    const v = await prompt({ title: "Edit note", label: "Note", initial: m.text, multiline: true, confirmLabel: "Save" });
    if (v !== null) await act(() => api.patch(`/team-ai/memory/${encodeURIComponent(m.id)}`, { text: v }), "Note saved");
  };
  const remove = async (m: MemoryEntry) => {
    if (!(await confirm({ title: "Delete this note?", description: "The assistant stops using it at once.", confirmLabel: "Delete", tone: "danger" }))) return;
    await act(() => api.del(`/team-ai/memory/${encodeURIComponent(m.id)}`), "Note deleted");
  };
  const items = q.data?.memory ?? [];
  return (
    <section aria-label="Memory" className="space-y-4">
      <Card className="p-4">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) add.mutate(); }}>
          <Field label={s.isAdmin ? "Add a note the assistant should know" : "Suggest a note for the assistant"} hint={s.isAdmin ? "Facts about your team, like opening hours or how you name projects. The assistant uses only the notes listed here." : "An admin reviews it before the assistant uses it."}>
            {(x) => <Textarea {...x} value={text} onChange={(e) => setText(e.target.value)} maxLength={TEAMAI_CAPS.memoryChars} rows={2} data-testid="memory-input" placeholder="Our support hours are 9 to 5, Monday to Friday" />}
          </Field>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted">{text.length} of {TEAMAI_CAPS.memoryChars}</span>
            <Button type="submit" size="sm" loading={add.isPending} disabled={text.trim().length < 3} data-testid="memory-add">{s.isAdmin ? "Add note" : "Suggest"}</Button>
          </div>
        </form>
      </Card>
      {q.isError && !q.data ? <LoadError onRetry={() => q.refetch()} /> : !q.data ? <Loading label="Loading notes" /> : !items.length ? (
        <EmptyState title="Nothing remembered yet" body="The assistant remembers only what you add here, and everyone can see it." />
      ) : (
        <ul className="space-y-2" data-testid="memory-list">
          {items.map((m) => (
            <li key={m.id}>
              <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="whitespace-pre-wrap break-words text-[14px] text-fg">{m.text}</p>
                  <p className="mt-1 text-[12px] text-muted">
                    {m.status === "suggested" && <Badge tone="warn" className="mr-2">Suggested</Badge>}
                    Added by {m.createdByName || "someone"} {when(m.createdAt)}{m.updatedAt !== m.createdAt ? `, edited by ${m.updatedByName || "someone"} ${when(m.updatedAt)}` : ""}
                  </p>
                </div>
                {(s.isAdmin || (m.mine && m.status === "suggested")) && (
                  <div className="flex shrink-0 gap-1">
                    {s.isAdmin && m.status === "suggested" && <Button size="sm" variant="secondary" onClick={() => void act(() => api.post(`/team-ai/memory/${encodeURIComponent(m.id)}/accept`), "Note accepted")}>Accept</Button>}
                    {s.isAdmin && <Button size="sm" variant="ghost" onClick={() => void edit(m)} aria-label={`Edit note: ${m.text.slice(0, 40)}`}>Edit</Button>}
                    <Button size="sm" variant="ghost" onClick={() => void remove(m)} aria-label={`Delete note: ${m.text.slice(0, 40)}`}>{m.status === "suggested" && !s.isAdmin ? "Withdraw" : "Delete"}</Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {dialogs}
    </section>
  );
}

// ---------------------------------------------------------------- instruction sets

function InstructionDialog({ s, open, initial, onClose }: { s: TeamAiState; open: boolean; initial: InstructionSet | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [shared, setShared] = useState(initial?.shared ?? false);
  const save = useMutation({
    mutationFn: () => (initial ? api.patch(`/team-ai/instructions/${encodeURIComponent(initial.id)}`, { name, body, ...(s.isAdmin ? { shared } : {}) })
      : api.create("/team-ai/instructions", { name, body, shared: s.isAdmin && shared })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: qk.instructions }); toast.success("Instruction set saved"); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title={initial ? "Edit instruction set" : "New instruction set"} description="A named instruction your team can run again, by hand or in a routine."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!name.trim() || body.trim().length < 3} onClick={() => save.mutate()} data-testid="ins-save">Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(x) => <Input {...x} value={name} onChange={(e) => setName(e.target.value)} maxLength={TEAMAI_CAPS.nameChars} data-testid="ins-name" placeholder="Weekly summary" />}</Field>
        <Field label="Instructions" hint={`${body.length} of ${TEAMAI_CAPS.bodyChars.toLocaleString()}`}>
          {(x) => <Textarea {...x} value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={TEAMAI_CAPS.bodyChars} data-testid="ins-body" placeholder="Write a short, friendly summary of this for the team, with next steps." />}
        </Field>
        {s.isAdmin && <Switch checked={shared} onChange={setShared} label="Share with the workspace (members can use it, admins can change it)" />}
      </div>
    </Dialog>
  );
}

function InstructionsTab({ s }: { s: TeamAiState }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.instructions, queryFn: () => api.get<{ instructions: InstructionSet[] }>("/team-ai/instructions"), ...quickRetry });
  const [edit, setEdit] = useState<{ ins: InstructionSet | null } | null>(null);
  const [result, setResult] = useState<RunEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialogs } = useDialogs();
  const run = async (i: InstructionSet) => {
    setBusy(i.id);
    try { const r = await api.post<RunEntry>(`/team-ai/instructions/${encodeURIComponent(i.id)}/run`); setResult(r); await qc.invalidateQueries({ queryKey: qk.runs }); await qc.invalidateQueries({ queryKey: qk.state }); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const remove = async (i: InstructionSet) => {
    if (!(await confirm({ title: `Delete ${i.name}?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/team-ai/instructions/${encodeURIComponent(i.id)}`); await qc.invalidateQueries({ queryKey: qk.instructions }); toast.success("Instruction set deleted"); } catch (e) { toast.error(errorMessage(e)); }
  };
  const items = q.data?.instructions ?? [];
  const canRun = s.ai.on && s.ai.source !== "none";
  return (
    <section aria-label="Instructions" className="space-y-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEdit({ ins: null })} data-testid="ins-new">New instruction set</Button></div>
      {q.isError && !q.data ? <LoadError onRetry={() => q.refetch()} /> : !q.data ? <Loading label="Loading instruction sets" /> : !items.length ? (
        <EmptyState title="No instruction sets yet" body="Save an instruction once and run it again whenever you need it, or use it in a routine." action={<Button size="sm" onClick={() => setEdit({ ins: null })}>New instruction set</Button>} />
      ) : (
        <ul className="space-y-2" data-testid="ins-list">
          {items.map((i) => (
            <li key={i.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-fg">{i.name} {i.shared ? <Badge className="ml-1">Shared</Badge> : <Badge tone="neutral" className="ml-1">Only you</Badge>}</p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted">{i.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="secondary" loading={busy === i.id} disabled={!canRun} onClick={() => void run(i)} title={canRun ? undefined : "Needs AI on and an AI source"}>Try it</Button>
                    {i.canEdit && <Button size="sm" variant="ghost" onClick={() => setEdit({ ins: i })} aria-label={`Edit ${i.name}`}>Edit</Button>}
                    {i.canEdit && <Button size="sm" variant="ghost" onClick={() => void remove(i)} aria-label={`Delete ${i.name}`}>Delete</Button>}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {edit && <InstructionDialog s={s} open initial={edit.ins} onClose={() => setEdit(null)} />}
      <Dialog open={!!result} onClose={() => setResult(null)} title={result?.status === "done" ? "Draft" : "Not run"} footer={<><Button variant="secondary" onClick={() => setResult(null)}>Done</Button></>}>
        {result?.status === "done" ? (
          <div className="space-y-2"><p className="whitespace-pre-wrap break-words text-[14px] text-fg" data-testid="try-result">{result.result}</p><CopyButton value={result.result ?? ""} label="Copy" /></div>
        ) : <p className="text-[14px] text-muted" data-testid="try-result">{result?.reasonText ?? "It did not run."}</p>}
      </Dialog>
      {dialogs}
    </section>
  );
}

// ---------------------------------------------------------------- routines

function RoutineDialog({ s, initial, onClose }: { s: TeamAiState; initial: Routine | null; onClose: () => void }) {
  const qc = useQueryClient();
  const ins = useQuery({ queryKey: qk.instructions, queryFn: () => api.get<{ instructions: InstructionSet[] }>("/team-ai/instructions"), ...quickRetry });
  const usable = (ins.data?.instructions ?? []).filter((i) => i.shared || i.mine);
  const [v, setV] = useState({
    name: initial?.name ?? "", instructionId: initial?.instructionId ?? "", trigger: (initial?.trigger ?? "daily") as RoutineTrigger, hour: initial?.hour ?? 9, weekday: initial?.weekday ?? 1,
    formId: initial?.formId ?? "", projectId: initial?.projectId ?? "", output: (initial?.output ?? "draft") as RoutineOutput, channelId: initial?.channelId ?? "",
  });
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((o) => ({ ...o, [k]: x }));
  const save = useMutation({
    mutationFn: () => {
      const b = { ...v, formId: v.formId || null, projectId: v.projectId || null, channelId: v.channelId || null };
      return initial ? api.patch(`/team-ai/routines/${encodeURIComponent(initial.id)}`, b) : api.create("/team-ai/routines", b);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: qk.routines }); toast.success("Routine saved"); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ok = v.name.trim() && v.instructionId && (v.output !== "chat" || v.channelId) && (v.trigger !== "form_response" || v.formId);
  return (
    <Dialog open onClose={onClose} title={initial ? "Edit routine" : "New routine"} description="Runs an instruction set on a schedule or when something happens. The result is a draft or a chat message, never an email."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()} data-testid="routine-save">Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(x) => <Input {...x} value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={TEAMAI_CAPS.nameChars} data-testid="routine-name" placeholder="Monday summary" />}</Field>
        <Field label="Instruction set" hint={usable.length ? undefined : "Make an instruction set first."}>
          {(x) => <Select {...x} value={v.instructionId} onChange={(e) => set("instructionId", e.target.value)} data-testid="routine-ins">
            <option value="">Pick one</option>
            {usable.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>}
        </Field>
        <Field label="When it runs">
          {(x) => <Select {...x} value={v.trigger} onChange={(e) => set("trigger", e.target.value as RoutineTrigger)} data-testid="routine-trigger">
            {ROUTINE_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </Select>}
        </Field>
        {(v.trigger === "daily" || v.trigger === "weekly") && (
          <div className="grid grid-cols-2 gap-3">
            {v.trigger === "weekly" && (
              <Field label="Day">{(x) => <Select {...x} value={String(v.weekday)} onChange={(e) => set("weekday", Number(e.target.value))}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>}</Field>
            )}
            <Field label="Hour, workspace time">{(x) => <Select {...x} value={String(v.hour)} onChange={(e) => set("hour", Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>)}</Select>}</Field>
          </div>
        )}
        {v.trigger === "task_created" && (
          <Field label="Project">{(x) => <Select {...x} value={v.projectId} onChange={(e) => set("projectId", e.target.value)}><option value="">Any project</option>{s.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        )}
        {v.trigger === "form_response" && (
          <Field label="Form">{(x) => <Select {...x} value={v.formId} onChange={(e) => set("formId", e.target.value)}><option value="">Pick a form</option>{s.forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
        )}
        <Field label="Result goes to">
          {(x) => <Select {...x} value={v.output} onChange={(e) => set("output", e.target.value as RoutineOutput)} data-testid="routine-output">
            <option value="draft">A draft in the run log</option>
            <option value="chat">A message in a channel</option>
          </Select>}
        </Field>
        {v.output === "chat" && (
          <Field label="Channel" hint="Everyone who can read the channel sees the message.">
            {(x) => <Select {...x} value={v.channelId} onChange={(e) => set("channelId", e.target.value)} data-testid="routine-channel"><option value="">Pick a channel</option>{s.channels.map((c) => <option key={c.id} value={c.id}>{c.private ? `${c.name} (private)` : c.name}</option>)}</Select>}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function RoutinesTab({ s }: { s: TeamAiState }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.routines, queryFn: () => api.get<{ routines: Routine[] }>("/team-ai/routines"), ...quickRetry });
  const [edit, setEdit] = useState<{ r: Routine | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialogs } = useDialogs();
  const refresh = async () => { await qc.invalidateQueries({ queryKey: qk.routines }); await qc.invalidateQueries({ queryKey: qk.runs }); await qc.invalidateQueries({ queryKey: qk.state }); };
  const toggle = async (r: Routine, enabled: boolean) => { try { await api.patch(`/team-ai/routines/${encodeURIComponent(r.id)}`, { enabled }); await refresh(); } catch (e) { toast.error(errorMessage(e)); } };
  const runNow = async (r: Routine) => {
    setBusy(r.id);
    try { const x = await api.post<RunEntry>(`/team-ai/routines/${encodeURIComponent(r.id)}/run`); await refresh(); if (x.status === "done") toast.success(x.output === "chat" ? "Posted in the channel" : "Draft ready in the run log"); else toast.message(x.reasonText ?? "It did not run"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const remove = async (r: Routine) => {
    if (!(await confirm({ title: `Delete ${r.name}?`, description: "Its past runs stay in the run log.", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/team-ai/routines/${encodeURIComponent(r.id)}`); await refresh(); toast.success("Routine deleted"); } catch (e) { toast.error(errorMessage(e)); }
  };
  const items = q.data?.routines ?? [];
  return (
    <section aria-label="Routines" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{s.isAdmin ? `Up to ${s.caps.routinesMax} routines and ${s.caps.runsPerDay} runs a day.` : "Admins set up routines."}</p>
        {s.isAdmin && <Button size="sm" onClick={() => setEdit({ r: null })} disabled={items.length >= s.caps.routinesMax} data-testid="routine-new">New routine</Button>}
      </div>
      {q.isError && !q.data ? <LoadError onRetry={() => q.refetch()} /> : !q.data ? <Loading label="Loading routines" /> : !items.length ? (
        <EmptyState title="No routines yet" body={s.isAdmin ? "Run an instruction set every morning, or when a task or form response comes in." : "Your admins have not set up any routines."} />
      ) : (
        <ul className="space-y-2" data-testid="routine-list">
          {items.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-fg">{r.name}</p>
                  <p className="mt-0.5 text-[12.5px] text-muted">
                    {describeSchedule(r)}, {r.output === "chat" ? `posts in ${r.channelName ?? "a channel"}` : "writes a draft"}. Uses {r.instructionName ?? "a deleted instruction set"}.
                    {r.lastRunAt ? ` Last run ${when(r.lastRunAt)}${r.lastStatus && r.lastStatus !== "done" ? ` (${r.lastStatus})` : ""}.` : ""}
                    {r.enabled && r.nextRunAt ? ` Next ${whenInZone(r.nextRunAt, s.zone)}.` : ""}
                  </p>
                </div>
                {s.isAdmin && (
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <Switch checked={r.enabled} onChange={(x) => void toggle(r, x)} label={`${r.name} on`} />
                    <Button size="sm" variant="secondary" loading={busy === r.id} disabled={!s.ai.on || s.ai.source === "none"} onClick={() => void runNow(r)}>Run now</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ r })} aria-label={`Edit ${r.name}`}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(r)} aria-label={`Delete ${r.name}`}>Delete</Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {edit && <RoutineDialog s={s} initial={edit.r} onClose={() => setEdit(null)} />}
      {dialogs}
    </section>
  );
}

// ---------------------------------------------------------------- run log

const STATUS_TONE: Record<RunEntry["status"], "neutral" | "ok" | "warn" | "bad"> = { queued: "neutral", running: "neutral", done: "ok", skipped: "warn", failed: "bad" };
const STATUS_TEXT: Record<RunEntry["status"], string> = { queued: "Waiting", running: "Running", done: "Done", skipped: "Skipped", failed: "Failed" };
const KIND_TEXT: Record<RunEntry["kind"], string> = { routine: "Routine", mention: "Chat question", try: "Try" };

function RunsTab({ s }: { s: TeamAiState }) {
  const qc = useQueryClient();
  const [pages, setPages] = useState<string[]>([""]);
  const q = useQuery({ queryKey: [...qk.runs, pages.length], queryFn: async () => {
    const all: RunEntry[] = []; let next: string | null = null;
    for (const p of pages) { const r = await api.get<{ runs: RunEntry[]; next: string | null }>(`/team-ai/runs${p ? `?before=${encodeURIComponent(p)}` : ""}`); all.push(...r.runs); next = r.next; }
    return { runs: all, next };
  }, ...quickRetry });
  const [post, setPost] = useState<RunEntry | null>(null);
  const [channel, setChannel] = useState("");
  const { confirm, dialogs } = useDialogs();
  const doPost = useMutation({
    mutationFn: () => api.post(`/team-ai/runs/${encodeURIComponent(post!.id)}/post`, { channelId: channel }),
    onSuccess: () => { toast.success("Posted"); setPost(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = async (r: RunEntry) => {
    if (!(await confirm({ title: "Delete this run?", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/team-ai/runs/${encodeURIComponent(r.id)}`); await qc.invalidateQueries({ queryKey: qk.runs }); } catch (e) { toast.error(errorMessage(e)); }
  };
  const items = q.data?.runs ?? [];
  return (
    <section aria-label="Run log" className="space-y-3">
      <p className="text-[13px] text-muted">{s.isAdmin ? `Every run in the last ${TEAMAI_CAPS.keepRunsDays} days.` : `Your runs and questions in the last ${TEAMAI_CAPS.keepRunsDays} days.`} Chat answers stay in their channel.</p>
      {q.isError && !q.data ? <LoadError onRetry={() => q.refetch()} /> : !q.data ? <Loading label="Loading the run log" /> : !items.length ? (
        <EmptyState title="No runs yet" body="Runs from routines, Try it and chat questions show here." />
      ) : (
        <ul className="space-y-2" data-testid="run-list">
          {items.map((r) => (
            <li key={r.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-[14px] text-fg"><span className="font-semibold">{r.label || KIND_TEXT[r.kind]}</span> <span className="text-[12.5px] text-muted">{KIND_TEXT[r.kind]}, {r.actorName ? `${r.actorName}, ` : ""}{when(r.createdAt)}</span></p>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
                </div>
                {r.reason && <p className="mt-1 text-[13px] text-muted">{r.reasonText ?? REASON_TEXT[r.reason] ?? "It did not run."}</p>}
                {r.output === "draft" && r.result && (
                  <details className="mt-2">
                    <summary className="min-h-9 cursor-pointer text-[13px] font-medium text-brand-hover">Show draft</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-fill p-3 text-[13.5px] text-fg">{r.result}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <CopyButton value={r.result} label="Copy" />
                      <Button size="sm" variant="secondary" onClick={() => { setPost(r); setChannel(""); }}>Post to a channel</Button>
                      {(s.isAdmin || r.kind === "try") && <Button size="sm" variant="ghost" onClick={() => void remove(r)}>Delete</Button>}
                    </div>
                  </details>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {q.data?.next && <div className="flex justify-center"><Button size="sm" variant="secondary" loading={q.isFetching} onClick={() => setPages((p) => [...p, q.data!.next!])}>Load more</Button></div>}
      <Dialog open={!!post} onClose={() => setPost(null)} title="Post the draft" description="It posts under your name. Read it first: you are sending it, not the assistant."
        footer={<><Button variant="secondary" onClick={() => setPost(null)}>Cancel</Button><Button disabled={!channel} loading={doPost.isPending} onClick={() => doPost.mutate()}>Post</Button></>}>
        <Field label="Channel">{(x) => <Select {...x} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Pick a channel</option>{s.channels.map((c) => <option key={c.id} value={c.id}>{c.private ? `${c.name} (private)` : c.name}</option>)}</Select>}</Field>
      </Dialog>
      {dialogs}
    </section>
  );
}
