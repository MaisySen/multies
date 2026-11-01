/**
 * R88: Tools > Secure share > File requests. Make a link a client can upload files to without an account, see each
 * request's received files, download them, close or reopen a request. Hidden unless GET /api/tools lists
 * the "file_requests" feature.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Meter, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconCopy, IconDownload, IconFileUp, IconLock, IconMail, IconTrash, IconUpload } from "@/web/components/ui/icon";
import {
  REQUEST_EXPIRY_CHOICES, REQUEST_FILE_CAPS, REQUEST_KEEP_DAYS, REQUEST_TOTAL_CAPS, REQUEST_TYPE_GROUPS, REQUEST_TYPE_KEYS, allowedLabel,
  type FileRequestInfo, type RequestFileInfo, type RequestTypeGroup,
} from "@/shared/secure-share";
import type { KeptUsage } from "@/shared/share-sign";
import { attachToNewEmail } from "@/web/lib/compose-files";
import { LoadErrorInline } from "@/web/components/load-error-t1g";

const MB = 1024 * 1024;
const sizeOf = (n: number) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const STATUS: Record<FileRequestInfo["status"], { label: string; tone: "ok" | "neutral" | "warn" | "bad" }> = {
  open: { label: "Open", tone: "ok" }, closed: { label: "Closed", tone: "neutral" }, expired: { label: "Ended", tone: "neutral" }, full: { label: "Full", tone: "warn" }, paused: { label: "Paused after reports", tone: "bad" },
};
const field = "w-full";

function FileRow({ f, onDelete }: { f: RequestFileInfo; onDelete: (f: RequestFileInfo) => void }) {
  const from = [f.uploaderName, f.uploaderEmail].filter(Boolean).join(", ");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0" data-testid="request-file">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={f.name}>{f.name}</span>
        <span className="block text-[12.5px] text-muted">{sizeOf(f.bytes)} · {f.status === "done" ? when(f.completedAt ?? f.createdAt) : `Uploading, ${Math.round(f.progress * 100)}%`}{from ? ` · ${from}` : ""}</span>
        {f.note && <span className="mt-1 block whitespace-pre-wrap text-[13px] text-fg/80">{f.note}</span>}
      </span>
      {f.status === "done" && <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg hover:bg-hover max-sm:min-h-11" href={`/api/tools/requests/files/${encodeURIComponent(f.id)}`} download={f.name}><IconDownload className="h-3.5 w-3.5" aria-hidden />Download</a>}
      <Button size="sm" variant="ghost" onClick={() => onDelete(f)} aria-label={`Delete ${f.name}`}><IconTrash className="h-3.5 w-3.5" /></Button>
    </li>
  );
}

function RequestRow({ r, startOpen }: { r: FileRequestInfo; startOpen: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(startOpen);
  const [del, setDel] = useState<RequestFileInfo | null>(null);
  const detail = useQuery({ queryKey: ["tools-requests", r.id], enabled: open, queryFn: () => api.get<FileRequestInfo>(`/tools/requests/${r.id}`), refetchInterval: open ? 15_000 : false });
  const toggle = useMutation({
    mutationFn: (o: boolean) => api.patch<FileRequestInfo>(`/tools/requests/${r.id}`, { open: o }),
    onSuccess: (x) => { toast.success(x.status === "open" ? "Request reopened" : "Request closed"); void qc.invalidateQueries({ queryKey: ["tools-requests"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (f: RequestFileInfo) => api.del(`/tools/requests/files/${f.id}`),
    onSuccess: () => { setDel(null); toast.success("File deleted"); void qc.invalidateQueries({ queryKey: ["tools-requests"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const st = STATUS[r.status];
  const files = detail.data?.files ?? [];
  return (
    <li className="border-b border-line py-3 last:border-0" data-testid="request-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium" title={r.title}>{r.title}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {r.hasPassword && <Badge><IconLock className="h-3 w-3" />Password</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        <span>{r.uploads} {r.uploads === 1 ? "file" : "files"}, {sizeOf(r.bytesReceived)} of {sizeOf(r.maxTotalBytes)}</span>
        <span>{r.status === "open" || r.status === "full" ? "Open until" : "Ended"} {day(r.expiresAt)}</span>
        {r.createdByName && <span className="max-sm:hidden">By {r.createdByName}</span>}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide files" : "Files"}</Button>
          {r.status === "closed" || r.status === "paused" ? <Button size="sm" variant="ghost" onClick={() => toggle.mutate(true)} loading={toggle.isPending}>Reopen</Button>
            : r.status !== "expired" && <Button size="sm" variant="ghost" onClick={() => toggle.mutate(false)} loading={toggle.isPending}>Close</Button>}
        </span>
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-fill px-3 py-1 text-sm">
          {detail.isLoading ? <div className="space-y-2 py-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-1/3" /></div>
            : detail.isError ? <LoadErrorInline onRetry={() => detail.refetch()} />
              : !files.length ? <p className="py-3 text-muted">No files yet. You'll get a notification when the first one arrives.</p>
                : <ul>{files.map((f) => <FileRow key={f.id} f={f} onDelete={setDel} />)}</ul>}
          <p className="pb-2 pt-1 text-[12px] text-muted">{allowedLabel(r.allowed)} · files up to {sizeOf(r.maxFileBytes)} · kept {r.keepDays} days after they arrive{r.folder ? ` · folder ${r.folder}` : ""}</p>
        </div>
      )}
      <Dialog open={!!del} onClose={() => setDel(null)} title="Delete this file?" description={del ? `${del.name} will be deleted for good. The person who sent it won't be told.` : undefined}
        footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => del && remove.mutate(del)}>Delete file</Button></>} />
    </li>
  );
}

export function RequestsTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focus = params.get("request");
  const list = useQuery({ queryKey: ["tools-requests"], queryFn: () => api.get<{ requests: FileRequestInfo[]; usage: KeptUsage }>("/tools/requests") });
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [folder, setFolder] = useState("");
  const [fileCap, setFileCap] = useState(String(25 * MB));
  const [totalCap, setTotalCap] = useState(String(100 * MB));
  const [groups, setGroups] = useState<RequestTypeGroup[]>([]);
  const [maxUploads, setMaxUploads] = useState("");
  const [days, setDays] = useState("14");
  const [keep, setKeep] = useState("30");
  const [password, setPassword] = useState("");
  const [brand, setBrand] = useState(true);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<FileRequestInfo | null>(null);

  const create = async () => {
    setError(null); setBusy(true);
    try {
      const r = await api.post<{ request: FileRequestInfo }>("/tools/requests", {
        title, message: message || null, folder: folder || null, password: password || null, maxFileBytes: Number(fileCap), maxTotalBytes: Number(totalCap),
        allowed: groups.length ? groups.join(",") : "any", maxUploads: maxUploads ? Number(maxUploads) : null, keepDays: Number(keep), expiresInDays: Number(days), showBrand: brand, notify,
      });
      setMade(r.request);
      void qc.invalidateQueries({ queryKey: ["tools-requests"] });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const reset = () => { setMade(null); setTitle(""); setMessage(""); setPassword(""); setGroups([]); setMaxUploads(""); };
  const toggleGroup = (g: RequestTypeGroup) => setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));
  const tooBig = Number(fileCap) > Number(totalCap);

  return (
    <div className="space-y-5" data-testid="requests-tab">
      <Card className="space-y-4 p-5">
        {made?.url ? (
          <div className="space-y-3" data-testid="request-made">
            <p className="font-medium">Your request link is ready</p>
            <div className="flex gap-2 max-sm:flex-col">
              <Input readOnly value={made.url} className={field} aria-label="Request link" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(made.url!); toast.success("Link copied"); }}><IconCopy className="h-4 w-4" />Copy</Button>
              <Button onClick={() => attachToNewEmail(navigate, {}, { subject: made.title, text: `Hi,\n\nYou can send me the files here: ${made.url}\n\nNo account needed. The link works until ${day(made.expiresAt)}.\n` })}><IconMail className="h-4 w-4" />Email it</Button>
            </div>
            <p className="text-[13px] text-muted">This is the only time the full link is shown. Anyone with it can send files until {day(made.expiresAt)}.</p>
            <Button variant="ghost" size="sm" onClick={reset}>Make another request</Button>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><IconUpload className="h-4 w-4" /></span>
              <div><p className="font-medium">Ask someone for files</p><p className="text-[13px] text-muted">They open your link and upload, no account needed. You get a notification when files arrive.</p></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-[13px] font-medium sm:col-span-2">Name of the request
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Tax documents for 2026" data-testid="request-title" />
              </label>
              <label className="space-y-1 text-[13px] font-medium sm:col-span-2">Message to them <span className="font-normal text-muted">(optional)</span>
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={3} placeholder="Please send last year's statements and your ID." />
              </label>
              <label className="space-y-1 text-[13px] font-medium">Each file up to
                <Select value={fileCap} onChange={(e) => setFileCap(e.target.value)}>{REQUEST_FILE_CAPS.map((n) => <option key={n} value={n}>{sizeOf(n)}</option>)}</Select>
              </label>
              <label className="space-y-1 text-[13px] font-medium">All files together up to
                <Select value={totalCap} onChange={(e) => setTotalCap(e.target.value)}>{REQUEST_TOTAL_CAPS.map((n) => <option key={n} value={n}>{sizeOf(n)}</option>)}</Select>
              </label>
              <fieldset className="space-y-1.5 sm:col-span-2">
                <legend className="text-[13px] font-medium">Kinds of files <span className="font-normal text-muted">(none picked means any file except programs)</span></legend>
                <div className="flex flex-wrap gap-2">
                  {REQUEST_TYPE_KEYS.map((g) => (
                    <button key={g} type="button" aria-pressed={groups.includes(g)} onClick={() => toggleGroup(g)}
                      className={`h-8 rounded-full border px-3 text-[13px] transition-colors max-sm:min-h-11 ${groups.includes(g) ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line-strong text-fg hover:bg-hover"}`}>{REQUEST_TYPE_GROUPS[g].label}</button>
                  ))}
                </div>
              </fieldset>
              <label className="space-y-1 text-[13px] font-medium">Link works for
                <Select value={days} onChange={(e) => setDays(e.target.value)}>{REQUEST_EXPIRY_CHOICES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}</Select>
              </label>
              <label className="space-y-1 text-[13px] font-medium">Keep files for
                <Select value={keep} onChange={(e) => setKeep(e.target.value)}>{REQUEST_KEEP_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
              </label>
              <label className="space-y-1 text-[13px] font-medium">Most files <span className="font-normal text-muted">(optional)</span>
                <Input type="number" min={1} max={500} value={maxUploads} onChange={(e) => setMaxUploads(e.target.value)} placeholder="No limit" />
              </label>
              <label className="space-y-1 text-[13px] font-medium">Folder name <span className="font-normal text-muted">(optional)</span>
                <Input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={60} placeholder="Clients, Acme" />
              </label>
              <label className="space-y-1 text-[13px] font-medium sm:col-span-2">Password <span className="font-normal text-muted">(optional, tell it to them another way)</span>
                <Input type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={brand} onChange={(e) => setBrand(e.target.checked)} />Show my workspace logo and colour on the page</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Email me when files arrive</label>
            </div>
            {tooBig && <p className="text-sm text-warn">Each file can't be bigger than all files together.</p>}
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button onClick={create} loading={busy} disabled={!title.trim() || tooBig || (password.length > 0 && password.length < 4)} data-testid="request-create"><IconFileUp className="h-4 w-4" />Create request link</Button>
          </>
        )}
      </Card>
      <section>
        <div className="mb-2 flex items-center justify-between gap-4">
          <h2 className="text-[15px] font-semibold">Your requests</h2>
          {list.data && <div className="w-48 text-right text-[12px] text-muted"><Meter value={list.data.usage.bytes} max={list.data.usage.cap} label="Storage for shared files" /><span>{sizeOf(list.data.usage.bytes)} of {sizeOf(list.data.usage.cap)} used</span></div>}
        </div>
        <Card className="px-5 py-1">
          {list.isLoading ? <div className="space-y-3 py-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/3" /></div>
            : list.isError ? <LoadErrorInline onRetry={() => list.refetch()} />
              : !list.data?.requests.length ? <EmptyState className="py-8" icon={<IconUpload />} title="No file requests yet" body="Make one above and send the link. Files people send show up here." />
                : <ul>{list.data.requests.map((r) => <RequestRow key={r.id} r={r} startOpen={focus === r.id} />)}</ul>}
        </Card>
        <p className="mt-3 text-[12px] text-muted">Received files count toward your workspace's storage for shared files and are deleted after the time you chose. Programs and installers are never accepted.</p>
      </section>
    </div>
  );
}
