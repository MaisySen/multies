/**
 * R85: mail rules. Each rule watches one mailbox for mail that meets its conditions and runs its actions in order
 * (label, move to a tab, mark read, forward, reply with a saved reply, make a task, notify). A rule can be tried on
 * recent mail before it is saved, turned off, run on recent mail, and every run is logged.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowDown, IconArrowLeft, IconArrowUp, IconCheck, IconClose, IconEdit, IconHistory, IconMore, IconPlay, IconPlus, IconTrash, IconWarning, IconWorkflow } from "@/web/components/ui/icon";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { qk } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { mailDate, timeAgo } from "@/web/lib/format";
import type { MailboxOverview } from "@/web/lib/types";
import {
  LABEL_MAX, RULE_ACTION_LABEL, RULE_ACTIONS, RULE_ACTIONS_MAX, RULE_CONDITIONS_MAX, RULE_FIELD_LABEL, RULE_FIELDS, RULE_NAME_MAX, RULE_SENDS_PER_DAY, RULE_TEST_SCAN,
  describeConditions, ruleFieldNeedsValue, MailRuleInput, type MailRule, type MailRuleActionT, type MailRuleConditionT, type MailRuleRun, type RuleActionKind,
} from "@/shared/mail-rules-r85";
import { useSplits } from "./splits";
import { useSavedReplies } from "./saved-replies";
import { useProjects } from "../work/data";

const KEY = ["mail", "rules"] as const;
const useRules = () => useQuery({ queryKey: KEY, queryFn: async () => (await api.get<{ rules: MailRule[] }>("/mail/rules")).rules, staleTime: 15_000 });

interface TestResult { scanned: number; matched: number; sample: { id: string; from: string; subject: string; snippet: string; date: string }[] }
interface Draft { id?: string; name: string; mailboxId: string; match: "all" | "any"; conditions: MailRuleConditionT[]; actions: MailRuleActionT[]; enabled: boolean }

function blankAction(kind: RuleActionKind): MailRuleActionT {
  switch (kind) {
    case "label": return { kind, label: "" };
    case "move_to_tab": return { kind, tab: "other" };
    case "forward": return { kind, to: "" };
    case "auto_reply": return { kind, snippetId: "" };
    case "create_task": return { kind };
    default: return { kind } as MailRuleActionT;
  }
}

/** "Add label Billing, then Mark as read" */
function describeActions(actions: MailRuleActionT[], tabName: (id: string) => string, replyName: (id: string) => string): string {
  return actions.map((a) => {
    switch (a.kind) {
      case "label": return `add label ${a.label}`;
      case "move_to_tab": return `move to ${tabName(a.tab)}`;
      case "forward": return `forward to ${a.to}`;
      case "auto_reply": return `reply with ${replyName(a.snippetId)}`;
      default: return RULE_ACTION_LABEL[a.kind].toLowerCase();
    }
  }).join(", then ");
}

