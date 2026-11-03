/**
 * R126 People: Settings > Team > Onboarding. Admins build onboarding and offboarding checklists; each step has an owner
 * (the person, their manager or whoever assigns it) and a due day counted from the start date. Members see the list
 * read only; the server refuses their changes.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { quickRetry } from "@/web/lib/quick-retry-pol1";
import { api, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { useDialogs } from "@/web/components/ui/confirm";
import { IconArrowLeft, IconEdit, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { ITEM_OWNERS, ITEM_OWNER_LABEL, MAX_ITEMS, type ItemOwner, type OnboardingTemplate, type RunKind } from "@/shared/people-r126";
import { getStaff, getTemplates, pk } from "./model";
import { PeopleOff } from "./staff";

type Row = { id?: string; title: string; offsetDays: string; owner: ItemOwner };
const STARTER: Row[] = [
  { title: "Order a laptop and accounts", offsetDays: "-5", owner: "assigner" },
  { title: "Welcome and first day plan", offsetDays: "0", owner: "manager" },
  { title: "Read the team handbook", offsetDays: "2", owner: "person" },
  { title: "First week check in", offsetDays: "5", owner: "manager" },
];
const LEAVER: Row[] = [
  { title: "Access review: remove accounts and keys", offsetDays: "0", owner: "assigner" },
  { title: "Return laptop and equipment", offsetDays: "0", owner: "person" },
  { title: "Hand over open work", offsetDays: "-5", owner: "manager" },
];
const dayText = (n: number) => (n === 0 ? "On the day" : n < 0 ? `${-n} ${n === -1 ? "day" : "days"} before` : `${n} ${n === 1 ? "day" : "days"} after`);

export function OnboardingSettingsPage() {
  const config = useConfig();
  const on = !!config.data?.peopleR126;
  const q = useQuery({ queryKey: pk.templates, queryFn: getTemplates, enabled: on, ...quickRetry });
  const staff = useQuery({ queryKey: pk.staff, queryFn: getStaff, enabled: on, ...quickRetry });
  const qc = useQueryClient();
  const [edit, setEdit] = useState<{ tpl?: OnboardingTemplate; kind: RunKind } | null>(null);
  const { confirm, dialogs } = useDialogs();
  if (config.data && !on) return <PeopleOff />;
  const isAdmin = !!staff.data?.isAdmin;
  const remove = async (t: OnboardingTemplate) => {
    if (!(await confirm({ title: `Delete ${t.name}?`, description: "People it was assigned to keep their tasks.", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/people/templates/${encodeURIComponent(t.id)}`); await qc.invalidateQueries({ queryKey: pk.templates }); toast.success("Checklist deleted"); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="onboarding-settings">
      <Link to="/app/settings/team" className="mb-2 inline-flex min-h-9 items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" aria-hidden="true" />Team</Link>
      <PageHeader title="Onboarding and offboarding" description="Checklists you assign from a person's profile in Contacts > Staff. Each step becomes a task in Tasks, due from their start or last day."
        actions={isAdmin && <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setEdit({ kind: "offboarding" })} data-testid="tpl-new-off">New offboarding</Button><Button size="sm" onClick={() => setEdit({ kind: "onboarding" })} data-testid="tpl-new"><IconPlus className="h-4 w-4" aria-hidden="true" />New onboarding</Button></span>} />
      {q.isError && !q.data ? <LoadError onRetry={() => q.refetch()} /> : !q.data ? <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading checklists"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-24 rounded-xl" /></div> : !q.data.templates.length ? (
        <EmptyState title="No checklists yet" body={isAdmin ? "Start with a new starter checklist. We fill in common steps you can change." : "Your admins have not built any checklists yet."}
          action={isAdmin ? <Button size="sm" onClick={() => setEdit({ kind: "onboarding" })}>New onboarding</Button> : undefined} />
      ) : (
        <ul className="space-y-3" data-testid="tpl-list">
          {q.data.templates.map((t) => (
            <li key={t.id}><Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-[15px] font-semibold text-fg">{t.name}</h2>
                <Badge tone={t.kind === "onboarding" ? "brand" : "neutral"}>{t.kind === "onboarding" ? "Onboarding" : "Offboarding"}</Badge>
                <span className="text-[12.5px] text-subtle">{t.items.length} {t.items.length === 1 ? "step" : "steps"}</span>
                {isAdmin && <span className="ml-auto flex gap-1"><Button size="icon" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEdit({ tpl: t, kind: t.kind })}><IconEdit className="h-4 w-4" aria-hidden="true" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}><IconTrash className="h-4 w-4" aria-hidden="true" /></Button></span>}
              </div>
              <ol className="mt-2 space-y-1 text-[13px]">
                {t.items.map((it) => <li key={it.id} className="flex flex-wrap gap-x-2"><span className="text-fg">{it.title}</span><span className="text-subtle">{dayText(it.offsetDays)} · {ITEM_OWNER_LABEL[it.owner]}</span></li>)}
              </ol>
            </Card></li>
          ))}
        </ul>
      )}
      {dialogs}
      {edit && <TemplateDialog key={edit.tpl?.id ?? edit.kind} tpl={edit.tpl} kind={edit.kind} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TemplateDialog({ tpl, kind, onClose }: { tpl?: OnboardingTemplate; kind: RunKind; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(tpl?.name ?? (kind === "onboarding" ? "New starter" : "Leaver"));
  const [rows, setRows] = useState<Row[]>(tpl ? tpl.items.map((i) => ({ id: i.id, title: i.title, offsetDays: String(i.offsetDays), owner: i.owner })) : kind === "onboarding" ? STARTER : LEAVER);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setRow = (i: number, r: Partial<Row>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...r } : y)));
  const save = async () => {
    const items = rows.filter((r) => r.title.trim()).map((r) => ({ id: r.id, title: r.title, offsetDays: Number(r.offsetDays || 0), owner: r.owner }));
    if (!name.trim()) { setErr("Give the checklist a name."); return; }
    if (!items.length) { setErr("Add at least one step."); return; }
    if (items.some((i) => !Number.isInteger(i.offsetDays) || i.offsetDays < -60 || i.offsetDays > 365)) { setErr("Days from start must be a whole number from -60 to 365."); return; }
    setBusy(true); setErr(null);
    try {
      const body = { name, kind, items };
      if (tpl) await api.put(`/people/templates/${encodeURIComponent(tpl.id)}`, body); else await api.create("/people/templates", body);
      await qc.invalidateQueries({ queryKey: pk.templates });
      toast.success(tpl ? "Checklist saved" : "Checklist created");
      onClose();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={tpl ? "Edit checklist" : kind === "onboarding" ? "New onboarding checklist" : "New offboarding checklist"}
      description={kind === "onboarding" ? "Days count from the start date. Use a minus number for steps before day one." : "Days count from the last day."}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} data-testid="tpl-save">Save</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
        <Field label="Name">{(x) => <Input {...x} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="tpl-name" />}</Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-fg/90">Steps</legend>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr,auto] gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr,90px,170px,auto]" data-testid="tpl-row">
              <Input aria-label={`Step ${i + 1}`} value={r.title} maxLength={140} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="What needs doing" className="col-span-2 sm:col-span-1" />
              <Input aria-label={`Step ${i + 1} days from start`} inputMode="numeric" value={r.offsetDays} onChange={(e) => setRow(i, { offsetDays: e.target.value.replace(/[^0-9-]/g, "") })} />
              <Select aria-label={`Step ${i + 1} owner`} value={r.owner} onChange={(e) => setRow(i, { owner: e.target.value as ItemOwner })}>{ITEM_OWNERS.map((o) => <option key={o} value={o}>{ITEM_OWNER_LABEL[o]}</option>)}</Select>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><IconTrash className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          ))}
          {rows.length < MAX_ITEMS && <Button type="button" size="sm" variant="secondary" onClick={() => setRows((x) => [...x, { title: "", offsetDays: "0", owner: "person" }])} data-testid="tpl-add-row"><IconPlus className="h-4 w-4" aria-hidden="true" />Add step</Button>}
        </fieldset>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
