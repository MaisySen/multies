/**
 * Tools P2 (5, flag batch): "Run on all attachments" in a thread. Pick a tool; it runs once per matching attachment
 * (tools that take several files, such as merge, run once on all of them), each result shows as it lands, then
 * Download all (one ZIP made in the browser) or Attach to a new email. Uses POST /api/tools/jobs/from-attachments,
 * so nothing is downloaded and uploaded again. Each job counts as one tool run.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { zipSync } from "fflate";
import { toast } from "sonner";
import { IconCheckCircle, IconDownload, IconFile, IconMail, IconWrench } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Badge } from "@/web/components/ui/misc";
import { useConfig } from "@/web/lib/queries";
import { batchTools, toolTakes, type ToolDef, type ToolJob, type ToolsInfo } from "@/shared/tools";
import { attachmentJob, jobFailure, waitForJob } from "@/web/lib/tool-jobs";
import { attachToNewEmail } from "@/web/lib/compose-files"; // Tools P2
import { ORDER, lookOf } from "./tool-directory"; // Tools UX
import { ToolIcon } from "./tool-icon"; // Tools UX: the one "Attach to a new email" path
import { useToolsInfo } from "./use-tools-info";
import { OptionField, defaultsFor, optionsProblem, optionsToSend, resultLine, sizeOf, visibleOptions } from "./tool-fields";

export interface BatchAttachment { id: string; filename: string; available?: boolean }
type Row = { key: string; label: string; ids: string[]; state: "waiting" | "working" | "done" | "failed"; job?: ToolJob; error?: string };

/** One job per file, or one job for all files when the tool takes several (merge, images to PDF, scan, merge spreadsheets). */
export function planBatch(tool: Pick<ToolDef, "maxFiles" | "minFiles" | "label">, files: BatchAttachment[]): { label: string; ids: string[] }[] {
  if (!files.length) return [];
  if (tool.maxFiles === 1) return files.map((f) => ({ label: f.filename, ids: [f.id] }));
  const max = tool.maxFiles === "plan" ? files.length : tool.maxFiles;
  return [{ label: `${files.length} files into one`, ids: files.slice(0, max).map((f) => f.id) }];
}

