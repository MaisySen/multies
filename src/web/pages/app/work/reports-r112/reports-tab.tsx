/**
 * R112: Docs > Forms > Reports. Owners and admins see every case and the channel settings; a member sees only the cases
 * they are the handler of. List and case side by side at 1280, one at a time on a phone.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Field, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconArrowLeft, IconExternalLink, IconShieldCheck } from "@/web/components/ui/icon";
import { Composer, Thread, day, when } from "./thread";
import {
  REPORT_STATUSES, REPORT_STATUS_LABELS, daysLeft,
  type ReportCaseDetail, type ReportCaseRow, type ReportChannelView, type ReportStatus,
} from "@/shared/reporting-r112";

type View = "open" | "new" | "mine" | "closed" | "all";
const VIEWS: { id: View; label: string }[] = [{ id: "open", label: "Open" }, { id: "new", label: "New" }, { id: "mine", label: "Mine" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" }];
interface Access { canSee: boolean; isAdmin: boolean; assigned: number }
interface Counts { open: number; new: number; closed: number; mine: number; overdue: number }
const tone = (s: ReportStatus) => (s === "new" ? "brand" : s === "closed" ? "neutral" : s === "investigating" ? "warn" : "ok") as "brand" | "neutral" | "warn" | "ok";

export function useReportAccess(on: boolean) {
  return useQuery({ queryKey: ["reporting", "access"], queryFn: () => api.get<Access>("/reporting/access"), enabled: on, staleTime: 60_000 });
}

function LoadError({ what, retry }: { what: string; retry: () => void }) {
  return <Card className="p-6 text-center text-[13px]" role="alert">Couldn't load {what}. <Button size="sm" variant="ghost" onClick={retry}>Try again</Button></Card>;
}

function ChannelCard({ channel }: { channel: ReportChannelView }) {
  const qc = useQueryClient();
  const handlers = useQuery({ queryKey: ["reporting", "handlers"], queryFn: () => api.get<{ handlers: { id: string; name: string; role: string }[] }>("/reporting/handlers") });
  const [intro, setIntro] = useState(channel.intro);
  const [busy, setBusy] = useState(false);
  useEffect(() => setIntro(channel.intro), [channel.intro]);
  const save = async (body: Partial<{ enabled: boolean; intro: string; defaultHandlerId: string | null }>) => {
    setBusy(true);
    try { const r = await api.put<{ channel: ReportChannelView }>("/reporting/channel", body); qc.setQueryData(["reporting", "channel"], r); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="space-y-4 p-4 sm:p-5" data-testid="report-channel">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Anonymous reporting page</div>
          <p className="mt-0.5 text-[13px] text-muted">People can report a concern without an account. The page keeps no device address, browser details or cookies. Only admins and the assigned handler see reports.</p>
        </div>
        <Switch checked={channel.enabled} onChange={(v) => void save({ enabled: v })} label={channel.enabled ? "Turn the reporting page off" : "Turn the reporting page on"} disabled={busy} />
      </div>
      {channel.enabled && channel.url && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg max-sm:basis-full border border-line bg-fill px-3 py-2 text-[12.5px]" data-testid="report-link">{channel.url}</code>
          <CopyButton value={channel.url} label="Copy link" />
          <a href={channel.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-elevated max-sm:min-h-11"><IconExternalLink className="h-4 w-4" />Open</a>
        </div>
      )}
      {channel.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New reports go to" hint="Gets a notice for each new report. Leave empty to tell every owner and admin.">{(fp) => (
            <Select {...fp} value={channel.defaultHandlerId ?? ""} onChange={(e) => void save({ defaultHandlerId: e.target.value || null })} disabled={busy || handlers.isPending}>
              <option value="">Owners and admins</option>
              {(handlers.data?.handlers ?? []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Message on the page" hint="Optional. Shown above the choices.">{(fp) => (
            <Textarea {...fp} value={intro} onChange={(e) => setIntro(e.target.value)} onBlur={() => intro !== channel.intro && void save({ intro })} className="min-h-20" maxLength={2000} />
          )}</Field>
        </div>
      )}
    </Card>
  );
}

function Deadline({ label, due, doneAt, overdue, now }: { label: string; due: number; doneAt: number | null; overdue: boolean; now: number }) {
  const left = daysLeft(due, now);
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
        {doneAt ? <><span>Done {day(doneAt)}</span><Badge tone="ok">Done</Badge></> : <><span>By {day(due)}</span>{overdue ? <Badge tone="bad">Overdue</Badge> : <span className="text-[12.5px] font-normal text-muted">{left === 1 ? "1 day left" : `${left} days left`}</span>}</>}
      </div>
    </div>
  );
}

function CaseView({ id, access, onBack }: { id: string; access: Access; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["reporting", "case", id], queryFn: () => api.get<{ case: ReportCaseDetail }>(`/reporting/cases/${id}`) });
  const handlers = useQuery({ queryKey: ["reporting", "handlers"], queryFn: () => api.get<{ handlers: { id: string; name: string }[] }>("/reporting/handlers"), enabled: access.isAdmin });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const c = q.data?.case;
  useEffect(() => { if (c) setOutcome(c.outcome); }, [c?.id, c?.outcome]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (r: { case: ReportCaseDetail }) => { qc.setQueryData(["reporting", "case", id], r); void qc.invalidateQueries({ queryKey: ["reporting", "cases"] }); };
  const patch = async (body: Record<string, unknown>) => { setBusy(true); try { done(await api.patch<{ case: ReportCaseDetail }>(`/reporting/cases/${id}`, body)); } catch (e) { showError(e as Error); } finally { setBusy(false); } };
  const send = async (text: string, files: File[], internal: boolean) => {
    setBusy(true);
    try {
      if (!files.length) done(await api.post<{ case: ReportCaseDetail }>(`/reporting/cases/${id}/messages`, { text, internal }));
      else {
        const fd = new FormData(); fd.set("data", JSON.stringify({ text, internal })); for (const f of files) fd.append("files", f);
        const res = await fetch(`/api/reporting/cases/${id}/messages`, { method: "POST", body: fd, credentials: "include", headers: { "x-multies-upload": "1" } });
        if (!res.ok) { let m = "That message couldn't be sent."; try { m = ((await res.json()) as { error?: { message?: string } }).error?.message ?? m; } catch { /* not JSON */ } throw new Error(m); }
        done((await res.json()) as { case: ReportCaseDetail });
      }
      return true;
    } catch (e) { showError(e as Error); return false; } finally { setBusy(false); }
  };
  const file = (fileId: string, name: string) => { const a = document.createElement("a"); a.href = `/api/reporting/cases/${id}/files/${fileId}`; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError || !c) return <LoadError what="this report" retry={() => void q.refetch()} />;
  const now = Date.now();
  return (
    <div className="space-y-4" data-testid="case-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden"><IconArrowLeft className="h-4 w-4" />All reports</Button>
        <h2 className="font-mono text-lg font-semibold" data-testid="case-no">{c.caseNo}</h2>
        <Badge tone={tone(c.status)}>{REPORT_STATUS_LABELS[c.status]}</Badge>
        <span className="text-[12.5px] text-muted">Received {when(c.createdAt)}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status">{(fp) => (
          <Select {...fp} value={c.status} onChange={(e) => void patch({ status: e.target.value })} disabled={busy} data-testid="case-status">
            {REPORT_STATUSES.map((s) => <option key={s} value={s}>{REPORT_STATUS_LABELS[s]}</option>)}
          </Select>
        )}</Field>
        <Field label="Handler" hint={access.isAdmin ? "Only admins and the handler can see this report." : undefined}>{(fp) => access.isAdmin ? (
          <Select {...fp} value={c.handlerId ?? ""} onChange={(e) => void patch({ handlerId: e.target.value || null })} disabled={busy || handlers.isPending} data-testid="case-handler">
            <option value="">No handler yet</option>
            {(handlers.data?.handlers ?? []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </Select>
        ) : <div {...fp} className="flex h-10 items-center text-[14px]">{c.handlerName ?? "You"}</div>}</Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Deadline label="Acknowledge within 7 days" due={c.ackDueAt} doneAt={c.acknowledgedAt} overdue={c.ackOverdue} now={now} />
        <Deadline label="Outcome within 3 months" due={c.outcomeDueAt} doneAt={c.closedAt} overdue={c.outcomeOverdue} now={now} />
      </div>
      <Field label="Outcome" hint="Shown to the reporter once the report is closed.">{(fp) => (
        <Textarea {...fp} value={outcome} onChange={(e) => setOutcome(e.target.value)} onBlur={() => outcome !== c.outcome && void patch({ outcome })} className="min-h-16" maxLength={4000} data-testid="case-outcome" />
      )}</Field>
      <Thread messages={c.messages} viewer="handler" onFile={file} />
      <Composer onSend={send} busy={busy} internalToggle placeholder="Reply to the reporter, or tick Internal note to keep it to handlers" testid="handler-reply" />
    </div>
  );
}

