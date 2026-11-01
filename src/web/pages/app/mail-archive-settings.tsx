/**
 * R111: Settings > Mail > Archive and retention (flag MAIL_ARCHIVE_R111). Owners and admins: retention policy with a
 * dry run, legal holds, archive search with cases and export. Members: a read only card of the policy that applies.
 * Nothing here deletes anything by itself: a policy starts 7 days after it is turned on, and holds always win.
 */
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArchive, IconDownload, IconGavel, IconHourglass, IconInfo, IconLock, IconPlus, IconSearch, IconTrash } from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { fullDate, shortDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import {
  KEEP_YEAR_CHOICES, RETENTION_GRACE_DAYS, cleanFilters, describeFilters, keepLabel,
  type ArchiveFilters, type ArchiveHit, type LegalHoldView, type MailCaseView, type RetentionPreview, type RetentionView,
} from "@/shared/mail-archive";

const TABS = [["retention", "Retention"], ["holds", "Legal holds"], ["search", "Search and export"]] as const;
type Tab = (typeof TABS)[number][0];
const day = (iso: string | null | undefined) => (iso ? shortDate(iso) : "");

export function MailArchiveSettings() {
  const q = useQuery({ queryKey: ["mail-archive", "policy"], queryFn: () => api.get<{ policy: RetentionView }>("/mail-archive/policy") });
  const [params, setParams] = useSearchParams();
  if (q.isPending) return <PaneSkeleton />;
  if (q.isError) return <ErrorCard onRetry={() => q.refetch()} />;
  const policy = q.data.policy;
  if (!policy.canManage) return <MemberNotice policy={policy} />;
  const raw = params.get("tab");
  const tab: Tab = TABS.some(([t]) => t === raw) ? (raw as Tab) : "retention";
  const go = (t: Tab) => setParams(t === "retention" ? {} : { tab: t }, { replace: true });
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex(([t]) => t === tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]![0];
      go(next);
      document.getElementById(`archive-tab-${next}`)?.focus();
    }
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">Decide how long Multies keeps mail, protect mail that must not be deleted, and search and export mail for a review.</p>
      <div className="-mx-1 overflow-x-auto px-1">
        <div role="tablist" aria-label="Archive and retention" className="inline-flex rounded-lg bg-fill p-0.5">
          {TABS.map(([t, label]) => (
            <button key={t} id={`archive-tab-${t}`} role="tab" type="button" aria-selected={tab === t} aria-controls={`archive-panel-${t}`} tabIndex={tab === t ? 0 : -1}
              onClick={() => go(t)} onKeyDown={onKey}
              className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 max-sm:min-h-11", tab === t ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
              {label}{t === "holds" && policy.activeHolds ? <span className="ml-1.5 rounded-full bg-warn-soft px-1.5 text-[11px] text-warn">{policy.activeHolds}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`archive-panel-${tab}`} aria-labelledby={`archive-tab-${tab}`}>
        {tab === "retention" && <RetentionPanel policy={policy} />}
        {tab === "holds" && <HoldsPanel />}
        {tab === "search" && <SearchPanel />}
      </div>
    </div>
  );
}

function PaneSkeleton() {
  return <div className="space-y-4" aria-busy="true" aria-label="Loading"><Skeleton className="h-9 w-80 max-w-full" /><Card className="space-y-3 p-5"><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></Card></div>;
}
function ErrorCard({ onRetry, text = "Couldn't load archive and retention." }: { onRetry: () => void; text?: string }) {
  return <Card className="flex flex-col items-start gap-3 p-5 text-sm sm:flex-row sm:items-center sm:justify-between"><span>{text}</span><Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button></Card>;
}

function MemberNotice({ policy }: { policy: RetentionView }) {
  return (
    <Card className="flex gap-4 p-5" data-testid="retention-member-notice">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fill text-muted"><IconArchive className="h-5 w-5" aria-hidden /></span>
      <div className="min-w-0 space-y-1 text-sm">
        <h2 className="text-[15px] font-semibold">{keepLabel(policy.enabled, policy.keepYears)}</h2>
        <p className="text-muted">
          {policy.enabled && policy.keepYears
            ? <>Mail in this workspace older than {policy.keepYears} {policy.keepYears === 1 ? "year" : "years"} is deleted automatically{policy.startsAt && new Date(policy.startsAt) > new Date() ? `, starting ${day(policy.startsAt)}` : ""}. Mail under a legal hold is always kept.</>
            : <>This workspace keeps your mail until someone deletes it.</>}
        </p>
        <p className="text-subtle">Workspace owners and admins manage this setting.</p>
      </div>
    </Card>
  );
}

/* ---------- Retention ---------- */

function RetentionPanel({ policy }: { policy: RetentionView }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<number | null>(policy.enabled ? policy.keepYears : null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const changed = choice !== (policy.enabled ? policy.keepYears : null);
  const check = useMutation({
    mutationFn: (keepYears: number) => api.post<{ preview: RetentionPreview }>("/mail-archive/policy/preview", { keepYears }),
    onSuccess: (r) => setPreview(r.preview),
    onError: showError,
  });
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; keepYears: number | null; confirmEligible?: number }) => api.put<{ policy: RetentionView }>("/mail-archive/policy", body),
    onSuccess: (r) => {
      qc.setQueryData(["mail-archive", "policy"], r);
      setPreview(null); setConfirmOff(false);
      toast.success(r.policy.enabled ? "Retention policy saved" : "Retention turned off. Mail is kept forever.");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "count_changed") {
        const p = (err.details as { preview?: RetentionPreview } | undefined)?.preview;
        if (p) setPreview(p);
        toast.error("The count changed. Check the new number and confirm again.");
        return;
      }
      showError(err);
    },
  });
  const pickYears = (v: string) => { setChoice(v === "forever" ? null : Number(v)); setPreview(null); };
  const graceLeft = policy.enabled && policy.startsAt && new Date(policy.startsAt) > new Date();
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="text-[15px] font-semibold">{keepLabel(policy.enabled, policy.keepYears)}</h2><Badge tone={policy.enabled ? "brand" : "neutral"} dot>{policy.enabled ? "On" : "Off"}</Badge></div>
            <p className="mt-1 text-sm text-muted">
              {!policy.enabled && "Nothing is deleted automatically. Turn on a policy to delete mail once it reaches a set age."}
              {graceLeft && <>Deletion starts {day(policy.startsAt)}. Until then nothing is deleted and you can turn it off.</>}
              {policy.enabled && !graceLeft && (policy.lastRunAt ? <>Last checked {timeAgo(policy.lastRunAt)}: {policy.lastRunDeleted} deleted. {policy.totalDeleted} deleted in all.</> : <>The first daily pass runs soon.</>)}
            </p>
          </div>
          {policy.enabled && <Button variant="secondary" size="sm" onClick={() => setConfirmOff(true)}>Turn off</Button>}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs text-subtle"><IconInfo className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />Times use the workspace time zone ({policy.timeZone}). Drafts, mail under a legal hold and connected accounts are never deleted.</p>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">{policy.enabled ? "Change how long mail is kept" : "Keep mail for"}</h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Keep mail" className="sm:w-64">
            {(p) => (
              <Select {...p} value={choice == null ? "forever" : String(choice)} onChange={(e) => pickYears(e.target.value)}>
                <option value="forever">Forever</option>
                {KEEP_YEAR_CHOICES.map((y) => <option key={y} value={y}>{y} {y === 1 ? "year" : "years"}</option>)}
              </Select>
            )}
          </Field>
          {choice != null && changed && (
            <Button variant="outline" loading={check.isPending} onClick={() => check.mutate(choice)}><IconHourglass className="h-4 w-4" aria-hidden />Check what this deletes</Button>
          )}
          {choice == null && policy.enabled && <Button variant="secondary" onClick={() => setConfirmOff(true)}>Keep forever</Button>}
        </div>
        {preview && choice != null && preview.keepYears === choice && (
          <div className="mt-4 rounded-lg border border-line bg-fill/60 p-4 text-sm" role="status" data-testid="retention-dry-run">
            <p className="font-medium">Dry run: {preview.eligible.toLocaleString()} {preview.eligible === 1 ? "message" : "messages"} would be deleted</p>
            <ul className="mt-2 space-y-1 text-muted">
              <li>Mail dated before {day(preview.cutoff)}</li>
              {preview.heldBack > 0 && <li>{preview.heldBack.toLocaleString()} kept because of a legal hold</li>}
              {preview.connectedSkipped > 0 && <li>{preview.connectedSkipped.toLocaleString()} in connected accounts left alone</li>}
              <li>Deletion starts {day(preview.startsAt)}, {RETENTION_GRACE_DAYS} days from now, then runs once a day</li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant={preview.eligible ? "danger" : "primary"} loading={save.isPending} onClick={() => save.mutate({ enabled: true, keepYears: choice, confirmEligible: preview.eligible })}>
                {policy.enabled ? "Save policy" : "Turn on policy"}
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>
      <ConfirmDialog open={confirmOff} onClose={() => setConfirmOff(false)} busy={save.isPending} tone="primary" confirmLabel="Turn off"
        title="Turn off retention?" description="Mail will be kept until someone deletes it. Nothing already deleted comes back."
        onConfirm={() => save.mutate({ enabled: false, keepYears: null })} />
    </div>
  );
}

