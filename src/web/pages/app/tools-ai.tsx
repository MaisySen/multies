/**
 * Tools P2 H3: AI document helpers. Ask a document, translate keeping layout, invoices and receipts to a
 * spreadsheet, expense report, contract dates to My Work. Rules run first; AI fills gaps inside the
 * workspace's daily allowance (or on its own AI key). Each section shows only when its flag is on.
 * Opens with ?feature=ask&attachment=<id>&name=<file> from a mail attachment.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconClose, IconDownload, IconFileUp, IconMail } from "@/web/components/ui/icon";
import { useAttachToNewEmail } from "@/web/lib/compose-files"; // Tools P2: the one "Attach to a new email" path
import { api, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, Meter, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { Field, Input, Select } from "@/web/components/ui/input";

type Feature = "ask" | "translate" | "extract" | "expenses" | "contracts";
interface Usage { units: number; cap: number; percent: number; ownKey: boolean; globalReached: boolean; features: Feature[]; languages: Record<string, string>; caps: { translatePages: number; extractFiles: number } }
interface Job { token: string; name: string; status: string; error?: string; downloadUrl?: string; attachmentId?: string }
interface Row { file: string; attachmentId?: string | null; supplier: string | null; abn: string | null; invoice_number: string | null; date: string | null; due_date: string | null; subtotal: number | null; gst: number | null; total: number | null; currency: string | null; category: string | null; ai: string[] }
interface Facts { parties: string[]; start_date: string | null; end_date: string | null; renewal_date: string | null; notice_days: number | null; auto_renew: boolean | null; amounts: string[]; ai: string[] }
interface Reminder { title: string; due: string; kind: string }
interface Source { file?: File; attachment?: { id: string; name: string } }

const LABELS: Record<Feature, string> = { ask: "Ask a document", translate: "Translate", extract: "Invoices to a sheet", expenses: "Expense report", contracts: "Contract dates" };
export const AI_NOTE = "AI can make mistakes. Check important details against the document.";
export const TRANSLATE_NOTE = "Machine translation can be wrong. Have important documents checked by a person.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(token: string): Promise<Job> {
  const started = Date.now();
  for (;;) {
    const j = await api.get<Job>(`/tools/jobs/${encodeURIComponent(token)}`);
    if (j.status === "done") return j;
    if (j.status === "failed") throw new Error(j.error || "The file could not be read.");
    if (j.status === "expired") throw new Error("This file has expired. Open it again.");
    if (Date.now() - started > 5 * 60_000) throw new Error("This is taking too long. Try a shorter file.");
    await sleep(Date.now() - started > 20_000 ? 3000 : 1200);
  }
}

async function uploadForm(path: string, fd: FormData): Promise<Job> {
  const res = await fetch(`/api${path}`, { method: "POST", body: fd, credentials: "include", headers: { "x-multies-upload": "1" } });
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } } & Job;
  if (res.status !== 202) throw new Error(body.error?.message || "That didn't work. Try again.");
  return body;
}

/** Starts reading one source (upload or mail attachment) and waits until the text is ready. */
async function readSource(feature: Feature, src: Source): Promise<Job> {
  let job: Job;
  if (src.attachment) {
    const r = await api.post<{ jobs: Job[] }>("/tools/ai/read", { attachmentIds: [src.attachment.id], feature });
    job = r.jobs[0];
  } else {
    const fd = new FormData();
    fd.append("file", src.file!, src.file!.name);
    job = await uploadForm(`/tools/ai/read/upload?feature=${feature}`, fd);
  }
  await waitFor(job.token);
  return job;
}

/** A file made on the server (the XLSX or CSV sheet), as a File named the way the server named it. */
async function postFile(path: string, body: unknown, fallbackName: string): Promise<File> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(b.error?.message || "That didn't work. Try again."); }
  const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "application/octet-stream" });
}

