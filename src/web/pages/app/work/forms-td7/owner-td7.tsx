/**
 * TD7 Forms pro B for form owners (FORMS_TD7): the look (brand kit with a live preview), access (close date,
 * response cap, password, save and resume), views and completion with drop off per question, saved parts, and
 * starting a form from pasted questions, a CSV file or an AI draft (AI only when the workspace allows it).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { timeAgo } from "@/web/lib/format";
import {
  ACCENT_LABELS, BRAND_ACCENTS, BRAND_FONTS, BRAND_SURFACES, CLOSED_MESSAGE_MAX, FONT_LABELS, PASSWORD_MAX, PASSWORD_MIN, parseImport,
  type FieldReach, type ImportedField, type Td7Settings,
} from "@/shared/forms-td7";

interface ProState { settings: Td7Settings; hasPassword: boolean; responses: number; closed: "date" | "cap" | null }
interface Analytics { totals: { views: number; starts: number; completions: number }; completionRate: number; startRate: number; days: { day: string; views: number; starts: number; completions: number }[]; questions: FieldReach[]; partials: number }
interface Partial { id: string; answered: number; answers: Record<string, string | string[]>; updatedAt: string; expiresAt: string }
type Tab = "look" | "access" | "analytics" | "saved";
const TABS: { id: Tab; label: string }[] = [{ id: "look", label: "Look" }, { id: "access", label: "Access" }, { id: "analytics", label: "Views and completion" }, { id: "saved", label: "Saved parts" }];

/** datetime-local value in the viewer's own time zone, from an ISO time. */
const toLocal = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export function Td7FormDialog({ form, onClose }: { form: { id: string; name: string; url: string; fields: { id?: string; label: string }[] }; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("look");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (n < 0) return; e.preventDefault(); setTab(TABS[n].id); tabRefs.current[n]?.focus();
  };
  return (
    <Dialog open onClose={onClose} title={`${form.name}: more settings`} className="max-w-2xl" footer={<Button variant="ghost" onClick={onClose}>Done</Button>}>
      <div role="tablist" aria-label="Form settings" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t, i) => (
          <button key={t.id} ref={(el) => { tabRefs.current[i] = el; }} role="tab" id={`td7-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`td7-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg"}`}
            onClick={() => setTab(t.id)} onKeyDown={(e) => onKey(e, i)} data-testid={`td7-tab-${t.id}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`td7-panel-${tab}`} aria-labelledby={`td7-tab-${tab}`}>
        {tab === "look" || tab === "access" ? <SettingsPanel formId={form.id} name={form.name} part={tab} /> : tab === "analytics" ? <AnalyticsPanel formId={form.id} /> : <SavedPanel formId={form.id} fields={form.fields} />}
      </div>
    </Dialog>
  );
}

function SettingsPanel({ formId, name, part }: { formId: string; name: string; part: "look" | "access" }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["form-td7", formId], queryFn: () => api.get<ProState>(`/forms/${formId}/pro`) });
  const [s, setS] = useState<Td7Settings | null>(null);
  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !s) setS(q.data.settings); }, [q.data, s]);
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data || !s) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>;
  const save = async (body: { settings?: Td7Settings; password?: string | null }, done = "Saved") => {
    setBusy(true);
    try {
      const r = await api.put<ProState>(`/forms/${formId}/pro`, body);
      qc.setQueryData(["form-td7", formId], r); setS(r.settings); setPw(""); setPwErr(""); toast.success(done);
    } catch (e) {
      if (e instanceof ApiError && e.fields?.password) setPwErr(e.fields.password); else showError(e as Error);
    } finally { setBusy(false); }
  };
  const b = s.brand;
  if (part === "look") return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-3">
        <Field label="Colour">{(fp) => (<Select {...fp} value={b.accent} onChange={(e) => setS({ ...s, brand: { ...b, accent: e.target.value as typeof b.accent } })} data-testid="td7-accent">{BRAND_ACCENTS.map((a) => <option key={a} value={a}>{ACCENT_LABELS[a]}</option>)}</Select>)}</Field>
        <Field label="Background">{(fp) => (<Select {...fp} value={b.surface} onChange={(e) => setS({ ...s, brand: { ...b, surface: e.target.value as typeof b.surface } })}>{BRAND_SURFACES.map((x) => <option key={x} value={x}>{x === "plain" ? "Plain" : "Tinted with the colour"}</option>)}</Select>)}</Field>
        <Field label="Font">{(fp) => (<Select {...fp} value={b.font} onChange={(e) => setS({ ...s, brand: { ...b, font: e.target.value as typeof b.font } })}>{BRAND_FONTS.map((x) => <option key={x} value={x}>{FONT_LABELS[x]}</option>)}</Select>)}</Field>
        <Field label="Logo" hint="Uses your workspace logo from Settings, Branding.">{(fp) => (<Select {...fp} value={b.logo} onChange={(e) => setS({ ...s, brand: { ...b, logo: e.target.value as typeof b.logo } })}><option value="none">No logo</option><option value="mark">Square mark</option><option value="wide">Wide logo</option></Select>)}</Field>
        <Button onClick={() => void save({ settings: s }, "Look saved")} loading={busy} data-testid="td7-save-look">Save look</Button>
      </div>
      <div aria-label="Preview" role="img" className="td7-brand flex overflow-hidden rounded-xl border border-line bg-bg" data-brand-accent={b.accent} data-brand-surface={b.surface} data-brand-font={b.font} data-testid="td7-preview">
        <div className="flex w-full items-center bg-bg p-4">
          <div className="w-full rounded-lg bg-surface p-4 shadow-sm">
            <p className="text-[15px] font-semibold">{name}</p>
            <p className="mt-3 text-[12px] text-muted">Your name</p>
            <div className="mt-1 h-8 rounded-md border border-line bg-surface" />
            <div className="mt-4 rounded-md bg-brand px-3 py-2 text-center text-[13px] font-medium text-brand-fg">Send</div>
          </div>
        </div>
      </div>
    </div>
  );
  const p = q.data;
  return (
    <div className="space-y-4">
      {p.closed && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">{p.closed === "cap" ? "This form has reached its answer limit and is closed." : "This form's close date has passed and it is closed."}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Close on" hint="Leave empty to keep it open.">{(fp) => (<Input {...fp} type="datetime-local" value={toLocal(s.closesAt)} onChange={(e) => setS({ ...s, closesAt: e.target.value ? new Date(e.target.value).toISOString() : null })} data-testid="td7-closes" />)}</Field>
        <Field label="Answer limit" hint={`${p.responses} so far. Leave empty for no limit.`}>{(fp) => (<Input {...fp} type="number" min={1} inputMode="numeric" value={s.responseCap ?? ""} onChange={(e) => setS({ ...s, responseCap: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null })} data-testid="td7-cap" />)}</Field>
      </div>
      <Field label="Closed message" hint="Shown when the form is closed.">{(fp) => (<Textarea {...fp} rows={2} maxLength={CLOSED_MESSAGE_MAX} value={s.closedMessage} onChange={(e) => setS({ ...s, closedMessage: e.target.value })} placeholder="This form is closed and no longer takes answers." />)}</Field>
      <Switch checked={s.saveResume} onChange={(v) => setS({ ...s, saveResume: v })} label="Let people save and finish later (link works for 7 days)" />
      <Button onClick={() => void save({ settings: s }, "Access saved")} loading={busy} data-testid="td7-save-access">Save access</Button>
      <div className="border-t border-line pt-4">
        <h3 className="text-[14px] font-semibold">Password</h3>
        <p className="mt-1 text-[13px] text-muted">{p.hasPassword ? "This form asks for a password before it opens." : "Anyone with the link can open this form."}</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label={p.hasPassword ? "New password" : "Password"} error={pwErr} className="min-w-0 flex-1">{(fp) => (<Input {...fp} type="password" autoComplete="new-password" value={pw} maxLength={PASSWORD_MAX} onChange={(e) => { setPw(e.target.value); if (pwErr) setPwErr(""); }} data-testid="td7-set-password" />)}</Field>
          <Button variant="secondary" onClick={() => { if (pw.length < PASSWORD_MIN) { setPwErr(`Use at least ${PASSWORD_MIN} characters.`); return; } void save({ password: pw }, "Password set"); }} loading={busy} data-testid="td7-password-save">{p.hasPassword ? "Change" : "Set password"}</Button>
          {p.hasPassword && <Button variant="ghost" className="text-bad" onClick={() => void save({ password: null }, "Password removed")}>Remove</Button>}
        </div>
      </div>
    </div>
  );
}

function AnalyticsPanel({ formId }: { formId: string }) {
  const q = useQuery({ queryKey: ["form-td7-analytics", formId], queryFn: () => api.get<Analytics>(`/forms/${formId}/analytics`) });
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>;
  const a = q.data;
  if (!a.totals.views && !a.totals.completions) return <EmptyState title="No visits yet" body="Share the form link. Views, starts and completions show here, counted without cookies." />;
  const max = Math.max(1, ...a.questions.map((x) => x.reached));
  return (
    <div className="space-y-4" data-testid="td7-analytics">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["Views", a.totals.views], ["Starts", a.totals.starts], ["Completed", a.totals.completions], ["Completion rate", `${a.completionRate}%`]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line p-3"><dt className="text-[12px] text-muted">{k}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {a.partials > 0 && <p className="text-[13px] text-muted">{a.partials} saved {a.partials === 1 ? "part is" : "parts are"} waiting to be finished.</p>}
      <div>
        <h3 className="text-[14px] font-semibold">Drop off per question</h3>
        <table className="mt-2 w-full text-[13px]">
          <thead><tr className="text-left text-muted"><th className="py-1 font-medium">Question</th><th className="py-1 text-right font-medium">Reached</th><th className="py-1 text-right font-medium">Stopped here</th></tr></thead>
          <tbody>
            {a.questions.map((x) => (
              <tr key={x.fieldId} className="border-t border-line">
                <td className="py-1.5 pr-2"><span className="block truncate">{x.label}</span><span className="mt-1 block h-1.5 rounded-full bg-fill"><span className="td7-bar block h-1.5 rounded-full bg-brand" data-w={Math.round((x.reached / max) * 20) * 5} /></span></td>
                <td className="py-1.5 text-right tabular-nums">{x.reached}</td>
                <td className="py-1.5 text-right tabular-nums">{x.dropped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SavedPanel({ formId, fields }: { formId: string; fields: { id?: string; label: string }[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["form-td7-partials", formId], queryFn: () => api.get<{ partials: Partial[] }>(`/forms/${formId}/partials`) });
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>;
  if (!q.data.partials.length) return <EmptyState title="No saved parts" body="When people save and finish later, their unfinished answers show here, apart from sent answers." />;
  const label = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  const remove = async (id: string) => { try { await api.del(`/forms/${formId}/partials/${id}`); void qc.invalidateQueries({ queryKey: ["form-td7-partials", formId] }); } catch (e) { showError(e as Error); } };
  return (
    <ul className="space-y-2" data-testid="td7-partials">
      {q.data.partials.map((p) => (
        <li key={p.id} className="rounded-lg border border-line p-3 text-[13px]">
          <div className="flex items-center justify-between gap-2"><span className="text-muted">{p.answered} answered, saved {timeAgo(p.updatedAt)}</span><Button size="sm" variant="ghost" className="text-bad" onClick={() => void remove(p.id)} aria-label="Delete saved part">Delete</Button></div>
          <dl className="mt-2 space-y-1">{Object.entries(p.answers).slice(0, 6).map(([k, v]) => <div key={k}><dt className="inline font-medium">{label(k)}: </dt><dd className="inline break-words">{Array.isArray(v) ? v.join(", ") : v}</dd></div>)}</dl>
        </li>
      ))}
    </ul>
  );
}

/** Start a new form from pasted questions, a CSV file, or an AI draft. Import never needs AI. */
export function Td7Starter({ onUse }: { onUse: (d: { name?: string; description?: string; fields: ImportedField[] }) => void }) {
  const [mode, setMode] = useState<"" | "paste" | "ai">("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = mode === "paste" && text.trim() ? parseImport(text) : null;
  const useImport = () => { if (!preview?.fields.length) { setErr("Add at least one question, one per line."); return; } onUse({ fields: preview.fields }); setMode(""); setText(""); };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 200_000) { setErr("That file is too big. Use a CSV under 200 KB."); return; }
    setText(await f.text()); setMode("paste"); setErr("");
  };
  const draft = async () => {
    setBusy(true); setErr("");
    try { const r = await api.post<{ draft: { name: string; description: string; fields: ImportedField[] } }>("/forms/td7/ai-draft", { prompt: text }); onUse(r.draft); setMode(""); setText(""); }
    catch (e) { if (e instanceof ApiError && e.status !== 0 && e.status < 500) setErr(e.fields?.prompt ?? e.message); else showError(e as Error); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-dashed border-line p-3" data-testid="td7-starter">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted">Start faster:</span>
        <Button size="sm" variant="ghost" onClick={() => { setMode("paste"); setErr(""); }} aria-pressed={mode === "paste"} data-testid="td7-import">Paste questions</Button>
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>Import CSV</Button>
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} data-testid="td7-csv" />
        <Button size="sm" variant="ghost" onClick={() => { setMode("ai"); setErr(""); }} aria-pressed={mode === "ai"} data-testid="td7-ai">Draft with AI</Button>
      </div>
      {mode && (
        <div className="mt-3 space-y-2">
          <Field label={mode === "ai" ? "Describe the form in a sentence" : "One question per line"} hint={mode === "ai" ? "Uses your workspace AI. Nothing is saved until you press Save." : "End with * for required. Choices: Size: Small | Medium | Large. A CSV with label, type, required and options columns works too."} error={err}>{(fp) => (<Textarea {...fp} rows={mode === "ai" ? 2 : 5} value={text} maxLength={mode === "ai" ? 500 : 20000} onChange={(e) => { setText(e.target.value); if (err) setErr(""); }} data-testid="td7-starter-text" />)}</Field>
          {preview && <p className="text-[12.5px] text-muted" role="status">{preview.fields.length} {preview.fields.length === 1 ? "question" : "questions"} found{preview.skipped ? `, ${preview.skipped} skipped` : ""}.</p>}
          <div className="flex gap-2">
            {mode === "ai" ? <Button size="sm" onClick={() => void draft()} loading={busy} disabled={text.trim().length < 4} data-testid="td7-ai-go">Draft form</Button> : <Button size="sm" onClick={useImport} data-testid="td7-import-go">Use these questions</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setMode(""); setErr(""); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
