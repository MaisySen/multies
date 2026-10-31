/**
 * R91 Dashboards plus (DASHBOARDS_PLUS): share by link, emailed reports, alerts, data sources and the question
 * builder. Each is a dialog opened from the dashboard header or a card's menu; on phones the dialogs are sheets.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { useTeam } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, CopyButton, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconClose, IconPlus, IconTrash } from "@/web/components/ui/icon";

export type QOp = "is" | "is_not" | "contains" | "gt" | "lt" | "empty" | "not_empty" | "last_days" | "before" | "after";
export interface Question { table: string; sourceId?: string; filters: { field: string; op: QOp; value?: string }[]; groupBy?: string | null; bucket?: "day" | "week" | "month" | null; measure: { op: "count" | "sum" | "avg" | "min" | "max"; field?: string } }
export interface QuestionResult { kind: "question"; value: number | null; rows: { label: string; value: number }[] | null; truncated: boolean; format: "money" | "hours" | null; label: string }
type Chart = "number" | "bar" | "line" | "donut" | "table";
interface CatalogField { id: string; label: string; kind: string; values: string[] | null }
interface Catalog { tables: { id: string; label: string; countOnly: boolean; fields: CatalogField[] }[] }
interface Source { id: string; name: string; kind: "csv" | "url"; url: string | null; refresh: string; columns: { name: string; kind: "number" | "date" | "text" }[]; rowCount: number; refreshedAt: string | null; lastError: string | null; canManage: boolean }

const pk = { catalog: ["dash-plus", "catalog"], sources: ["dash-plus", "sources"], shares: (id: string) => ["dash-plus", "shares", id], reports: (id: string) => ["dash-plus", "reports", id], alerts: (id: string) => ["dash-plus", "alerts", id] };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const Section = ({ title, children, className }: { title: string; children: ReactNode; className?: string }) => (
  <section className={cn("space-y-3", className)}><h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{title}</h3>{children}</section>
);
const Note = ({ children }: { children: ReactNode }) => <p className="rounded-lg bg-fill px-3 py-2.5 text-[13px] text-muted">{children}</p>;
const Row = ({ children, testid }: { children: ReactNode; testid?: string }) => <li data-testid={testid} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2.5">{children}</li>;

// ---------------------------------------------------------------- share by link

export function ShareDialog({ dashboardId, open, onClose }: { dashboardId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: pk.shares(dashboardId), enabled: open, queryFn: () => api.get<{ canManage: boolean; links: { id: string; createdAt: string; expiresAt: string | null; hasPassword: boolean; showBrand: boolean; active: boolean }[] }>(`/dashboards-plus/${dashboardId}/shares`) });
  const [expires, setExpires] = useState("30");
  const [password, setPassword] = useState("");
  const [brand, setBrand] = useState(true);
  const [made, setMade] = useState<string | null>(null);
  useEffect(() => { if (open) { setMade(null); setPassword(""); } }, [open]);
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/dashboards-plus/${dashboardId}/shares`, { expiresInDays: expires === "never" ? null : Number(expires), password: password || undefined, showBrand: brand }),
    onSuccess: async (r) => { setMade(r.url); setPassword(""); await qc.invalidateQueries({ queryKey: pk.shares(dashboardId) }); },
    onError: (e) => showError(e as Error),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/dashboards-plus/shares/${id}`),
    onSuccess: async () => { toast("Link turned off"); await qc.invalidateQueries({ queryKey: pk.shares(dashboardId) }); },
    onError: (e) => showError(e as Error),
  });
  const links = list.data?.links.filter((l) => l.active) ?? [];
  return (
    <Dialog open={open} onClose={onClose} title="Share by link" className="sm:max-w-xl" description="Anyone with the link sees this dashboard's numbers, read only, without signing in. Lists show counts only and people show as Person 1, Person 2, so titles, mail and names stay private.">
      <div className="space-y-6" data-testid="share-dialog">
        {list.isPending ? <Skeleton className="h-24" /> : !list.data?.canManage ? <Note>Only the owner or a workspace admin can share this dashboard by link.</Note> : (
          <>
            {made ? (
              <div className="space-y-2 rounded-lg border border-line p-3" data-testid="share-made">
                <p className="text-[13px] font-medium">Your link is ready</p>
                <div className="flex gap-2"><Input readOnly value={made} aria-label="Public link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" /><CopyButton value={made} label="Copy" toastText="Link copied" /></div>
                <p className="text-[12.5px] text-muted">Copy it now. For safety the full link is shown only once.</p>
              </div>
            ) : (
              <Section title="New link">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Expires">{(fp) => (<><Select {...fp} value={expires} onChange={(e) => setExpires(e.target.value)}><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="never">Never</option></Select></>)}</Field>
                  <Field label="Password" hint="Optional, at least 6 characters">{(fp) => (<><Input {...fp} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></>)}</Field>
                </div>
                <Switch checked={brand} onChange={setBrand} label="Show the workspace name" />
                <div className="flex justify-end"><Button onClick={() => create.mutate()} disabled={create.isPending || (password.length > 0 && password.length < 6)}>{create.isPending ? "Creating" : "Create link"}</Button></div>
              </Section>
            )}
            <Section title="Active links">
              {!links.length ? <p className="text-[13px] text-muted">No public links yet.</p> : (
                <ul className="space-y-2">{links.map((l) => (
                  <Row key={l.id} testid="share-row">
                    <span className="text-[13px]">Made {when(l.createdAt)}</span>
                    <span className="text-[12.5px] text-muted">{l.expiresAt ? `Expires ${when(l.expiresAt)}` : "Never expires"}</span>
                    {l.hasPassword && <Badge>Password</Badge>}
                    <Button variant="secondary" size="sm" className="ml-auto" onClick={() => revoke.mutate(l.id)} disabled={revoke.isPending}>Turn off</Button>
                  </Row>
                ))}</ul>
              )}
            </Section>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- emailed reports

interface Report { id: string; frequency: "daily" | "weekly" | "monthly"; hour: number; weekday: number | null; monthDay: number | null; timeZone: string; withPdf: boolean; enabled: boolean; recipients: { email: string; userId?: string }[]; unsubscribed: string[]; nextRunAt: string; lastRunAt: string | null; lastError: string | null }
const describeReport = (r: Pick<Report, "frequency" | "hour" | "weekday" | "monthDay">) =>
  `${r.frequency === "daily" ? "Every day" : r.frequency === "weekly" ? `Every ${DAYS[r.weekday ?? 0]}` : `Monthly on day ${r.monthDay ?? 1}`} at ${hourLabel(r.hour)}`;

export function ReportsDialog({ dashboardId, open, onClose }: { dashboardId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: pk.reports(dashboardId), enabled: open, queryFn: () => api.get<{ canManage: boolean; reports: Report[] }>(`/dashboards-plus/${dashboardId}/reports`) });
  const [editing, setEditing] = useState<Report | "new" | null>(null);
  useEffect(() => { if (open) setEditing(null); }, [open]);
  const refresh = () => qc.invalidateQueries({ queryKey: pk.reports(dashboardId) });
  const toggle = useMutation({ mutationFn: (r: Report) => api.patch(`/dashboards-plus/reports/${r.id}`, { ...pick(r), enabled: !r.enabled }), onSuccess: refresh, onError: (e) => showError(e as Error) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/dashboards-plus/reports/${id}`), onSuccess: async () => { toast("Report removed"); await refresh(); }, onError: (e) => showError(e as Error) });
  const send = useMutation({ mutationFn: (id: string) => api.post<{ sent: number }>(`/dashboards-plus/reports/${id}/send`), onSuccess: async (r) => { toast(r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}` : "Nobody to send to: everyone unsubscribed"); await refresh(); }, onError: (e) => showError(e as Error) });
  return (
    <Dialog open={open} onClose={onClose} title={editing ? (editing === "new" ? "New emailed report" : "Edit report") : "Emailed reports"} className="sm:max-w-xl"
      description={editing ? undefined : "Mail this dashboard's numbers on a schedule, with a PDF and a link. Every email has a one click unsubscribe."}>
      <div data-testid="reports-dialog">
        {list.isPending ? <Skeleton className="h-24" /> : !list.data?.canManage ? <Note>Only the owner or a workspace admin can schedule reports for this dashboard.</Note>
          : editing ? <ReportForm dashboardId={dashboardId} report={editing === "new" ? null : editing} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} />
          : (
            <div className="space-y-4">
              {!list.data.reports.length ? <Note>No reports yet. A weekly report on Monday morning is a good start.</Note> : (
                <ul className="space-y-2">{list.data.reports.map((r) => (
                  <Row key={r.id} testid="report-row">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{describeReport(r)}</p>
                      <p className="truncate text-[12.5px] text-muted">{r.recipients.length} {r.recipients.length === 1 ? "person" : "people"}{r.unsubscribed.length ? `, ${r.unsubscribed.length} unsubscribed` : ""} · next {when(r.nextRunAt)}{r.lastRunAt ? ` · last sent ${when(r.lastRunAt)}` : ""}</p>
                      {r.lastError && <p className="text-[12.5px] text-danger">{r.lastError}</p>}
                    </div>
                    <Switch checked={r.enabled} onChange={() => toggle.mutate(r)} label={`Send ${lc(describeReport(r))}`} />
                    <Button variant="secondary" size="sm" onClick={() => send.mutate(r.id)} disabled={send.isPending}>Send now</Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>Edit</Button>
                    <button type="button" aria-label="Remove report" className="rounded p-1 text-subtle hover:bg-hover hover:text-fg" onClick={() => del.mutate(r.id)}><IconTrash className="h-4 w-4" /></button>
                  </Row>
                ))}</ul>
              )}
              <div className="flex justify-end"><Button onClick={() => setEditing("new")}><IconPlus className="h-4 w-4" />New report</Button></div>
            </div>
          )}
      </div>
    </Dialog>
  );
}
const pick = (r: Report) => ({ frequency: r.frequency, hour: r.hour, weekday: r.weekday, monthDay: r.monthDay, timeZone: r.timeZone, withPdf: r.withPdf, recipients: r.recipients, enabled: r.enabled });

function zones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { return ["UTC", zone()]; }
}

function ReportForm({ dashboardId, report, onDone, onCancel }: { dashboardId: string; report: Report | null; onDone: () => void; onCancel: () => void }) {
  const team = useTeam();
  const [f, setF] = useState({ frequency: report?.frequency ?? "weekly", hour: report?.hour ?? 8, weekday: report?.weekday ?? 0, monthDay: report?.monthDay ?? 1, timeZone: report?.timeZone ?? zone(), withPdf: report?.withPdf ?? true, enabled: report?.enabled ?? true });
  const [people, setPeople] = useState<{ email: string; userId?: string }[]>(report?.recipients ?? []);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const members = (team.data?.members ?? []).filter((m) => m.email && !people.some((p) => p.userId === m.userId));
  const tzs = useMemo(zones, []);
  const addEmail = () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setErr("Check the email address."); return; }
    if (people.some((p) => p.email === e)) { setEmail(""); return; }
    if (people.length >= 20) { setErr("A report goes to up to 20 people."); return; }
    setPeople([...people, { email: e }]); setEmail(""); setErr(null);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, weekday: f.frequency === "weekly" ? f.weekday : null, monthDay: f.frequency === "monthly" ? f.monthDay : null, recipients: people };
      return report ? api.patch(`/dashboards-plus/reports/${report.id}`, body) : api.post(`/dashboards-plus/${dashboardId}/reports`, body);
    },
    onSuccess: () => { toast(report ? "Report saved" : `Report scheduled: ${lc(describeReport(f))}`); onDone(); },
    onError: (e) => showError(e as Error),
  });
  return (
    <div className="space-y-5" data-testid="report-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How often">{(fp) => (<><Select {...fp} value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as Report["frequency"] })}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Select></>)}</Field>
        {f.frequency === "weekly" && <Field label="On">{(fp) => (<><Select {...fp} value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></>)}</Field>}
        {f.frequency === "monthly" && <Field label="On day" hint="Day 31 sends on the last day of shorter months">{(fp) => (<><Select {...fp} value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: Number(e.target.value) })}>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</Select></>)}</Field>}
        <Field label="At">{(fp) => (<><Select {...fp} value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select></>)}</Field>
        <Field label="Time zone">{(fp) => (<><Select {...fp} value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })}>{tzs.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select></>)}</Field>
      </div>
      <Switch checked={f.withPdf} onChange={(v) => setF({ ...f, withPdf: v })} label="Include a PDF of the dashboard" />
      <Section title="Send to">
        {people.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" data-testid="report-people">{people.map((p) => (
            <li key={p.email} className="inline-flex max-w-full items-center gap-1 rounded-full bg-fill py-1 pl-2.5 pr-1 text-[12.5px]">
              <span className="truncate">{p.userId ? (team.data?.members.find((m) => m.userId === p.userId)?.name ?? p.email) : p.email}</span>
              <button type="button" aria-label={`Remove ${p.email}`} className="rounded-full p-0.5 text-subtle hover:bg-hover hover:text-fg" onClick={() => setPeople(people.filter((x) => x.email !== p.email))}><IconClose className="h-3.5 w-3.5" /></button>
            </li>
          ))}</ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Add a member">{(fp) => (<>
            <Select {...fp} value="" onChange={(e) => { const m = members.find((x) => x.userId === e.target.value); if (m?.email && people.length < 20) setPeople([...people, { email: m.email.toLowerCase(), userId: m.userId }]); }}>
              <option value="">{members.length ? "Pick someone" : "Everyone is added"}</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
            </Select>
          </>)}</Field>
          <Field label="Add an email" error={err ?? undefined}>{(fp) => (<>
            <div className="flex gap-2"><Input {...fp} type="email" value={email} placeholder="name@company.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }} className="min-w-0 flex-1" /><Button variant="secondary" onClick={addEmail}>Add</Button></div>
          </>)}</Field>
        </div>
        <p className="text-[12.5px] text-muted">People outside the workspace get a read only link; members open the dashboard in the app.</p>
      </Section>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !people.length}>{save.isPending ? "Saving" : report ? "Save report" : "Schedule report"}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- alerts

interface Alert { id: string; widgetId: string; direction: "above" | "below"; threshold: number; byMail: boolean; quietStart: number | null; quietEnd: number | null; timeZone: string; enabled: boolean; state: "ok" | "crossed" | null; lastValue: number | null; lastFiredAt: string | null }
export function AlertsDialog({ dashboardId, cards, open, presetCard, onClose }: { dashboardId: string; cards: { id: string; title: string }[]; open: boolean; presetCard?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: pk.alerts(dashboardId), enabled: open, queryFn: () => api.get<{ alerts: Alert[] }>(`/dashboards-plus/${dashboardId}/alerts`) });
  const [f, setF] = useState({ widgetId: "", direction: "above" as "above" | "below", threshold: "", byMail: true, quiet: true, quietStart: 22, quietEnd: 7 });
  useEffect(() => { if (open) setF((x) => ({ ...x, widgetId: presetCard ?? cards[0]?.id ?? "", threshold: "" })); }, [open, presetCard, cards]);
  const refresh = () => qc.invalidateQueries({ queryKey: pk.alerts(dashboardId) });
  const create = useMutation({
    mutationFn: () => api.post(`/dashboards-plus/${dashboardId}/alerts`, { widgetId: f.widgetId, direction: f.direction, threshold: Number(f.threshold), byMail: f.byMail, quietStart: f.quiet ? f.quietStart : null, quietEnd: f.quiet ? f.quietEnd : null, timeZone: zone() }),
    onSuccess: async () => { toast("Alert set. You hear once each time it crosses the line."); setF({ ...f, threshold: "" }); await refresh(); },
    onError: (e) => showError(e as Error),
  });
  const toggle = useMutation({ mutationFn: (a: Alert) => api.patch(`/dashboards-plus/alerts/${a.id}`, { enabled: !a.enabled }), onSuccess: refresh, onError: (e) => showError(e as Error) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/dashboards-plus/alerts/${id}`), onSuccess: async () => { toast("Alert removed"); await refresh(); }, onError: (e) => showError(e as Error) });
  const title = (id: string) => cards.find((c) => c.id === id)?.title ?? "Removed card";
  const valid = f.widgetId && f.threshold.trim() !== "" && Number.isFinite(Number(f.threshold));
  return (
    <Dialog open={open} onClose={onClose} title="Alerts" className="sm:max-w-xl" description="Hear when a number crosses a line: once in the app, and by email if you like. Nothing repeats until it comes back and crosses again.">
      <div className="space-y-6" data-testid="alerts-dialog">
        {!cards.length ? <Note>Alerts work on cards that show one number, like a count or a question with no grouping. Add one first.</Note> : (
          <Section title="New alert">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Card" className="sm:col-span-3">{(fp) => (<><Select {...fp} value={f.widgetId} onChange={(e) => setF({ ...f, widgetId: e.target.value })}>{cards.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></>)}</Field>
              <Field label="When it goes">{(fp) => (<><Select {...fp} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as "above" | "below" })}><option value="above">Above</option><option value="below">Below</option></Select></>)}</Field>
              <Field label="This number" className="sm:col-span-2">{(fp) => (<><Input {...fp} type="number" inputMode="decimal" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} placeholder="10" /></>)}</Field>
            </div>
            <Switch checked={f.byMail} onChange={(v) => setF({ ...f, byMail: v })} label="Email me too" />
            <Switch checked={f.quiet} onChange={(v) => setF({ ...f, quiet: v })} label="Quiet hours" />
            {f.quiet && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="From">{(fp) => (<><Select {...fp} value={f.quietStart} onChange={(e) => setF({ ...f, quietStart: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select></>)}</Field>
                <Field label="Until">{(fp) => (<><Select {...fp} value={f.quietEnd} onChange={(e) => setF({ ...f, quietEnd: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select></>)}</Field>
              </div>
            )}
            <div className="flex justify-end"><Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>{create.isPending ? "Saving" : "Set alert"}</Button></div>
          </Section>
        )}
        <Section title="Your alerts">
          {list.isPending ? <Skeleton className="h-16" /> : !list.data?.alerts.length ? <p className="text-[13px] text-muted">No alerts on this dashboard yet.</p> : (
            <ul className="space-y-2">{list.data.alerts.map((a) => (
              <Row key={a.id} testid="alert-row">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{title(a.widgetId)} {a.direction} {a.threshold.toLocaleString()}</p>
                  <p className="truncate text-[12.5px] text-muted">{a.state === "crossed" ? `Crossed${a.lastFiredAt ? ` ${when(a.lastFiredAt)}` : ""}` : "Watching"}{a.lastValue !== null ? ` · now ${a.lastValue.toLocaleString()}` : ""}{a.byMail ? " · email" : ""}{a.quietStart !== null ? ` · quiet ${hourLabel(a.quietStart)} to ${hourLabel(a.quietEnd ?? 0)}` : ""}</p>
                </div>
                <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={`Alert on ${title(a.widgetId)}`} />
                <button type="button" aria-label="Remove alert" className="rounded p-1 text-subtle hover:bg-hover hover:text-fg" onClick={() => del.mutate(a.id)}><IconTrash className="h-4 w-4" /></button>
              </Row>
            ))}</ul>
          )}
        </Section>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- data sources

export function SourcesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: pk.sources, enabled: open, queryFn: () => api.get<{ sources: Source[] }>("/dashboards-plus/sources") });
  const [mode, setMode] = useState<"csv" | "url">("csv");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [refreshEvery, setRefreshEvery] = useState("daily");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reset = () => { setName(""); setUrl(""); setFile(null); setErr(null); if (fileRef.current) fileRef.current.value = ""; };
  const refresh = () => qc.invalidateQueries({ queryKey: pk.sources });
  const add = useMutation({
    mutationFn: () => api.post<{ source: Source }>("/dashboards-plus/sources", mode === "csv" ? { kind: "csv", name: name.trim() || file?.name.replace(/\.csv$/i, "") || "Data", csv: file?.text ?? "" } : { kind: "url", name: name.trim() || "Sheet", url: url.trim(), refresh: refreshEvery }),
    onSuccess: async (r) => { toast(`${r.source.name} added: ${r.source.rowCount.toLocaleString()} rows`); reset(); await refresh(); },
    onError: (e) => setErr((e as Error).message),
  });
  const reload = useMutation({ mutationFn: (id: string) => api.post<{ source: Source }>(`/dashboards-plus/sources/${id}/refresh`), onSuccess: async (r) => { if (r.source.lastError) toast(r.source.lastError); else toast("Updated"); await refresh(); }, onError: (e) => showError(e as Error) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/dashboards-plus/sources/${id}`), onSuccess: async () => { toast("Data source removed"); await refresh(); }, onError: (e) => showError(e as Error) });
  const pickFile = async (f: File | undefined) => {
    setErr(null);
    if (!f) return setFile(null);
    if (f.size > 1_000_000) { setErr("The file is bigger than 1 MB."); return; }
    setFile({ name: f.name, text: await f.text() });
    if (!name) setName(f.name.replace(/\.csv$/i, "").slice(0, 80));
  };
  const ready = mode === "csv" ? !!file : /^https:\/\//.test(url.trim());
  return (
    <Dialog open={open} onClose={onClose} title="Data sources" className="sm:max-w-xl" description="Bring in a CSV file or a published sheet, then ask questions of it from Add widget. Up to 1 MB, 5,000 rows and 30 columns.">
      <div className="space-y-6" data-testid="sources-dialog">
        <Section title="Add a source">
          <div role="tablist" aria-label="Source type" className="inline-flex rounded-lg bg-fill p-0.5">
            {(["csv", "url"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setErr(null); }}
                className={cn("rounded-md px-3 py-1.5 text-[13px]", mode === m ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>{m === "csv" ? "Upload a CSV" : "CSV link"}</button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "csv" ? (
              <Field label="File">{(fp) => (<><input {...fp} ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => void pickFile(e.target.files?.[0])} className="block w-full text-[13px] text-muted file:mr-3 file:rounded-md file:border-0 file:bg-fill file:px-3 file:py-1.5 file:text-[13px] file:text-fg" /></>)}</Field>
            ) : (
              <>
                <Field label="Link" hint="A published sheet or any public https CSV link" className="sm:col-span-2">{(fp) => (<><Input {...fp} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></>)}</Field>
                <Field label="Refresh">{(fp) => (<><Select {...fp} value={refreshEvery} onChange={(e) => setRefreshEvery(e.target.value)}><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="manual">Only when I ask</option></Select></>)}</Field>
              </>
            )}
            <Field label="Name">{(fp) => (<><Input {...fp} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={mode === "csv" ? "Sales by month" : "Leads sheet"} /></>)}</Field>
          </div>
          {err && <p role="alert" className="text-[13px] text-danger">{err}</p>}
          <div className="flex justify-end"><Button onClick={() => add.mutate()} disabled={!ready || add.isPending}>{add.isPending ? "Reading" : "Add source"}</Button></div>
        </Section>
        <Section title="Sources in this workspace">
          {list.isPending ? <Skeleton className="h-16" /> : !list.data?.sources.length ? <p className="text-[13px] text-muted">No data sources yet.</p> : (
            <ul className="space-y-2">{list.data.sources.map((s) => (
              <Row key={s.id} testid="source-row">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium" title={s.name}>{s.name}</p>
                  <p className="truncate text-[12.5px] text-muted">{s.rowCount.toLocaleString()} rows · {s.columns.length} columns · updated {when(s.refreshedAt)}{s.kind === "url" ? ` · ${s.refresh === "manual" ? "refresh by hand" : `refresh ${s.refresh}`}` : ""}</p>
                  {s.lastError && <p className="text-[12.5px] text-danger">{s.lastError}</p>}
                </div>
                {s.kind === "url" && <Button variant="secondary" size="sm" onClick={() => reload.mutate(s.id)} disabled={reload.isPending}>Refresh</Button>}
                {s.canManage && <button type="button" aria-label={`Remove ${s.name}`} className="rounded p-1 text-subtle hover:bg-hover hover:text-fg" onClick={() => del.mutate(s.id)}><IconTrash className="h-4 w-4" /></button>}
              </Row>
            ))}</ul>
          )}
        </Section>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- question builder

const OPS_BY_KIND: Record<string, { op: QOp; label: string }[]> = {
  enum: [{ op: "is", label: "is" }, { op: "is_not", label: "is not" }],
  person: [{ op: "empty", label: "is nobody" }, { op: "not_empty", label: "is someone" }],
  project: [{ op: "empty", label: "is empty" }, { op: "not_empty", label: "is set" }],
  mailbox: [{ op: "not_empty", label: "is any" }], form: [{ op: "not_empty", label: "is any" }], page: [{ op: "not_empty", label: "is any" }],
  text: [{ op: "contains", label: "contains" }, { op: "is", label: "is" }, { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" }],
  number: [{ op: "gt", label: "is more than" }, { op: "lt", label: "is less than" }, { op: "is", label: "is" }, { op: "empty", label: "is empty" }],
  date: [{ op: "last_days", label: "in the last days" }, { op: "after", label: "is on or after" }, { op: "before", label: "is before" }, { op: "empty", label: "is empty" }, { op: "not_empty", label: "is set" }],
};
const NEEDS_VALUE: QOp[] = ["is", "is_not", "contains", "gt", "lt", "last_days", "before", "after"];
const VALUE_LABEL: Record<string, string> = { todo: "To do", doing: "In progress", done: "Done", none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent", task: "Task", story: "Story", bug: "Bug", epic: "Epic",
  lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost", confirmed: "Confirmed", cancelled: "Cancelled", yes: "Billable", no: "Not billable", inbox: "Inbox", sent: "Sent", archive: "Archive", spam: "Spam" };

export function QuestionBuilder({ open, initial, onClose, onSave, renderResult }: {
  open: boolean; initial?: { question: Question; chart: Chart; title: string } | null; onClose: () => void;
  onSave: (w: { question: Question; chart: Chart; title?: string }) => void; renderResult: (chart: Chart, r: QuestionResult) => ReactNode;
}) {
  const catalog = useQuery({ queryKey: pk.catalog, enabled: open, staleTime: Infinity, queryFn: () => api.get<Catalog>("/dashboards-plus/question/catalog") });
  const sources = useQuery({ queryKey: pk.sources, enabled: open, queryFn: () => api.get<{ sources: Source[] }>("/dashboards-plus/sources") });
  const blank: Question = { table: "tasks", filters: [], groupBy: "status", bucket: null, measure: { op: "count" } };
  const [q, setQ] = useState<Question>(initial?.question ?? blank);
  const [chart, setChart] = useState<Chart>(initial?.chart ?? "bar");
  const [title, setTitle] = useState(initial?.title ?? "");
  useEffect(() => { if (open) { setQ(initial?.question ?? blank); setChart(initial?.chart ?? "bar"); setTitle(initial?.title ?? ""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const src = q.table === "source" ? sources.data?.sources.find((s) => s.id === q.sourceId) : undefined;
  const table = catalog.data?.tables.find((t) => t.id === q.table);
  const fields: CatalogField[] = q.table === "source" ? (src?.columns.map((c) => ({ id: c.name, label: c.name, kind: c.kind, values: null })) ?? []) : (table?.fields ?? []);
  const numberFields = fields.filter((f) => f.kind === "number");
  const countOnly = !!table?.countOnly || (q.table === "source" && !numberFields.length);
  const field = (id?: string | null) => fields.find((f) => f.id === id);
  const grouped = !!q.groupBy;
  useEffect(() => { if (grouped && chart === "number") setChart("bar"); if (!grouped && chart !== "number") setChart("number"); }, [grouped]); // eslint-disable-line react-hooks/exhaustive-deps
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 350); return () => clearTimeout(t); }, [q]);
  const incomplete = debounced.filters.some((f) => NEEDS_VALUE.includes(f.op) && !f.value) || (debounced.measure.op !== "count" && !debounced.measure.field) || (debounced.table === "source" && !debounced.sourceId);
  const preview = useQuery({ queryKey: ["dash-plus", "preview", debounced], enabled: open && !incomplete, retry: false, queryFn: () => api.post<{ result: QuestionResult }>("/dashboards-plus/question/preview", { question: debounced, tz: zone() }) });
  const setTable = (v: string) => {
    if (v.startsWith("source:")) setQ({ table: "source", sourceId: v.slice(7), filters: [], groupBy: null, bucket: null, measure: { op: "count" } });
    else setQ({ table: v, filters: [], groupBy: null, bucket: null, measure: { op: "count" } });
  };
  const setFilter = (i: number, patch: Partial<Question["filters"][number]>) => setQ({ ...q, filters: q.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const g = field(q.groupBy);
  const charts: { id: Chart; label: string }[] = grouped ? [{ id: "bar", label: "Bar" }, { id: "line", label: "Line" }, { id: "donut", label: "Donut" }, { id: "table", label: "Table" }] : [{ id: "number", label: "Number" }];
  return (
    <Dialog open={open} onClose={onClose} title={initial ? "Edit question" : "New question"} className="sm:max-w-4xl" description="Pick the data, narrow it down, then choose what to count or add up. You only ever see data you could see anyway."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => onSave({ question: q, chart, title: title.trim() || undefined })} disabled={incomplete || preview.isError}>{initial ? "Save card" : "Add to dashboard"}</Button></>}>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="question-builder">
        <div className="min-w-0 space-y-5">
          {catalog.isPending ? <Skeleton className="h-64" /> : (
            <>
              <Field label="Data">{(fp) => (<>
                <Select {...fp} value={q.table === "source" ? `source:${q.sourceId ?? ""}` : q.table} onChange={(e) => setTable(e.target.value)} aria-label="Data">
                  <optgroup label="Multies">{catalog.data?.tables.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>
                  {!!sources.data?.sources.length && <optgroup label="Data sources">{sources.data.sources.map((s) => <option key={s.id} value={`source:${s.id}`}>{s.name}</option>)}</optgroup>}
                </Select>
              </>)}</Field>
              <Section title="Filters">
                {!q.filters.length && <p className="text-[13px] text-muted">Everything you can see. Add a filter to narrow it down.</p>}
                <ul className="space-y-2">{q.filters.map((f, i) => {
                  const fd = field(f.field); const ops = OPS_BY_KIND[fd?.kind ?? "text"] ?? OPS_BY_KIND.text!;
                  return (
                    <li key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2" data-testid="question-filter">
                      <Select aria-label="Field" value={f.field} onChange={(e) => { const nf = field(e.target.value); setFilter(i, { field: e.target.value, op: (OPS_BY_KIND[nf?.kind ?? "text"] ?? OPS_BY_KIND.text!)[0]!.op, value: "" }); }}>{fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                      <Select aria-label="Condition" value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as QOp, value: "" })}>{ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</Select>
                      <button type="button" aria-label="Remove filter" className="rounded p-1.5 text-subtle hover:bg-hover hover:text-fg" onClick={() => setQ({ ...q, filters: q.filters.filter((_, j) => j !== i) })}><IconClose className="h-4 w-4" /></button>
                      {NEEDS_VALUE.includes(f.op) && (
                        <div className="col-span-2">
                          {fd?.values ? <Select aria-label="Value" value={f.value ?? ""} onChange={(e) => setFilter(i, { value: e.target.value })}><option value="">Pick a value</option>{fd.values.map((v) => <option key={v} value={v}>{VALUE_LABEL[v] ?? v}</option>)}</Select>
                            : <Input aria-label="Value" type={f.op === "last_days" || fd?.kind === "number" ? "number" : f.op === "before" || f.op === "after" ? "date" : "text"} value={f.value ?? ""} onChange={(e) => setFilter(i, { value: e.target.value })} placeholder={f.op === "last_days" ? "30" : ""} />}
                        </div>
                      )}
                    </li>
                  );
                })}</ul>
                <Button variant="secondary" size="sm" onClick={() => fields[0] && setQ({ ...q, filters: [...q.filters, { field: fields[0].id, op: (OPS_BY_KIND[fields[0].kind] ?? OPS_BY_KIND.text!)[0]!.op, value: "" }] })} disabled={q.filters.length >= 8 || !fields.length}><IconPlus className="h-4 w-4" />Add filter</Button>
              </Section>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Measure">{(fp) => (<>
                  <Select {...fp} value={q.measure.op} onChange={(e) => setQ({ ...q, measure: { op: e.target.value as Question["measure"]["op"], field: e.target.value === "count" ? undefined : (q.measure.field ?? numberFields[0]?.id) } })}>
                    <option value="count">Count</option>
                    {!countOnly && <><option value="sum">Total of</option><option value="avg">Average of</option><option value="min">Lowest</option><option value="max">Highest</option></>}
                  </Select>
                </>)}</Field>
                {q.measure.op !== "count" && <Field label="Of">{(fp) => (<><Select {...fp} value={q.measure.field ?? ""} onChange={(e) => setQ({ ...q, measure: { ...q.measure, field: e.target.value } })}>{numberFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select></>)}</Field>}
                <Field label="Group by">{(fp) => (<>
                  <Select {...fp} value={q.groupBy ?? ""} onChange={(e) => { const v = e.target.value || null; setQ({ ...q, groupBy: v, bucket: field(v)?.kind === "date" ? (q.bucket ?? "week") : null }); }}>
                    <option value="">Nothing, one number</option>
                    {fields.filter((f) => f.kind !== "number" && f.kind !== "text" || q.table === "source").map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </Select>
                </>)}</Field>
                {g?.kind === "date" && <Field label="Per">{(fp) => (<><Select {...fp} value={q.bucket ?? "week"} onChange={(e) => setQ({ ...q, bucket: e.target.value as "day" | "week" | "month" })}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></Select></>)}</Field>}
              </div>
              <Field label="Show as">{(fp) => (<>
                <div {...fp} role="radiogroup" aria-label="Show as" className="inline-flex flex-wrap rounded-lg bg-fill p-0.5">
                  {charts.map((c) => <button key={c.id} type="button" role="radio" aria-checked={chart === c.id} onClick={() => setChart(c.id)} className={cn("rounded-md px-3 py-1.5 text-[13px]", chart === c.id ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>{c.label}</button>)}
                </div>
              </>)}</Field>
              <Field label="Card title" hint="Leave empty to describe the question">{(fp) => (<><Input {...fp} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={preview.data?.result.label ?? "Question"} /></>)}</Field>
            </>
          )}
        </div>
        <div className="min-w-0">
          <div className="sticky top-0 rounded-xl border border-line p-4" data-testid="question-preview">
            <p className="mb-3 truncate text-[13px] font-semibold">{title.trim() || preview.data?.result.label || "Preview"}</p>
            {incomplete ? <p className="py-12 text-center text-[13px] text-muted">Finish the question to see the answer.</p>
              : preview.isError ? <p role="alert" className="py-12 text-center text-[13px] text-danger">{(preview.error as Error).message}</p>
              : !preview.data ? <Skeleton className="h-48" />
              : <div className={cn(preview.isFetching && "opacity-60 transition-opacity")}>{renderResult(chart, preview.data.result)}</div>}
            {preview.data?.result.truncated && <p className="mt-2 text-[12px] text-muted">Showing the first 50 groups.</p>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