async function downloadPost(path: string, body: unknown, fallbackName: string) {
  const file = await postFile(path, body, fallbackName);
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Tools P2: in a translated PDF the original words stay under the translation (shown on the result). */
export const TRANSLATE_PDF_HIDDEN_NOTE = "In a translated PDF the original words stay hidden under the translation and can still be copied. If that matters, turn the PDF into Word first and translate the Word file.";

function SourcePicker({ value, onChange, accept, disabled, hint }: { value: Source; onChange: (s: Source) => void; accept: string; disabled?: boolean; hint: string }) {
  const input = useRef<HTMLInputElement>(null);
  const name = value.attachment?.name ?? value.file?.name;
  return (
    <div className="space-y-2">
      {name ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated px-3 py-2 text-sm">
          <span className="truncate" data-testid="ai-source">{name}{value.attachment ? <span className="text-muted"> from mail</span> : null}</span>
          <button type="button" aria-label="Choose another file" className="text-muted hover:text-fg max-sm:min-h-11" disabled={disabled} onClick={() => onChange({})}><IconClose className="h-4 w-4" /></button>
        </div>
      ) : (
        <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-line-strong px-4 py-6 text-sm text-muted hover:border-accent hover:text-fg">
          <IconFileUp className="h-5 w-5" /><span className="font-medium text-fg">Choose a file</span><span>{hint}</span>
        </button>
      )}
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onChange({ file: f }); e.target.value = ""; }} />
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{text}</p>;
}

