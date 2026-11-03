/**
 * TD10 (CRM_TD10): saved analyses from templates. Pick a template, adjust the filters, save it for yourself or share it
 * with the workspace. A shared analysis always runs as the person looking at it, so it only counts what they can see.
 * Keys: J and K move through templates and saved analyses, N starts from the first template, / jumps to the filters.
 */
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconChart, IconShare, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { useCommandHandlers } from "@/web/lib/commands";
import { useOnline, walkRows } from "@/web/lib/crm-keys-td10";
import { useConfig, useTeam } from "@/web/lib/queries";
import { NotFound } from "@/web/pages/not-found";
import { cn } from "@/web/lib/cn";
import { ANALYSIS_PERIODS, ANALYSIS_TEMPLATES, TEMPLATE_INFO, periodLabel, type AnalysisFilters, type AnalysisTemplate } from "@/shared/crm-td10";

interface Saved { id: string; name: string; template: AnalysisTemplate; filters: AnalysisFilters; shared: boolean; mine: boolean; canEdit: boolean; updatedAt: string }
interface Result { template: AnalysisTemplate; rows: { label: string; value: number; detail?: string }[]; value: number | null; format: "money" | "hours" | "percent" | null; truncated: boolean }

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
export function formatValue(v: number, f: Result["format"]) {
  if (f === "money") return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(v);
  if (f === "hours") return `${Math.round(v * 10) / 10} h`;
  if (f === "percent") return `${Math.round(v * 10) / 10}%`;
  return new Intl.NumberFormat("en-AU").format(v);
}

export function AnalysesPage() {
  const config = useConfig();
  if (config.data && !config.data.crmTd10) return <NotFound />; // TD10: off = today (no such page)
  return <Analyses />;
}