/** Unique names inside one ZIP ("report.pdf", "report (2).pdf"). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(/(\.[A-Za-z0-9]{1,8})?$/, (ext) => ` (${c})${ext}`);
  });
}

const POOL = 2;

export function BatchTools({ attachments }: { attachments: BatchAttachment[] }) {
  const config = useConfig();
  const files = attachments.filter((a) => a.available !== false);
  const [open, setOpen] = useState(false);
  const info = useToolsInfo(files.length >= 2);
  if (!config.data?.tools || files.length < 2 || !info.data?.features.includes("batch")) return null;
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm" data-testid="batch-bar">
        <IconWrench className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-muted">{files.length} attachments in this conversation</span>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="batch-open">Run on all attachments</Button>
      </div>
      {open && <BatchDialog info={info.data} files={files} onClose={() => setOpen(false)} />}
    </>
  );
}

function BatchDialog({ info, files, onClose }: { info: ToolsInfo; files: BatchAttachment[]; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tools = useMemo(() => batchTools(info.features, info.tools).filter((t) => files.some((f) => toolTakes(t, f.filename))), [info, files]);
  const sortedTools = useMemo(() => [...tools].sort((a, b) => (ORDER.indexOf(a.op) + 1 || 99) - (ORDER.indexOf(b.op) + 1 || 99)), [tools]);
  const [op, setOp] = useState(sortedTools[0]?.op ?? "");
  const tool = tools.find((t) => t.op === op);
  const [options, setOptions] = useState<Record<string, string>>(() => defaultsFor(sortedTools[0]));
  const matching = tool ? files.filter((f) => toolTakes(tool, f.filename)) : [];
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const chosen = matching.filter((f) => !skip.has(f.id));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [zipping, setZipping] = useState(false);
  const running = !!rows && rows.some((r) => r.state === "waiting" || r.state === "working");
  const done = (rows ?? []).filter((r) => r.state === "done" && r.job?.downloadUrl).map((r) => r.job!);
  const problem = tool ? optionsProblem(tool, options) : null;
  const plan = tool ? planBatch(tool, chosen) : [];

  const pickTool = (next: ToolDef) => { setOp(next.op); setOptions(defaultsFor(next)); setSkip(new Set()); };

  const run = async () => {
    if (!tool || !plan.length) return;
    const sent = optionsToSend(tool, options);
    const list: Row[] = plan.map((p, i) => ({ key: String(i), label: p.label, ids: p.ids, state: "waiting" }));
    setRows(list);
    const update = (key: string, patch: Partial<Row>) => setRows((cur) => cur?.map((r) => (r.key === key ? { ...r, ...patch } : r)) ?? cur);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const r = list[next++];
        update(r.key, { state: "working" });
        try {
          const job = await attachmentJob(tool.op, r.ids, sent);
          const fin = await waitForJob(job.token, (j) => update(r.key, { job: j }));
          if (fin.status === "done") update(r.key, { state: "done", job: fin });
          else update(r.key, { state: "failed", error: jobFailure(fin) });
        } catch (err) {
          update(r.key, { state: "failed", error: (err as Error).message });
          // A plan limit stops the rest: they would be refused the same way.
          if ((err as { code?: string }).code === "plan_limit") { for (const x of list.slice(next)) update(x.key, { state: "failed", error: "Not run: the plan limit was reached." }); next = list.length; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, list.length) }, worker));
    void qc.invalidateQueries({ queryKey: ["tools"] });
  };

  const downloadAll = async () => {
    setZipping(true);
    try {
      const names = uniqueNames(done.map((j) => j.name));
      const entries: Record<string, Uint8Array> = {};
      for (const [i, j] of done.entries()) {
        const res = await fetch(j.downloadUrl!, { credentials: "same-origin" });
        if (!res.ok) throw new Error("A result has expired. Run the tools again.");
        entries[names[i]] = new Uint8Array(await res.arrayBuffer());
      }
      const zip = zipSync(entries, { level: 0 });
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${tool?.label ?? "Tools"} results.zip`.replace(/[^A-Za-z0-9 ._()-]+/g, " ");
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast.error((err as Error).message);
    } finally { setZipping(false); }
  };

  return (
    <Dialog open onClose={() => { if (!running) onClose(); }} title="Run on all attachments" className="sm:max-w-2xl"
      description={rows ? undefined : "Pick a tool. It runs on every attachment it can take, and each result is ready to download or send."}
      footer={rows ? (
        <div className="flex flex-wrap items-center justify-end gap-2" data-testid="batch-actions">
          {done.length > 1 && <Button type="button" variant="secondary" disabled={running || zipping} onClick={downloadAll} data-testid="batch-download-all"><IconDownload className="h-4 w-4" aria-hidden />{zipping ? "Making the ZIP" : "Download all"}</Button>}
          {done.length > 0 && <Button type="button" variant="secondary" disabled={running} onClick={() => attachToNewEmail(navigate, { jobs: done })} data-testid="batch-attach"><IconMail className="h-4 w-4" aria-hidden />Attach to a new email</Button>}
          <Button type="button" disabled={running} onClick={onClose}>{running ? "Working" : "Done"}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!tool || !plan.length || !!problem} onClick={run} data-testid="batch-run">
            {!tool ? "Run" : plan.length === 1 && plan[0].ids.length > 1 ? `${tool.label}: ${plan[0].ids.length} files into one` : `Run on ${plan.length} ${plan.length === 1 ? "file" : "files"}`}
          </Button>
        </div>
      )}>
      {!rows ? (
        tools.length === 0 ? (
          <p className="text-sm text-muted">No tool takes these attachments.</p>
        ) : (
          <div className="space-y-4" data-testid="batch-pick">
            {/* Tools UX: a grid of tools with their icons, in the Tools page's order, instead of a wall of words. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tool">
              {sortedTools.map((t) => {
                const look = lookOf(t.op);
                return (
                  <button key={t.op} type="button" role="radio" aria-checked={t.op === op} onClick={() => pickTool(t)} data-testid={`batch-tool-${t.op}`}
                    className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[13.5px] max-sm:min-h-11 ${t.op === op ? "border-brand bg-brand/5 font-semibold ring-1 ring-brand" : "border-line hover:bg-hover"}`}>
                    {look && <ToolIcon e={look} size="sm" />}<span className="min-w-0 flex-1 truncate">{look?.name ?? t.label}</span>
                  </button>
                );
              })}
            </div>
            {tool && (
              <>
                <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line" aria-label="Attachments to use">
                  {files.map((f) => {
                    const takes = toolTakes(tool, f.filename);
                    return (
                      <li key={f.id}>
                        <label className={`flex items-center gap-3 px-3 py-2 text-sm max-sm:min-h-11 ${takes ? "" : "opacity-50"}`}>
                          <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" disabled={!takes} checked={takes && !skip.has(f.id)}
                            onChange={() => setSkip((cur) => { const n = new Set(cur); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
                          <IconFile className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                          {!takes && <span className="shrink-0 text-[12px] text-muted">Not for this tool</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {visibleOptions(tool, options).length > 0 && (
                  <div className="space-y-3">
                    {visibleOptions(tool, options).map((o) => <OptionField key={o.name} idPrefix="batch-opt" o={o} value={options[o.name] ?? ""} disabled={false} onChange={(v) => setOptions((cur) => ({ ...cur, [o.name]: v }))} />)}
                  </div>
                )}
                {problem && <p className="text-[13px] text-muted">{problem}</p>}
                <p className="text-[12.5px] text-muted">{plan.length === 1 ? "Uses 1 tool run." : `Uses ${plan.length} tool runs, one per file.`}{tool.note ? ` ${tool.note}` : ""}</p>
              </>
            )}
          </div>
        )
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="batch-results" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm" data-testid="batch-row" data-state={r.state}>
              {r.state === "done" ? <IconCheckCircle className="h-4 w-4 shrink-0 text-ok" aria-hidden /> : <IconFile className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.state === "done" && r.job ? r.job.name : r.label}</div>
                <div className="text-[12.5px] text-muted">
                  {r.state === "waiting" ? "Waiting" : r.state === "working" ? (r.job?.progress ? `Page ${Math.min(r.job.progress.done + 1, r.job.progress.total)} of ${r.job.progress.total}` : "Working on it")
                    : r.state === "failed" ? r.error : [r.job && resultLine(r.job), r.job?.bytes ? sizeOf(r.job.bytes) : null].filter(Boolean).join(" ")}
                </div>
              </div>
              {r.state === "failed" && <Badge tone="bad">Didn't work</Badge>}
              {r.state === "done" && r.job?.downloadUrl && (
                <a href={r.job.downloadUrl} download={r.job.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] hover:bg-hover max-sm:h-11" aria-label={`Download ${r.job.name}`}><IconDownload className="h-4 w-4" aria-hidden />Download</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
