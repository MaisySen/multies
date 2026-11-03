/**
 * TD10 (CRM_TD10): suggestions from mail on the Contacts page. Rules read recent mail (no AI); nothing changes in the
 * CRM until someone presses Accept. Keys: J and K move, A accepts, D discards (the "?" sheet lists them under CRM).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCalendarClock, IconCheck, IconEdit, IconHandshake, IconMail, IconRefresh, IconUser, IconUserCheck } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { useCommandHandlers } from "@/web/lib/commands";
import { focusedRow, useOnline, walkRows } from "@/web/lib/crm-keys-td10";
import { shortDate } from "@/web/lib/format";
import { useConfig } from "@/web/lib/queries";
import { dayLabel } from "@/shared/crm-td10";

export type SuggestionKind = "contact_details" | "new_contact" | "last_contacted" | "next_step";
export interface Suggestion { id: string; kind: SuggestionKind; target: { type: string; id: string | null; label: string }; fields: Record<string, string>; messageAt: string; current?: Record<string, string | null> }

export const useCrmTd10On = () => !!useConfig().data?.crmTd10;
const KEY = ["crm-td10-suggestions"];

/** Open suggestions (a cheap read); the Contacts tab shows the count. */
export function useSuggestions(enabled = true) {
  return useQuery({ queryKey: KEY, enabled, staleTime: 60_000, queryFn: async () => (await api.get<{ items: Suggestion[] }>("/crm-td10/suggestions")).items });
}

const FIELD_LABEL: Record<string, string> = { name: "Name", title: "Job title", phone: "Phone", company: "Company" };

function headline(s: Suggestion) {
  const who = s.target.label || s.fields.email || "this contact";
  if (s.kind === "contact_details") return `Update ${who}`;
  if (s.kind === "new_contact") return `Add ${s.fields.name || s.fields.email} as a contact`;
  if (s.kind === "last_contacted") return `Log your last email on ${who}`;
  return `${s.fields.title || "Follow up"}, ${s.fields.when || dayLabel(s.fields.due)}`;
}

function detail(s: Suggestion): string[] {
  if (s.kind === "last_contacted") return [`Emailed ${s.fields.contactName || "the contact"} on ${dayLabel(s.fields.date)}`];
  if (s.kind === "next_step") return [`Due ${dayLabel(s.fields.due)}`, `For ${s.target.label}`];
  return ["name", "title", "phone", "company"].filter((k) => s.fields[k]).map((k) => {
    const was = s.current?.[k];
    return `${FIELD_LABEL[k]}: ${s.fields[k]}${was ? ` (now ${was})` : ""}`;
  });
}

const ICON: Record<SuggestionKind, typeof IconUser> = { contact_details: IconUserCheck, new_contact: IconUser, last_contacted: IconHandshake, next_step: IconCalendarClock };