export function MailRulesPage() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const rules = useRules();
  const overview = useQuery({ queryKey: qk.overview, queryFn: async () => (await api.get<{ mailboxes: MailboxOverview[] }>("/mail/overview")).mailboxes });
  const mailboxes = useMemo(() => overview.data ?? [], [overview.data]);
  const firstBox = params.get("mailbox") && mailboxes.some((m) => m.id === params.get("mailbox")) ? params.get("mailbox")! : mailboxes[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [logFor, setLogFor] = useState<MailRule | null>(null);
  const [deleting, setDeleting] = useState<MailRule | null>(null);
  const replies = useSavedReplies();
  const replyName = (id: string) => replies.data?.snippets.find((s) => s.id === id)?.name ?? "a saved reply";
  const boxName = (id: string) => mailboxes.find((m) => m.id === id)?.address ?? "";

  const patch = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.patch<{ rule: MailRule }>(`/mail/rules/${v.id}`, { enabled: v.enabled }),
    onMutate: (v) => { qc.setQueryData<MailRule[]>(KEY, (old) => old?.map((r) => (r.id === v.id ? { ...r, enabled: v.enabled } : r))); },
    onSuccess: (r) => toast.success(r.rule.enabled ? `${r.rule.name} is on` : `${r.rule.name} is off`),
    onError: (e) => { showError(e); void qc.invalidateQueries({ queryKey: KEY }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/mail/rules/${id}`),
    onSuccess: () => { toast.success("Rule deleted"); setDeleting(null); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: (e) => showError(e),
  });
  // Run on recent mail asks first, with how many messages will change.
  const [confirmRun, setConfirmRun] = useState<{ rule: MailRule; matched: number } | null>(null);
  const countRecent = useMutation({
    mutationFn: (r: MailRule) => api.post<TestResult>("/mail/rules/test", { mailboxId: r.mailboxId, match: r.match, conditions: r.conditions }),
    onSuccess: (t, r) => { if (t.matched) setConfirmRun({ rule: r, matched: Math.min(t.matched, 50) }); else toast.info("No recent mail matches this rule"); },
    onError: (e) => showError(e),
  });
  const runRecent = useMutation({
    mutationFn: (id: string) => api.post<{ ran: number; matched: number }>(`/mail/rules/${id}/run-recent`, {}),
    onSettled: () => setConfirmRun(null),
    onSuccess: (r) => { toast.success(r.ran ? `Ran on ${r.ran} recent ${r.ran === 1 ? "message" : "messages"}` : "No recent mail matched", { description: r.ran ? "Replies and forwards only go to new mail." : undefined }); void qc.invalidateQueries({ queryKey: ["mail"] }); },
    onError: (e) => showError(e),
  });
  const startNew = () => setDraft({ name: "", mailboxId: firstBox, match: "all", conditions: [{ field: "from", value: "" }], actions: [blankAction("label")], enabled: true });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <ButtonLink to="/app/mail" variant="ghost" size="sm" className="-ml-3 mb-2 text-muted"><IconArrowLeft className="h-4 w-4" />Mail</ButtonLink>
      <PageHeader title="Mail rules" description="Sort, label and answer new mail as it arrives. Rules run on mail to your hosted addresses."
        actions={rules.data?.length ? <Button onClick={startNew} disabled={!firstBox} data-testid="rule-new"><IconPlus className="h-4 w-4" />New rule</Button> : undefined} />
      {rules.isPending || overview.isPending ? (
        <Card className="divide-y divide-line">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="flex items-center gap-3 p-4"><Skeleton className="h-6 w-10" /><div className="flex-1"><Skeleton className="mb-2 h-4 w-40" /><Skeleton className="h-3 w-72 max-w-full" /></div></div>)}</Card>
      ) : rules.isError ? (
        <EmptyState icon={<IconWarning />} title="Rules didn't load" body="Check your connection and try again." action={<Button variant="secondary" onClick={() => rules.refetch()}>Try again</Button>} />
      ) : !rules.data.length ? (
        <EmptyState icon={<IconWorkflow />} title="No rules yet"
          body={mailboxes.length ? "A rule does the same thing to every matching email, like labelling invoices or answering new customers while you're away." : "Add a mailbox first, then make rules for the mail it gets."}
          action={mailboxes.length ? <Button onClick={startNew} data-testid="rule-new"><IconPlus className="h-4 w-4" />New rule</Button> : <ButtonLink to="/app/mailboxes" variant="secondary">Add a mailbox</ButtonLink>} />
      ) : (
        <Card className="divide-y divide-line" data-testid="rules-list">
          {rules.data.map((r) => (
            <RuleRow key={r.id} rule={r} box={mailboxes.length > 1 ? boxName(r.mailboxId) : ""} replyName={replyName}
              onToggle={(v) => patch.mutate({ id: r.id, enabled: v })}
              onEdit={() => setDraft({ id: r.id, name: r.name, mailboxId: r.mailboxId, match: r.match, conditions: r.conditions, actions: r.actions, enabled: r.enabled })}
              onLog={() => setLogFor(r)} onDelete={() => setDeleting(r)}
              onRun={() => countRecent.mutate(r)} running={countRecent.isPending && countRecent.variables?.id === r.id} />
          ))}
        </Card>
      )}
      {draft && <RuleEditor draft={draft} setDraft={setDraft} mailboxes={mailboxes} onClose={() => setDraft(null)} />}
      <RunLog rule={logFor} onClose={() => setLogFor(null)} />
      <ConfirmDialog open={!!confirmRun} onClose={() => setConfirmRun(null)} onConfirm={() => confirmRun && runRecent.mutate(confirmRun.rule.id)} busy={runRecent.isPending}
        tone="primary" confirmLabel="Run now" title={confirmRun ? `Run ${confirmRun.rule.name} on ${confirmRun.matched} recent ${confirmRun.matched === 1 ? "message" : "messages"}?` : "Run on recent mail?"}
        description="They get this rule's labels, tabs, stars and other changes now. Replies and forwards are not sent." />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} busy={remove.isPending}
        title={`Delete the rule ${deleting?.name ?? ""}?`} description="Mail it already sorted stays where it is. Its run log goes with it." />
    </div>
  );
}

function RuleRow({ rule, box, replyName, onToggle, onEdit, onLog, onDelete, onRun, running }: {
  rule: MailRule; box: string; replyName: (id: string) => string; onToggle: (v: boolean) => void; onEdit: () => void; onLog: () => void; onDelete: () => void; onRun: () => void; running: boolean;
}) {
  const splits = useSplits(rule.mailboxId, true);
  const tabName = (id: string) => splits.data?.tabs.find((t) => t.id === id)?.name ?? id;
  return (
    <div className="flex items-start gap-3 p-4" data-testid={`rule-${rule.id}`}>
      <div className="pt-0.5"><Switch checked={rule.enabled} onChange={onToggle} label={`${rule.name} on`} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("text-[14px] font-medium", !rule.enabled && "text-muted")}>{rule.name}</span>
          {!rule.enabled && <Badge>Off</Badge>}
          {rule.lastError && <Badge tone="bad">Last run had a problem</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] text-muted">When {describeConditions(rule)}: {describeActions(rule.actions, tabName, replyName)}.</p>
        <p className="mt-1 text-[12px] text-subtle">{box && <>{box} · </>}{rule.runCount ? `Ran ${rule.runCount} ${rule.runCount === 1 ? "time" : "times"}, last ${timeAgo(rule.lastRunAt)}` : "Hasn't run yet"}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon" onClick={onLog} aria-label="Run log" title="Run log" className="max-sm:hidden"><IconHistory className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onRun} loading={running} aria-label="Run on recent mail" title="Run on recent mail" className="max-sm:hidden"><IconPlay className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit" title="Edit" className="max-sm:hidden"><IconEdit className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Delete ${rule.name}`} title="Delete" className="max-sm:hidden"><IconTrash className="h-4 w-4" /></Button>
        <div className="sm:hidden">
          <Menu label={`More for ${rule.name}`} sheet trigger={<Button variant="ghost" size="icon"><IconMore className="h-4 w-4" /></Button>}>
            <MenuItem icon={<IconEdit />} onSelect={onEdit}>Edit</MenuItem>
            <MenuItem icon={<IconHistory />} onSelect={onLog}>Run log</MenuItem>
            <MenuItem icon={<IconPlay />} onSelect={onRun}>Run on recent mail</MenuItem>
            <MenuItem icon={<IconTrash />} danger onSelect={onDelete}>Delete</MenuItem>
          </Menu>
        </div>
      </div>
    </div>
  );
}