function AskPanel({ src, setSrc }: { src: Source; setSrc: (s: Source) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // QUAL1 review: `fallback` is set when built-in AI answered because the workspace's own key was refused; it is shown.
  const [summary, setSummary] = useState<{ bullets: string[]; pages: number[]; partial: boolean; fallback?: { message: string } } | null>(null);
  const [q, setQ] = useState("");
  const [answers, setAnswers] = useState<{ q: string; a: string; pages: number[]; note?: string }[]>([]);
  useEffect(() => { setJob(null); setSummary(null); setAnswers([]); setErr(null); }, [src]);
  const ensure = async () => { if (job) return job; setBusy("Reading the document"); const j = await readSource("ask", src); setJob(j); return j; };
  const summarise = async () => {
    setErr(null);
    try { const j = await ensure(); setBusy("Writing a summary"); setSummary(await api.post("/tools/ai/ask", { token: j.token })); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setErr(null);
    try { const j = await ensure(); setBusy("Finding the answer"); const r = await api.post<{ answer: string; pages: number[]; fallback?: { message: string } }>("/tools/ai/ask", { token: j.token, question }); setAnswers((a) => [{ q: question, a: r.answer, pages: r.pages, note: r.fallback?.message }, ...a]); setQ(""); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const has = !!(src.file || src.attachment);
  return (
    <div className="space-y-4">
      <SourcePicker value={src} onChange={setSrc} accept=".pdf,.docx,.png,.jpg,.jpeg" disabled={!!busy} hint="PDF, Word or a photo of a page" />
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!has || !!busy} loading={busy === "Writing a summary"} onClick={summarise}>Summarise</Button></div>
      {summary && (
        <Card className="space-y-2 p-4" data-testid="ai-summary">
          <h3 className="text-sm font-semibold">Summary</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{summary.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {summary.partial && <p className="text-xs text-muted">This is a long document, so the summary is based on parts of it spread through the whole file.</p>}
          {summary.fallback && <p className="text-xs text-muted" data-testid="ai-fallback">{summary.fallback.message}</p>}
        </Card>
      )}
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <Input aria-label="Ask a question about the document" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question, like: when does this end?" maxLength={500} disabled={!has || !!busy} />
        <Button type="submit" disabled={!has || !q.trim() || !!busy} loading={busy === "Finding the answer"} className="sm:shrink-0">Ask</Button>
      </form>
      {busy && <p className="text-sm text-muted" aria-live="polite">{busy}...</p>}
      <Problem text={err} />
      {answers.map((a, i) => (
        <Card key={i} className="space-y-1 p-4" data-testid="ai-answer">
          <p className="text-sm font-medium">{a.q}</p>
          <p className="whitespace-pre-wrap text-sm">{a.a}</p>
          {a.pages.length > 0 && <p className="text-xs text-muted">Pages: {a.pages.join(", ")}</p>}
          {a.note && <p className="text-xs text-muted" data-testid="ai-fallback">{a.note}</p>}
        </Card>
      ))}
    </div>
  );
}

function TranslatePanel({ src, setSrc, languages, pageCap }: { src: Source; setSrc: (s: Source) => void; languages: Record<string, string>; pageCap: number }) {
  const [target, setTarget] = useState("en");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Job | null>(null);
  /** QUAL1 review: built-in AI translated in place of the workspace's refused key: said under the result. */
  const [note, setNote] = useState<string | null>(null);
  const attach = useAttachToNewEmail();
  useEffect(() => { setResult(null); setProgress(null); setErr(null); setNote(null); }, [src, target]);
  const run = async () => {
    setErr(null); setResult(null); setNote(null);
    try {
      setBusy("Reading the document");
      const seg = await readSource("translate", src);
      setBusy("Translating");
      const all: Record<string, string> = {};
      let offset: number | null = 0;
      while (offset !== null) {
        const r: { translations: Record<string, string>; done: number; total: number; next: number | null; fallback?: { message: string } } = await api.post("/tools/ai/translate", { token: seg.token, target, offset, count: 40 });
        Object.assign(all, r.translations);
        if (r.fallback?.message) setNote(r.fallback.message);
        setProgress({ done: r.done, total: r.total });
        offset = r.next;
      }
      setBusy("Putting the translation into the file");
      let job: Job;
      if (src.attachment) job = await api.post<Job>("/tools/ai/translate/apply", { attachmentId: src.attachment.id, target, translations: all });
      else {
        const fd = new FormData();
        fd.append("file", src.file!, src.file!.name);
        fd.append("target", target);
        fd.append("translations", JSON.stringify(all));
        job = await uploadForm("/tools/ai/translate/apply", fd);
      }
      setResult(await waitFor(job.token).then((j) => ({ ...j, name: job.name })));
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-4">
      <SourcePicker value={src} onChange={setSrc} accept=".pdf,.docx" disabled={!!busy} hint={`PDF or Word, up to ${pageCap} pages`} />
      <Field label="Translate into">{(p) => (
        <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!busy}>
          {Object.entries(languages).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      )}</Field>
      <Button size="sm" disabled={!(src.file || src.attachment) || !!busy} loading={!!busy} onClick={run}>Translate</Button>
      {busy && <div aria-live="polite" className="space-y-1 text-sm text-muted"><p>{busy}...</p>{progress && busy === "Translating" && <Meter value={progress.done} max={progress.total} label={`${progress.done} of ${progress.total} parts`} />}</div>}
      <Problem text={err} />
      {result?.downloadUrl && (
        <Card className="space-y-2 p-4" data-testid="ai-translate-done">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{result.name}</span>
            <span className="flex items-center gap-3">
              <a className="inline-flex items-center gap-1.5 text-sm font-medium text-accent" href={`/api${result.downloadUrl.replace(/^\/api/, "")}`}><IconDownload className="h-4 w-4" />Download</a>
              <Button size="sm" variant="secondary" onClick={() => attach({ jobs: [result] })} data-testid="ai-translate-attach"><IconMail className="h-4 w-4" />Attach to a new email</Button>
            </span>
          </div>
          {/\.pdf$/i.test(result.name) && <p className="text-xs text-muted" data-testid="ai-translate-hidden-note">{TRANSLATE_PDF_HIDDEN_NOTE}</p>}
          {note && <p className="text-xs text-muted" data-testid="ai-fallback">{note}</p>}
        </Card>
      )}
      <p className="text-xs text-muted">{TRANSLATE_NOTE}</p>
    </div>
  );
}

const money = (n: number | null) => (n === null ? "" : n.toFixed(2));
const COLS: { key: keyof Row; label: string; num?: boolean; width?: string }[] = [
  { key: "supplier", label: "Supplier", width: "min-w-48" }, { key: "abn", label: "ABN", width: "min-w-32" }, { key: "invoice_number", label: "Number", width: "min-w-24" },
  { key: "date", label: "Date", width: "min-w-28" }, { key: "gst", label: "GST", num: true, width: "min-w-20" }, { key: "total", label: "Total", num: true, width: "min-w-20" }, { key: "category", label: "Category", width: "min-w-36" },
];

function ReviewTable({ rows, setRows }: { rows: Row[]; setRows: (r: Row[]) => void }) {
  const set = (i: number, k: keyof Row, v: string, num?: boolean) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: num ? (v.trim() === "" ? null : Number(v)) : v || null, ai: r.ai.filter((x) => x !== k) } : r)));
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm" data-testid="ai-review">
        <thead className="bg-elevated text-left text-xs text-muted"><tr><th className="px-2 py-2">File</th>{COLS.map((c) => <th key={c.key} className="px-2 py-2">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              <td className="max-w-40 truncate px-2 py-1 text-muted" title={r.file}>{r.file}</td>
              {COLS.map((c) => (
                <td key={c.key} className={`px-1 py-1 ${c.width ?? ""}`}>
                  <input aria-label={`${c.label} for ${r.file}`} className={`w-full rounded border bg-surface px-1.5 py-1 ${r.ai.includes(c.key) ? "border-warn" : "border-transparent hover:border-line"} ${c.num ? "text-right" : ""}`}
                    title={r.ai.includes(c.key) ? "Filled by AI. Please check." : undefined}
                    inputMode={c.num ? "decimal" : undefined} value={c.num ? money(r[c.key] as number | null) : String(r[c.key] ?? "")} onChange={(e) => set(i, c.key, e.target.value, c.num)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SheetButtons({ rows, feature, title }: { rows: Row[]; feature: "extract" | "expenses"; title?: string }) {
  const [err, setErr] = useState<string | null>(null);
  const attach = useAttachToNewEmail();
  const get = (format: "xlsx" | "csv") => downloadPost("/tools/ai/sheet", { feature, format, rows, title }, `sheet.${format}`).catch((e) => setErr(errorMessage(e)));
  // The sheet is made here in Multies (no engine job), so it rides to the new email as a file.
  const email = () => postFile("/tools/ai/sheet", { feature, format: "xlsx", rows, title }, "sheet.xlsx").then((f) => attach({ files: [f] }, { subject: title ?? "" })).catch((e) => setErr(errorMessage(e)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => get("xlsx")}><IconDownload className="h-4 w-4" />Excel</Button>
        <Button size="sm" variant="secondary" onClick={() => get("csv")}><IconDownload className="h-4 w-4" />CSV</Button>
        {feature === "extract" && <Button size="sm" variant="secondary" onClick={email} data-testid="ai-sheet-attach"><IconMail className="h-4 w-4" />Attach to a new email</Button>}
      </div>
      <Problem text={err} />
    </div>
  );
}

function InvoicesPanel({ src, maxFiles }: { src: Source; maxFiles: number }) {
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const run = async () => {
    setErr(null); setNote(null);
    try {
      const jobs: Job[] = [];
      const sources: Source[] = [...(src.attachment ? [src] : []), ...files.map((f) => ({ file: f }))];
      for (const [i, s] of sources.entries()) { setBusy(`Reading file ${i + 1} of ${sources.length}`); jobs.push(await readSource("extract", s)); }
      setBusy("Finding the details");
      const r = await api.post<{ rows: Row[]; note: string | null }>("/tools/ai/invoices", { feature: "extract", files: jobs.map((j) => ({ token: j.token, attachmentId: j.attachmentId })) });
      setRows(r.rows); setNote(r.note);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const count = files.length + (src.attachment ? 1 : 0);
  return (
    <div className="space-y-4">
      {src.attachment && <p className="text-sm">From mail: <span className="font-medium">{src.attachment.name}</span></p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => input.current?.click()}><IconFileUp className="h-4 w-4" />Add invoices or receipts</Button>
        <span className="text-sm text-muted">{count ? `${count} chosen` : `PDF or photos, up to ${maxFiles}`}</span>
        <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => { setFiles((f) => [...f, ...(e.target.files ? [...e.target.files] : [])].slice(0, maxFiles)); e.target.value = ""; }} />
      </div>
      <Button size="sm" disabled={!count || !!busy} loading={!!busy} onClick={run}>Read details</Button>
      {busy && <p className="text-sm text-muted" aria-live="polite">{busy}...</p>}
      <Problem text={err} />
      {note && <p className="text-sm text-muted">{note} The details below come from the document text only.</p>}
      {rows.length > 0 && (<><ReviewTable rows={rows} setRows={setRows} /><p className="text-xs text-muted">Boxes with a coloured border were filled by AI. {AI_NOTE}</p><SheetButtons rows={rows} feature="extract" /></>)}
    </div>
  );
}

interface Receipt { id: string; filename: string; size: number; date: string; subject: string | null }

function ExpensesPanel() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("receipt");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pdf, setPdf] = useState<Job | null>(null);
  const [title, setTitle] = useState("Expense report");
  const list = useQuery({ queryKey: ["ai-receipts", from, to, q], queryFn: () => api.get<{ receipts: Receipt[] }>(`/tools/ai/receipts?from=${from}&to=${to}&q=${encodeURIComponent(q)}`) });
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const read = async () => {
    setErr(null); setPdf(null);
    try {
      const r = await api.post<{ jobs: Job[] }>("/tools/ai/read", { attachmentIds: [...chosen], feature: "expenses" });
      for (const [i, j] of r.jobs.entries()) { setBusy(`Reading receipt ${i + 1} of ${r.jobs.length}`); await waitFor(j.token); }
      setBusy("Finding the details");
      const x = await api.post<{ rows: Row[] }>("/tools/ai/invoices", { feature: "expenses", files: r.jobs.map((j) => ({ token: j.token, attachmentId: j.attachmentId })) });
      setRows(x.rows);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const makePdf = async () => {
    setErr(null);
    try {
      setBusy("Making the summary");
      const s = await api.post<Job>("/tools/ai/expenses/report", { rows, title, from, to });
      await waitFor(s.token);
      setBusy("Adding the receipts");
      const p = await api.post<Job>("/tools/ai/expenses/pack", { summaryToken: s.token, attachmentIds: rows.map((r) => r.attachmentId).filter(Boolean), title });
      setPdf({ ...(await waitFor(p.token)), name: p.name });
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const attach = useAttachToNewEmail();
  // The PDF report is an engine result (goes by its token); the sheet is made here (goes as a file).
  const attachReport = async () => {
    if (!pdf) return;
    try {
      const sheet = await postFile("/tools/ai/sheet", { feature: "expenses", format: "xlsx", rows, title }, "expenses.xlsx");
      attach({ jobs: [pdf], files: [sheet] }, { subject: title });
    } catch (e) { setErr(errorMessage(e)); }
  };
  const total = useMemo(() => rows.reduce((n, r) => n + (r.total ?? 0), 0), [rows]);
  const gst = useMemo(() => rows.reduce((n, r) => n + (r.gst ?? 0), 0), [rows]);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Search">{(p) => <Input {...p} value={q} onChange={(e) => setQ(e.target.value)} placeholder="receipt, invoice, a supplier" />}</Field>
      </div>
      <Card className="max-h-72 overflow-y-auto p-2">
        {list.isLoading ? <Skeleton className="h-16" /> : (list.data?.receipts ?? []).length === 0 ? <p className="p-3 text-sm text-muted">No PDF or photo attachments in these dates.</p> : (
          <ul className="divide-y divide-line">
            {list.data!.receipts.map((r) => (
              <li key={r.id}><label className="flex cursor-pointer items-center gap-3 px-2 py-2 text-sm max-sm:min-h-11">
                <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="min-w-0 flex-1 truncate">{r.filename}<span className="text-muted"> · {r.subject ?? ""}</span></span>
                <span className="shrink-0 text-xs text-muted">{new Date(r.date).toLocaleDateString()}</span>
              </label></li>
            ))}
          </ul>
        )}
      </Card>
      <Button size="sm" disabled={chosen.size === 0 || !!busy} loading={!!busy && rows.length === 0} onClick={read}>Read {chosen.size || ""} receipts</Button>
      {busy && <p className="text-sm text-muted" aria-live="polite">{busy}...</p>}
      <Problem text={err} />
      {rows.length > 0 && (
        <div className="space-y-3">
          <ReviewTable rows={rows} setRows={setRows} />
          <p className="text-sm"><span className="font-medium">Total {total.toFixed(2)}</span><span className="text-muted"> · GST {gst.toFixed(2)} · {rows.length} receipts</span></p>
          <p className="text-xs text-muted">Boxes with a coloured border were filled by AI. {AI_NOTE}</p>
          <Field label="Report title">{(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-2">
            <SheetButtons rows={rows} feature="expenses" title={title} />
            <Button size="sm" disabled={!!busy} onClick={makePdf}>Make PDF report</Button>
          </div>
          {pdf?.downloadUrl && (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="ai-expense-pdf">
              <span className="min-w-0 truncate text-sm">{pdf.name}</span>
              <span className="flex items-center gap-3">
                <a className="inline-flex items-center gap-1.5 text-sm font-medium text-accent" href={`/api${pdf.downloadUrl.replace(/^\/api/, "")}`}><IconDownload className="h-4 w-4" />Download</a>
                <Button size="sm" variant="secondary" onClick={() => void attachReport()} data-testid="ai-expense-attach"><IconMail className="h-4 w-4" />Attach report and sheet to a new email</Button>
              </span>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ContractPanel({ src, setSrc }: { src: Source; setSrc: (s: Source) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<{ name: string; facts: Facts; reminders: Reminder[]; note: string | null } | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  useEffect(() => { setData(null); setAdded(null); setErr(null); }, [src]);
  const run = async () => {
    setErr(null);
    try { setBusy("Reading the contract"); const j = await readSource("contracts", src); setBusy("Finding the key dates"); setData(await api.post("/tools/ai/contract", { token: j.token })); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const add = async () => {
    if (!data) return;
    setErr(null);
    try { setBusy("Adding reminders"); const r = await api.post<{ created: unknown[] }>("/tools/ai/contract/reminders", { attachmentId: src.attachment?.id, name: data.name, reminders: data.reminders.map(({ title, due }) => ({ title, due })) }); setAdded(r.created.length); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };
  const f = data?.facts;
  const yesNo = (v: boolean | null) => (v === null ? "Not stated" : v ? "Yes" : "No");
  const mark = (k: string) => (f?.ai.includes(k) ? <Badge tone="warn">AI</Badge> : null);
  return (
    <div className="space-y-4">
      <SourcePicker value={src} onChange={setSrc} accept=".pdf,.docx" disabled={!!busy} hint="PDF or Word" />
      <Button size="sm" disabled={!(src.file || src.attachment) || !!busy} loading={!!busy && !data} onClick={run}>Find key facts</Button>
      {busy && <p className="text-sm text-muted" aria-live="polite">{busy}...</p>}
      <Problem text={err} />
      {f && (
        <Card className="space-y-3 p-4" data-testid="ai-contract">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">Parties</dt><dd>{f.parties.join(" and ") || "Not found"} {mark("parties")}</dd>
            <dt className="text-muted">Start</dt><dd>{f.start_date ?? "Not found"} {mark("start_date")}</dd>
            <dt className="text-muted">End</dt><dd>{f.end_date ?? "Not found"} {mark("end_date")}</dd>
            <dt className="text-muted">Renews by itself</dt><dd>{yesNo(f.auto_renew)} {mark("auto_renew")}</dd>
            {f.renewal_date && (<><dt className="text-muted">Renews on</dt><dd>{f.renewal_date}</dd></>)}
            <dt className="text-muted">Notice period</dt><dd>{f.notice_days ? `${f.notice_days} days` : "Not found"} {mark("notice_days")}</dd>
            <dt className="text-muted">Amounts</dt><dd>{f.amounts.join(", ") || "Not found"} {mark("amounts")}</dd>
          </dl>
          {data.note && <p className="text-xs text-muted">{data.note}</p>}
          {data.reminders.length > 0 ? (
            <div className="space-y-2 border-t border-line pt-3">
              <ul className="space-y-1 text-sm">{data.reminders.map((r) => <li key={r.kind}>{r.due}: {r.title}</li>)}</ul>
              {added !== null ? <p className="text-sm">Added {added} {added === 1 ? "task" : "tasks"} to <Link className="underline underline-offset-2" to="/app/my-work">My Work</Link>.</p>
                : <Button size="sm" loading={busy === "Adding reminders"} onClick={add}>Add reminders</Button>}
            </div>
          ) : <p className="text-sm text-muted">No upcoming dates to remind you about.</p>}
          <p className="text-xs text-muted">{AI_NOTE}</p>
        </Card>
      )}
    </div>
  );
}

export function AiUsageLine({ usage }: { usage: Usage | undefined }) {
  if (!usage) return null;
  if (usage.ownKey) return <p className="text-sm text-muted" data-testid="ai-usage">AI runs on your workspace's own AI key.</p>;
  return (
    <div className="space-y-1" data-testid="ai-usage">
      <div className="flex items-center justify-between text-xs text-muted"><span>Today's free AI allowance</span><span>{usage.percent}% used</span></div>
      <Meter value={usage.units} max={usage.cap} label={`Today's free AI: ${usage.percent}% used`} />
      {(usage.globalReached || usage.percent >= 100) && <p className="text-xs text-muted">Today's free AI limit is used up. Add your own AI key in Settings or try again tomorrow.</p>}
    </div>
  );
}

export const useAiUsage = (enabled: boolean) => useQuery({ queryKey: ["ai-usage"], enabled, queryFn: () => api.get<Usage>("/tools/ai/usage"), staleTime: 30_000, retry: false });

export function ToolsAiPage() {
  const config = useConfig();
  const usage = useAiUsage(!!config.data?.tools);
  const [params, setParams] = useSearchParams();
  const features = usage.data?.features ?? [];
  const asked = params.get("feature") as Feature | null;
  const feature: Feature | undefined = asked && features.includes(asked) ? asked : features[0];
  const attachment = params.get("attachment");
  const [src, setSrc] = useState<Source>(attachment ? { attachment: { id: attachment, name: params.get("name") ?? "Attachment" } } : {});
  useEffect(() => { if (attachment) setSrc({ attachment: { id: attachment, name: params.get("name") ?? "Attachment" } }); }, [attachment, params]);
  if (usage.isLoading) return <div className="mx-auto max-w-4xl p-6"><Skeleton className="h-40" /></div>;
  if (!usage.data || features.length === 0) return <div className="mx-auto max-w-4xl p-6"><PageHeader title="AI document helpers" description="Not available in this workspace." /></div>;
  return (
    <ToolsFrame entryKey={feature ?? "ask"} title="AI document helpers" description="Summaries, answers, translations and details read from your documents." usage={false} testId="tools-ai">
      <AiUsageLine usage={usage.data} />
      <div role="tablist" aria-label="AI helpers" className="grid grid-cols-2 gap-1 rounded-xl bg-elevated p-1 sm:flex sm:overflow-x-auto">
        {features.map((f) => (
          <button key={f} role="tab" aria-selected={f === feature} type="button" onClick={() => { const n = new URLSearchParams(params); n.set("feature", f); setParams(n, { replace: true }); }}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-center text-sm max-sm:min-h-11 max-sm:last:odd:col-span-2 ${f === feature ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-fg"}`}>{LABELS[f]}</button>
        ))}
      </div>
      <Card className="p-4 sm:p-5" role="tabpanel">
        {feature === "ask" && <AskPanel src={src} setSrc={setSrc} />}
        {feature === "translate" && <TranslatePanel src={src} setSrc={setSrc} languages={usage.data.languages} pageCap={usage.data.caps.translatePages} />}
        {feature === "extract" && <InvoicesPanel src={src} maxFiles={usage.data.caps.extractFiles} />}
        {feature === "expenses" && <ExpensesPanel />}
        {feature === "contracts" && <ContractPanel src={src} setSrc={setSrc} />}
      </Card>
      <p className="text-xs text-muted">Document text is sent to our infrastructure provider's AI service, or to your workspace's own AI provider when a key is set. It is not used for training and is not kept after the answer.</p>
    </ToolsFrame>
  );
}