function Analyses() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const online = useOnline();
  const { confirm, dialogs } = useDialogs();
  const saved = useQuery({ queryKey: ["crm-td10-analyses"], queryFn: async () => (await api.get<{ items: Saved[] }>("/crm-td10/analyses")).items });
  const openId = params.get("a");
  const open = saved.data?.find((s) => s.id === openId) ?? null;
  const [template, setTemplate] = useState<AnalysisTemplate>("pipeline_by_stage");
  const [filters, setFilters] = useState<AnalysisFilters>({ days: TEMPLATE_INFO.pipeline_by_stage.defaultDays });
  const active: AnalysisTemplate = open?.template ?? template;
  const activeFilters: AnalysisFilters = open && !params.get("edit") ? open.filters : filters;
  const result = useQuery({
    queryKey: ["crm-td10-run", active, activeFilters],
    queryFn: async () => (await api.post<{ result: Result }>("/crm-td10/analyses/run", { template: active, filters: activeFilters, tz: tz() })).result,
  });
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const pick = (t: AnalysisTemplate) => { setParams({}); setTemplate(t); setFilters({ days: TEMPLATE_INFO[t].defaultDays }); setName(TEMPLATE_INFO[t].title); };
  const openSaved = (s: Saved) => { setParams({ a: s.id }); setFilters(s.filters); };
  const setF = (patch: Partial<AnalysisFilters>) => {
    const next = { ...activeFilters, ...patch };
    for (const k of Object.keys(next) as (keyof AnalysisFilters)[]) if (next[k] === undefined || (next[k] as unknown) === "") delete next[k];
    setFilters(next);
    if (open) setParams({ a: open.id, edit: "1" });
  };
  const save = async () => {
    setSaving(true);
    try {
      if (open && open.canEdit) {
        await api.patch(`/crm-td10/analyses/${open.id}`, { filters: activeFilters });
        setParams({ a: open.id });
        toast("Analysis updated");
      } else {
        const r = await api.post<Saved>("/crm-td10/analyses", { name: (name || TEMPLATE_INFO[active].title).slice(0, 80), template: active, filters: activeFilters, shared: share });
        setParams({ a: r.id });
        toast(share ? "Saved and shared with the workspace" : "Analysis saved");
      }
      await qc.invalidateQueries({ queryKey: ["crm-td10-analyses"] });
    } catch (e) { showError(e as Error); } finally { setSaving(false); }
  };
  const toggleShare = async (s: Saved, v: boolean) => {
    try { await api.patch(`/crm-td10/analyses/${s.id}`, { shared: v }); await qc.invalidateQueries({ queryKey: ["crm-td10-analyses"] }); toast(v ? "Shared with the workspace" : "Only you can see it now"); } catch (e) { showError(e as Error); }
  };
  const remove = async (s: Saved) => {
    if (!(await confirm({ title: `Delete ${s.name}?`, description: s.shared ? "It disappears for everyone in the workspace." : "This can't be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/crm-td10/analyses/${s.id}`); setParams({}); await qc.invalidateQueries({ queryKey: ["crm-td10-analyses"] }); toast(`Deleted ${s.name}`); } catch (e) { showError(e as Error); }
  };
  useCommandHandlers({
    "crm-next": () => walkRows(1),
    "crm-prev": () => walkRows(-1),
    "crm-new": () => { document.querySelector<HTMLElement>("[data-testid=template-card]")?.focus(); },
    "crm-search": () => { filtersRef.current?.querySelector<HTMLElement>("select, input")?.focus(); },
  });
  const info = TEMPLATE_INFO[active];
  const dirty = !!open && !!params.get("edit");
  return (
    <div>
      <PageHeader title="Analyses" description="Start from a template, adjust the filters and save it. Shared analyses show each person only the records they can see." />
      {!online && <p role="status" className="mb-3 rounded-lg border border-line bg-fill px-3 py-2 text-[13px] text-muted" data-testid="analyses-offline">You're offline. Results will refresh when you're back.</p>}
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <section aria-labelledby="tpl-h">
            <h2 id="tpl-h" className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Templates</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {ANALYSIS_TEMPLATES.map((t) => (
                <button key={t} type="button" data-crm-row data-testid="template-card" aria-pressed={!open && template === t} onClick={() => pick(t)}
                  className={cn("min-h-11 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50", !open && template === t ? "border-brand/40 bg-brand/10" : "border-line bg-surface")}>
                  <span className="block text-[14px] font-medium text-fg">{TEMPLATE_INFO[t].title}</span>
                  <span className="block text-[12.5px] text-muted">{TEMPLATE_INFO[t].blurb}</span>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="saved-h">
            <h2 id="saved-h" className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Saved</h2>
            {saved.isError && !saved.data ? <LoadError compact onRetry={() => saved.refetch()} />
              : saved.isPending ? <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading saved analyses"><Skeleton className="h-11" /><Skeleton className="h-11" /></div>
              : !saved.data.length ? <p className="rounded-xl border border-dashed border-line px-3 py-4 text-[13px] text-muted" data-testid="saved-empty">Nothing saved yet. Pick a template and press Save.</p>
              : (
                <ul className="space-y-1.5" data-testid="saved-list">
                  {saved.data.map((s) => (
                    <li key={s.id}>
                      <button type="button" data-crm-row data-testid="saved-row" aria-pressed={open?.id === s.id} onClick={() => openSaved(s)}
                        className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13.5px] transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50", open?.id === s.id ? "border-brand/40 bg-brand/10" : "border-line bg-surface")}>
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.shared && <span className="flex items-center gap-1 text-[11.5px] text-subtle"><IconShare className="h-3.5 w-3.5" aria-hidden />Shared</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
        <Card className="min-w-0 p-4" data-testid="analysis-panel">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold text-fg">{open?.name ?? info.title}</h2>
              <p className="text-[12.5px] text-muted">{info.blurb}{open && !open.mine ? " Shared by a teammate." : ""}</p>
            </div>
            {open?.canEdit && (
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-[12.5px] text-muted"><Switch checked={open.shared} onChange={(v) => toggleShare(open, v)} label="Share with the workspace" />Shared</label>
                <Button variant="ghost" size="icon" aria-label={`Delete ${open.name}`} onClick={() => remove(open)}><IconTrash className="h-4 w-4" /></Button>
              </div>
            )}
          </div>
          <Filters template={active} value={activeFilters} onChange={setF} refEl={filtersRef} />
          <ResultView q={result} />
          {(!open || dirty || !open.canEdit) && (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4" data-testid="save-bar">
              {(!open || !open.canEdit) && (
                <>
                  <Field label="Name" className="min-w-[12rem] flex-1">{(p) => <Input {...p} value={name || info.title} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
                  <label className="flex h-9 items-center gap-2 text-[13px] text-muted"><Switch checked={share} onChange={setShare} label="Share with the workspace" />Share with the workspace</label>
                </>
              )}
              <Button onClick={save} loading={saving} disabled={!online} data-testid="analysis-save">{open && open.canEdit ? "Save changes" : "Save"}</Button>
            </div>
          )}
        </Card>
      </div>
      {dialogs}
    </div>
  );
}

function Filters({ template, value, onChange, refEl }: { template: AnalysisTemplate; value: AnalysisFilters; onChange: (p: Partial<AnalysisFilters>) => void; refEl: React.RefObject<HTMLDivElement | null> }) {
  const keys = TEMPLATE_INFO[template].filters;
  const team = useTeam();
  const projects = useQuery({ queryKey: ["projects", "names"], enabled: keys.includes("project"), staleTime: 300_000, queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const people = useMemo(() => (team.data?.members ?? []).filter((m) => m.kind === "human"), [team.data]);
  return (
    <div ref={refEl} className="mb-4 flex flex-wrap gap-3" data-testid="analysis-filters">
      {keys.includes("days") && (
        <Field label="Period" className="w-40">{(p) => (
          <Select {...p} value={String(value.days ?? 0)} onChange={(e) => onChange({ days: Number(e.target.value) })}>
            {ANALYSIS_PERIODS.map((d) => <option key={d} value={d}>{periodLabel(d)}</option>)}
          </Select>
        )}</Field>
      )}
      {(keys.includes("owner") || keys.includes("person")) && (
        <Field label={keys.includes("owner") ? "Owner" : "Person"} className="w-48">{(p) => (
          <Select {...p} value={(keys.includes("owner") ? value.owner : value.person) ?? ""} onChange={(e) => onChange(keys.includes("owner") ? { owner: e.target.value || undefined } : { person: e.target.value || undefined })}>
            <option value="">Everyone</option>
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
          </Select>
        )}</Field>
      )}
      {keys.includes("project") && (
        <Field label="Project" className="w-48">{(p) => (
          <Select {...p} value={value.project ?? ""} onChange={(e) => onChange({ project: e.target.value || undefined })}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
          </Select>
        )}</Field>
      )}
      {keys.includes("billable") && (
        <Field label="Billable" className="w-40">{(p) => (
          <Select {...p} value={value.billable ?? ""} onChange={(e) => onChange({ billable: (e.target.value || undefined) as AnalysisFilters["billable"] })}>
            <option value="">All time</option><option value="yes">Billable</option><option value="no">Not billable</option>
          </Select>
        )}</Field>
      )}
    </div>
  );
}

function ResultView({ q }: { q: { data?: Result; isPending: boolean; isError: boolean; refetch: () => unknown } }) {
  if (q.isError && !q.data) return <LoadError compact onRetry={() => q.refetch()} />;
  if (q.isPending || !q.data) return <div role="status" aria-busy="true" aria-label="Loading results" className="space-y-2"><Skeleton className="h-6" /><Skeleton className="h-6 w-4/5" /><Skeleton className="h-6 w-3/5" /></div>;
  const r = q.data;
  if (!r.rows.length) return <EmptyState className="py-10" icon={<IconChart />} title="No records in this period" body="Try a longer period or clear a filter. Only records you can see are counted." />;
  const top = Math.max(...r.rows.map((x) => Math.abs(x.value)), r.format === "percent" ? 100 : 0) || 1;
  return (
    <div data-testid="analysis-result">
      <table className="w-full text-[13.5px]">
        <caption className="sr-only">Results</caption>
        <thead className="sr-only"><tr><th scope="col">Group</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {r.rows.map((row) => (
            <tr key={row.label} className="align-middle" data-testid="analysis-row">
              <th scope="row" className="w-1/3 max-w-[10rem] truncate py-1.5 pr-3 text-left font-normal text-muted">{row.label}</th>
              <td className="py-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill" aria-hidden><div className="h-full rounded-full bg-brand transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.max(2, (Math.abs(row.value) / top) * 100)}%` }} /></div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-fg">{formatValue(row.value, r.format)}</span>
                </div>
                {row.detail && <div className="text-[11.5px] text-subtle">{row.detail}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.truncated && <p className="mt-2 text-[12px] text-subtle">Showing the first 50 groups.</p>}
    </div>
  );
}