function RuleEditor({ draft, setDraft, mailboxes, onClose }: { draft: Draft; setDraft: (d: Draft) => void; mailboxes: MailboxOverview[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const splits = useSplits(draft.mailboxId, true);
  const tabs = splits.data?.tabs ?? [];
  const replies = useSavedReplies();
  const projects = useProjects();
  const set = (p: Partial<Draft>) => { setDraft({ ...draft, ...p }); setError(null); if (p.conditions || p.match || p.mailboxId) setTest(null); };
  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>("/mail/rules/test", { mailboxId: draft.mailboxId, match: draft.match, conditions: draft.conditions }),
    onSuccess: (r) => setTest(r),
    onError: (e) => showError(e),
  });
  const save = useMutation({
    mutationFn: () => {
      const { id, ...body } = draft;
      return id ? api.patch<{ rule: MailRule }>(`/mail/rules/${id}`, body) : api.post<{ rule: MailRule }>("/mail/rules", body);
    },
    onSuccess: () => { toast.success(draft.id ? "Rule saved" : "Rule made"); void qc.invalidateQueries({ queryKey: KEY }); onClose(); },
    onError: (e) => showError(e),
  });
  const submit = () => {
    const parsed = MailRuleInput.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the rule."); return; }
    save.mutate();
  };
  const condsOk = draft.conditions.length > 0 && draft.conditions.every((c) => !ruleFieldNeedsValue(c.field) || c.value.trim());
  const setCond = (i: number, c: MailRuleConditionT) => set({ conditions: draft.conditions.map((x, j) => (j === i ? c : x)) });
  const setAction = (i: number, a: MailRuleActionT) => set({ actions: draft.actions.map((x, j) => (j === i ? a : x)) });
  const moveAction = (i: number, by: number) => { const a = [...draft.actions]; const [x] = a.splice(i, 1); a.splice(i + by, 0, x); set({ actions: a }); };
  const sends = draft.actions.some((a) => a.kind === "forward" || a.kind === "auto_reply");
  // Each action can be used once in a rule: Add action picks the next unused one and the picker greys out the rest.
  const used = new Set(draft.actions.map((a) => a.kind));
  const once = (k: RuleActionKind) => k !== "label" && k !== "forward";
  const unused = [...RULE_ACTIONS.filter((k) => !used.has(k)), ...(["label", "forward"] as const).filter((k) => used.has(k))];

  return (
    <Dialog open onClose={onClose} title={draft.id ? "Edit rule" : "New rule"} className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl max-sm:max-h-[calc(100dvh-0.5rem)]">
      <div className="space-y-5" data-testid="rule-editor">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Name">{(p) => <Input {...p} value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={RULE_NAME_MAX} placeholder="Invoices from Acme" autoFocus />}</Field>
          {mailboxes.length > 1 && (
            <Field label="Mailbox">{(p) => <Select {...p} value={draft.mailboxId} onChange={(e) => set({ mailboxId: e.target.value })}>{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</Select>}</Field>
          )}
        </div>

        <section aria-labelledby="rule-when">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 id="rule-when" className="text-[13px] font-medium">When new mail</h3>
            <Select aria-label="Match" value={draft.match} onChange={(e) => set({ match: e.target.value as "all" | "any" })} className="h-8 w-auto! text-[13px]">
              <option value="all">meets all of these</option>
              <option value="any">meets any of these</option>
            </Select>
          </div>
          <ul className="space-y-2">
            {draft.conditions.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <Select aria-label={`Condition ${i + 1}`} value={c.field} onChange={(e) => setCond(i, { field: e.target.value as MailRuleConditionT["field"], value: c.value })} className="w-full sm:w-48">
                  {RULE_FIELDS.map((f) => <option key={f} value={f}>{RULE_FIELD_LABEL[f]}</option>)}
                </Select>
                {ruleFieldNeedsValue(c.field)
                  ? <Input aria-label={`Condition ${i + 1} value`} value={c.value} onChange={(e) => setCond(i, { ...c, value: e.target.value })} placeholder={c.field === "domain" ? "acme.com" : c.field === "subject" ? "invoice" : "name or address"} className="min-w-0 flex-1" />
                  : <span className="flex-1 text-[13px] text-subtle">Any file attached</span>}
                <Button variant="ghost" size="icon" onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })} disabled={draft.conditions.length === 1} aria-label={`Remove condition ${i + 1}`}><IconClose className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {draft.conditions.length < RULE_CONDITIONS_MAX && <Button variant="ghost" size="sm" onClick={() => set({ conditions: [...draft.conditions, { field: "subject", value: "" }] })}><IconPlus className="h-4 w-4" />Add condition</Button>}
            <Button variant="secondary" size="sm" onClick={() => runTest.mutate()} loading={runTest.isPending} disabled={!condsOk} className="ml-auto max-sm:ml-0 max-sm:w-full"><IconPlay className="h-4 w-4" />Test on recent mail</Button>
          </div>
          {test && (
            <div className="mt-3 rounded-xl border border-line bg-fill/40 p-3" data-testid="rule-test-result" role="status">
              <p className="text-[13px] font-medium">{test.matched ? `${test.matched} of the last ${test.scanned} messages match` : `None of the last ${test.scanned} messages match`}</p>
              {test.matched === 0 && <p className="mt-0.5 text-[12px] text-subtle">Try a shorter word, or match any condition instead of all.</p>}
              {test.sample.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {test.sample.slice(0, 5).map((m) => (
                    <li key={m.id} className="min-w-0 text-[12.5px]">
                      <div className="flex gap-2"><span className="min-w-0 flex-1 truncate font-medium">{m.from}</span><time className="shrink-0 text-subtle" dateTime={m.date}>{mailDate(m.date)}</time></div>
                      <div className="truncate text-muted">{m.subject || "(no subject)"}</div>
                    </li>
                  ))}
                </ul>
              )}
              {test.matched > 5 && <p className="mt-1.5 text-[12px] text-subtle">and {test.matched - 5} more.</p>}
            </div>
          )}
          {!test && <p className="mt-2 text-[12px] text-subtle">The test reads your last {RULE_TEST_SCAN} Inbox messages and changes nothing.</p>}
        </section>

        <section aria-labelledby="rule-then">
          <h3 id="rule-then" className="mb-2 text-[13px] font-medium">Do this, in order</h3>
          <ol className="space-y-2">
            {draft.actions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2 sm:flex-nowrap" data-testid="rule-action">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-[11px] tabular-nums text-muted" aria-hidden>{i + 1}</span>
                <Select aria-label={`Action ${i + 1}`} value={a.kind} onChange={(e) => setAction(i, blankAction(e.target.value as RuleActionKind))} className="min-w-0 flex-1 sm:w-52 sm:flex-none">
                  {RULE_ACTIONS.map((k) => <option key={k} value={k} disabled={k !== a.kind && once(k) && used.has(k)}>{RULE_ACTION_LABEL[k]}</option>)}
                </Select>
                <div className="order-last w-full sm:order-none sm:w-auto sm:flex-1">
                  <ActionConfig a={a} i={i} onChange={(x) => setAction(i, x)} tabs={tabs} replies={replies.data?.snippets ?? []} projects={(projects.data ?? []).filter((p) => !p.archived)} />
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" onClick={() => moveAction(i, -1)} disabled={i === 0} aria-label={`Move action ${i + 1} up`}><IconArrowUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => moveAction(i, 1)} disabled={i === draft.actions.length - 1} aria-label={`Move action ${i + 1} down`}><IconArrowDown className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })} disabled={draft.actions.length === 1} aria-label={`Remove action ${i + 1}`}><IconClose className="h-4 w-4" /></Button>
                </div>
              </li>
            ))}
          </ol>
          {draft.actions.length < RULE_ACTIONS_MAX && unused.length > 0 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => set({ actions: [...draft.actions, blankAction(unused[0])] })}><IconPlus className="h-4 w-4" />Add action</Button>}
          {sends && <p className="mt-2 text-[12px] text-subtle">Replies skip newsletters, robots and your own team, go once a day per sender, and stop after {RULE_SENDS_PER_DAY} a day.</p>}
        </section>

        <label className="flex items-center gap-3 text-[13px]">
          <Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Rule on" />
          <span>Rule on<span className="block text-[12px] text-subtle">Turn it off to keep the rule without running it.</span></span>
        </label>
        {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
      </div>
      {/* The buttons stay on screen while the form scrolls, above the home bar on a phone. */}
      <div className="sticky bottom-0 z-10 -mx-6 -mb-5 mt-5 flex justify-end gap-2 border-t border-line bg-elevated px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-testid="rule-editor-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={save.isPending} data-testid="rule-save">{draft.id ? "Save rule" : "Make rule"}</Button>
      </div>
    </Dialog>
  );
}

