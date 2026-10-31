/**
 * R94 CRM pieces around the timeline: saved segments on the contacts list, CSV import with dedupe, companies added by
 * hand and the company page, and the deal forecast with won and lost reasons. All behind CRM_TIMELINE.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowLeft, IconBuilding, IconCheck, IconFilter, IconFilterX, IconGlobe, IconPlus, IconTeam, IconTrash, IconTrendingUp, IconUpload } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Avatar, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { initials, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { CSV_FIELDS, CSV_FIELD_LABELS, CSV_MAX_BYTES, checkRows, guessMapping, parseCsv, type CsvMapping } from "@/shared/crm-csv";
import { CrmTimeline } from "./crm-timeline";
import type { Contact } from "./data";

const aud = (n: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);

/* Segments */

export interface SegFilters { source?: string; noCompany?: boolean; hasOpenDeal?: boolean; lastWithinDays?: number; lastOlderThanDays?: number }
export interface Segment { id: string; name: string; filters: SegFilters; shared: boolean; canEdit: boolean }
export const hasFilters = (f: SegFilters) => Object.values(f).some((v) => v !== undefined && v !== false && v !== "");
export function filtersQuery(f: SegFilters, q: string) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== false && v !== "") p.set(k, String(v));
  return p.toString();
}
const LAST: { id: string; label: string; f: SegFilters }[] = [
  { id: "", label: "Any time", f: {} }, { id: "w7", label: "Last 7 days", f: { lastWithinDays: 7 } }, { id: "w30", label: "Last 30 days", f: { lastWithinDays: 30 } },
  { id: "w90", label: "Last 90 days", f: { lastWithinDays: 90 } }, { id: "o90", label: "Not in 90 days", f: { lastOlderThanDays: 90 } },
];
const lastId = (f: SegFilters) => LAST.find((l) => l.f.lastWithinDays === f.lastWithinDays && l.f.lastOlderThanDays === f.lastOlderThanDays)?.id ?? "";

