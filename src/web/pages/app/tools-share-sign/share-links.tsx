/**
 * Tools P2: secure share links. Send a big file as a link with an expiry (1 hour to 30 days), an optional password
 * and download limit, and see each download. The file comes from an upload, a Tools result (?result=<token>) or a
 * mail attachment (?attachment=<id>). Hidden unless GET /api/tools lists the "share" feature.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { peekCarried, takeCarried } from "@/web/lib/carried-files";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Meter, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { IconCopy, IconFileUp, IconLink, IconLock, IconMail, IconTrash } from "@/web/components/ui/icon";
import { SHARE_EXPIRY_CHOICES, type KeptUsage, type ShareLinkInfo } from "@/shared/share-sign";
import type { ToolsInfo } from "@/shared/tools";
import { attachToNewEmail } from "@/web/lib/compose-files";

const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const STATUS: Record<ShareLinkInfo["status"], { label: string; tone: "ok" | "neutral" | "warn" | "bad" }> = {
  active: { label: "Active", tone: "ok" }, expired: { label: "Expired", tone: "neutral" }, revoked: { label: "Turned off", tone: "neutral" }, used_up: { label: "Used up", tone: "warn" },
};

/** Opens a new email with the link in it, through the one "Attach to a new email" path (lib/compose-files). */
export function composeWithLink(navigate: (to: string) => void, name: string, url: string) {
  const text = `Hi,\n\nHere is ${name}: ${url}\n`;
  attachToNewEmail(navigate, {}, { subject: name, text });
}

function upload(file: File, fields: Record<string, string>): Promise<{ link: ShareLinkInfo }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/tools/share");
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.onerror = () => reject(new Error("Couldn't reach Multies. Check your connection and try again."));
    xhr.onload = () => {
      let body: { error?: { message?: string } } & Partial<{ link: ShareLinkInfo }> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201 && body.link) resolve(body as { link: ShareLinkInfo });
      else reject(new Error(body.error?.message || "That didn't work. Try again."));
    };
    xhr.send(fd);
  });
}