function ActionConfig({ a, i, onChange, tabs, replies, projects }: { a: MailRuleActionT; i: number; onChange: (a: MailRuleActionT) => void; tabs: { id: string; name: string }[]; replies: { id: string; name: string }[]; projects: { id: string; name: string }[] }) {
  const label = `Action ${i + 1} setting`;
  switch (a.kind) {
    case "label": return <Input aria-label={label} value={a.label} maxLength={LABEL_MAX} onChange={(e) => onChange({ ...a, label: e.target.value })} placeholder="Label name" />;
    case "move_to_tab": return tabs.length
      ? <Select aria-label={label} value={a.tab} onChange={(e) => onChange({ ...a, tab: e.target.value })}>{tabs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      : <p className="text-[12px] text-subtle">Inbox tabs are off. Turn them on in Mail to use this.</p>;
    case "forward": return <Input aria-label={label} type="email" value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value })} placeholder="name@example.com" />;
    case "auto_reply": return replies.length
      ? <Select aria-label={label} value={a.snippetId} onChange={(e) => onChange({ ...a, snippetId: e.target.value })}><option value="">Choose a saved reply</option>{replies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      : <p className="text-[12px] text-subtle">No saved replies yet. Make one from the reply box in Mail.</p>;
    case "create_task": return (
      <Select aria-label={label} value={a.projectId ?? ""} onChange={(e) => onChange({ ...a, projectId: e.target.value || undefined })}>
        <option value="">My tasks</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
    );
    case "notify": return <p className="text-[12px] text-subtle">A notification on your devices.</p>;
    default: return null;
  }
}

