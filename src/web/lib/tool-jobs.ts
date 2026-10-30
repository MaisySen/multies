/**
 * Tools jobs from the browser: upload with progress, run on mail attachments, and wait for a result.
 * The Tools page, batch runs, auto redact, the P2 editors, composer rules, workflows and templates share these.
 */
import { api } from "@/web/lib/api";
import type { ToolDef, ToolJob, ToolOp } from "@/shared/tools";

export type ToolError = Error & { status?: number; code?: string };

/** Uploads with progress (fetch has no upload progress). The upload header marks it as coming from Multies. */
export function uploadJob(op: ToolOp, files: File[], options: Record<string, string>, onPct: (pct: number) => void = () => {}, extra: { def?: Pick<ToolDef, "extra" | "extBy">; files?: File[]; signal?: AbortSignal } = {}): Promise<ToolJob> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(options)) if (v.trim() !== "") fd.append(k, v);
    for (const f of files) fd.append("files", f, f.name);
    const field = extra.def?.extra?.field;
    if (field) for (const f of extra.files ?? []) fd.append(field, f, f.name);
    const q = new URLSearchParams({ op, files: String(files.length), name: files[0]?.name ?? "" });
    if (field) q.set("extra", String(extra.files?.length ?? 0));
    const by = extra.def?.extBy?.option;
    if (by && options[by]) q.set(by, options[by]);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/tools/jobs?${q.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    // Tools UX: Cancel stops the upload.
    extra.signal?.addEventListener("abort", () => { xhr.abort(); reject(Object.assign(new Error("Stopped."), { status: -1 })); });
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

/** Runs a tool on mail attachments (nothing uploaded again). */
export const attachmentJob = (op: ToolOp, attachmentIds: string[], options: Record<string, string> = {}) =>
  api.post<ToolJob>("/tools/jobs/from-attachments", { op, attachmentIds, options: Object.fromEntries(Object.entries(options).filter(([, v]) => v.trim() !== "")) });

/**
 * Polls a job until it is done, failed or expired. Calls onUpdate with each reading (progress).
 * A 503 (engine waking) is retried; other errors reject. Stops quietly when the signal aborts.
 */
export function waitForJob(token: string, onUpdate: (j: ToolJob) => void = () => {}, signal?: AbortSignal): Promise<ToolJob> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (signal?.aborted) return;
      try {
        const j = await api.get<ToolJob>(`/tools/jobs/${encodeURIComponent(token)}`);
        if (signal?.aborted) return;
        onUpdate(j);
        if (j.status === "done" || j.status === "failed" || j.status === "expired") { resolve(j); return; }
      } catch (err) {
        if ((err as ToolError).status !== 503) { reject(err); return; }
      }
      setTimeout(tick, Date.now() - started > 20_000 ? 3000 : 1200);
    };
    setTimeout(tick, 900);
  });
}

/** A finished job's result as text (pii-find matches, form fields, page lists). */
export async function jobText(job: ToolJob): Promise<string> {
  if (!job.downloadUrl) throw new Error("This file has expired. Run the tool again.");
  const res = await fetch(job.downloadUrl, { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 404 ? "This file has expired. Run the tool again." : "Couldn't read the result. Try again.");
  return res.text();
}

/** The plain words for a finished job that did not work. */
export const jobFailure = (j: ToolJob) => (j.status === "expired" ? "This file has expired. Run the tool again." : j.error ?? "The file could not be processed.");

/* Tools P2 (H6): code paths that want a File back and an error thrown (composer rules, workflows, templates). */

export class ToolJobError extends Error { constructor(message: string, readonly status = 0, readonly code?: string) { super(message); } }

/** Uploads files and option fields as a form (with progress). `path` is /api/tools/jobs?op=... or /api/tools/workflows/run. */
export function uploadJobTo(path: string, files: File[], fields: Record<string, string>, onPct?: (pct: number) => void, signal?: AbortSignal): Promise<ToolJob> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== "") fd.append(k, v);
    for (const f of files) fd.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    if (onPct) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    signal?.addEventListener("abort", () => { xhr.abort(); reject(new ToolJobError("Stopped.")); });
    xhr.onerror = () => reject(new ToolJobError("Couldn't reach Multies. Check your connection and try again."));
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string } } & Partial<ToolJob> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 202) resolve(body as ToolJob);
      else reject(new ToolJobError(body.error?.message || "That didn't work. Try again.", xhr.status, body.error?.code));
    };
    xhr.send(fd);
  });
}

/** Polls a job until it is done (or failed, expired, timed out). */
export async function waitForJobDone(token: string, opts: { timeoutMs?: number; signal?: AbortSignal; onUpdate?: (j: ToolJob) => void } = {}): Promise<ToolJob> {
  const until = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  let wait = 900;
  for (;;) {
    if (opts.signal?.aborted) throw new ToolJobError("Stopped.");
    await new Promise((r) => setTimeout(r, wait));
    const j = await api.get<ToolJob>(`/tools/jobs/${encodeURIComponent(token)}`);
    opts.onUpdate?.(j);
    if (j.status === "done") return j;
    if (j.status === "failed") throw new ToolJobError(j.error || "The file could not be processed.");
    if (j.status === "expired") throw new ToolJobError("This file has expired. Run it again.");
    if (Date.now() > until) throw new ToolJobError("This is taking longer than usual.", 408, "timeout");
    wait = Math.min(3000, wait + 300);
  }
}

/** Downloads a finished job's file as a File named like the result. */
export async function jobFile(job: ToolJob, type = "application/pdf"): Promise<File> {
  if (!job.downloadUrl) throw new ToolJobError("The result is not ready.");
  const res = await fetch(job.downloadUrl, { credentials: "include" });
  if (!res.ok) throw new ToolJobError("The result could not be downloaded.", res.status);
  const blob = await res.blob();
  return new File([blob], job.name, { type: blob.type || type });
}

/** One tool on one file, start to finish, with a deadline: the composer's rules use this. */
export async function runToolOnFile(op: string, file: File, options: Record<string, string> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<File> {
  const job = await uploadJobTo(`/api/tools/jobs?op=${encodeURIComponent(op)}&files=1&name=${encodeURIComponent(file.name)}`, [file], options, undefined, opts.signal);
  return jobFile(await waitForJobDone(job.token, opts));
}

/** Saves a File through the browser's download. */
export function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
