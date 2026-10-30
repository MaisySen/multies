/**
 * Tools P2, H7: the editors' client side. Uploads (with progress), runs straight from mail attachments,
 * polls a job until it is done and reads its result (thumbnails ZIP, JSON or a file).
 */
import { useQuery } from "@tanstack/react-query";
import { unzipSync } from "fflate";
import { api, ApiError } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import type { ToolsInfo } from "@/shared/tools";
import type { ToolFeature } from "@/shared/tool-features";
import type { CompareStart, EditorJob, EditorOp } from "@/shared/tools-editors";
import { useEffect } from "react";
import { peekCarried, takeCarried } from "@/web/lib/carried-files";

export class RunError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
  get limit() { return this.code === "plan_limit"; }
}

const asRunError = (err: unknown): RunError => {
  if (err instanceof RunError) return err;
  if (err instanceof ApiError) return new RunError(err.message, err.status, err.code);
  return new RunError(err instanceof Error && err.message ? err.message : "That didn't work. Try again.");
};

/** POSTs a form with upload progress (fetch has none). The upload header marks it as coming from Multies. */
function sendForm<T>(path: string, fd: FormData, onPct: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new RunError("Couldn't reach Multies. Check your connection and try again."));
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string } } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 202) resolve(body as T);
      else reject(new RunError(body.error?.message || "That didn't work. Try again.", xhr.status, body.error?.code));
    };
    xhr.send(fd);
  });
}

/** Where a PDF comes from: a file on this device or a mail attachment (no upload). */
export type Source = { kind: "file"; file: File } | { kind: "attachment"; id: string; name: string };
export const sourceName = (s: Source) => (s.kind === "file" ? s.file.name : s.name);

/** R66: the PDFs dropped on the Tools list before this page opened (read in a state initialiser; see useTakeCarried). */
export const carriedPdfs = (): Source[] => peekCarried().filter((f) => /\.pdf$/i.test(f.name)).map((file) => ({ kind: "file" as const, file }));
/** Clears the handed over files once the page has them (after the first render, so a strict re-render still sees them). */
export function useTakeCarried() { useEffect(() => { takeCarried(); }, []); }

/** Starts one engine job on one PDF. */
export async function start(op: Exclude<EditorOp, "compare">, src: Source, options: Record<string, string> = {}, onPct: (pct: number) => void = () => undefined): Promise<EditorJob> {
  try {
    if (src.kind === "attachment") return await api.post<EditorJob>("/tools/editors/jobs/from-attachments", { op, attachmentIds: [src.id], options });
    const fd = new FormData();
    for (const [k, v] of Object.entries(options)) fd.append(k, v);
    fd.append("files", src.file, src.file.name);
    return await sendForm<EditorJob>(`/api/tools/editors/jobs?op=${op}&files=1&name=${encodeURIComponent(src.file.name)}`, fd, onPct);
  } catch (err) { throw asRunError(err); }
}

/** Starts compare on two PDFs, older first: the report PDF and the change list. */
export async function startCompare(older: Source, newer: Source, onPct: (pct: number) => void = () => undefined): Promise<CompareStart> {
  try {
    if (older.kind === "attachment" && newer.kind === "attachment") return await api.post<CompareStart>("/tools/editors/jobs/from-attachments", { op: "compare", attachmentIds: [older.id, newer.id] });
    // A mix of an attachment and a file: fetch the attachment so both go up together.
    const fileOf = async (s: Source) => (s.kind === "file" ? s.file : new File([await (await fetch(`/api/mail/attachments/${encodeURIComponent(s.id)}`, { credentials: "include" })).blob()], s.name, { type: "application/pdf" }));
    const fd = new FormData();
    for (const f of [await fileOf(older), await fileOf(newer)]) fd.append("files", f, f.name);
    return await sendForm<CompareStart>("/api/tools/editors/compare", fd, onPct);
  } catch (err) { throw asRunError(err); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls a job until it is done; throws a plain RunError when it failed or expired. Polling reads no database. */
export async function waitFor(job: EditorJob, onJob: (j: EditorJob) => void = () => undefined, signal?: { stopped: boolean }): Promise<EditorJob> {
  let j = job;
  const started = Date.now();
  for (let i = 0; ; i++) {
    if (j.status === "done") return j;
    if (j.status === "failed") throw new RunError(j.error ?? "The file could not be processed.");
    if (j.status === "expired") throw new RunError("This file has expired. Run the tool again.");
    if (signal?.stopped) throw new RunError("Stopped.");
    if (Date.now() - started > 10 * 60_000) throw new RunError("This is taking too long. Try again in a minute.");
    await sleep(i < 5 ? 700 : 1500);
    try { j = await api.get<EditorJob>(`/tools/editors/jobs/${encodeURIComponent(job.token)}`); } catch (err) { throw asRunError(err); }
    onJob(j);
  }
}

async function download(job: EditorJob): Promise<Response> {
  if (!job.downloadUrl) throw new RunError("This file has expired. Run the tool again.");
  const res = await fetch(job.downloadUrl, { credentials: "include" });
  if (!res.ok) throw new RunError(res.status === 404 ? "This file has expired. Run the tool again." : "Couldn't fetch the result. Try again.");
  return res;
}

export const readJson = async (job: EditorJob): Promise<unknown> => (await download(job)).json();
export const readBlob = async (job: EditorJob): Promise<Blob> => (await download(job)).blob();

/** The page images from a thumbnails ZIP (page-001.png...), in page order, as object URLs. */
export async function readThumbnails(job: EditorJob): Promise<string[]> {
  const zip = new Uint8Array(await (await download(job)).arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(zip, { filter: (f) => /^page-\d{1,4}\.png$/.test(f.name.split("/").pop() ?? "") }); } catch { throw new RunError("The page previews could not be read. Try again."); }
  return Object.keys(entries)
    .sort((a, b) => Number(/(\d+)\.png$/.exec(a)?.[1]) - Number(/(\d+)\.png$/.exec(b)?.[1]))
    .map((k) => URL.createObjectURL(new Blob([entries[k] as BlobPart], { type: "image/png" })));
}

/** Which P2 features are on (GET /api/tools, shared with the Tools page's cache). */
export function useToolFeatures(): { ready: boolean; on: (f: ToolFeature) => boolean; info: ToolsInfo | undefined } {
  const config = useConfig();
  const enabled = !!config.data?.tools;
  const info = useQuery({ queryKey: ["tools"], enabled, queryFn: () => api.get<ToolsInfo>("/tools") });
  const features = info.data?.features ?? [];
  return { ready: !enabled ? !config.isLoading : !info.isLoading, on: (f) => features.includes(f), info: info.data };
}

/** "Email it": the shared "Attach to a new email" path (lib/compose-files); results go by their token. */
export { useAttachToNewEmail } from "@/web/lib/compose-files";