export function SegmentBar({ segment, setSegment, filters, setFilters }: { segment: Segment | null; setSegment: (s: Segment | null) => void; filters: SegFilters; setFilters: (f: SegFilters) => void }) {
  const qc = useQueryClient();
  const segs = useQuery({ queryKey: ["crm-segments"], queryFn: async () => (await api.get<{ segments: Segment[] }>("/crm/segments")).segments });
  const [showFilters, setShowFilters] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = segment ? segment.filters : filters;
  const remove = async (s: Segment) => {
    try { await api.del(`/crm/segments/${s.id}`); if (segment?.id === s.id) setSegment(null); await qc.invalidateQueries({ queryKey: ["crm-segments"] }); toast(`Removed ${s.name}`); } catch (e) { showError(e as Error); }
  };
  return (
    <div className="mb-3" data-testid="segment-bar">
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
        <button type="button" aria-pressed={!segment && !hasFilters(filters)} onClick={() => { setSegment(null); setFilters({}); }}
          className={cn("h-8 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors duration-150", !segment && !hasFilters(filters) ? "border-brand/40 bg-brand/10 font-medium" : "border-line text-muted hover:bg-hover hover:text-fg")}>Everyone</button>
        {segs.data?.map((s) => (
          <button key={s.id} type="button" aria-pressed={segment?.id === s.id} onClick={() => { setSegment(s); setFilters({}); setShowFilters(false); }}
            className={cn("h-8 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors duration-150", segment?.id === s.id ? "border-brand/40 bg-brand/10 font-medium" : "border-line text-muted hover:bg-hover hover:text-fg")}>
            {s.name}{s.shared && <span className="sr-only"> (team)</span>}
          </button>
        ))}
        <button type="button" aria-expanded={showFilters} onClick={() => { setShowFilters((v) => !v); if (segment) { setFilters(segment.filters); setSegment(null); } }}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 text-[12.5px] text-muted transition-colors duration-150 hover:bg-hover hover:text-fg" data-testid="filters-toggle">
          <IconFilter className="h-3.5 w-3.5" aria-hidden />Filter
        </button>
        {segment?.canEdit && <Button size="sm" variant="ghost" onClick={() => void remove(segment)} aria-label={`Remove segment ${segment.name}`}><IconTrash className="h-4 w-4" /></Button>}
      </div>
      {showFilters && !segment && (
        <Card className="mt-2 flex flex-wrap items-end gap-3 p-3" data-testid="filters-panel">
          <label className="grid gap-1 text-[12px] text-subtle">Last email
            <Select value={lastId(active)} onChange={(e) => { const l = LAST.find((x) => x.id === e.target.value)!; setFilters({ ...filters, lastWithinDays: l.f.lastWithinDays, lastOlderThanDays: l.f.lastOlderThanDays }); }} className="h-9 w-auto text-[13px]">
              {LAST.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </label>
          <label className="grid gap-1 text-[12px] text-subtle">Added
            <Select value={filters.source ?? ""} onChange={(e) => setFilters({ ...filters, source: e.target.value || undefined })} className="h-9 w-auto text-[13px]">
              <option value="">Any way</option><option value="mail">From email</option><option value="manual">By hand</option><option value="import">From a file</option>
            </Select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={!!filters.noCompany} onChange={(e) => setFilters({ ...filters, noCompany: e.target.checked || undefined })} />No company</label>
          <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={!!filters.hasOpenDeal} onChange={(e) => setFilters({ ...filters, hasOpenDeal: e.target.checked || undefined })} />Has an open deal</label>
          <div className="ml-auto flex gap-2">
            {hasFilters(filters) && <Button size="sm" variant="ghost" onClick={() => setFilters({})}><IconFilterX className="h-4 w-4" />Clear</Button>}
            <Button size="sm" variant="secondary" disabled={!hasFilters(filters)} onClick={() => setSaving(true)} data-testid="save-segment">Save as segment</Button>
          </div>
        </Card>
      )}
      {saving && <SaveSegmentDialog filters={filters} onClose={() => setSaving(false)} onSaved={(s) => { setSegment(s); setFilters({}); setShowFilters(false); }} />}
    </div>
  );
}

function SaveSegmentDialog({ filters, onClose, onSaved }: { filters: SegFilters; onClose: () => void; onSaved: (s: Segment) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { const r = await api.post<{ segment: Segment }>("/crm/segments", { name, filters, shared }); await qc.invalidateQueries({ queryKey: ["crm-segments"] }); toast(`Saved ${r.segment.name}`); onSaved(r.segment); onClose(); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Save as segment" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={() => void submit()}>Save segment</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name">{(f) => <Input {...f} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Quiet for 90 days" />}</Field>
        <label className="flex min-h-11 items-center gap-2 text-[13.5px]"><input type="checkbox" className="h-4 w-4" checked={shared} onChange={(e) => setShared(e.target.checked)} />Share with my team</label>
      </form>
    </Dialog>
  );
}

/* CSV import */

export function ImportContactsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [existing, setExisting] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headers = rows?.[0] ?? [];
  const check = useMemo(() => (rows && mapping ? checkRows(rows.slice(1), mapping) : null), [rows, mapping]);
  const pick = async (file: File | undefined) => {
    setError(null); setResult(null); setExisting(null);
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) { setError("That file is over 2 MB. Split it into smaller files."); return; }
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) { setError("That file has no rows under its header."); return; }
    const m = guessMapping(parsed[0]);
    setRows(parsed); setFileName(file.name); setMapping(m);
    const c = checkRows(parsed.slice(1), m);
    try { const r = await api.post<{ existing: number }>("/crm/import/check", { emails: c.rows.map((x) => x.email) }); setExisting(r.existing); } catch { setExisting(null); }
  };
  const remap = async (m: CsvMapping) => {
    setMapping(m);
    if (!rows) return;
    const c = checkRows(rows.slice(1), m);
    try { const r = await api.post<{ existing: number }>("/crm/import/check", { emails: c.rows.map((x) => x.email) }); setExisting(r.existing); } catch { setExisting(null); }
  };
  const run = async () => {
    if (!check?.rows.length) return;
    const total = check.rows.length;
    const sum = { created: 0, updated: 0, skipped: 0, failed: 0 };
    setProgress({ done: 0, total });
    try {
      for (let i = 0; i < total; i += 25) {
        const r = await api.post<{ created: number; updated: number; skipped: number; failed: unknown[] }>("/crm/import/batch", { rows: check.rows.slice(i, i + 25), mode });
        sum.created += r.created; sum.updated += r.updated; sum.skipped += r.skipped; sum.failed += r.failed.length;
        setProgress({ done: Math.min(total, i + 25), total });
      }
      setResult(sum);
      await qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) { showError(e as Error); setResult(sum); } finally { setProgress(null); }
  };
  const footer = result ? <Button onClick={onClose}>Done</Button> : (
    <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={!!progress} disabled={!check?.rows.length || mapping?.email === -1} onClick={() => void run()} data-testid="import-run">{check?.rows.length ? `Import ${check.rows.length} ${check.rows.length === 1 ? "contact" : "contacts"}` : "Import"}</Button></>
  );
  return (
    <Dialog open onClose={onClose} title="Import contacts" description="From a CSV file. We match people by email so nobody is added twice." footer={footer} className="max-w-xl">
      {result ? (
        <div className="space-y-2 text-[14px]" role="status" data-testid="import-result">
          <p className="flex items-center gap-2 font-medium"><IconCheck className="h-4 w-4 text-success" aria-hidden />Import finished</p>
          <p className="text-muted">{result.created} added, {result.updated} updated, {result.skipped} already here and left as they were{result.failed ? `, ${result.failed} could not be added` : ""}.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong p-4 text-center text-[13.5px] text-muted transition-colors duration-150 hover:bg-hover focus-within:ring-2 focus-within:ring-brand/40">
            <IconUpload className="h-5 w-5" aria-hidden />
            <span>{fileName ? <>Using <span className="font-medium text-fg">{fileName}</span>. Pick another file</> : "Pick a CSV file"}</span>
            <span className="text-[12px] text-subtle">Up to 5,000 rows and 2 MB. Exports from Google, Outlook and most tools work.</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} data-testid="import-file" />
          </label>
          {error && <p className="text-[13px] text-danger" role="alert">{error}</p>}
          {rows && mapping && check && (
            <>
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-subtle">Columns</legend>
                {CSV_FIELDS.map((f) => (
                  <label key={f} className="grid gap-1 text-[12.5px] text-subtle">{CSV_FIELD_LABELS[f]}{f === "email" && " (needed)"}
                    <Select value={mapping[f]} onChange={(e) => void remap({ ...mapping, [f]: Number(e.target.value) })} className="h-9 text-[13px]">
                      <option value={-1}>Do not import</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </Select>
                  </label>
                ))}
              </fieldset>
              <Card className="p-3 text-[13px]" data-testid="import-summary">
                <ul className="space-y-1">
                  <li><span className="font-medium tabular-nums">{check.rows.length}</span> ready to import{existing !== null && <> · <span className="tabular-nums">{existing}</span> already in your contacts</>}</li>
                  {check.duplicatesInFile > 0 && <li><span className="tabular-nums">{check.duplicatesInFile}</span> repeated in the file, kept once</li>}
                  {check.invalid.length > 0 && <li className="text-danger"><span className="tabular-nums">{check.invalid.length}</span> rows skipped: {check.invalid.slice(0, 3).map((x) => `line ${x.line} (${x.reason.toLowerCase()})`).join(", ")}{check.invalid.length > 3 ? " and more" : ""}</li>}
                  {check.tooMany && <li className="text-danger">Only the first 5,000 rows are imported.</li>}
                </ul>
              </Card>
              {(existing ?? 0) > 0 && (
                <fieldset className="grid gap-1 text-[13.5px]">
                  <legend className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-subtle">People already here</legend>
                  <label className="flex min-h-11 items-center gap-2"><input type="radio" name="mode" checked={mode === "skip"} onChange={() => setMode("skip")} />Leave them as they are</label>
                  <label className="flex min-h-11 items-center gap-2"><input type="radio" name="mode" checked={mode === "update"} onChange={() => setMode("update")} />Fill in name, phone, title and company from the file</label>
                </fieldset>
              )}
              {progress && <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Importing" className="h-2 overflow-hidden rounded-full bg-fill"><div className="h-full bg-brand transition-[width] duration-200" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* Companies */

export function NewCompanyDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ company: { id: string } }>("/crm/companies", { name, domain: domain || null });
      await qc.invalidateQueries({ queryKey: ["companies"] });
      onClose(); navigate(`/app/contacts/companies/${r.company.id}`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New company" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={() => void submit()}>Add company</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name">{(f) => <Input {...f} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Harbour Coffee" />}</Field>
        <Field label="Website" hint="People who email from this domain join the company on their own.">{(f) => <Input {...f} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="harbourcoffee.com.au" />}</Field>
      </form>
    </Dialog>
  );
}

interface CompanyDetail { company: { id: string; name: string; domain: string | null; notes: string }; contacts: Contact[]; deals: { id: string; title: string; stage: string; value: number }[] }

export function CompanyPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["company", id], queryFn: () => api.get<CompanyDetail>(`/companies/${id}`) });
  const [notes, setNotes] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.error) return <EmptyState icon={<IconBuilding />} title="Company not found" body="It may have been removed." action={<Button onClick={() => navigate("/app/contacts?tab=companies")}>All companies</Button>} />;
  const { company: c, contacts, deals } = q.data;
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const saveNotes = async () => {
    if (notes === null || notes === c.notes) return;
    try { await api.patch(`/companies/${c.id}`, { name: c.name, notes }); await qc.invalidateQueries({ queryKey: ["company", id] }); } catch (e) { showError(e as Error); }
  };
  return (
    <div>
      <Link to="/app/contacts?tab=companies" className="mb-4 inline-flex min-h-6 items-center gap-1 text-[12.5px] text-subtle hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />Companies</Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-elevated"><IconBuilding className="h-5 w-5 text-muted" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h1 className="large-title truncate" data-testid="company-name">{c.name}</h1>
          <p className="text-[13.5px] text-muted">{c.domain ? <span className="inline-flex items-center gap-1"><IconGlobe className="h-3.5 w-3.5" aria-hidden />{c.domain}</span> : "No website"} · {contacts.length} {contacts.length === 1 ? "person" : "people"}</p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(true)}>Rename</Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0"><CrmTimeline type="company" id={c.id} /></div>
        <aside className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">People</h2>
            {!contacts.length ? <p className="text-[13px] text-muted">Nobody yet. Open a contact and pick this company.</p> : (
              <ul className="-mx-2 space-y-0.5">
                {contacts.slice(0, 12).map((p) => (
                  <li key={p.id}><Link to={`/app/contacts/${p.id}`} className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                    <Avatar label={initials(p.name || p.email)} className="h-7 w-7 text-[11px]" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px]">{p.name || p.email}</span><span className="block truncate text-[12px] text-subtle">{p.lastContactAt ? `Last ${timeAgo(p.lastContactAt)}` : p.email}</span></span>
                  </Link></li>
                ))}
              </ul>
            )}
            {contacts.length > 12 && <p className="mt-2 text-[12.5px] text-subtle">and {contacts.length - 12} more</p>}
          </Card>
          <Card className="p-4 text-[13px]">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Deals</h2>
            {!deals.length ? <p className="text-muted">No deals yet.</p> : (
              <dl className="grid grid-cols-[1fr_auto] gap-y-1.5">
                <dt className="text-subtle">Open</dt><dd className="tabular-nums">{aud(open.reduce((n, d) => n + d.value, 0))}</dd>
                <dt className="text-subtle">Won</dt><dd className="tabular-nums">{aud(deals.filter((d) => d.stage === "won").reduce((n, d) => n + d.value, 0))}</dd>
              </dl>
            )}
            <Link to="/app/deals" className="mt-2 inline-flex min-h-6 text-[12.5px] text-subtle hover:text-fg">Open deals board</Link>
          </Card>
          <div>
            <label htmlFor="company-notes" className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Notes</label>
            <Textarea id="company-notes" className="mt-2 min-h-28 text-[13px]" value={notes ?? c.notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => void saveNotes()} placeholder="What matters about this company" />
          </div>
        </aside>
      </div>
      {editing && <RenameCompany id={c.id} name={c.name} notes={c.notes} onClose={() => setEditing(false)} />}
    </div>
  );
}

