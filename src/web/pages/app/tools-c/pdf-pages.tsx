/**
 * R100 Tools C: three PDF pages that run on the device. Fix a PDF (repair, fast web view, lock with a password; qpdf),
 * QR and barcodes on a PDF (pdf-lib), and Read comments (pdf.js). Nothing is uploaded and no run is counted.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { sizeLabel } from "@/web/components/tools/tool-directory";
import { useLeaveGuard } from "@/web/components/tools/leave-guard";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { CopyButton, Skeleton } from "@/web/components/ui/misc";
import { IconDownload, IconUpload } from "@/web/components/ui/icon";
import { saveFile } from "@/web/lib/tool-jobs";
import type { FixOp } from "@/web/lib/pdf-c/qpdf";
import type { CodeKind, Spot } from "@/web/lib/pdf-c/codes";
import type { PdfNote } from "@/web/lib/pdf-c/annotations";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const MAX = 100 * 1024 * 1024;

/** The drop zone every page here starts with: choose, drop or paste a PDF. */
function PdfDrop({ onFile, busy, error, testId, hint }: { onFile: (f: File) => void; busy?: boolean; error?: string | null; testId: string; hint: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const take = (f?: File | null) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { toast.error(`${f.name} is not a PDF.`); return; }
    if (f.size > MAX) { toast.error(`${f.name} is over 100 MB. Split it first.`); return; }
    onFile(f);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); };
  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <button type="button" onClick={() => input.current?.click()} disabled={busy} data-testid={`${testId}-drop`}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors duration-150 ${drag ? "border-brand bg-brand/5" : "border-line-strong hover:border-brand/60 hover:bg-hover"} ${ring}`}>
        <IconUpload className="h-7 w-7 text-brand" aria-hidden />
        <span className="text-[15px] font-semibold">{busy ? "Opening the PDF" : "Choose a PDF or drop it here"}</span>
        <span className="text-[13px] text-muted">{hint}</span>
      </button>
      <input ref={input} type="file" accept=".pdf,application/pdf" className="sr-only" tabIndex={-1} aria-hidden data-testid={`${testId}-input`}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; take(f); }} />
      {error && <p role="alert" className="mt-3 text-[13px] text-bad" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  );
}

function FileRow({ file, onClear, children }: { file: File; onClear: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium" title={file.name}>{file.name}</span>
      <span className="text-[13px] text-muted tabular-nums">{sizeLabel(file.size)}</span>
      {children}
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>Choose another</Button>
    </div>
  );
}

function Done({ name, bytes, notes, onAgain, testId }: { name: string; bytes: Uint8Array; notes?: string[]; onAgain: () => void; testId: string }) {
  const save = () => saveFile(new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
  return (
    <div className="space-y-3 rounded-2xl border border-ok/30 bg-ok/5 p-4" data-testid={`${testId}-done`} role="status">
      <p className="text-[15px] font-semibold">Ready: {name} <span className="font-normal text-muted">({sizeLabel(bytes.byteLength)})</span></p>
      {notes?.length ? <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={save} data-testid={`${testId}-download`}><IconDownload className="h-4 w-4" aria-hidden />Download</Button>
        <Button type="button" variant="secondary" onClick={onAgain}>Start over</Button>
      </div>
    </div>
  );
}

const outName = (name: string, suffix: string) => name.replace(/\.pdf$/i, "") + suffix + ".pdf";

/* ---------------- Fix a PDF ---------------- */

const FIX_OPS: { id: FixOp; label: string; line: string }[] = [
  { id: "repair", label: "Repair", line: "Rebuild a PDF that will not open or shows errors." },
  { id: "linearize", label: "Fast web view", line: "Reorder the file so the first page shows while the rest loads." },
  { id: "encrypt", label: "Lock with a password", line: "Strong encryption (AES 256); choose whether people can print or copy." },
];

export function PdfFixPage() {
  const [file, setFile] = useState<File | null>(null);
  const [op, setOp] = useState<FixOp>("repair");
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [owner, setOwner] = useState("");
  const [allowPrint, setAllowPrint] = useState(true); const [allowCopy, setAllowCopy] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; notes: string[] } | null>(null);
  const leaveGuard = useLeaveGuard(!!file && !result && busy);
  const mismatch = op === "encrypt" && pw2.length > 0 && pw !== pw2;
  const run = async () => {
    if (!file) return;
    if (op === "encrypt" && pw !== pw2) { setError("The two passwords do not match."); return; }
    setBusy(true); setError(null);
    try {
      const { fixPdf } = await import("@/web/lib/pdf-c/qpdf");
      const out = await fixPdf(new Uint8Array(await file.arrayBuffer()), op, { password: current || undefined, encrypt: op === "encrypt" ? { userPassword: pw, ownerPassword: owner || undefined, allowPrint, allowCopy } : undefined });
      const notes = [...out.warnings];
      if (op === "repair" && !notes.length) notes.push("No problems were found; the file was rewritten cleanly.");
      if (op === "encrypt") notes.push("Keep the password safe. Nobody, including us, can open the file without it.");
      setResult({ bytes: out.bytes, notes });
    } catch (e) { setError((e as Error).message || "This PDF could not be fixed."); }
    finally { setBusy(false); }
  };
  const reset = () => { setFile(null); setResult(null); setError(null); setPw(""); setPw2(""); setOwner(""); setCurrent(""); };
  return (
    <ToolsFrame entryKey="pdf-fix" title="Fix a PDF" description="Repair a damaged PDF, make it open fast on the web, or lock it with a password. It all happens on your device." usage={false} testId="pdf-fix">
      {leaveGuard}
      {!file ? <PdfDrop onFile={(f) => { setFile(f); setResult(null); setError(null); }} testId="pdf-fix" hint="Up to 100 MB. Nothing is uploaded." /> : result ? (
        <Done name={outName(file.name, op === "repair" ? " (repaired)" : op === "linearize" ? " (web)" : " (locked)")} bytes={result.bytes} notes={result.notes} onAgain={reset} testId="pdf-fix" />
      ) : (
        <div className="space-y-4">
          <FileRow file={file} onClear={reset} />
          <fieldset className="grid gap-2 sm:grid-cols-3" data-testid="pdf-fix-ops">
            <legend className="sr-only">What to do</legend>
            {FIX_OPS.map((o) => (
              <label key={o.id} className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors duration-150 ${op === o.id ? "border-brand bg-brand/5" : "border-line hover:bg-hover"}`}>
                <span className="flex items-center gap-2 text-[14px] font-semibold"><input type="radio" name="fix-op" value={o.id} checked={op === o.id} onChange={() => { setOp(o.id); setError(null); }} className={ring} data-testid={`pdf-fix-op-${o.id}`} />{o.label}</span>
                <span className="text-[13px] text-muted">{o.line}</span>
              </label>
            ))}
          </fieldset>
          {op === "encrypt" && (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="pdf-fix-encrypt">
              <label className="space-y-1.5"><span className="block text-[13px] font-medium">Password to open</span><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="pdf-fix-pw" /></label>
              <label className="space-y-1.5"><span className="block text-[13px] font-medium">Type it again</span><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch || undefined} data-testid="pdf-fix-pw2" />{mismatch && <span className="block text-xs text-bad">The passwords do not match.</span>}</label>
              <label className="space-y-1.5 sm:col-span-2"><span className="block text-[13px] font-medium">Owner password <span className="font-normal text-subtle">(optional, lets you change the limits later)</span></span><Input type="password" autoComplete="new-password" value={owner} onChange={(e) => setOwner(e.target.value)} /></label>
              <label className="flex min-h-11 items-center gap-2 text-[14px]"><input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} className={ring} />Allow printing</label>
              <label className="flex min-h-11 items-center gap-2 text-[14px]"><input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} className={ring} />Allow copying text</label>
            </div>
          )}
          <details className="rounded-xl border border-line px-3 py-2 text-[13px]"><summary className={`cursor-pointer py-1 font-medium ${ring}`}>This PDF already has a password</summary>
            <label className="mt-2 block space-y-1.5"><span className="block text-muted">Its current password</span><Input type="password" autoComplete="off" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="pdf-fix-current" /></label>
          </details>
          {error && <p role="alert" className="text-[13px] text-bad" data-testid="pdf-fix-error">{error}</p>}
          <div className="flex items-center gap-3">
            <Button type="button" onClick={() => void run()} disabled={busy || (op === "encrypt" && (!pw || mismatch))} data-testid="pdf-fix-run">{busy ? "Working" : FIX_OPS.find((o) => o.id === op)!.label}</Button>
            {busy && <span className="text-[13px] text-muted" aria-live="polite">Working on your device. Big files take a little longer.</span>}
          </div>
        </div>
      )}
    </ToolsFrame>
  );
}

