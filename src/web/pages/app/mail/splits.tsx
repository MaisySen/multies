/**
 * R31: split inbox (tabs over Inbox, the "Edit splits" sheet with a rule builder and live count) and read
 * status (the Settings > Mail switch and the "Opened 2x, last 3:14 PM" line).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp, IconClose, IconEye, IconPlus, IconSliders, IconTrash } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Select, PHONE_PICK } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { mailDate } from "@/web/lib/format";
import {
  fieldNeedsValue, readStatusLine, SPLIT_FIELD_LABEL, SPLIT_FIELDS, SPLIT_NAME_MAX, SPLIT_RULES_MAX,
  type MailSplit, type ReadStatus, type SplitField, type SplitTab,
} from "@/shared/mail-splits";
import type { TabStyle } from "@/shared/mail-rules-r85";
import { MAIL_DRAG_TYPE, TabStyleSection } from "./tabs-r85";

export const DEFAULT_SPLIT = "important";
const STYLE_INTRO: Record<TabStyle, string> = {
  classic: "Important shows mail from people, including someone writing for the first time when their mail is verified. Other holds newsletters, notifications and receipts.",
  categories: "Primary shows mail from people. Updates holds receipts, alerts and notices. Promotions holds offers and newsletters.",
  off: "Inbox shows everything in one list.",
};
export const splitsKey = (mailboxId: string) => ["mail", "splits", mailboxId] as const;

export function useSplits(mailboxId: string, enabled: boolean) {
  return useQuery({
    queryKey: splitsKey(mailboxId),
    enabled: enabled && !!mailboxId,
    queryFn: () => api.get<{ splits: MailSplit[]; tabs: SplitTab[]; style?: TabStyle; defaultTab?: string }>(`/mail/splits?${new URLSearchParams({ mailboxId })}`),
    // R59 hotfix (D1 reads): tab counts repeat the badge counts' work, so they refresh every 2 minutes (and on mail changes), not every 30 s.
    refetchInterval: 120_000, staleTime: 30_000,
  });
}

export { stepSplit } from "@/shared/mail-splits";

export function SplitTabs({ tabs, active, onChange, onEdit, onDropMessage }: { tabs: SplitTab[]; active: string; onChange: (id: string) => void; onEdit: () => void; onDropMessage?: (messageId: string, tab: SplitTab) => void }) {
  // R85: a mail row dragged onto a tab moves its thread there (and teaches its sender).
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1 border-b border-line px-2" data-testid="split-tabs">
      {/* R85: arrow keys, Home and End move between tabs (the tabs pattern); only the open tab is in the Tab order. */}
      <div role="tablist" aria-label="Inbox tabs" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none]"
        onKeyDown={(e) => {
          const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
          if (!(e.key in keys) || !tabs.length) return;
          e.preventDefault();
          const i = Math.max(0, tabs.findIndex((t) => t.id === active));
          const by = keys[e.key];
          const next = by === -Infinity ? 0 : by === Infinity ? tabs.length - 1 : (i + by + tabs.length) % tabs.length;
          onChange(tabs[next].id);
          e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
        }}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={t.id === active} tabIndex={t.id === active ? 0 : -1} onClick={() => onChange(t.id)} data-testid={`split-tab-${t.builtIn ? t.id : t.name}`}
            onDragOver={onDropMessage ? (e) => { if (e.dataTransfer.types.includes(MAIL_DRAG_TYPE) && t.id !== active) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(t.id); } } : undefined}
            onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
            onDrop={onDropMessage ? (e) => { const id = e.dataTransfer.getData(MAIL_DRAG_TYPE); setOver(null); if (id && t.id !== active) { e.preventDefault(); onDropMessage(id, t); } } : undefined}
            className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:h-10",
              t.id === active ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:bg-hover hover:text-fg",
              over === t.id && "bg-brand-soft text-brand-hover ring-2 ring-brand/40")}>
            {t.name}
            {t.unread > 0 && <span className={cn("min-w-5 rounded-full px-1.5 text-center text-[11px] tabular-nums", t.id === active ? "bg-brand text-white" : "bg-fill text-muted")} aria-label={`${t.unread} unread`}>{t.unread > 99 ? "99+" : t.unread}</span>}
          </button>
        ))}
      </div>
      <button type="button" onClick={onEdit} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg max-sm:h-10 max-sm:w-10" aria-label="Edit tabs" title="Edit tabs">
        <IconSliders className="h-4 w-4" />
      </button>
    </div>
  );
}

type Draft = { id?: string; name: string; rules: { field: SplitField; value: string }[]; match: "all" | "any"; leavesImportant: boolean };
const blank = (): Draft => ({ name: "", rules: [{ field: "fromDomain", value: "" }], match: "all", leavesImportant: true });
const PLACEHOLDER: Partial<Record<SplitField, string>> = { fromContains: "name or address", fromDomain: "example.com", to: "team@yourdomain.com", subjectContains: "invoice" };