export function ReportsTab() {
  const [params, setParams] = useSearchParams();
  const access = useReportAccess(true);
  const isAdmin = !!access.data?.isAdmin;
  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ?? (isAdmin ? "open" : "mine")) as View;
  const open = params.get("case");
  const channel = useQuery({ queryKey: ["reporting", "channel"], queryFn: () => api.get<{ channel: ReportChannelView }>("/reporting/channel"), enabled: isAdmin });
  const list = useQuery({ queryKey: ["reporting", "cases", view], queryFn: () => api.get<{ cases: ReportCaseRow[]; counts: Counts }>(`/reporting/cases?view=${view}`), enabled: !!access.data?.canSee });
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: k === "view" });
  if (access.isPending) return <Skeleton className="h-64" />;
  if (access.isError) return <LoadError what="reports" retry={() => void access.refetch()} />;
  if (!access.data?.canSee) return <Card><EmptyState icon={<IconShieldCheck />} title="No reports for you" body="Reports are seen only by owners, admins and the person handling each one." /></Card>;
  const counts = list.data?.counts;
  const now = Date.now();
  return (
    <div className="space-y-4">
      {isAdmin && (channel.isPending ? <Skeleton className="h-24" /> : channel.isError ? <LoadError what="the reporting page settings" retry={() => void channel.refetch()} /> : channel.data && <ChannelCard channel={channel.data.channel} />)}
      <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
        <div className={`space-y-3 ${open ? "max-lg:hidden" : ""}`}>
          <div className="flex items-center gap-2"><div role="group" aria-label="Show" className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1">
            {VIEWS.filter((v) => isAdmin || v.id === "mine" || v.id === "closed").map((v) => (
              <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => set("view", v.id)}
                className={`h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11 ${view === v.id ? "bg-fill text-fg" : "text-muted hover:text-fg"}`}>
                {v.label}{counts && v.id !== "all" ? <span className="ml-1 text-subtle">{counts[v.id as keyof Counts]}</span> : null}
              </button>
            ))}
          </div>{!!counts?.overdue && <Badge tone="bad">{counts.overdue} overdue</Badge>}</div>
          {list.isPending ? <Skeleton className="h-48" /> : list.isError ? <LoadError what="reports" retry={() => void list.refetch()} /> : !list.data.cases.length ? (
            <Card><EmptyState icon={<IconShieldCheck />} title={view === "closed" ? "No closed reports" : "No reports yet"} body={isAdmin ? (channel.data?.channel.enabled ? "Share the page link where your people can find it, such as your staff handbook or intranet." : "Turn on the reporting page above to get a link people can use.") : "Reports you handle show here."} /></Card>
          ) : (
            <Card className="divide-y divide-line overflow-hidden" data-testid="case-list">
              {list.data.cases.map((c) => (
                <button key={c.id} type="button" onClick={() => set("case", c.id)} aria-current={open === c.id ? "true" : undefined}
                  className={`block w-full px-4 py-3 text-left transition-colors duration-150 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${open === c.id ? "bg-fill" : ""}`} data-testid="case-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold">{c.caseNo}</span>
                    <Badge tone={tone(c.status)}>{REPORT_STATUS_LABELS[c.status]}</Badge>
                    {c.unread && <Badge tone="brand" dot>New message</Badge>}
                    {(c.ackOverdue || c.outcomeOverdue) && <Badge tone="bad">Overdue</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted">{c.summary}</p>
                  <p className="mt-1 text-[12px] text-subtle">{day(c.createdAt)} · {c.handlerName ?? "No handler"}{c.status === "new" ? ` · acknowledge by ${day(c.ackDueAt)}` : c.status !== "closed" ? ` · outcome due in ${Math.max(0, daysLeft(c.outcomeDueAt, now))} days` : ""}</p>
                </button>
              ))}
            </Card>
          )}
        </div>
        <div className={open ? "" : "max-lg:hidden"}>
          {open ? <CaseView key={open} id={open} access={access.data} onBack={() => set("case", null)} /> : <Card className="hidden p-8 text-center text-[13px] text-muted lg:block">Pick a report to read it.</Card>}
        </div>
      </div>
    </div>
  );
}
