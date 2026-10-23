/** Files on a task: upload (members and guests) and download. Files always download, never open inline. */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Paperclip, Upload } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { timeAgo } from "@/web/lib/format";
import type { TaskFile } from "./data";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
}

export function FileList({ files, uploadPath, downloadPath, onUploaded }: { files: TaskFile[]; uploadPath: string; downloadPath: (id: string) => string; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        if (f.size > 10_000_000) throw new Error(`${f.name} is over 10 MB.`);
        await api.post(uploadPath, { filename: f.name, contentType: f.type || "application/octet-stream", contentBase64: await toBase64(f) });
      }
      onUploaded();
    } catch (e) { showError(e as Error); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return (
    <section className="mt-6" aria-label="Files">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Files</h3>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => input.current?.click()}><Upload className="h-3.5 w-3.5" />{busy ? "Uploading" : "Upload"}</Button>
        <input ref={input} type="file" multiple hidden aria-label="Upload a file" onChange={(e) => void upload(e.target.files)} />
      </div>
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-[13px]">
              <Paperclip className="h-3.5 w-3.5 text-muted" aria-hidden />
              <a href={`/api${downloadPath(f.id)}`} className="truncate text-fg hover:underline" download>{f.filename}</a>
              <span className="ml-auto whitespace-nowrap text-[11.5px] text-subtle">{size(f.sizeBytes)} · {f.uploadedBy.name} · {timeAgo(f.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-1.5 text-[12.5px] text-subtle">No files yet.</p>}
    </section>
  );
}

export function TaskFiles({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: ["task-files", taskId], queryFn: async () => (await api.get<{ files: TaskFile[] }>(`/files?taskId=${taskId}`)).files });
  return <FileList files={q.data ?? []} uploadPath={`/files?taskId=${taskId}`} downloadPath={(id) => `/files/${id}/download`} onUploaded={() => void q.refetch()} />;
}
