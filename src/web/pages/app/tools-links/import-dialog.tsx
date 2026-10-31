/** R87: bulk create from a CSV file (columns url, slug or code, title, tags), with a preview before anything is made. */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { IconFileUp } from "@/web/components/ui/icon";
import { MAX_BULK, type ShortLinkInfo } from "@/shared/links";
import { linksKey } from "./data";

interface Row { url: string; code?: string; title?: string; tags?: string }

export async function parseLinksCsv(text: string): Promise<{ rows: Row[]; problem: string | null }> {
  const Papa = (await import("papaparse")).default;
  const out = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
  const fields = out.meta.fields ?? [];
  const urlKey = fields.find((f) => ["url", "destination", "link", "long url", "address"].includes(f));
  if (!urlKey) return { rows: [], problem: "The file needs a column named url." };
  const codeKey = fields.find((f) => ["slug", "code", "back half", "short", "alias"].includes(f));
  const rows = out.data.map((r) => ({ url: (r[urlKey] ?? "").trim(), code: codeKey ? (r[codeKey] ?? "").trim() || undefined : undefined, title: (r.title ?? r.name ?? "").trim() || undefined, tags: (r.tags ?? r.tag ?? "").trim() || undefined })).filter((r) => r.url);
  if (!rows.length) return { rows, problem: "The file has no rows with an address." };
  if (rows.length > MAX_BULK) return { rows, problem: `Import up to ${MAX_BULK} links at a time. This file has ${rows.length}.` };
  return { rows, problem: null };
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [result, setResult] = useState<{ created: ShortLinkInfo[]; failed: { line: number; message: string }[] } | null>(null);
  const reset = () => { setRows([]); setProblem(null); setName(""); setResult(null); };
  const run = useMutation({
    mutationFn: () => api.post<{ created: ShortLinkInfo[]; failed: { line: number; message: string }[] }>("/links/bulk", { rows }),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: linksKey }); toast.success(`${r.created.length} ${r.created.length === 1 ? "link" : "links"} made`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setName(f.name); setResult(null);
    if (f.size > 1024 * 1024) { setProblem("Use a file under 1 MB."); setRows([]); return; }
    const p = await parseLinksCsv(await f.text());
    setRows(p.rows); setProblem(p.problem);
  };
  const close = () => { reset(); onClose(); };
  return (
    <Dialog open={open} onClose={close} title="Import links from CSV" description="One link per row. Columns: url (needed), slug, title, tags (split tags with ;)."
      footer={result ? <Button onClick={close}>Done</Button> : <><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={() => run.mutate()} disabled={!rows.length || !!problem} loading={run.isPending} data-testid="import-run">Make {rows.length || ""} {rows.length === 1 ? "link" : "links"}</Button></>}>
      <div className="space-y-4" data-testid="import-dialog">
        {!result && (
          <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong p-5 text-center text-sm hover:bg-hover/40 focus-within:ring-2 focus-within:ring-brand">
            <IconFileUp className="h-5 w-5 text-muted" aria-hidden />
            <span className="font-medium">{name || "Choose a CSV file"}</span>
            <span className="text-[12.5px] text-muted">{rows.length ? `${rows.length} ${rows.length === 1 ? "row" : "rows"} ready` : `Up to ${MAX_BULK} rows`}</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} data-testid="import-file" />
          </label>
        )}
        {problem && <p className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad" role="alert">{problem}</p>}
        {!result && rows.length > 0 && !problem && (
          <div className="max-h-48 overflow-auto rounded-lg border border-line text-[12.5px]">
            <table className="w-full"><thead className="bg-fill/60 text-left text-muted"><tr><th className="px-3 py-1.5 font-medium">Address</th><th className="px-3 py-1.5 font-medium">Back half</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.slice(0, 8).map((r, i) => <tr key={i}><td className="max-w-[260px] truncate px-3 py-1.5">{r.url}</td><td className="px-3 py-1.5 text-muted">{r.code ?? "Random"}</td></tr>)}</tbody></table>
            {rows.length > 8 && <p className="px-3 py-1.5 text-muted">and {rows.length - 8} more</p>}
          </div>
        )}
        {result && (
          <div className="space-y-2 text-sm" data-testid="import-result">
            <p><span className="font-medium">{result.created.length}</span> made{result.failed.length ? <>, <span className="font-medium text-bad">{result.failed.length}</span> skipped</> : ""}.</p>
            {result.failed.length > 0 && <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border border-line p-2 text-[12.5px]">{result.failed.map((f) => <li key={f.line}><span className="text-muted">Row {f.line}:</span> {f.message}</li>)}</ul>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
