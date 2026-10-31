/**
 * R78 Convert hub: runs a planned route on one file, step by step. Browser steps run here (browser-ops, a lazy chunk);
 * an engine step is the same Tools job the Tools screens use (upload, wait, download), so limits, run counting and
 * clean up on the engine are unchanged. A step that turns one file into many (every page of a PDF) is followed by the
 * next step on each of them.
 */
import { formatDef, renameTo, type ConverterDef, type FormatId, type Route } from "@/shared/convert-routes";
import { toolDef, type ToolOp } from "@/shared/tools";
import { jobFailure, uploadJob, waitForJob } from "@/web/lib/tool-jobs";

export type BrowserOps = typeof import("./browser-ops");
let ops: Promise<BrowserOps> | null = null;
/** The on device converters, loaded the first time a job needs them. */
export const loadOps = (): Promise<BrowserOps> => (ops ??= import("./browser-ops").catch((e) => { ops = null; throw e; }));

export interface Progress { fraction: number; label: string; where: "device" | "engine" }

async function engineStep(step: ConverterDef, file: File, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<File> {
  const op = step.op as ToolOp;
  const def = toolDef(op);
  const options = step.options ?? {};
  const label = `${formatDef(step.from).label} to ${formatDef(step.to).label} on the Multies engine`;
  onProgress({ fraction: 0, label: `Uploading for ${label}`, where: "engine" });
  const job = await uploadJob(op, [file], options, (pct) => onProgress({ fraction: (pct / 100) * 0.4, label: `Uploading for ${label}`, where: "engine" }), { def, signal });
  const done = await waitForJob(job.token, (j) => {
    const pct = typeof (j as { progress?: number }).progress === "number" ? (j as { progress?: number }).progress! : 0;
    onProgress({ fraction: 0.4 + 0.5 * Math.min(1, pct / 100), label, where: "engine" });
  }, signal);
  if (done.status !== "done" || !done.downloadUrl) throw new Error(jobFailure(done));
  const res = await fetch(done.downloadUrl, { credentials: "include" });
  if (!res.ok) throw new Error("The converted file could not be downloaded. Try again.");
  const blob = await res.blob();
  return new File([blob], renameTo(file.name, step.to), { type: formatDef(step.to).mime });
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
