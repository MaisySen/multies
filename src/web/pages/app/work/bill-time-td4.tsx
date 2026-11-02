/**
 * TD4: Bill time, a tab in Invoices and quotes (/app/contacts/invoices?tab=time), owners and admins with BILL_TD4.
 * Pick a project and dates, see unbilled billable time grouped by person and task at each rate, untick any, and create a
 * DRAFT invoice. The time on it is locked until that invoice is deleted or voided. Money is integer cents; the rounding
 * is stated on screen and on each invoice line. Past runs list with a CSV of each run.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconDownload, IconFilePlus, IconSettings, IconTimer, IconWarning } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { DateInput, Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, tableStyles } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { cn } from "@/web/lib/cn";
import { useConfig } from "@/web/lib/queries";
import { CURRENCIES, money, parseMoney } from "@/shared/invoices";
import { ROUNDINGS, ROUNDING_LABEL, groupRun, hoursText, roundingSentence, type Rounding } from "@/shared/bill-time-td4";

export const useBillTimeOn = () => !!(useConfig().data as { billTd4?: boolean } | undefined)?.billTd4;

interface Project { id: string; name: string; key: string; color: string }
interface Entry { id: string; date: string; seconds: number; billedSeconds: number; note: string; personKey: string; personName: string; taskKey: string; taskLabel: string; rateCents: number | null }
interface Person { key: string; name: string; rateCents: number | null; projectRateCents: number | null; defaultRateCents: number | null }
interface Preview {
  project: Project; from: string; to: string; timeZone: string; rounding: Rounding; tooMany: boolean; max: number; client: { id: string; name: string; email: string } | null; currency: string;
  projectRateCents: number | null; workspaceRateCents: number | null; people: Person[]; entries: Entry[];
}
interface Run { id: string; projectName: string | null; clientName: string | null; docId: string; docNumber: string | null; docStatus: string | null; from: string; to: string; entryCount: number; seconds: number; amountCents: number; currency: string; status: "open" | "released"; createdAt: string; releaseReason: string | null }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function defaultRange() {
  const now = new Date();
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(now) };
}
const centsInput = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const dayText = (s: string) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function useOnline() {
  const [on, setOn] = useState(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

export function BillTimeTab({ ContactPicker }: { ContactPicker: (p: { onPick: (c: { id: string; name: string; email: string }) => void; hint?: string }) => React.ReactElement }) {
  const [params, setParams] = useSearchParams();
  const range = useMemo(defaultRange, []);
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [rounding, setRounding] = useState<Rounding | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [client, setClient] = useState<{ id: string; name: string; email: string } | null>(null);
  const [rates, setRates] = useState(false);
  const online = useOnline();
  const qc = useQueryClient();

  const projects = useQuery({ queryKey: ["bill-time", "projects"], queryFn: () => api.get<{ projects: Project[] }>("/bill-time/projects"), staleTime: 60_000 });
  useEffect(() => { if (!projectId && projects.data?.projects.length) setProjectId(projects.data.projects[0].id); }, [projects.data, projectId]);
  const okRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const pv = useQuery({
    queryKey: ["bill-time", "preview", projectId, from, to, rounding],
    enabled: !!projectId && okRange,
    queryFn: () => api.get<Preview>(`/bill-time/preview?projectId=${encodeURIComponent(projectId)}&from=${from}&to=${to}${rounding != null ? `&rounding=${rounding}` : ""}`),
  });
  useEffect(() => { setOff(new Set()); setClient(null); }, [projectId, from, to]);
  const data = pv.data;
  const chosen = useMemo(() => (data?.entries ?? []).filter((e) => !off.has(e.id)), [data, off]);
  const shownRounding = (rounding ?? data?.rounding ?? 0) as Rounding;
  const totals = useMemo(() => groupRun(chosen, shownRounding), [chosen, shownRounding]);
  const lines = useMemo(() => groupRun(data?.entries ?? [], shownRounding).lines, [data, shownRounding]);
  const billTo = client ?? data?.client ?? null;

  const create = useMutation({
    mutationFn: () => api.post<{ docId: string }>("/bill-time/runs", { projectId, from, to, rounding: shownRounding, entryIds: chosen.map((e) => e.id), contactId: billTo?.id ?? null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["bill-time"] });
      void qc.invalidateQueries({ queryKey: ["invoices", "docs"] });
      void qc.invalidateQueries({ queryKey: ["home-widgets", "billing"] });
      toast.success("Draft invoice made. Its time is now locked.", { action: { label: "Open invoice", onClick: () => { window.location.assign(`/app/contacts/invoices/${encodeURIComponent(r.docId)}`); } } });
    },
    onError: (e) => { if (e instanceof ApiError && e.code === "stale") void pv.refetch(); showError(e); },
  });

  const toggle = (ids: string[], on: boolean) => setOff((s) => { const n = new Set(s); for (const id of ids) { if (on) n.delete(id); else n.add(id); } return n; });
  const allOn = !!data && chosen.length === data.entries.length;
  const blocker = !billTo ? "Pick the client to bill." : totals.missingRate ? "Set a rate for everyone ticked." : !chosen.length ? "Tick at least one entry." : !online ? "You are offline." : null;

  if (projects.isPending) return <TabSkeleton />;
  if (projects.error) return <LoadError onRetry={projects.refetch} />;
  if (!projects.data.projects.length) return <EmptyState icon={<IconTimer />} title="No projects yet" body="Billing runs work per project. Make a project in Tasks and track time on it first." />;

  return (
    <div className="space-y-4" data-testid="bill-time">
      {!online && <Card role="status" className="flex items-center gap-2 border-warn/40 p-3 text-sm"><IconWarning className="h-4 w-4 shrink-0 text-warn" aria-hidden />You are offline. Billing runs need a connection.</Card>}
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Project">{(fp) => (
          <Select {...fp} value={projectId} onChange={(e) => { setProjectId(e.target.value); setParams({ tab: "time", project: e.target.value }, { replace: true }); }}>
            {projects.data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>)}</Field>
        <Field label="From">{(fp) => <DateInput {...fp} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(fp) => <DateInput {...fp} value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Round each entry up to">{(fp) => (
          <Select {...fp} value={String(shownRounding)} onChange={(e) => setRounding(Number(e.target.value) as Rounding)}>
            {ROUNDINGS.map((r) => <option key={r} value={r}>{ROUNDING_LABEL[r]}</option>)}
          </Select>)}</Field>
      </Card>
      {!okRange ? <Card className="p-4 text-sm text-muted" role="status">Pick a start date on or before the end date.</Card>
        : pv.isPending ? <TabSkeleton />
        : pv.error ? <LoadError onRetry={pv.refetch} />
        : data && (
          <>
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-muted">Bill to</p>
                <p className="truncate text-sm font-medium" data-testid="bill-to">{billTo ? (billTo.name || billTo.email) : "No client picked yet"}</p>
                <p className="text-[12px] text-subtle">{data.currency} · times in {data.timeZone}</p>
              </div>
              <div className="w-full sm:w-72"><ContactPicker onPick={setClient} hint="Change who this time is billed to" /></div>
              <Button variant="secondary" onClick={() => setRates(true)}><IconSettings className="h-4 w-4" />Rates</Button>
            </Card>
            {data.entries.length === 0 ? (
              <EmptyState icon={<IconTimer />} title="No time waiting to be billed" body="Billable time on this project in these dates is already on an invoice, or none was tracked." />
            ) : (
              <>
                {data.tooMany && <Card role="status" className="p-3 text-sm">Showing the first {data.max} entries. Bill these, then the rest show here.</Card>}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={allOn} onChange={(e) => toggle(data.entries.map((x) => x.id), e.target.checked)} />Tick all</label>
                  <span className="text-muted">{chosen.length} of {data.entries.length} entries</span>
                </div>
                <div className="space-y-3">
                  {lines.map((l) => {
                    const es = data.entries.filter((e) => l.entryIds.includes(e.id));
                    const lineOn = es.filter((e) => !off.has(e.id)).length;
                    return (
                      <Card key={l.key} className="overflow-hidden" data-testid="bill-line">
                        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                          <label className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-2">
                            <input type="checkbox" className="h-4 w-4 shrink-0" aria-label={`Tick all for ${l.personName}, ${l.taskLabel}`} checked={lineOn === es.length} ref={(el) => { if (el) el.indeterminate = lineOn > 0 && lineOn < es.length; }} onChange={(e) => toggle(es.map((x) => x.id), e.target.checked)} />
                            <span className="min-w-0"><span className="block truncate text-sm font-medium">{l.taskLabel}</span><span className="block truncate text-[12px] text-muted">{l.personName}</span></span>
                          </label>
                          <span className="text-right text-sm tabular-nums">
                            {l.missingRate ? <Badge tone="warn">No rate</Badge> : <span className="text-muted">{money(l.rateCents, data.currency)} an hour</span>}
                            <span className="ml-3 font-medium">{hoursText(l.qtyMilli)}</span>
                            {!l.missingRate && <span className="ml-3 font-medium">{money(l.amountCents, data.currency)}</span>}
                          </span>
                        </div>
                        <ul className="divide-y divide-line">
                          {es.map((e) => (
                            <li key={e.id} className="flex items-center gap-3 px-4 py-1.5 text-[13px]">
                              <input type="checkbox" className="h-4 w-4 shrink-0" id={`be-${e.id}`} checked={!off.has(e.id)} onChange={(ev) => toggle([e.id], ev.target.checked)} />
                              <label htmlFor={`be-${e.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 sm:min-h-9">
                                <span className="w-14 shrink-0 text-muted">{dayText(e.date)}</span>
                                <span className="min-w-0 flex-1 truncate">{e.note || <span className="text-subtle">No note</span>}</span>
                                <span className="shrink-0 tabular-nums text-muted">{Math.round(e.seconds / 60)} min{e.billedSeconds !== e.seconds ? `, billed ${Math.round(e.billedSeconds / 60)}` : ""}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </Card>
                    );
                  })}
                </div>
                <Card className="flex flex-col gap-3 p-4 sm:sticky sm:bottom-2 sm:z-10 sm:flex-row sm:items-center" data-testid="bill-total">
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium tabular-nums">{hoursText(totals.qtyMilli)} · {money(totals.amountCents, data.currency)} before tax</p>
                    <p className="text-[12px] text-muted">{roundingSentence(shownRounding)} GST is added on the invoice.</p>
                    {blocker && <p className="text-[12px] text-warn" role="status">{blocker}</p>}
                  </div>
                  <Button className="max-sm:w-full" onClick={() => create.mutate()} disabled={!!blocker || create.isPending} loading={create.isPending}><IconFilePlus className="h-4 w-4" />Create draft invoice</Button>
                </Card>
              </>
            )}
            <RatesDialog open={rates} onClose={() => setRates(false)} data={data} />
          </>
        )}
      <PastRuns />
    </div>
  );
}

function TabSkeleton() {
  return <div className="space-y-3" data-testid="bill-loading"><Skeleton className="h-20 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>;
}

function RatesDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: Preview }) {
  const qc = useQueryClient();
  const [ws, setWs] = useState(""), [proj, setProj] = useState(""), [cur, setCur] = useState("AUD");
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setWs(centsInput(data.workspaceRateCents)); setProj(centsInput(data.projectRateCents)); setCur(data.currency);
    setPeople(Object.fromEntries(data.people.map((p) => [p.key, centsInput(p.projectRateCents)])));
  }, [open, data]);
  const parse = (s: string) => (s.trim() === "" ? null : parseMoney(s));
  const bad = [ws, proj, ...Object.values(people)].some((s) => s.trim() !== "" && parse(s) == null);
  const save = useMutation({
    mutationFn: () => api.put("/bill-time/setup", {
      projectId: data.project.id, currency: cur, rateCents: parse(proj), workspaceRateCents: parse(ws),
      personRates: data.people.map((p) => ({ personKey: p.key, rateCents: parse(people[p.key] ?? ""), scope: "project" as const })),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["bill-time"] }); void qc.invalidateQueries({ queryKey: ["home-widgets", "billing"] }); toast.success("Rates saved"); onClose(); },
    onError: showError,
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Rates for ${data.project.name}`} description="An hourly rate before tax. A person's rate on this project wins, then the project rate, then the workspace rate.">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!bad) save.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Workspace rate">{(fp) => <Input {...fp} inputMode="decimal" value={ws} placeholder="Not set" onChange={(e) => setWs(e.target.value)} />}</Field>
          <Field label="Project rate">{(fp) => <Input {...fp} inputMode="decimal" value={proj} placeholder="Uses workspace rate" onChange={(e) => setProj(e.target.value)} />}</Field>
          <Field label="Currency">{(fp) => <Select {...fp} value={cur} onChange={(e) => setCur(e.target.value)}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
        </div>
        {data.people.length > 0 && <p className="pt-1 text-[13px] font-medium">People on this project</p>}
        {data.people.map((p) => (
          <Field key={p.key} label={p.name} hint={p.projectRateCents == null && p.rateCents != null ? `Now ${money(p.rateCents, cur)} an hour` : undefined}>{(fp) => (
            <Input {...fp} inputMode="decimal" value={people[p.key] ?? ""} placeholder="Uses project rate" onChange={(e) => setPeople((x) => ({ ...x, [p.key]: e.target.value }))} />)}</Field>
        ))}
        {bad && <p className="text-[13px] text-bad" role="alert">Type amounts like 120 or 120.50.</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={bad || save.isPending} loading={save.isPending}>Save rates</Button>
        </div>
      </form>
    </Dialog>
  );
}

function PastRuns() {
  const runs = useQuery({ queryKey: ["bill-time", "runs"], queryFn: () => api.get<{ runs: Run[] }>("/bill-time/runs"), staleTime: 30_000 });
  if (runs.isPending) return null;
  if (runs.error) return <LoadError compact onRetry={runs.refetch} />;
  if (!runs.data.runs.length) return null;
  return (
    <section aria-labelledby="bill-runs-h" className="pt-2">
      <h2 id="bill-runs-h" className="mb-2 text-sm font-semibold">Past billing runs</h2>
      <div className={cn(tableStyles.wrap, "max-md:hidden")}>
        <table className={tableStyles.table}>
          <thead className={tableStyles.head}><tr>
            <th className={tableStyles.th}>Made</th><th className={tableStyles.th}>Project</th><th className={tableStyles.th}>Client</th><th className={tableStyles.th}>Dates</th>
            <th className={cn(tableStyles.th, "text-right")}>Hours</th><th className={cn(tableStyles.th, "text-right")}>Before tax</th><th className={tableStyles.th}>Invoice</th><th className={tableStyles.th}><span className="sr-only">CSV</span></th>
          </tr></thead>
          <tbody className={tableStyles.body}>
            {runs.data.runs.map((r) => (
              <tr key={r.id} className={tableStyles.row}>
                <td className={tableStyles.td}>{dayText(r.createdAt)}</td><td className={tableStyles.td}>{r.projectName ?? "Removed project"}</td><td className={tableStyles.td}>{r.clientName ?? ""}</td>
                <td className={tableStyles.td}>{r.from} to {r.to}</td>
                <td className={cn(tableStyles.td, "text-right tabular-nums")}>{hoursText(Math.round(r.seconds / 3.6))}</td>
                <td className={cn(tableStyles.td, "text-right tabular-nums")}>{money(r.amountCents, r.currency)}</td>
                <td className={tableStyles.td}><RunState r={r} /></td>
                <td className={tableStyles.td}>{r.status === "open" && <a className="inline-flex min-h-9 items-center gap-1 text-[13px] text-accent hover:underline" href={`/api/bill-time/runs/${encodeURIComponent(r.id)}/export.csv`} download><IconDownload className="h-3.5 w-3.5" />CSV</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {runs.data.runs.map((r) => (
          <li key={r.id}><Card className="p-3 text-sm">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate font-medium">{r.clientName ?? r.projectName ?? "Billing run"}</span><span className="block text-[12px] text-muted">{r.from} to {r.to}</span></span><RunState r={r} /></div>
            <div className="mt-1 flex items-center justify-between gap-2 tabular-nums"><span>{hoursText(Math.round(r.seconds / 3.6))} · {money(r.amountCents, r.currency)}</span>
              {r.status === "open" && <a className="inline-flex min-h-11 items-center gap-1 text-[13px] text-accent" href={`/api/bill-time/runs/${encodeURIComponent(r.id)}/export.csv`} download><IconDownload className="h-3.5 w-3.5" />CSV</a>}</div>
          </Card></li>
        ))}
      </ul>
    </section>
  );
}

function RunState({ r }: { r: Run }) {
  if (r.status === "released") return <Badge tone="neutral">{r.releaseReason === "voided" ? "Invoice voided, time released" : "Draft deleted, time released"}</Badge>;
  return <Link className="text-accent hover:underline" to={`/app/contacts/invoices/${encodeURIComponent(r.docId)}`}>{r.docNumber ?? "Draft invoice"}</Link>;
}