/* ---------- Legal holds ---------- */

interface Targets { mailboxes: { id: string; address: string; displayName: string }[]; people: { id: string; name: string; email: string }[] }
function HoldsPanel() {
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: ["mail-archive", "holds"], queryFn: () => api.get<{ holds: LegalHoldView[] }>("/mail-archive/holds") });
  const [open, setOpen] = useState(false);
  const [lift, setLift] = useState<LegalHoldView | null>(null);
  const release = useMutation({
    mutationFn: (id: string) => api.post(`/mail-archive/holds/${id}/release`),
    onSuccess: () => { setLift(null); toast.success("Hold lifted"); void qc.invalidateQueries({ queryKey: ["mail-archive"] }); },
    onError: showError,
  });
  const active = holds.data?.holds.filter((h) => !h.releasedAt) ?? [];
  const past = holds.data?.holds.filter((h) => h.releasedAt) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">While a hold is on, nothing in its mailbox or from its person can be deleted, by anyone or by retention.</p>
        <Button onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" aria-hidden />Place a hold</Button>
      </div>
      {holds.isPending ? <Card className="space-y-3 p-5"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></Card>
        : holds.isError ? <ErrorCard onRetry={() => holds.refetch()} text="Couldn't load legal holds." />
        : !active.length ? <Card><EmptyState icon={<IconGavel />} title="No active holds" body="Place a hold on a mailbox or a person when mail must be kept for a dispute, audit or investigation." /></Card>
        : (
          <Card className="divide-y divide-line" data-testid="holds-active">
            {active.map((h) => (
              <div key={h.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><IconLock className="h-4 w-4 text-warn" aria-hidden /><span className="truncate font-medium" title={h.name}>{h.name}</span><Badge tone="warn">{h.kind === "mailbox" ? "Mailbox" : "Person"}</Badge></div>
                  <p className="mt-0.5 truncate text-[13px] text-muted" title={h.targetLabel}>{h.targetLabel}</p>
                  {h.note && <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{h.note}</p>}
                  <p className="mt-0.5 text-xs text-subtle" title={fullDate(h.createdAt)}>Placed {day(h.createdAt)}{h.createdBy ? ` by ${h.createdBy}` : ""}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setLift(h)} aria-label={`Lift hold ${h.name}`}>Lift hold</Button>
              </div>
            ))}
          </Card>
        )}
      {past.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted hover:text-fg">Lifted holds ({past.length})</summary>
          <Card className="mt-2 divide-y divide-line">
            {past.map((h) => (
              <div key={h.id} className="p-4 text-[13px]"><span className="font-medium">{h.name}</span> <span className="text-muted">· {h.targetLabel}</span>
                <p className="text-xs text-subtle">Placed {day(h.createdAt)}, lifted {day(h.releasedAt)}{h.releasedBy ? ` by ${h.releasedBy}` : ""}</p></div>
            ))}
          </Card>
        </details>
      )}
      {open && <PlaceHoldDialog onClose={() => setOpen(false)} />}
      <ConfirmDialog open={!!lift} onClose={() => setLift(null)} busy={release.isPending} tone="primary" confirmLabel="Lift hold"
        title={`Lift "${lift?.name ?? ""}"?`} description="Its mail can be deleted again by people and by the retention policy. The record of the hold is kept."
        onConfirm={() => lift && release.mutate(lift.id)} />
    </div>
  );
}

function PlaceHoldDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const targets = useQuery({ queryKey: ["mail-archive", "targets"], queryFn: () => api.get<Targets>("/mail-archive/holds/targets") });
  const [kind, setKind] = useState<"mailbox" | "person">("mailbox");
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const place = useMutation({
    mutationFn: () => api.post("/mail-archive/holds", { kind, targetId, name, note: note || null }),
    onSuccess: () => { toast.success("Hold placed"); void qc.invalidateQueries({ queryKey: ["mail-archive"] }); onClose(); },
  });
  const list = kind === "mailbox" ? (targets.data?.mailboxes ?? []).map((m) => ({ id: m.id, label: m.address })) : (targets.data?.people ?? []).map((p) => ({ id: p.id, label: p.name ? `${p.name} (${p.email})` : p.email }));
  const submit = (e?: FormEvent) => { e?.preventDefault(); if (targetId && name.trim()) place.mutate(); };
  return (
    <Dialog open onClose={onClose} title="Place a legal hold" description="Mail in scope can't be deleted until you lift the hold."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={place.isPending} disabled={!targetId || !name.trim()} onClick={() => submit()}>Place hold</Button></>}>
      <form className="space-y-4" onSubmit={submit}>
        <div role="radiogroup" aria-label="Hold" className="inline-flex rounded-lg bg-fill p-0.5">
          {(["mailbox", "person"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setTargetId(""); }}
              className={cn("rounded-md px-3 py-1.5 text-[13px] max-sm:min-h-11", kind === k ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{k === "mailbox" ? "A mailbox" : "A person"}</button>
          ))}
        </div>
        <Field label={kind === "mailbox" ? "Mailbox" : "Person"} hint={kind === "person" ? "Covers every mailbox they can open and the mail they sent." : undefined}>
          {(p) => (
            <Select {...p} value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={targets.isPending}>
              <option value="">{targets.isPending ? "Loading" : kind === "mailbox" ? "Choose a mailbox" : "Choose a person"}</option>
              {list.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Name" hint="For example the matter, case or audit it is for." error={place.error instanceof ApiError ? place.error.message : undefined}>
          {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Supplier dispute 2026" />}
        </Field>
        <Field label="Note (optional)">{(p) => <Textarea {...p} value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

/* ---------- Search and export ---------- */

const EMPTY: ArchiveFilters = {};
function SearchPanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ArchiveFilters>(EMPTY);
  const [applied, setApplied] = useState<ArchiveFilters | null>(null);
  const [pages, setPages] = useState<{ hits: ArchiveHit[]; next: string | null }[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const boxes = useQuery({ queryKey: ["mail-archive", "targets"], queryFn: () => api.get<Targets>("/mail-archive/holds/targets") });
  const cases = useQuery({ queryKey: ["mail-archive", "cases"], queryFn: () => api.get<{ cases: MailCaseView[] }>("/mail-archive/cases") });
  const search = useMutation({
    mutationFn: (v: { filters: ArchiveFilters; cursor?: string }) => api.post<{ hits: ArchiveHit[]; next: string | null }>("/mail-archive/search", v),
    onSuccess: (r, v) => setPages((p) => (v.cursor ? [...p, r] : [r])),
    onError: showError,
  });
  const run = (e?: FormEvent) => { e?.preventDefault(); const f = cleanFilters(draft); setApplied(f); search.mutate({ filters: f }); };
  const set = (k: keyof ArchiveFilters, v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }));
  const hits = pages.flatMap((p) => p.hits);
  const next = pages[pages.length - 1]?.next ?? null;
  const boxName = (id: string) => boxes.data?.mailboxes.find((m) => m.id === id)?.address;
  const [delCase, setDelCase] = useState<MailCaseView | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/mail-archive/cases/${id}`), onSuccess: () => { setDelCase(null); toast.success("Case deleted. No mail was deleted."); void qc.invalidateQueries({ queryKey: ["mail-archive", "cases"] }); }, onError: showError });
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form onSubmit={run} className="space-y-4" aria-label="Search all mail">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Words" className="sm:col-span-2">{(p) => <Input {...p} type="search" value={draft.q ?? ""} maxLength={200} onChange={(e) => set("q", e.target.value)} placeholder="Subject, sender or text" />}</Field>
            <Field label="From">{(p) => <Input {...p} value={draft.from ?? ""} maxLength={254} onChange={(e) => set("from", e.target.value)} placeholder="name or address" />}</Field>
            <Field label="To or cc">{(p) => <Input {...p} value={draft.to ?? ""} maxLength={254} onChange={(e) => set("to", e.target.value)} placeholder="name or address" />}</Field>
            <Field label="Mailbox">{(p) => (
              <Select {...p} value={draft.mailboxId ?? ""} onChange={(e) => set("mailboxId", e.target.value)}>
                <option value="">All mailboxes</option>
                {(boxes.data?.mailboxes ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
              </Select>
            )}</Field>
            <Field label="Folder">{(p) => (
              <Select {...p} value={draft.folder ?? ""} onChange={(e) => set("folder", e.target.value)}>
                <option value="">All folders</option>
                {(["inbox", "sent", "archive", "spam", "trash"] as const).map((f) => <option key={f} value={f}>{f[0]!.toUpperCase() + f.slice(1)}</option>)}
              </Select>
            )}</Field>
            <Field label="From date">{(p) => <Input {...p} type="date" value={draft.after ?? ""} onChange={(e) => set("after", e.target.value)} />}</Field>
            <Field label="Before date">{(p) => <Input {...p} type="date" value={draft.before ?? ""} onChange={(e) => set("before", e.target.value)} />}</Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm max-sm:min-h-11"><input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={!!draft.hasAttachments} onChange={(e) => set("hasAttachments", e.target.checked)} />With attachments</label>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setDraft(EMPTY); setApplied(null); setPages([]); }}>Clear</Button>
              <Button type="submit" loading={search.isPending && !pages.length}><IconSearch className="h-4 w-4" aria-hidden />Search</Button>
            </div>
          </div>
        </form>
      </Card>

      {applied && (
        <Card className="overflow-hidden" data-testid="archive-results">
          <div className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-sm"><span className="font-medium">{search.isPending && !pages.length ? "Searching" : `${hits.length}${next ? "+" : ""} ${hits.length === 1 ? "message" : "messages"}`}</span> <span className="text-muted">· {describeFilters(applied, boxName)}</span></p>
            <Button variant="outline" size="sm" disabled={!hits.length} onClick={() => setSaveOpen(true)}><IconDownload className="h-4 w-4" aria-hidden />Save as case and export</Button>
          </div>
          {search.isPending && !pages.length ? <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            : !hits.length ? <EmptyState icon={<IconSearch />} title="No mail matches" body="Try fewer words, a wider date range or all mailboxes." />
            : (
              <ul className="divide-y divide-line">
                {hits.map((h) => (
                  <li key={h.id} className="grid gap-1 px-4 py-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2"><span className="truncate font-medium" title={h.fromAddress}>{h.fromName || h.fromAddress}</span>{h.held && <Badge tone="warn"><IconLock className="h-3 w-3" aria-hidden />On hold</Badge>}{h.hasAttachments && <span className="sr-only">Has attachments</span>}</div>
                      <p className="truncate" title={h.subject}>{h.subject || <span className="text-subtle">(no subject)</span>}</p>
                      <p className="truncate text-xs text-subtle">{h.mailbox} · {h.folder}{h.to.length ? ` · to ${h.to.join(", ")}` : ""}</p>
                    </div>
                    <time className="whitespace-nowrap text-xs text-muted" dateTime={h.date} title={fullDate(h.date)}>{day(h.date)}</time>
                  </li>
                ))}
              </ul>
            )}
          {next && <div className="border-t border-line p-2"><Button variant="ghost" className="w-full" loading={search.isPending} onClick={() => search.mutate({ filters: applied, cursor: next })}>Load more</Button></div>}
        </Card>
      )}

      <section aria-labelledby="cases-h" className="space-y-2">
        <h2 id="cases-h" className="text-[15px] font-semibold">Cases</h2>
        {cases.isPending ? <Card className="p-4"><Skeleton className="h-4 w-1/2" /></Card>
          : cases.isError ? <ErrorCard onRetry={() => cases.refetch()} text="Couldn't load cases." />
          : !cases.data.cases.length ? <Card><EmptyState icon={<IconArchive />} title="No cases yet" body="Search for the mail you need, then save it as a case to export it as an mbox file in a ZIP." /></Card>
          : (
            <Card className="divide-y divide-line" data-testid="cases-list">
              {cases.data.cases.map((c) => (
                <div key={c.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-[13px]">
                    <p className="truncate font-medium" title={c.name}>{c.name}</p>
                    <p className="truncate text-muted">{describeFilters(c.filters, boxName)}</p>
                    <p className="text-xs text-subtle">Saved {day(c.createdAt)}{c.createdBy ? ` by ${c.createdBy}` : ""}{c.lastExportedAt ? ` · exported ${c.exportCount} ${c.exportCount === 1 ? "time" : "times"}, last ${day(c.lastExportedAt)}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <a href={`/api/mail-archive/cases/${c.id}/export`} download onClick={() => setTimeout(() => void qc.invalidateQueries({ queryKey: ["mail-archive", "cases"] }), 1500)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium hover:bg-hover max-sm:min-h-11"><IconDownload className="h-4 w-4" aria-hidden />Export ZIP</a>
                    <Button variant="ghost" size="sm" aria-label={`Delete case ${c.name}`} onClick={() => setDelCase(c)}><IconTrash className="h-4 w-4" aria-hidden /></Button>
                  </div>
                </div>
              ))}
            </Card>
          )}
      </section>
      {saveOpen && applied && <SaveCaseDialog filters={applied} onClose={() => setSaveOpen(false)} />}
      <ConfirmDialog open={!!delCase} onClose={() => setDelCase(null)} busy={remove.isPending} confirmLabel="Delete case"
        title={`Delete "${delCase?.name ?? ""}"?`} description="Only the saved search goes. No mail is deleted." onConfirm={() => delCase && remove.mutate(delCase.id)} />
    </div>
  );
}

function SaveCaseDialog({ filters, onClose }: { filters: ArchiveFilters; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ case: MailCaseView }>("/mail-archive/cases", { name, filters }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["mail-archive", "cases"] });
      const a = document.createElement("a");
      a.href = `/api/mail-archive/cases/${r.case.id}/export`; a.download = ""; document.body.appendChild(a); a.click(); a.remove();
      toast.success("Case saved. Your export is downloading.");
      onClose();
    },
  });
  const submit = (e?: FormEvent) => { e?.preventDefault(); if (name.trim()) create.mutate(); };
  return (
    <Dialog open onClose={onClose} title="Save as case and export" description="The export is a ZIP with every matching message as an mbox file, a CSV list and a summary. It is recorded in the audit log."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} disabled={!name.trim()} onClick={() => submit()}><IconDownload className="h-4 w-4" aria-hidden />Save and export</Button></>}>
      <form onSubmit={submit}>
        <Field label="Case name" error={create.error instanceof ApiError ? create.error.message : undefined}>{(p) => <Input {...p} autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Supplier dispute 2026" />}</Field>
      </form>
    </Dialog>
  );
}
