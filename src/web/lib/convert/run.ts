/**
 * R78 Convert hub: runs a planned route on one file, step by step. Browser steps run here (browser-ops, a lazy chunk);
 * an engine step is the same Tools job the Tools screens use (upload, wait, download), so limits, run counting and
 * clean up on the engine are unchanged. A step that turns one file into many (every page of a PDF) is followed by the
 * next step on each of them.
 */
import { formatDef, renameTo, type ConverterDef, type FormatId, type Route } from "@/shared/convert-routes";
import { toolDef, type ToolJob, type ToolOp, type ToolResultFacts } from "@/shared/tools";
import { jobFailure, uploadJob, waitForJob } from "@/web/lib/tool-jobs";

export type BrowserOps = typeof import("./browser-ops");
let ops: Promise<BrowserOps> | null = null;
/** The on device converters, loaded the first time a job needs them. */
export const loadOps = (): Promise<BrowserOps> => (ops ??= import("./browser-ops").catch((e) => { ops = null; throw e; }));

export interface Progress { fraction: number; label: string; where: "device" | "engine" }

/** How far a running engine job is (0 to 1): R86 jobs report done and total (pages, or seconds of video). */
export function jobFraction(j: ToolJob): number {
  const p = j.progress as ToolJob["progress"] | number | undefined;
  if (typeof p === "number") return Math.min(1, Math.max(0, p / 100));
  if (p && typeof p === "object" && p.total > 0) return Math.min(1, Math.max(0, p.done / p.total));
  return 0;
}

export interface EngineRun { file: File; result?: ToolResultFacts }

/**
 * One Tools job on one file (upload, wait, download), with progress: uploading is the first 40%, the engine's own
 * done and total the next 55%, the download the rest. `name` names the result (the engine's name when omitted).
 */
export async function runEngine(op: ToolOp, file: File, options: Record<string, string>, label: string, onProgress: (p: Progress) => void, opts: { name?: string; type?: string; signal?: AbortSignal } = {}): Promise<EngineRun> {
  const def = toolDef(op);
  onProgress({ fraction: 0, label: `Uploading for ${label}`, where: "engine" });
  const job = await uploadJob(op, [file], options, (pct) => onProgress({ fraction: (pct / 100) * 0.4, label: `Uploading for ${label}`, where: "engine" }), { def, signal: opts.signal });
  onProgress({ fraction: 0.4, label, where: "engine" });
  const done = await waitForJob(job.token, (j) => onProgress({ fraction: 0.4 + 0.55 * jobFraction(j), label, where: "engine" }), opts.signal);
  if (done.status !== "done" || !done.downloadUrl) throw new Error(jobFailure(done));
  onProgress({ fraction: 0.95, label: "Downloading the result", where: "engine" });
  const res = await fetch(done.downloadUrl, { credentials: "include" });
  if (!res.ok) throw new Error("The finished file could not be downloaded. Try again.");
  const blob = await res.blob();
  return { file: new File([blob], opts.name ?? done.name, { type: opts.type ?? (blob.type || "application/octet-stream") }), result: done.result };
}

async function engineStep(step: ConverterDef, file: File, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<File> {
  const label = `${formatDef(step.from).label} to ${formatDef(step.to).label} on the Multies engine`;
  const run = await runEngine(step.op as ToolOp, file, step.options ?? {}, label, onProgress, { name: renameTo(file.name, step.to), type: formatDef(step.to).mime, signal });
  return run.file;
}

/**
 * Runs every step of a route on one file. Returns the finished files (one, or one per page or sheet).
 * Progress is spread across the steps so the bar only moves forward.
 */
export async function runRoute(route: Route, file: File, opts: { quality?: number; signal?: AbortSignal; onProgress?: (p: Progress) => void } = {}): Promise<File[]> {
  const report = opts.onProgress ?? (() => {});
  let files = [file];
  const n = route.steps.length;
  for (let i = 0; i < n; i++) {
    const step = route.steps[i];
    if (opts.signal?.aborted) throw new Error("Stopped.");
    const span = (f: number) => (i + f) / n;
    const next: File[] = [];
    for (let k = 0; k < files.length; k++) {
      const each = (f: number) => span((k + f) / files.length);
      if (step.where === "engine") {
        next.push(await engineStep(step, files[k], (p) => report({ ...p, fraction: each(p.fraction) }), opts.signal));
      } else {
        const label = `${formatDef(step.from).label} to ${formatDef(step.to).label} on your device`;
        report({ fraction: each(0), label, where: "device" });
        const o = await loadOps();
        next.push(...await o.runBrowserStep(step, files[k], { quality: opts.quality, onProgress: (f) => report({ fraction: each(f), label, where: "device" }) }));
      }
    }
    files = next;
  }
  report({ fraction: 1, label: "Done", where: route.local ? "device" : "engine" });
  return files;
}

/** The name of a job's single download: the file itself, or a ZIP named after the source when there are several. */
export function downloadName(source: string, outputs: File[], to?: FormatId): string {
  if (outputs.length === 1) return outputs[0].name;
  const base = source.replace(/\.[^./\\]+$/, "") || "files";
  return `${base}${to ? `-${formatDef(to).exts[0]}` : ""}.zip`;
}