function RenameCompany({ id, name: initial, notes, onClose }: { id: string; name: string; notes: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await api.patch(`/companies/${id}`, { name, notes }); await qc.invalidateQueries({ queryKey: ["company", id] }); await qc.invalidateQueries({ queryKey: ["companies"] }); onClose(); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Rename company" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={() => void submit()}>Save</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}><Field label="Name">{(f) => <Input {...f} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field></form>
    </Dialog>
  );
}

/** The company a contact belongs to, changeable from the contact page. */
export function CompanyPicker({ contactId, companyId }: { contactId: string; companyId: string | null }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["companies", ""], queryFn: async () => (await api.get<{ companies: { id: string; name: string }[] }>("/companies")).companies });
  const change = async (v: string) => {
    try { await api.patch(`/contacts/${contactId}`, { companyId: v || null }); await qc.invalidateQueries({ queryKey: ["contact", contactId] }); toast(v ? "Company set" : "Company removed"); } catch (e) { showError(e as Error); }
  };
  return (
    <label className="grid gap-1 text-[12px] font-semibold uppercase tracking-wide text-subtle">Company
      <Select value={companyId ?? ""} onChange={(e) => void change(e.target.value)} className="h-9 text-[13px] font-normal normal-case tracking-normal text-fg" data-testid="company-picker">
        <option value="">No company</option>
        {list.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
    </label>
  );
}