/* ---------------- QR and barcodes on a PDF ---------------- */

const SPOT_LABEL: Record<Spot, string> = { "top-left": "Top left", top: "Top", "top-right": "Top right", left: "Left", center: "Middle", right: "Right", "bottom-left": "Bottom left", bottom: "Bottom", "bottom-right": "Bottom right" };

export function PdfCodesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<{ width: number; height: number }[]>([]);
  const [kind, setKind] = useState<CodeKind>("qr");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"all" | "first" | "list">("first");
  const [list, setList] = useState("");
  const [spot, setSpot] = useState<Spot>("bottom-right");
  const [size, setSize] = useState(96);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Uint8Array | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const opened = useRef<{ draw: (p: number, c: HTMLCanvasElement, w: number) => Promise<void>; close: () => void } | null>(null);
  const leaveGuard = useLeaveGuard(!!file && !result && !!text);
  useEffect(() => () => opened.current?.close(), []);
  const open = async (f: File) => {
    setBusy(true); setError(null);
    try {
      const { openForEdit } = await import("@/web/lib/convert/pdf-edit");
      opened.current?.close();
      const doc = await openForEdit(f);
      opened.current = doc; setPages(doc.pages); setFile(f); setResult(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (file && canvas.current && opened.current) void opened.current.draw(0, canvas.current, 260).catch(() => {}); }, [file]);
  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const { stampCode, parsePageList } = await import("@/web/lib/pdf-c/codes");
      const target = where === "all" ? "all" as const : where === "first" ? [1] : parsePageList(list);
      setResult(await stampCode(new Uint8Array(await file.arrayBuffer()), { kind, text: text.trim(), pages: target, spot, size, label: true }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const reset = () => { opened.current?.close(); opened.current = null; setFile(null); setResult(null); setError(null); setPages([]); };
  const first = pages[0];
  const box = kind === "qr" ? { w: size, h: size } : { w: size, h: Math.round(size / 3) + 12 };
  return (
    <ToolsFrame entryKey="pdf-codes" title="QR and barcodes on a PDF" description="Put a QR code or a barcode on any page, at the size and spot you choose. It all happens on your device." usage={false} testId="pdf-codes">
      {leaveGuard}
      {!file ? <PdfDrop onFile={(f) => void open(f)} busy={busy} error={error} testId="pdf-codes" hint="Up to 100 MB and 300 pages. Nothing is uploaded." /> : result ? (
        <Done name={outName(file.name, " (with code)")} bytes={result} onAgain={reset} testId="pdf-codes" />
      ) : (
        <div className="space-y-4">
          <FileRow file={file} onClear={reset}><span className="text-[13px] text-muted">{pages.length} {pages.length === 1 ? "page" : "pages"}</span></FileRow>
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <div className="space-y-3">
              <div role="group" aria-label="Kind of code" className="flex w-fit rounded-lg bg-fill p-0.5">
                {(["qr", "code128"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setSize(k === "qr" ? 96 : 180); }} className={`h-9 rounded-md px-3 text-[13px] max-sm:h-11 ${kind === k ? "bg-surface font-medium shadow-sm" : "text-muted"} ${ring}`} data-testid={`pdf-codes-kind-${k}`}>{k === "qr" ? "QR code" : "Barcode"}</button>)}
              </div>
              <label className="block space-y-1.5"><span className="block text-[13px] font-medium">{kind === "qr" ? "Link or text" : "Text or number (letters, digits and symbols)"}</span>
                <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "qr" ? "https://multies.si/invoice/42" : "INV-2026-0042"} data-testid="pdf-codes-text" /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5"><span className="block text-[13px] font-medium">Pages</span>
                  <Select value={where} onChange={(e) => setWhere(e.target.value as typeof where)} data-testid="pdf-codes-pages"><option value="first">First page</option><option value="all">Every page</option><option value="list">Pages I choose</option></Select></label>
                {where === "list" && <label className="block space-y-1.5"><span className="block text-[13px] font-medium">Which pages</span><Input value={list} onChange={(e) => setList(e.target.value)} placeholder="1, 3-5" data-testid="pdf-codes-list" /></label>}
                <label className="block space-y-1.5"><span className="block text-[13px] font-medium">Size: {size} points</span>
                  <input type="range" min={36} max={kind === "qr" ? 240 : 360} step={4} value={size} onChange={(e) => setSize(Number(e.target.value))} className={`w-full accent-[var(--brand)] ${ring}`} data-testid="pdf-codes-size" aria-valuetext={`${size} points`} /></label>
              </div>
              <fieldset><legend className="mb-1.5 text-[13px] font-medium">Where on the page</legend>
                <div className="grid w-fit grid-cols-3 gap-1" data-testid="pdf-codes-spots">
                  {(Object.keys(SPOT_LABEL) as Spot[]).map((s) => <button key={s} type="button" aria-pressed={spot === s} aria-label={SPOT_LABEL[s]} title={SPOT_LABEL[s]} onClick={() => setSpot(s)} className={`h-11 w-11 rounded-lg border transition-colors duration-150 ${spot === s ? "border-brand bg-brand/15" : "border-line hover:bg-hover"} ${ring}`} />)}
                </div>
              </fieldset>
            </div>
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-muted">Page 1 preview</p>
              <div className="relative w-fit overflow-hidden rounded-lg border border-line bg-white" data-testid="pdf-codes-preview">
                <canvas ref={canvas} className="block" style={{ width: 260 }} aria-label="First page" />
                {first && (() => {
                  const k = 260 / first.width, m = 24 * k, w = box.w * k, h = box.h * k, W = 260, H = first.height * k;
                  const left = spot.endsWith("left") ? m : spot.endsWith("right") ? W - m - w : (W - w) / 2;
                  const top = spot.startsWith("top") ? m : spot.startsWith("bottom") ? H - m - h : (H - h) / 2;
                  return <div aria-hidden className="absolute rounded-sm border-2 border-brand bg-brand/20 transition-all duration-150" style={{ left, top, width: w, height: h }} />;
                })()}
              </div>
            </div>
          </div>
          {error && <p role="alert" className="text-[13px] text-bad" data-testid="pdf-codes-error">{error}</p>}
          <Button type="button" onClick={() => void run()} disabled={busy || !text.trim()} data-testid="pdf-codes-run">{busy ? "Adding" : kind === "qr" ? "Add the QR code" : "Add the barcode"}</Button>
        </div>
      )}
    </ToolsFrame>
  );
}