/** "12 threads match", updated as the rules change (debounced). */
function LiveCount({ draft, mailboxId }: { draft: Draft; mailboxId: string }) {
  const ready = draft.rules.length > 0 && draft.rules.every((r) => !fieldNeedsValue(r.field) || r.value.trim());
  const body = JSON.stringify({ rules: draft.rules, match: draft.match, mailboxId });
  const [debounced, setDebounced] = useState(body);
  useEffect(() => { const t = setTimeout(() => setDebounced(body), 300); return () => clearTimeout(t); }, [body]);
  const q = useQuery({ queryKey: ["mail", "split-preview", debounced], enabled: ready, queryFn: () => api.post<{ threads: number }>("/mail/splits/preview", JSON.parse(debounced)) });
  if (!ready) return <span className="text-subtle">Fill in each rule to see matches</span>;
  if (q.isPending) return <span className="text-subtle">Counting</span>;
  const n = q.data?.threads ?? 0;
  return <span data-testid="split-preview-count">{n === 1 ? "1 thread matches" : `${n} threads match`}</span>;
}

function SplitForm({ draft, setDraft, mailboxId, builtIn }: { draft: Draft; setDraft: (d: Draft) => void; mailboxId: string; builtIn: string }) {
  const setRule = (i: number, patch: Partial<Draft["rules"][number]>) => setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-3">
      <label className="block text-[13px] font-medium">Name
        <input value={draft.name} maxLength={SPLIT_NAME_MAX} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Vendors" aria-label="Tab name"
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm font-normal outline-none focus:border-brand/60 focus:ring-4 focus:ring-brand/10" />
      </label>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span>Mail that matches</span>
        <Select bare aria-label="Match" value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value as "all" | "any" })} className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg"
          phoneClassName={`${PHONE_PICK} h-10 px-3`}>
          <option value="all">all rules</option>
          <option value="any">any rule</option>
        </Select>
      </div>
      <ul className="space-y-2">
        {draft.rules.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <Select bare aria-label={`Rule ${i + 1}`} value={r.field} onChange={(e) => setRule(i, { field: e.target.value as SplitField })} className="h-9 w-44 shrink-0 rounded-lg border border-line bg-surface px-2 text-[13px]"
              phoneClassName={`${PHONE_PICK} h-10 w-36 shrink-0 px-3`}>
              {SPLIT_FIELDS.map((f) => <option key={f} value={f}>{SPLIT_FIELD_LABEL[f]}</option>)}
            </Select>
            {fieldNeedsValue(r.field)
              ? <input aria-label={`Rule ${i + 1} value`} value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={PLACEHOLDER[r.field]}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-brand/60 focus:ring-4 focus:ring-brand/10" />
              : <span className="flex-1" />}
            <button type="button" disabled={draft.rules.length === 1} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })} className="grid h-9 w-9 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg disabled:opacity-30" aria-label={`Remove rule ${i + 1}`}><IconClose className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
      {draft.rules.length < SPLIT_RULES_MAX && (
        <button type="button" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { field: "fromContains", value: "" }] })} className="inline-flex items-center gap-1 text-[13px] text-brand-hover hover:underline"><IconPlus className="h-3.5 w-3.5" />Add a rule</button>
      )}
      <label className="flex items-start gap-3 rounded-lg bg-fill/60 p-3 text-[13px]">
        <Switch checked={draft.leavesImportant} onChange={(v) => setDraft({ ...draft, leavesImportant: v })} label={`Take this mail out of ${builtIn}`} />
        <span>Take this mail out of {builtIn}<span className="block text-subtle">Off: it shows here and stays where it was too.</span></span>
      </label>
      <p className="text-[13px] font-medium" aria-live="polite"><LiveCount draft={draft} mailboxId={mailboxId} /></p>
    </div>
  );
}