/* Deals: forecast and reasons */

interface Forecast { openWeighted: number; openTotal: number; openCount: number; noDate: number; overdue: number; wonThisMonth: number; lostThisMonth: number; wonCount: number; lostCount: number; months: { month: string; weighted: number; total: number; count: number }[]; reasons: { won: { reason: string; count: number }[]; lost: { reason: string; count: number }[] } }

export function ForecastStrip() {
  const q = useQuery({ queryKey: ["crm-forecast"], queryFn: () => api.get<Forecast>("/crm/forecast") });
  if (q.isPending) return <Skeleton className="mb-4 h-24 rounded-xl" />;
  if (q.error || !q.data) return null;
  const f = q.data;
  const max = Math.max(1, ...f.months.slice(0, 3).map((m) => m.weighted));
  const monthName = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  return (
    <Card className="mb-4 grid gap-4 p-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.4fr)]" data-testid="forecast">
      <div><div className="text-[12px] text-subtle">Weighted pipeline</div><div className="text-[20px] font-semibold tabular-nums">{aud(f.openWeighted)}</div><div className="text-[12px] text-muted">{f.openCount} open, {aud(f.openTotal)} in full</div></div>
      <div><div className="text-[12px] text-subtle">Won this month</div><div className="text-[20px] font-semibold tabular-nums">{aud(f.wonThisMonth)}</div><div className="text-[12px] text-muted">{f.wonCount} won, {f.lostCount} lost</div></div>
      <div><div className="text-[12px] text-subtle">Top reason lost</div><div className="truncate text-[15px] font-medium">{f.reasons.lost[0]?.reason ?? "None yet"}</div><div className="text-[12px] text-muted">{f.overdue ? `${f.overdue} past their close date` : f.noDate ? `${f.noDate} with no close date` : "Close dates look current"}</div></div>
      <div aria-label="Expected to close, weighted">
        <div className="mb-1 flex items-center gap-1 text-[12px] text-subtle"><IconTrendingUp className="h-3.5 w-3.5" aria-hidden />Next 3 months, weighted</div>
        <ul className="space-y-1">
          {f.months.slice(0, 3).map((m) => (
            <li key={m.month} className="grid grid-cols-[36px_1fr_auto] items-center gap-2 text-[12.5px]">
              <span className="text-subtle">{monthName(m.month)}</span>
              <span className="h-2 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full bg-brand/70" style={{ width: `${(m.weighted / max) * 100}%` }} /></span>
              <span className="tabular-nums">{aud(m.weighted)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

const WON = ["Best price", "Fast reply", "Right fit", "Referral"];
const LOST = ["Price", "Timing", "Chose another option", "No reply", "No budget"];

/** Asked when a deal lands in Won or Lost; skipping keeps the move. */
export function CloseReasonDialog({ stage, title, onDone }: { stage: "won" | "lost"; title: string; onDone: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  const picks = stage === "won" ? WON : LOST;
  return (
    <Dialog open onClose={() => onDone(null)} title={stage === "won" ? `Nice. Why did ${title} win?` : `Why was ${title} lost?`} description="It helps the forecast show what works. You can skip it."
      footer={<><Button variant="secondary" onClick={() => onDone(null)}>Skip</Button><Button disabled={!reason.trim()} onClick={() => onDone(reason.trim())} data-testid="reason-save">Save reason</Button></>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {picks.map((p) => <button key={p} type="button" onClick={() => setReason(p)} aria-pressed={reason === p} className={cn("min-h-9 rounded-full border px-3 text-[13px] transition-colors duration-150", reason === p ? "border-brand/40 bg-brand/10 font-medium" : "border-line hover:bg-hover")}>{p}</button>)}
      </div>
      <Field label="Or in your words">{(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />}</Field>
    </Dialog>
  );
}

/** Edit a deal's chance, close date and reason. */
export function DealDetailsDialog({ deal, onClose }: { deal: { id: string; title: string; stage: string; value: number; expectedClose: string | null; probability?: number; probabilitySet?: boolean; closeReason?: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const [prob, setProb] = useState(deal.probabilitySet ? String(deal.probability ?? "") : "");
  const [close, setClose] = useState(deal.expectedClose?.slice(0, 10) ?? "");
  const [value, setValue] = useState(String(deal.value));
  const [reason, setReason] = useState(deal.closeReason ?? "");
  const [busy, setBusy] = useState(false);
  const closed = deal.stage === "won" || deal.stage === "lost";
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(`/deals/${deal.id}`, { value: Number(value) || 0, expectedClose: close || null, ...(closed ? { closeReason: reason || null } : { probability: prob === "" ? null : Math.max(0, Math.min(100, Number(prob))) }) });
      await qc.invalidateQueries({ queryKey: ["deals"] }); await qc.invalidateQueries({ queryKey: ["crm-forecast"] }); onClose();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={deal.title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void submit()} data-testid="deal-save">Save</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Value (A$, ex GST)">{(f) => <Input {...f} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))} />}</Field>
        <Field label="Expected close">{(f) => <Input {...f} type="date" value={close} onChange={(e) => setClose(e.target.value)} />}</Field>
        {closed ? (
          <Field label={deal.stage === "won" ? "Why it was won" : "Why it was lost"}>{(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />}</Field>
        ) : (
          <Field label="Chance to win (%)" hint={`Leave empty to use the stage default (${deal.probabilitySet ? "set by hand now" : `${deal.probability ?? 0}%`}).`}>{(f) => <Input {...f} inputMode="numeric" value={prob} onChange={(e) => setProb(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} placeholder={String(deal.probability ?? "")} data-testid="deal-probability" />}</Field>
        )}
      </form>
    </Dialog>
  );
}

export { IconPlus, IconTeam };