export function SuggestionsTab() {
  const qc = useQueryClient();
  const online = useOnline();
  const list = useSuggestions();
  const [editing, setEditing] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const scanned = useRef(false);
  const scan = useMutation({
    mutationFn: (_mode: "auto" | "manual") => api.post<{ added: number; scanned: number }>("/crm-td10/suggestions/scan", {}),
    onSuccess: async (r, mode) => { await qc.invalidateQueries({ queryKey: KEY }); if (mode === "manual") toast(r.added ? `${r.added} new ${r.added === 1 ? "suggestion" : "suggestions"}` : "Nothing new in your mail"); },
    onError: (e, mode) => {
      if (mode !== "manual") return;
      if (e instanceof ApiError && e.status === 429) toast("Mail was checked a moment ago. Try again in a minute."); else showError(e as Error);
    },
  });
  useEffect(() => { if (!scanned.current && online) { scanned.current = true; scan.mutate("auto"); } }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async (s: Suggestion, edits: Record<string, string> = {}) => {
    setBusy(s.id);
    try {
      await api.post(`/crm-td10/suggestions/${s.id}/accept`, edits);
      toast(s.kind === "new_contact" ? "Contact added" : s.kind === "next_step" ? "Next step added" : s.kind === "last_contacted" ? "Logged on the deal" : "Contact updated");
      setEditing(null);
      await Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ["contacts"] })]);
    } catch (e) { showError(e as Error); await qc.invalidateQueries({ queryKey: KEY }); } finally { setBusy(null); }
  };
  const discard = async (s: Suggestion) => {
    setBusy(s.id);
    try {
      await api.post(`/crm-td10/suggestions/${s.id}/discard`, {});
      qc.setQueryData<Suggestion[]>(KEY, (old) => old?.filter((x) => x.id !== s.id));
      toast("Suggestion discarded", { action: { label: "Undo", onClick: async () => { try { await api.post(`/crm-td10/suggestions/${s.id}/undo`, {}); await qc.invalidateQueries({ queryKey: KEY }); } catch (e) { showError(e as Error); } } } });
    } catch (e) { showError(e as Error); await qc.invalidateQueries({ queryKey: KEY }); } finally { setBusy(null); }
  };
  const fromRow = () => { const id = focusedRow()?.dataset.suggestionId; return list.data?.find((x) => x.id === id) ?? null; };
  useCommandHandlers({
    "crm-next": () => walkRows(1),
    "crm-prev": () => walkRows(-1),
    "crm-accept": () => { const s = fromRow(); if (!s) return false; void accept(s); },
    "crm-discard": () => { const s = fromRow(); if (!s) return false; void discard(s); },
  });

  return (
    <div data-testid="crm-suggestions">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">Changes read from your recent mail. Nothing is saved until you accept it.</p>
        <Button variant="outline" size="sm" onClick={() => scan.mutate("manual")} loading={scan.isPending} disabled={!online} data-testid="crm-check-mail"><IconRefresh className="h-4 w-4" aria-hidden />Check mail</Button>
      </div>
      {!online && <p role="status" className="mb-3 rounded-lg border border-line bg-fill px-3 py-2 text-[13px] text-muted" data-testid="crm-offline">You're offline. Suggestions will refresh when you're back.</p>}
      {list.isError && !list.data ? <LoadError onRetry={() => list.refetch()} />
        : list.isPending ? <div aria-busy="true" aria-label="Loading suggestions" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : !list.data.length ? (
          <EmptyState icon={<IconMail />} title="Nothing to update" body="When mail brings a new contact, a phone number, a job title or a next step, it shows here for you to accept." />
        ) : (
          <Card className="divide-y divide-line overflow-hidden" data-testid="suggestion-list">
            <ul aria-label="Suggestions from mail">
              {list.data.map((s) => {
                const Icon = ICON[s.kind];
                return (
                  <li key={s.id} tabIndex={0} data-crm-row data-suggestion-id={s.id} data-testid="suggestion-row" aria-label={headline(s)}
                    className="flex flex-col gap-3 px-4 py-3 outline-none transition-colors duration-150 focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-brand/50 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><Icon className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-fg">{headline(s)}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
                          {detail(s).map((d) => <span key={d}>{d}</span>)}
                          <span className="text-subtle">From mail {shortDate(s.messageAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 max-sm:[&>button]:h-11 max-sm:[&>button]:flex-1">
                      <Button size="sm" onClick={() => accept(s)} loading={busy === s.id} disabled={!online} data-testid="suggestion-accept"><IconCheck className="h-4 w-4" aria-hidden />Accept</Button>
                      {s.kind !== "last_contacted" && <Button size="sm" variant="outline" onClick={() => setEditing(s)} disabled={!online} data-testid="suggestion-edit"><IconEdit className="h-4 w-4" aria-hidden />Edit</Button>}
                      <Button size="sm" variant="ghost" onClick={() => discard(s)} disabled={!online || busy === s.id} data-testid="suggestion-discard">Discard</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      {editing && <EditDialog s={editing} onClose={() => setEditing(null)} onSave={(e) => accept(editing, e)} busy={busy === editing.id} />}
    </div>
  );
}

function EditDialog({ s, onClose, onSave, busy }: { s: Suggestion; onClose: () => void; onSave: (edits: Record<string, string>) => void; busy: boolean }) {
  const step = s.kind === "next_step";
  const keys = step ? [] : ["name", "title", "phone", "company"].filter((k) => s.fields[k] !== undefined || s.kind === "new_contact");
  const [v, setV] = useState<Record<string, string>>(() => step ? { stepTitle: s.fields.title ?? "", due: s.fields.due ?? "" } : Object.fromEntries(keys.map((k) => [k, s.fields[k] ?? ""])));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const edits = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]).filter(([k, x]) => x !== "" || k === "name"));
    onSave(edits);
  };
  return (
    <Dialog open onClose={onClose} title={step ? "Edit the next step" : "Check the details"} description="Change anything before it is saved.">
      <form onSubmit={submit} className="space-y-3" data-testid="suggestion-edit-form">
        {step ? (
          <>
            <Field label="Next step">{(p) => <Input {...p} value={v.stepTitle} maxLength={120} onChange={(e) => setV({ ...v, stepTitle: e.target.value })} required />}</Field>
            <Field label="Due">{(p) => <Input {...p} type="date" value={v.due} onChange={(e) => setV({ ...v, due: e.target.value })} required />}</Field>
          </>
        ) : keys.map((k) => (
          <Field key={k} label={FIELD_LABEL[k]}>{(p) => <Input {...p} value={v[k] ?? ""} maxLength={k === "phone" ? 24 : 60} inputMode={k === "phone" ? "tel" : undefined} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}</Field>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} data-testid="suggestion-save">Save to CRM</Button>
        </div>
      </form>
    </Dialog>
  );
}
