/**
 * R112: Settings > Admin > Data requests (REPORTING_R112). A person's request to export or delete what this workspace holds about
 * them in Contacts, Form answers and Bookings. Nothing about them shows until they confirm their email. Every action is logged
 * (who, when, kinds, counts), never the data itself.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconDownload, IconMail, IconPlus, IconShieldCheck, IconTrash } from "@/web/components/ui/icon";
import { ApiError } from "@/web/lib/api";
import { LOCALE } from "@/shared/locale";
import {
  DATA_KINDS, DATA_KIND_LABELS, DATA_STATUS_LABELS, daysLeft, isEmail,
  type DataLogRow, type DataMatchCounts, type DataRequestRow, type DataRequestStatus,
} from "@/shared/reporting-r112";

interface Matches {
  contacts: { id: string; name: string; email: string; phone: string | null; title: string | null }[];
  forms: { id: string; form: string; createdAt: number }[];
  bookings: { id: string; page: string; startsAt: number; status: string }[];
}
interface Detail { request: DataRequestRow; matches: Matches | null; counts: DataMatchCounts | null; log: DataLogRow[] }
const day = (t: number) => new Date(t).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const when = (t: number) => new Date(t).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const tone = (s: DataRequestStatus) => (s === "verified" ? "brand" : s === "done" ? "ok" : s === "unverified" ? "warn" : "neutral") as "brand" | "ok" | "warn" | "neutral";
const ACTIONS: Record<string, string> = {
  requested: "Request made on the public page", entered: "Request entered", email_confirmed: "Email confirmed by the person", export_downloaded: "ZIP downloaded",
  download_link_sent: "Download link sent", download_used: "Person downloaded the ZIP", deleted: "Data deleted", cancelled: "Request cancelled", check_resent: "Confirm link sent again",
};
const countText = (c: Partial<DataMatchCounts>) => DATA_KINDS.filter((k) => c[k] !== undefined).map((k) => `${DATA_KIND_LABELS[k]} ${c[k]}`).join(", ");

function LogList({ rows }: { rows: DataLogRow[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted">Nothing yet.</p>;
  return (
    <ol className="space-y-2" data-testid="dr-log">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap gap-x-2 text-[13px]">
          <span className="text-subtle">{when(r.createdAt)}</span><span className="font-medium">{r.actor}</span><span>{ACTIONS[r.action] ?? r.action}</span>
          {Object.keys(r.counts).length > 0 && <span className="text-muted">({countText(r.counts)})</span>}
        </li>
      ))}
    </ol>
  );
}

function NewRequest({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"export" | "delete">("export");
  const [busy, setBusy] = useState(false);
  const make = async () => { setBusy(true); try { const r = await api.post<Detail>("/data-requests", { email: email.trim(), type }); onMade(r.request.id); } catch (e) { showError(e as Error); } finally { setBusy(false); } };
  return (
    <Dialog open onClose={onClose} title="New data request" description="We email the person a link to confirm the address is theirs. Their data shows here once they do."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void make()} loading={busy} disabled={!isEmail(email)} data-testid="dr-new-save">Send confirm link</Button></>}>
      <div className="space-y-3">
        <Field label="Their email">{(fp) => <Input {...fp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="dr-new-email" />}</Field>
        <Field label="They asked for">{(fp) => <Select {...fp} value={type} onChange={(e) => setType(e.target.value as "export" | "delete")} data-testid="dr-new-type"><option value="export">A copy of their data</option><option value="delete">Their data to be deleted</option></Select>}</Field>
      </div>
    </Dialog>
  );
}

function ConfirmDelete({ counts, onClose, onDo, busy }: { counts: DataMatchCounts; onClose: () => void; onDo: () => void; busy: boolean }) {
  const [text, setText] = useState("");
  return (
    <Dialog open onClose={onClose} title="Delete this person's data?" description="This can't be undone. Only this workspace is changed."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={onDo} loading={busy} disabled={text.trim().toUpperCase() !== "DELETE"} data-testid="dr-delete-confirm">Delete for good</Button></>}>
      <div className="space-y-3">
        <ul className="space-y-1 text-[14px]">{DATA_KINDS.map((k) => <li key={k}>{DATA_KIND_LABELS[k]}: <span className="font-medium">{counts[k]}</span></li>)}</ul>
        <Field label="Type DELETE to confirm">{(fp) => <Input {...fp} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" data-testid="dr-delete-text" />}</Field>
      </div>
    </Dialog>
  );
}

function RequestDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["data-requests", id], queryFn: () => api.get<Detail>(`/data-requests/${id}`) });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try { const r = await api.post<Detail>(`/data-requests/${id}/${path}`, body); qc.setQueryData(["data-requests", id], r); void qc.invalidateQueries({ queryKey: ["data-requests", "list"] }); void qc.invalidateQueries({ queryKey: ["data-requests", "log"] }); setConfirm(false); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const download = () => {
    const a = document.createElement("a"); a.href = `/api/data-requests/${id}/export`; a.download = ""; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { void qc.invalidateQueries({ queryKey: ["data-requests", id] }); void qc.invalidateQueries({ queryKey: ["data-requests", "log"] }); }, 1500);
  };
  const d = q.data;
  const r = d?.request;
  const now = Date.now();
  return (
    <Dialog open onClose={onClose} title={r ? (r.type === "export" ? "Copy of data" : "Delete data") : "Data request"} description={r ? `${r.email} · due ${day(r.dueAt)}` : undefined} className="sm:max-w-2xl"
      footer={!r ? undefined : (
        <div className="flex w-full flex-wrap items-center gap-2">
          {r.status === "unverified" && <Button variant="ghost" onClick={() => void act("resend")} loading={busy}>Send confirm link again</Button>}
          {(r.status === "unverified" || r.status === "verified" || r.status === "expired") && <Button variant="ghost" onClick={() => void act("cancel")} loading={busy}>Cancel request</Button>}
          <span className="flex-1" />
          {r.status === "verified" && <Button variant="secondary" onClick={download} data-testid="dr-zip"><IconDownload className="h-4 w-4" />Download ZIP</Button>}
          {r.status === "verified" && r.type === "export" && <Button onClick={() => void act("send-link")} loading={busy} data-testid="dr-send-link"><IconMail className="h-4 w-4" />Email them a download link</Button>}
          {r.status === "verified" && r.type === "delete" && <Button variant="danger" onClick={() => setConfirm(true)} data-testid="dr-delete"><IconTrash className="h-4 w-4" />Delete data</Button>}
        </div>
      )}>
      {q.isPending ? <Skeleton className="h-40" /> : q.isError || !d || !r ? <p className="text-[13px]" role="alert">Couldn't load this request. <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>Try again</Button></p> : (
        <div className="space-y-4" data-testid="dr-detail">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(r.status)}>{DATA_STATUS_LABELS[r.status]}</Badge>{r.overdue && <Badge tone="bad">Overdue</Badge>}
            {!r.overdue && (r.status === "verified" || r.status === "unverified") && <span className="text-[12.5px] text-muted">{Math.max(0, daysLeft(r.dueAt, now))} days left</span>}</div>
          {!d.matches ? (
            <p className="rounded-xl border border-line bg-fill px-4 py-3 text-[13.5px]">{r.status === "unverified" ? "Waiting for the person to confirm their email. Their data shows here once they do." : r.status === "done" ? "This request is done. Nothing about the person is shown any more." : "This request is closed."}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {DATA_KINDS.map((k) => <div key={k} className="rounded-xl border border-line p-3"><div className="text-[12px] text-muted">{DATA_KIND_LABELS[k]}</div><div className="mt-1 text-xl font-semibold" data-testid={`dr-count-${k}`}>{d.counts![k]}</div></div>)}
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-line p-3 text-[13px]" tabIndex={0} role="region" aria-label="What was found">
                {d.matches.contacts.map((c) => <div key={c.id}>Contact: <span className="font-medium">{c.name || c.email}</span>{c.title ? `, ${c.title}` : ""}{c.phone ? `, ${c.phone}` : ""}</div>)}
                {d.matches.forms.map((f) => <div key={f.id}>Form answer: <span className="font-medium">{f.form}</span>, {day(f.createdAt)}</div>)}
                {d.matches.bookings.map((b) => <div key={b.id}>Booking: <span className="font-medium">{b.page}</span>, {when(b.startsAt)} ({b.status})</div>)}
                {!d.matches.contacts.length && !d.matches.forms.length && !d.matches.bookings.length && <p className="text-muted">No data found for this email in this workspace.</p>}
              </div>
            </div>
          )}
          <div><div className="mb-2 text-[13px] font-semibold">History</div><LogList rows={d.log} /></div>
        </div>
      )}
      {confirm && d?.counts && <ConfirmDelete counts={d.counts} busy={busy} onClose={() => setConfirm(false)} onDo={() => void act("delete", { confirm: "DELETE" })} />}
    </Dialog>
  );
}

export function DataRequestsSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["data-requests", "settings"], queryFn: () => api.get<{ publicEnabled: boolean; url: string; dueDays: number }>("/data-requests/settings"), retry: false });
  const list = useQuery({ queryKey: ["data-requests", "list"], queryFn: () => api.get<{ requests: DataRequestRow[] }>("/data-requests"), enabled: settings.isSuccess });
  const log = useQuery({ queryKey: ["data-requests", "log"], queryFn: () => api.get<{ log: DataLogRow[] }>("/data-requests/log"), enabled: settings.isSuccess });
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = async (v: boolean) => { setBusy(true); try { qc.setQueryData(["data-requests", "settings"], await api.put("/data-requests/settings", { publicEnabled: v })); } catch (e) { showError(e as Error); } finally { setBusy(false); } };
  const forbidden = settings.error instanceof ApiError && (settings.error.status === 403 || settings.error.status === 404);
  const now = Date.now();
  return (
    <div className="space-y-5">
      <PageHeader title="Data requests" description="When someone asks for a copy of their data or for it to be deleted. Contacts, form answers and bookings are matched by email. Answer within 30 days."
        actions={settings.isSuccess ? <Button onClick={() => setMaking(true)} data-testid="dr-new"><IconPlus className="h-4 w-4" />New request</Button> : undefined} />
      {settings.isPending ? <Skeleton className="h-24" /> : forbidden ? (
        <Card><EmptyState icon={<IconShieldCheck />} title="Only owners and admins" body="Ask an owner or admin of this workspace to handle data requests." /></Card>
      ) : settings.isError ? (
        <Card className="p-6 text-center text-[13px]" role="alert">Couldn't load data requests. <Button size="sm" variant="ghost" onClick={() => void settings.refetch()}>Try again</Button></Card>
      ) : (
        <>
          <Card className="space-y-3 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1"><div className="text-[14px] font-semibold">Public request page</div><p className="mt-0.5 text-[13px] text-muted">A page where people can ask for their data themselves. Link it from your privacy policy.</p></div>
              <Switch checked={settings.data.publicEnabled} onChange={(v) => void toggle(v)} label={settings.data.publicEnabled ? "Turn the request page off" : "Turn the request page on"} disabled={busy} />
            </div>
            {settings.data.publicEnabled && <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-fill px-3 py-2 text-[12.5px]" data-testid="dr-link">{settings.data.url}</code><CopyButton value={settings.data.url} label="Copy link" /></div>}
          </Card>
          {list.isPending ? <Skeleton className="h-40" /> : list.isError ? (
            <Card className="p-6 text-center text-[13px]" role="alert">Couldn't load requests. <Button size="sm" variant="ghost" onClick={() => void list.refetch()}>Try again</Button></Card>
          ) : !list.data.requests.length ? (
            <Card><EmptyState icon={<IconShieldCheck />} title="No data requests" body="Requests from your public page, or ones you enter for someone, show here." action={<Button variant="secondary" onClick={() => setMaking(true)}>New request</Button>} /></Card>
          ) : (
            <Card className="divide-y divide-line overflow-hidden" data-testid="dr-list">
              {list.data.requests.map((r) => (
                <button key={r.id} type="button" onClick={() => setOpen(r.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" data-testid="dr-row">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{r.masked}</span>
                  <span className="text-[13px] text-muted">{r.type === "export" ? "Copy" : "Delete"}</span>
                  <Badge tone={tone(r.status)}>{DATA_STATUS_LABELS[r.status]}</Badge>
                  {r.overdue ? <Badge tone="bad">Overdue</Badge> : (r.status === "verified" || r.status === "unverified") && <span className="text-[12.5px] text-subtle">due in {Math.max(0, daysLeft(r.dueAt, now))} days</span>}
                  <span className="w-full text-[12px] text-subtle sm:w-auto">{day(r.createdAt)}</span>
                </button>
              ))}
            </Card>
          )}
          <Card className="p-4 sm:p-5"><div className="mb-2 text-[14px] font-semibold">Activity</div><p className="mb-3 text-[12.5px] text-muted">Who did what and how many records. The data itself is never kept here.</p>
            {log.isPending ? <Skeleton className="h-16" /> : log.isError ? <p className="text-[13px]">Couldn't load the activity. <Button size="sm" variant="ghost" onClick={() => void log.refetch()}>Try again</Button></p> : <LogList rows={log.data.log} />}
          </Card>
        </>
      )}
      {making && <NewRequest onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); setOpen(id); void qc.invalidateQueries({ queryKey: ["data-requests"] }); }} />}
      {open && <RequestDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
