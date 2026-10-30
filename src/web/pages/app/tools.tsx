/**
 * Tools P1: document tools inside Multies. Pick a tool, drop files, and the result comes back to download.
 * The work runs on Multies' own document engine (Singapore); files are deleted from it within an hour.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { IconArrowDown, IconArrowUp, IconClose, IconDownload, IconFile, IconFileUp, IconWrench } from "@/web/components/ui/icon";
import { api, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, Meter, PageHeader, Skeleton } from "@/web/components/ui/misc";
import type { ToolDef, ToolJob, ToolOp, ToolsInfo } from "@/shared/tools";

type Phase = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "working"; job: ToolJob; slow: boolean } | { kind: "done"; job: ToolJob } | { kind: "failed"; message: string; limit?: boolean };

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : mb(n));

/** Uploads with progress (fetch has no upload progress). The upload header marks it as coming from this page. */
function send(op: ToolOp, files: File[], onPct: (pct: number) => void): Promise<ToolJob> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/tools/jobs?op=${op}&files=${files.length}&name=${encodeURIComponent(files[0]?.name ?? "")}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(Object.assign(new Error("Couldn't reach Multies. Check your connection and try again."), { status: 0 }));
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string } } & Partial<ToolJob> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 202) resolve(body as ToolJob);
      else reject(Object.assign(new Error(body.error?.message || "That didn't work. Try again."), { status: xhr.status, code: body.error?.code }));
    };
    xhr.send(fd);
  });
}