function LinkRow({ l }: { l: ShareLinkInfo }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: ["tools-share", l.id], enabled: open, queryFn: () => api.get<ShareLinkInfo>(`/tools/share/${l.id}`) });
  const revoke = useMutation({
    mutationFn: () => api.del<ShareLinkInfo>(`/tools/share/${l.id}`),
    onSuccess: () => { toast.success("Link turned off"); void qc.invalidateQueries({ queryKey: ["tools-share"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const st = STATUS[l.status];
  return (
    <li className="border-b border-line py-3 last:border-0" data-testid="share-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {l.hasPassword && <Badge><IconLock className="h-3 w-3" />Password</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        <span>{sizeOf(l.bytes)}</span>
        <span>{l.downloads} {l.downloads === 1 ? "download" : "downloads"}{l.maxDownloads !== null ? ` of ${l.maxDownloads}` : ""}</span>
        <span>{l.status === "active" ? "Expires" : "Ended"} {when(l.expiresAt)}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide downloads" : "Downloads"}</Button>
          {l.status === "active" && <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} loading={revoke.isPending}><IconTrash className="h-3.5 w-3.5" />Turn off</Button>}
        </span>
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-fill p-3 text-[13px]">
          {detail.isLoading ? <Skeleton className="h-4 w-40" /> : !detail.data?.log?.length ? <p className="text-muted">No downloads yet.</p> : (
            <table className="w-full"><thead><tr className="text-left text-muted"><th className="py-1 font-medium">When</th><th className="font-medium">Country</th><th className="font-medium">Browser</th></tr></thead>
              <tbody>{detail.data.log.map((d, i) => <tr key={i}><td className="py-1">{when(d.at)}</td><td>{d.country ?? "Unknown"}</td><td>{d.agent ?? "Unknown"}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
    </li>
  );
}

export function ShareLinksPage() {
  const config = useConfig();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const tools = useQuery({ queryKey: ["tools"], enabled: !!config.data?.tools, queryFn: () => api.get<ToolsInfo>("/tools") });
  const on = !!tools.data?.features?.includes("share");
  const list = useQuery({ queryKey: ["tools-share"], enabled: on, queryFn: () => api.get<{ links: ShareLinkInfo[]; usage: KeptUsage }>("/tools/share") });
  const result = params.get("result");
  const attachment = params.get("attachment");
  const fromName = params.get("name") ?? "";
  const [file, setFile] = useState<File | null>(() => (result || attachment ? null : peekCarried()[0] ?? null));
  useEffect(() => { takeCarried(); }, []);
  const [expires, setExpires] = useState(String(7 * 86_400));
  const [password, setPassword] = useState("");
  const [limit, setLimit] = useState("");
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<ShareLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (config.data && (!config.data.tools || (tools.data && !on))) return <EmptyState title="Share links are not available" body="Ask your workspace admin about Tools." />;

  const source = result ? "result" : attachment ? "attachment" : file ? "upload" : null;
  const create = async () => {
    setError(null); setBusy(true);
    try {
      const opts = { expiresInSeconds: Number(expires), password: password || null, maxDownloads: limit ? Number(limit) : null, notifyFirst: notify };
      const r = source === "upload" && file
        ? await upload(file, { expiresInSeconds: expires, password, maxDownloads: limit, notifyFirst: notify ? "true" : "false" })
        : await api.post<{ link: ShareLinkInfo }>("/tools/share/from", source === "result" ? { source: "result", token: result, ...opts } : { source: "attachment", attachmentId: attachment, ...opts });
      setMade(r.link);
      void qc.invalidateQueries({ queryKey: ["tools-share"] });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const drop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); };
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 max-sm:p-4">
      <PageHeader eyebrow="Tools" title="Share links" description="Send a big file as a link that expires. Add a password or a download limit, and see every download." />
      <Card className="space-y-4 p-5">
        {made?.url ? (
          <div className="space-y-3" data-testid="share-made">
            <p className="font-medium">Your link is ready</p>
            <div className="flex gap-2 max-sm:flex-col">
              <input readOnly value={made.url} className={field} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(made.url!); toast.success("Link copied"); }}><IconCopy className="h-4 w-4" />Copy</Button>
              <Button onClick={() => composeWithLink(navigate, made.name, made.url!)}><IconMail className="h-4 w-4" />Email it</Button>
            </div>
            <p className="text-[13px] text-muted">This is the only time the full link is shown. It expires {when(made.expiresAt)}.</p>
            <Button variant="ghost" size="sm" onClick={() => { setMade(null); setFile(null); setPassword(""); }}>Share another file</Button>
          </div>
        ) : (
          <>
            {source === "result" || source === "attachment" ? (
              <div className="flex items-center gap-3 rounded-lg bg-fill px-3 py-2.5 text-sm"><IconLink className="h-4 w-4 text-muted" /><span className="truncate">{fromName || "Chosen file"}</span><span className="text-muted">{source === "result" ? "from Tools" : "from your mail"}</span></div>
            ) : (
              <div onDragOver={(e) => e.preventDefault()} onDrop={drop} className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
                <IconFileUp className="h-6 w-6 text-muted" />
                {file ? <p className="text-sm"><span className="font-medium">{file.name}</span> <span className="text-muted">{sizeOf(file.size)}</span></p> : <p className="text-sm text-muted">Drop a file here, up to 25 MB</p>}
                <input ref={input} type="file" className="hidden" data-testid="share-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <Button variant="outline" size="sm" onClick={() => input.current?.click()}>{file ? "Choose another file" : "Choose a file"}</Button>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-[13px] font-medium">Expires after
                <Select value={expires} onChange={(e) => setExpires(e.target.value)} data-testid="share-expiry">
                  {SHARE_EXPIRY_CHOICES.map((c) => <option key={c.seconds} value={c.seconds}>{c.label}</option>)}
                </Select>
              </label>
              <label className="space-y-1 text-[13px] font-medium">Download limit <span className="font-normal text-muted">(optional)</span>
                <input className={field} type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" />
              </label>
              <label className="space-y-1 text-[13px] font-medium sm:col-span-2">Password <span className="font-normal text-muted">(optional, tell it to them another way)</span>
                <input className={field} type="password" autoComplete="new-password" minLength={4} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Email me when it is first downloaded</label>
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button onClick={create} loading={busy} disabled={!source || (password.length > 0 && password.length < 4)} data-testid="share-create"><IconLink className="h-4 w-4" />Create link</Button>
          </>
        )}
      </Card>
      <section>
        <div className="mb-2 flex items-center justify-between gap-4">
          <h2 className="text-[15px] font-semibold">Your links</h2>
          {list.data && <div className="w-48 text-right text-[12px] text-muted"><Meter value={list.data.usage.bytes} max={list.data.usage.cap} label="Storage for shared files" /><span>{sizeOf(list.data.usage.bytes)} of {sizeOf(list.data.usage.cap)} used</span></div>}
        </div>
        <Card className="px-5 py-1">
          {list.isLoading ? <div className="py-4"><Skeleton className="h-5 w-2/3" /></div> : !list.data?.links.length ? <p className="py-6 text-center text-sm text-muted">No share links yet.</p> : <ul>{list.data.links.map((l) => <LinkRow key={l.id} l={l} />)}</ul>}
        </Card>
        <p className="mt-3 text-[12px] text-muted">Shared files are deleted when the link expires or is turned off. The download log keeps the time, the country and the browser, never the full address.</p>
      </section>
    </div>
  );
}