export function EditSplitsDialog({ open, onClose, mailboxId, splits, tabs = [], style = "classic" }: { open: boolean; onClose: () => void; mailboxId: string; splits: MailSplit[]; tabs?: SplitTab[]; style?: TabStyle }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (!open) setDraft(null); }, [open]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = { name: d.name.trim(), rules: d.rules.map((r) => ({ field: r.field, value: fieldNeedsValue(r.field) ? r.value.trim() : "" })), match: d.match, leavesImportant: d.leavesImportant };
      return d.id ? api.patch(`/mail/splits/${d.id}`, body) : api.post("/mail/splits", body);
    },
    onSuccess: (_r, d) => { toast.success(d.id ? "Tab saved" : "Tab added"); setDraft(null); void refresh(); },
    onError: (e) => showError(e),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/mail/splits/${id}`), onSuccess: () => { toast.success("Tab removed"); void refresh(); }, onError: (e) => showError(e) });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.post("/mail/splits/reorder", { ids }), onSuccess: () => void refresh(), onError: (e) => showError(e) });
  const move = (i: number, dir: -1 | 1) => {
    const ids = splits.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  const valid = !!draft && draft.name.trim().length > 0 && draft.rules.every((r) => !fieldNeedsValue(r.field) || r.value.trim());
  return (
    <Dialog open={open} onClose={onClose} title={draft ? (draft.id ? "Edit tab" : "New tab") : "Inbox tabs"}
      description={draft ? "Rules decide which mail lands in this tab." : STYLE_INTRO[style]}
      footer={draft
        ? <><Button variant="ghost" onClick={() => setDraft(null)}>Back</Button><Button disabled={!valid} loading={save.isPending} onClick={() => draft && save.mutate(draft)} data-testid="split-save">Save tab</Button></>
        : <><Button variant="ghost" onClick={onClose}>Done</Button>{style !== "off" && <Button onClick={() => setDraft(blank())} data-testid="split-new"><IconPlus className="h-4 w-4" />New tab</Button>}</>}>
      {draft ? <SplitForm draft={draft} setDraft={setDraft} mailboxId={mailboxId} builtIn={style === "categories" ? "Primary, Updates and Promotions" : "Important and Other"} /> : (<div className="space-y-5">
        <TabStyleSection tabs={tabs} />
        {style === "off" ? null : splits.length === 0
          ? <p className="text-sm text-muted">No tabs of your own yet. A tab of your own holds mail that matches rules, like everything from one domain.</p>
          : <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Your tabs">
            {splits.map((s, i) => (
              <li key={s.id} className="flex items-center gap-1 px-3 py-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:underline" onClick={() => setDraft({ id: s.id, name: s.name, rules: s.rules.map((r) => ({ field: r.field, value: r.value ?? "" })), match: s.match, leavesImportant: s.leavesImportant })}>
                  {s.name}<span className="ml-2 text-xs text-subtle">{s.rules.length === 1 ? "1 rule" : `${s.rules.length} rules`}</span>
                </button>
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="grid h-8 w-8 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg disabled:opacity-30" aria-label={`Move ${s.name} up`}><IconArrowUp className="h-4 w-4" /></button>
                <button type="button" disabled={i === splits.length - 1} onClick={() => move(i, 1)} className="grid h-8 w-8 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg disabled:opacity-30" aria-label={`Move ${s.name} down`}><IconArrowDown className="h-4 w-4" /></button>
                <button type="button" onClick={() => del.mutate(s.id)} className="grid h-8 w-8 place-items-center rounded-md text-subtle hover:bg-bad-soft hover:text-bad" aria-label={`Delete ${s.name}`}><IconTrash className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>}
      </div>)}
    </Dialog>
  );
}

/** "Opened 2x, last 3:14 PM" or "Not opened yet"; nothing when the message was not tracked. */
export function ReadStatusLine({ status, className }: { status?: ReadStatus | null; className?: string }) {
  const line = readStatusLine(status, mailDate);
  if (!line) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[12px]", status?.opens ? "text-brand-hover" : "text-subtle", className)} data-testid="read-status">
      <IconEye className="h-3 w-3" aria-hidden />{line}
    </span>
  );
}

/** Settings > Mail: "Show when people open my email", off by default. */
export function ReadStatusSection({ Section }: { Section: (p: { id?: string; title: string; description: React.ReactNode; children: React.ReactNode }) => React.ReactElement }) {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["mail", "prefs"], queryFn: () => api.get<{ prefs: { readStatus: boolean } }>("/mail/prefs") });
  const set = useMutation({
    mutationFn: (readStatus: boolean) => api.patch<{ prefs: { readStatus: boolean } }>("/mail/prefs", { readStatus }),
    onSuccess: (r) => { qc.setQueryData(["mail", "prefs"], r); toast.success(r.prefs.readStatus ? "Read status is on" : "Read status is off"); },
    onError: (e) => showError(e),
  });
  const on = prefs.data?.prefs.readStatus ?? false;
  return (
    <Section id="read-status" title="Read status" description="See when people open the mail you send. Mail you send carries a tiny image that tells Multies when it is shown. Some mail apps block images, so a message can be read without showing as opened.">
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={on} disabled={prefs.isPending || set.isPending} onChange={(v) => set.mutate(v)} label="Show when people open my email" />
        <span>Show when people open my email</span>
      </label>
      <p className="mt-2 text-xs text-subtle">Off by default. Only you see it, and only on mail sent while it is on.</p>
    </Section>
  );
}