/* ---------------- Read comments ---------------- */

export function PdfCommentsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState<PdfNote[] | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [label, setLabel] = useState<Record<string, string>>({});
  const open = async (f: File) => {
    setFile(f); setNotes(null); setError(null); setProgress([0, 0]);
    try {
      const lib = await import("@/web/lib/pdf-c/annotations");
      setLabel(lib.NOTE_LABEL);
      const r = await lib.readNotes(f, (d, t) => setProgress([d, t]));
      setNotes(r.notes);
    } catch (e) { setError((e as Error).message); setFile(null); } finally { setProgress(null); }
  };
  const shown = (notes ?? []).filter((n) => filter === "all" || n.kind === filter);
  const kinds = [...new Set((notes ?? []).map((n) => n.kind))];
  const [asText, setAsText] = useState("");
  useEffect(() => { if (file && notes) void import("@/web/lib/pdf-c/annotations").then((l) => setAsText(l.notesAsText(file.name, shown))); }, [file, notes, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ToolsFrame entryKey="pdf-comments" title="Read comments" description="See every comment and highlight in a PDF, page by page, with who wrote it and when. It all happens on your device." usage={false} testId="pdf-comments">
      {!file ? <PdfDrop onFile={(f) => void open(f)} error={error} testId="pdf-comments" hint="Up to 100 MB. Nothing is uploaded." /> : (
        <div className="space-y-4">
          <FileRow file={file} onClear={() => { setFile(null); setNotes(null); }} />
          {progress && <div className="space-y-2" aria-busy="true" data-testid="pdf-comments-loading"><p className="text-[13px] text-muted">Reading page {progress[0]} of {progress[1] || "?"}</p><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>}
          {notes && notes.length === 0 && <div className="rounded-2xl border border-line p-6 text-center" data-testid="pdf-comments-empty"><p className="text-[15px] font-semibold">No comments in this PDF</p><p className="mt-1 text-[13px] text-muted">It has no comments, highlights or notes to show.</p></div>}
          {notes && notes.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="pdf-comments-filter"><option value="all">All ({notes.length})</option>{kinds.map((k) => <option key={k} value={k}>{label[k]} ({notes.filter((n) => n.kind === k).length})</option>)}</Select>
                <CopyButton value={asText} label="Copy all" toastText="Copied" />
              </div>
              <ol className="space-y-2" data-testid="pdf-comments-list">
                {shown.map((n, i) => (
                  <li key={i} className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted"><span className="rounded-md bg-fill px-1.5 py-0.5 font-medium text-fg">Page {n.page}</span><span>{label[n.kind]}</span>{n.author && <span>· {n.author}</span>}{n.date && <span>· {n.date.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</span>}{n.replies > 0 && <span>· {n.replies} {n.replies === 1 ? "reply" : "replies"}</span>}</div>
                    {n.marked && <blockquote className="mt-2 border-l-2 border-brand/60 pl-2 text-[14px] italic">{n.marked}</blockquote>}
                    {n.text && <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px]">{n.text}</p>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </ToolsFrame>
  );
}