function ToolCard({ tool, active, onPick }: { tool: ToolDef; active: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} aria-pressed={active} data-testid={`tool-${tool.op}`}
      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${active ? "border-brand bg-brand/5" : "border-line bg-surface hover:bg-hover"}`}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#0071E3] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden><IconFile /></span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{tool.label}</span>
        <span className="mt-0.5 block text-[13px] text-muted">{tool.blurb}</span>
      </span>
    </button>
  );
}

export function ToolsPage() {
  const config = useConfig();
  const qc = useQueryClient();
  const enabled = !!config.data?.tools;
  const info = useQuery({ queryKey: ["tools"], enabled, queryFn: () => api.get<ToolsInfo>("/tools") });
  const [params] = useSearchParams();
  const asked = params.get("op");
  const [op, setOp] = useState<ToolOp>(asked === "merge" || asked === "convert" ? asked : "compress");
  useEffect(() => { if (asked === "compress" || asked === "merge" || asked === "convert") { setOp(asked); setFiles([]); setPhase({ kind: "idle" }); } }, [asked]);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tool = info.data?.tools.find((t) => t.op === op);
  const limits = info.data?.limits;
  const maxFiles = tool ? (tool.maxFiles === "plan" ? limits?.maxMergeFiles ?? 10 : tool.maxFiles) : 1;
  const total = files.reduce((n, f) => n + f.size, 0);
  const busy = phase.kind === "uploading" || phase.kind === "working";

  const pick = (next: ToolOp) => { if (busy) return; setOp(next); setFiles([]); setPhase({ kind: "idle" }); };
  const add = useCallback((list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = [...list];
    setPhase({ kind: "idle" });
    setFiles((cur) => (maxFiles === 1 ? incoming.slice(0, 1) : [...cur, ...incoming].slice(0, maxFiles)));
  }, [maxFiles]);
  const move = (i: number, by: number) => setFiles((cur) => { const n = [...cur]; const j = i + by; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i: number) => setFiles((cur) => cur.filter((_, k) => k !== i));
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (!busy) add(e.dataTransfer.files); };

  // Poll the job until it is done or failed. Polling costs the server no database read.
  useEffect(() => {
    if (phase.kind !== "working") return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const j = await api.get<ToolJob>(`/tools/jobs/${encodeURIComponent(phase.job.token)}`);
        if (stop) return;
        if (j.status === "done") { setPhase({ kind: "done", job: j }); qc.invalidateQueries({ queryKey: ["tools"] }); return; }
        if (j.status === "failed") { setPhase({ kind: "failed", message: j.error ?? "The file could not be processed." }); return; }
        if (j.status === "expired") { setPhase({ kind: "failed", message: "This file has expired. Run the tool again." }); return; }
        setPhase((p) => (p.kind === "working" ? { ...p, slow: Date.now() - started > 8000 } : p));
      } catch (err) {
        if (stop) return;
        if ((err as { status?: number }).status !== 503) { setPhase({ kind: "failed", message: errorMessage(err) }); return; }
      }
      if (!stop) setTimeout(tick, Date.now() - started > 20_000 ? 3000 : 1200);
    };
    const t = setTimeout(tick, 900);
    return () => { stop = true; clearTimeout(t); };
  }, [phase, qc]);

  const run = async () => {
    if (!tool || files.length < tool.minFiles) return;
    setPhase({ kind: "uploading", pct: 0 });
    try {
      const job = await send(op, files, (pct) => setPhase({ kind: "uploading", pct }));
      setPhase({ kind: "working", job, slow: false });
    } catch (err) {
      const e = err as { message: string; code?: string; status?: number };
      setPhase({ kind: "failed", message: e.message, limit: e.code === "plan_limit" || e.status === 413 });
    }
  };
  const reset = () => { setFiles([]); setPhase({ kind: "idle" }); };

  if (config.isLoading) return <div className="mx-auto max-w-4xl space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-40 w-full" /></div>;
  if (!enabled || info.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState icon={<IconWrench />} title="Tools are not on for this workspace" body="Document tools are not available here yet." />
      </div>
    );
  }

  const tooBig = !!limits && total > limits.maxBytes;
  const ready = !!tool && files.length >= tool.minFiles && !tooBig && !busy;
  const left = limits && info.data ? Math.max(0, limits.runsMonthly - info.data.usage.month) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="tools-page">
      <PageHeader title="Tools" description="Compress, merge and convert documents without leaving Multies. Files are processed on our document server in Singapore and deleted after 1 hour." />

      <div className="grid gap-3 sm:grid-cols-3" role="group" aria-label="Choose a tool">
        {info.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />) : info.data?.tools.map((t) => <ToolCard key={t.op} tool={t} active={t.op === op} onPick={() => pick(t.op)} />)}
      </div>

      {tool && (
        <Card className="space-y-4 p-4">
          <div
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragging ? "border-brand bg-brand/5" : "border-line"}`}
            data-testid="tools-drop"
          >
            <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface text-[#0071E3] shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_2px_6px_rgb(0_0_0/0.08)] [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconFileUp /></span>
            <p className="text-[15px] font-medium">Drop {tool.acceptLabel} here</p>
            <p className="mt-1 text-[13px] text-muted">Up to {limits ? mb(limits.maxBytes) : "20 MB"} in all{tool.maxFiles === "plan" ? `, up to ${maxFiles} files` : ""}.</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3" disabled={busy} onClick={() => input.current?.click()}>Choose {maxFiles === 1 ? "a file" : "files"}</Button>
            <input ref={input} type="file" className="sr-only" accept={tool.accept} multiple={maxFiles > 1} data-testid="tools-input" aria-label={`Choose ${tool.acceptLabel}`}
              onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          </div>

          {files.length > 0 && (
            <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Files to use">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {files.length > 1 && <span className="w-5 text-right text-subtle tabular-nums">{i + 1}</span>}
                  <IconFile className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-[12.5px] text-muted tabular-nums">{sizeOf(f.size)}</span>
                  {files.length > 1 && (
                    <>
                      <Button type="button" variant="ghost" size="icon" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.name} up`}><IconArrowUp className="h-4 w-4" /></Button>
                      <Button type="button" variant="ghost" size="icon" disabled={busy || i === files.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.name} down`}><IconArrowDown className="h-4 w-4" /></Button>
                    </>
                  )}
                  <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => remove(i)} aria-label={`Remove ${f.name}`}><IconClose className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}

          {tooBig && limits && <p className="text-sm text-danger" role="alert">These files add up to {mb(total)}. Your plan allows {mb(limits.maxBytes)} a run.</p>}
          {tool.op === "merge" && files.length === 1 && <p className="text-[13px] text-muted">Add one more PDF to merge. The order above is the order in the result.</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={run} disabled={!ready} data-testid="tools-run">{tool.label}</Button>
            {phase.kind === "uploading" && <span className="text-sm text-muted" role="status">Uploading {phase.pct}%</span>}
            {phase.kind === "working" && <span className="text-sm text-muted" role="status">{phase.slow ? "Still working. Large files take a little longer." : "Working on it"}</span>}
          </div>
        </Card>
      )}

      {phase.kind === "done" && phase.job.downloadUrl && (
        <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="tools-result">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#34C759] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden><IconFile /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{phase.job.name}</div>
            <div className="text-[12.5px] text-muted">{phase.job.bytes ? sizeOf(phase.job.bytes) : "Ready"}{op === "compress" && phase.job.bytes && files[0] ? `, was ${sizeOf(files[0].size)}` : ""}. Download within an hour.</div>
          </div>
          <a href={phase.job.downloadUrl} download={phase.job.name} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg hover:opacity-90" data-testid="tools-download"><IconDownload className="h-4 w-4" aria-hidden />Download</a>
          <Button type="button" variant="ghost" onClick={reset}>Start again</Button>
        </Card>
      )}

      {phase.kind === "failed" && (
        <Card className="flex flex-wrap items-center gap-3 p-4" role="alert" data-testid="tools-error">
          <Badge tone={phase.limit ? "warn" : "bad"}>{phase.limit ? "Plan limit" : "Didn't work"}</Badge>
          <p className="min-w-0 flex-1 text-sm">{phase.message}</p>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>Try again</Button>
        </Card>
      )}

      {limits && info.data && (
        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Tool runs this month</span>
            <span className="text-muted tabular-nums">{info.data.usage.month} of {limits.runsMonthly}</span>
          </div>
          <Meter value={info.data.usage.month} max={limits.runsMonthly} label="Tool runs this month" />
          <p className="text-[12.5px] text-muted">{left === 0 ? "None left this month. They reset on the 1st." : `${left} left this month, up to ${limits.runsDaily} a day.`}</p>
        </Card>
      )}
    </div>
  );
}