const STATUS: Record<MailRuleRun["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  ok: { label: "Done", tone: "ok" }, partial: { label: "Partly done", tone: "warn" }, failed: { label: "Failed", tone: "bad" }, skipped: { label: "Skipped", tone: "neutral" },
};

function RunLog({ rule, onClose }: { rule: MailRule | null; onClose: () => void }) {
  const runs = useQuery({ queryKey: ["mail", "rules", rule?.id, "runs"], enabled: !!rule, queryFn: async () => (await api.get<{ runs: MailRuleRun[] }>(`/mail/rules/${rule!.id}/runs`)).runs });
  return (
    <Dialog open={!!rule} onClose={onClose} title={rule ? `Run log: ${rule.name}` : "Run log"} description="The last 50 messages this rule acted on.">
      <div data-testid="rule-runs">
        {runs.isPending ? <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          : runs.isError ? <p className="text-[13px] text-bad">The log didn't load. Close this and try again.</p>
          : !runs.data.length ? <p className="py-6 text-center text-[13px] text-subtle">Nothing yet. Runs show here when new mail matches.</p>
          : (
            <ul className="max-h-[60dvh] divide-y divide-line overflow-y-auto">
              {runs.data.map((r) => (
                <li key={r.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.subject || "(no subject)"}</span>
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </div>
                  <div className="mt-0.5 flex gap-2 text-[12px] text-subtle"><span className="min-w-0 flex-1 truncate">{r.from}</span><time dateTime={r.createdAt}>{timeAgo(r.createdAt)}</time></div>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {r.steps.map((s, j) => (
                      <li key={j} className={cn("inline-flex max-w-full items-center gap-1 rounded-md px-1.5 text-[11.5px] leading-5", s.skipped ? "bg-fill text-muted" : s.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")} title={s.detail}>
                        {s.skipped ? null : s.ok ? <IconCheck className="h-3 w-3 shrink-0" aria-hidden /> : <IconWarning className="h-3 w-3 shrink-0" aria-hidden />}
                        <span className="truncate">{RULE_ACTION_LABEL[s.action]}{s.skipped ? ": skipped on recent mail" : s.detail && !s.ok ? `: ${s.detail}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Dialog>
  );
}
