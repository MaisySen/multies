/**
 * R78 Convert hub (/app/tools/convert): file first, not tool first. Drop any file, or many at once; Multies reads what
 * each one is and shows what it can become (src/shared/convert-routes.ts plans the route, up to three steps). Images,
 * PDF basics and spreadsheets run in the browser with nothing uploaded; anything the browser cannot do goes to the
 * Multies engine through the normal Tools job. Results land in a tray with progress per file, a download for each,
 * and one ZIP for all of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ACTIONS, actionsFor, commonTargets, formatDef, formatOf, parseRanges, routeLine, routeTo, FORMATS,
  type ActionDef, type BrowserCaps, type FormatId, type PlanOptions, type Route,
} from "@/shared/convert-routes";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { useToolsInfo } from "@/web/components/tools/use-tools-info";
import { runsLeft, sizeLabel, middleTruncate, takeCarried } from "@/web/components/tools/tool-directory";
import { Button } from "@/web/components/ui/button";
import {
  IconArrowDown, IconArrowUp, IconCheckCircle, IconClose, IconDownload, IconFile, IconImage, IconServer, IconSheet,
  IconShieldCheck, IconUpload, IconWarning, IconDocs,
} from "@/web/components/ui/icon";
import { measureCaps } from "@/web/lib/convert/caps";
import { downloadName, loadOps, runRoute, type Progress } from "@/web/lib/convert/run";
import { saveFile } from "@/web/lib/tool-jobs";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const MAX_FILES = 50;
const MAX_LOCAL_BYTES = 200 * 1024 * 1024;

interface Picked { id: string; file: File; fmt: FormatId | null; note?: string }
type JobStatus = "waiting" | "running" | "done" | "failed";
interface Job {
  id: string; title: string; status: JobStatus; progress: number; label: string; local: boolean;
  outputs: File[]; error?: string; to?: FormatId; thumb?: string; startedAt?: number; ms?: number;
}

let seq = 0;
const nextId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;
const familyIcon = (f: FormatId | null) => {
  if (!f) return IconFile;
  const fam = formatDef(f).family;
  return fam === "image" ? IconImage : fam === "sheet" ? IconSheet : fam === "pdf" ? IconDocs : IconFile;
};
const QUALITY = [{ v: 0.92, label: "High" }, { v: 0.8, label: "Balanced" }, { v: 0.6, label: "Smaller" }];
const IMAGE_OUT = new Set<FormatId>(["jpg", "webp", "avif"]);

/** Every extension the hub knows, for the file chooser. */
const ACCEPT = FORMATS.flatMap((f) => f.exts.map((e) => `.${e}`)).join(",");

export function ConvertHubPage() {
  const info = useToolsInfo();
  const [files, setFiles] = useState<Picked[]>([]);
  const [heicOk, setHeicOk] = useState(true);
  const [target, setTarget] = useState<FormatId | null>(null);
  const [action, setAction] = useState<ActionDef["id"] | null>(null);
  const [quality, setQuality] = useState(0.92);
  const [ranges, setRanges] = useState("");
  const [turn, setTurn] = useState<90 | 180 | 270>(90);
  const [numStyle, setNumStyle] = useState<"n" | "page n of N">("n");
  const [numPos, setNumPos] = useState<"bottom-center" | "bottom-right">("bottom-center");
  const [pageSize, setPageSize] = useState<"image" | "a4">("image");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const [zipping, setZipping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const thumbs = useRef<string[]>([]);

  const caps: BrowserCaps = useMemo(() => measureCaps(heicOk), [heicOk]);
  const left = info.data ? runsLeft(info.data.usage, info.data.limits) : null;
  const plan: PlanOptions = useMemo(() => ({ features: info.data?.features ?? [], engine: !!info.data?.enabled && (left?.left ?? 0) > 0, caps }), [info.data, left?.left, caps]);

  const usable = files.filter((f) => f.fmt && !f.note);
  const fmts = usable.map((f) => f.fmt!) as FormatId[];
  const targets = useMemo(() => commonTargets(fmts, plan), [fmts.join(","), plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useMemo(() => actionsFor(fmts), [fmts.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the choice valid as files come and go.
  useEffect(() => { if (target && !targets.some((t) => t.to === target)) setTarget(null); }, [targets, target]);
  useEffect(() => { if (action && !actions.some((a) => a.id === action)) setAction(null); }, [actions, action]);
  useEffect(() => () => { thumbs.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const add = useCallback((list: File[]) => {
    if (!list.length) return;
    const picked: Picked[] = list.map((file) => {
      const fmt = formatOf(file.name, file.type);
      const note = !fmt ? "Multies can't convert this kind of file yet." : file.size === 0 ? "This file is empty." : undefined;
      return { id: nextId(), file, fmt, note };
    });
    setFiles((cur) => [...cur, ...picked].slice(0, MAX_FILES));
    const heic = picked.find((p) => p.fmt === "heic");
    if (heic) {
      void loadOps().then((o) => o.browserOpensHeic(heic.file)).then((ok) => {
        setHeicOk(ok);
        if (!ok) setFiles((cur) => cur.map((p) => (p.fmt === "heic" ? { ...p, note: "This browser can't open HEIC photos. Open Multies in Safari on an iPhone or Mac, or share the photo as JPG." } : p)));
      });
    }
  }, []);

  // A file handed over from the Tools list (dropped there) arrives here.
  useEffect(() => { const c = takeCarried(); if (c.length) add(c); }, [add]);

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); };
  const move = (id: string, by: -1 | 1) => setFiles((cur) => {
    const i = cur.findIndex((f) => f.id === id), j = i + by;
    if (i < 0 || j < 0 || j >= cur.length) return cur;
    const next = [...cur]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const remove = (id: string) => setFiles((cur) => cur.filter((f) => f.id !== id));

  const chosenRoutes: Route[] = useMemo(() => {
    if (!target) return [];
    const seen = new Map<FormatId, Route | null>();
    for (const f of fmts) if (f !== target && !seen.has(f)) seen.set(f, routeTo(f, target, plan));
    return [...seen.values()].filter((r): r is Route => !!r);
  }, [target, fmts.join(","), plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const allLocal = action ? true : chosenRoutes.every((r) => r.local);
  const engineRuns = action ? 0 : (targets.find((t) => t.to === target)?.engineRuns ?? 0);
  const tooBigLocal = usable.some((f) => f.file.size > MAX_LOCAL_BYTES);
  const busy = jobs.some((j) => j.status === "running" || j.status === "waiting");
  const ready = !!usable.length && (!!target || !!action) && !tooBigLocal;

  const patch = (id: string, p: Partial<Job>) => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const makeThumb = (out: File[]): string | undefined => {
    const img = out.find((f) => /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(f.type));
    if (!img || img.size > 15 * 1024 * 1024) return undefined;
    const u = URL.createObjectURL(img); thumbs.current.push(u); return u;
  };

  async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t); }));
  }

  async function start() {
    if (!ready) return;
    const list = [...usable];
    if (action) {
      const def = ACTIONS.find((a) => a.id === action)!;
      const units = def.combine ? [list] : list.map((p) => [p]);
      const made: Job[] = units.map((u) => ({ id: nextId(), title: def.combine ? `${def.label}: ${u.length} files` : u[0].file.name, status: "waiting", progress: 0, label: "Waiting", local: true, outputs: [] }));
      setJobs((cur) => [...made, ...cur]);
      await pool(units.map((u, i) => ({ u, job: made[i] })), 2, async ({ u, job }) => {
        const t0 = performance.now();
        patch(job.id, { status: "running", label: `${def.label} on your device`, progress: 0.15, startedAt: Date.now() });
        try {
          const o = await loadOps();
          let outputs: File[] = [];
          const first = u[0].file;
          if (def.id === "merge") outputs = [await o.mergePdfs(u.map((p) => p.file), first.name.replace(/\.pdf$/i, "-merged.pdf"))];
          else if (def.id === "images-pdf") outputs = [await o.imagesToPdf(u.map((p) => ({ file: p.file, from: p.fmt! })), `${first.name.replace(/\.[^.]+$/, "")}-images.pdf`, { pageSize })];
          else if (def.id === "split") {
            const n = await o.pageCount(first);
            const r = ranges.trim() ? parseRanges(ranges, n) : null;
            if (ranges.trim() && !r) throw new Error(`Those pages don't fit this PDF (${n} pages). Try 1-3, 5.`);
            outputs = await o.splitPdf(first, r);
          } else if (def.id === "rotate") outputs = [await o.rotatePdf(first, turn)];
          else if (def.id === "numbers") outputs = [await o.numberPdf(first, { style: numStyle, position: numPos })];
          patch(job.id, { status: "done", progress: 1, label: "Done on your device", outputs, ms: Math.round(performance.now() - t0) });
        } catch (err) {
          patch(job.id, { status: "failed", progress: 1, label: "Not done", error: (err as Error).message || "That didn't work." });
        }
      });
      return;
    }
    const to = target!;
    const made: Job[] = list.map((p) => ({ id: nextId(), title: p.file.name, status: "waiting", progress: 0, label: "Waiting", local: p.fmt === to || !!routeTo(p.fmt!, to, plan)?.local, outputs: [], to }));
    setJobs((cur) => [...made, ...cur]);
    await pool(list.map((p, i) => ({ p, job: made[i] })), 2, async ({ p, job }) => {
      const t0 = performance.now();
      if (p.fmt === to) { patch(job.id, { status: "done", progress: 1, label: `Already ${formatDef(to).label}, kept as it is`, outputs: [p.file] }); return; }
      const route = routeTo(p.fmt!, to, plan);
      if (!route) { patch(job.id, { status: "failed", progress: 1, label: "Not done", error: `${formatDef(p.fmt!).label} can't become ${formatDef(to).label} here.` }); return; }
      patch(job.id, { status: "running", startedAt: Date.now() });
      try {
        const outputs = await runRoute(route, p.file, { quality: IMAGE_OUT.has(to) ? quality : undefined, onProgress: (pr: Progress) => patch(job.id, { progress: Math.max(0.03, pr.fraction), label: pr.label }) });
        patch(job.id, { status: "done", progress: 1, label: route.local ? "Done on your device" : "Done", outputs, thumb: makeThumb(outputs), ms: Math.round(performance.now() - t0) });
      } catch (err) {
        patch(job.id, { status: "failed", progress: 1, label: "Not done", error: (err as Error).message || "That didn't work." });
      }
    });
    void info.refetch();
  }

  async function downloadJob(j: Job) {
    if (j.outputs.length === 1) { saveFile(j.outputs[0], j.outputs[0].name); return; }
    const o = await loadOps();
    saveFile(await o.zipFiles(j.outputs), downloadName(j.title, j.outputs, j.to));
  }
  const done = jobs.filter((j) => j.status === "done");
  async function downloadAll() {
    setZipping(true);
    try {
      const o = await loadOps();
      saveFile(await o.zipFiles(done.flatMap((j) => j.outputs)), `multies-converted-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally { setZipping(false); }
  }
  const clearTray = () => { thumbs.current.forEach((u) => URL.revokeObjectURL(u)); thumbs.current = []; setJobs((cur) => cur.filter((j) => j.status === "running" || j.status === "waiting")); };

  const runLabel = action
    ? `${ACTIONS.find((a) => a.id === action)!.label}`
    : target ? `Convert ${usable.length} ${usable.length === 1 ? "file" : "files"} to ${formatDef(target).label}` : "Choose what to make";

  return (
    <ToolsFrame entryKey="convert-any" title="Convert any file" description="Drop files first. Multies shows what each one can become, and most jobs never leave your device." wide testId="convert-hub">
      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop} className="space-y-5">
        <button type="button" onClick={() => inputRef.current?.click()} data-testid="convert-drop"
          className={`group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 text-center transition-[background-color,border-color,padding] duration-200 ${files.length ? "py-6" : "py-12 sm:py-16"} ${dragging ? "border-brand bg-brand/10" : "border-line-strong bg-surface hover:border-brand/60 hover:bg-brand/5"} ${ring}`}>
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5 ${dragging ? "motion-safe:scale-110" : ""}`}><IconUpload className="h-6 w-6" aria-hidden /></span>
          <span className="text-[16px] font-semibold text-fg">{dragging ? "Drop to add" : files.length ? "Add more files" : "Drop any files here, or choose files"}</span>
          <span className="max-w-xl text-[13.5px] text-muted">Many at once. Photos, PDFs, spreadsheets, Word and PowerPoint files. Up to {MAX_FILES} files.</span>
        </button>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="sr-only" data-testid="convert-input" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />

        {!files.length && (
          <div className="flex flex-wrap justify-center gap-1.5" aria-label="Formats Multies reads" data-testid="convert-formats">
            {FORMATS.map((f) => <span key={f.id} className="rounded-full border border-line px-2.5 py-1 text-[12px] font-medium text-muted">{f.label}</span>)}
          </div>
        )}

        {!!files.length && (
          <section aria-labelledby="cv-files" className="rounded-2xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 id="cv-files" className="text-[14px] font-semibold">Your files <span className="font-normal text-muted">{files.length}</span></h2>
              <button type="button" onClick={() => setFiles([])} className={`rounded-lg px-2 py-1 text-[13px] text-muted hover:text-fg ${ring}`} data-testid="convert-clear-files">Clear</button>
            </div>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto" data-testid="convert-file-list">
              {files.map((p, i) => {
                const Icon = familyIcon(p.fmt);
                return (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="convert-file">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill text-muted"><Icon className="h-4 w-4" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium" title={p.file.name}>{middleTruncate(p.file.name, 46)}</p>
                      <p className={`text-[12px] ${p.note ? "text-warn" : "text-muted"}`}>{p.note ?? `${p.fmt ? formatDef(p.fmt).label : ""} · ${sizeLabel(p.file.size)}`}</p>
                    </div>
                    {files.length > 1 && (
                      <span className="flex shrink-0 items-center">
                        <button type="button" aria-label={`Move ${p.file.name} up`} disabled={i === 0} onClick={() => move(p.id, -1)} className={`flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover disabled:opacity-30 max-sm:h-11 max-sm:w-9 ${ring}`}><IconArrowUp className="h-4 w-4" /></button>
                        <button type="button" aria-label={`Move ${p.file.name} down`} disabled={i === files.length - 1} onClick={() => move(p.id, 1)} className={`flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover disabled:opacity-30 max-sm:h-11 max-sm:w-9 ${ring}`}><IconArrowDown className="h-4 w-4" /></button>
                      </span>
                    )}
                    <button type="button" aria-label={`Remove ${p.file.name}`} onClick={() => remove(p.id)} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11 ${ring}`}><IconClose className="h-4 w-4" /></button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!!usable.length && (
          <section aria-labelledby="cv-make" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
            <div>
              <h2 id="cv-make" className="text-[14px] font-semibold">Turn {usable.length === 1 ? "it" : "them"} into</h2>
              {targets.length ? (
                <div role="radiogroup" aria-label="Turn into" className="mt-2.5 flex flex-wrap gap-2" data-testid="convert-targets">
                  {targets.map((t) => {
                    const on = target === t.to;
                    return (
                      <button key={t.to} type="button" role="radio" aria-checked={on} onClick={() => { setTarget(on ? null : t.to); setAction(null); }} data-testid={`convert-to-${t.to}`}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[13.5px] font-medium transition-colors max-sm:min-h-11 ${on ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-fg hover:border-brand/60 hover:bg-brand/5"} ${ring}`}
                        title={t.local ? "Runs on your device" : `Uses the Multies engine (${t.engineRuns} ${t.engineRuns === 1 ? "run" : "runs"})`}>
                        {formatDef(t.to).label}
                        {!t.local && <IconServer className={`h-3.5 w-3.5 ${on ? "text-brand-fg/80" : "text-subtle"}`} aria-label="uses the Multies engine" />}
                      </button>
                    );
                  })}
                </div>
              ) : <p className="mt-2 text-[13.5px] text-muted" data-testid="convert-no-targets">These files have no format in common. Convert them in smaller groups of the same kind.</p>}
            </div>

            {!!actions.length && (
              <div>
                <h3 className="text-[13px] font-semibold text-muted">Or do this</h3>
                <div className="mt-2 flex flex-wrap gap-2" data-testid="convert-actions">
                  {actions.map((a) => {
                    const on = action === a.id;
                    return (
                      <button key={a.id} type="button" aria-pressed={on} onClick={() => { setAction(on ? null : a.id); setTarget(null); }} data-testid={`convert-action-${a.id}`} title={a.line}
                        className={`inline-flex h-9 items-center rounded-xl border px-3 text-[13.5px] font-medium transition-colors max-sm:min-h-11 ${on ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-fg hover:border-brand/60 hover:bg-brand/5"} ${ring}`}>{a.label}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {target && IMAGE_OUT.has(target) && (
              <Choice label="Quality" value={String(quality)} onChange={(v) => setQuality(Number(v))} options={QUALITY.map((q) => ({ value: String(q.v), label: q.label }))} testId="convert-quality" />
            )}
            {action === "split" && (
              <label className="block max-w-sm">
                <span className="text-[13px] font-medium">Pages</span>
                <input value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="Every page on its own" data-testid="convert-ranges"
                  className={`mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 text-[14px] placeholder:text-subtle ${ring}`} />
                <span className="mt-1 block text-[12px] text-muted">Leave empty for one PDF per page, or type ranges like 1-3, 5.</span>
              </label>
            )}
            {action === "rotate" && <Choice label="Turn" value={String(turn)} onChange={(v) => setTurn(Number(v) as 90 | 180 | 270)} options={[{ value: "90", label: "Right" }, { value: "180", label: "Upside down" }, { value: "270", label: "Left" }]} testId="convert-turn" />}
            {action === "numbers" && (
              <div className="flex flex-wrap gap-4">
                <Choice label="Style" value={numStyle} onChange={(v) => setNumStyle(v as "n" | "page n of N")} options={[{ value: "n", label: "1, 2, 3" }, { value: "page n of N", label: "Page 1 of 9" }]} testId="convert-num-style" />
                <Choice label="Position" value={numPos} onChange={(v) => setNumPos(v as "bottom-center" | "bottom-right")} options={[{ value: "bottom-center", label: "Bottom middle" }, { value: "bottom-right", label: "Bottom right" }]} testId="convert-num-pos" />
              </div>
            )}
            {action === "images-pdf" && <Choice label="Page size" value={pageSize} onChange={(v) => setPageSize(v as "image" | "a4")} options={[{ value: "image", label: "Same as each image" }, { value: "a4", label: "A4" }]} testId="convert-page-size" />}

            {(target || action) && (
              <div className={`flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px] ${allLocal ? "bg-ok-soft text-fg" : "bg-fill text-fg"}`} data-testid={allLocal ? "convert-local-note" : "convert-engine-note"} role="note">
                {allLocal ? <IconShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> : <IconServer className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />}
                <div>
                  {allLocal
                    ? <p><span className="font-semibold">Stays on your device.</span> Nothing is uploaded and no run is used.</p>
                    : <p><span className="font-semibold">Part of this uses the Multies engine</span> ({engineRuns} {engineRuns === 1 ? "run" : "runs"}). Files are sent over a secure connection and deleted from the engine within an hour.</p>}
                  {!action && chosenRoutes.length > 0 && <p className="mt-0.5 text-muted" data-testid="convert-route">{chosenRoutes.map((r) => `${formatDef(r.from).label}: ${routeLine(r)}`).join(". ")}.</p>}
                </div>
              </div>
            )}
            {tooBigLocal && <p className="flex items-center gap-2 text-[13px] text-warn"><IconWarning className="h-4 w-4" aria-hidden />A file is over {sizeLabel(MAX_LOCAL_BYTES)}, too large to convert here.</p>}

            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => void start()} disabled={!ready} data-testid="convert-run" className="max-sm:w-full">{runLabel}</Button>
              {busy && <span className="text-[13px] text-muted" role="status">Working. You can add more files while this runs.</span>}
            </div>
          </section>
        )}

        {!!jobs.length && (
          <section aria-labelledby="cv-tray" className="rounded-2xl border border-line bg-surface" data-testid="convert-tray">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 id="cv-tray" className="text-[14px] font-semibold">Results <span className="font-normal text-muted" data-testid="convert-tray-count">{done.length} of {jobs.length} ready</span></h2>
              <div className="flex items-center gap-2">
                {done.length > 1 && <Button size="sm" onClick={() => void downloadAll()} loading={zipping} data-testid="convert-download-all"><IconDownload className="h-4 w-4" aria-hidden />Download all as ZIP</Button>}
                {!busy && <Button size="sm" variant="ghost" onClick={clearTray} data-testid="convert-clear-tray">Clear</Button>}
              </div>
            </div>
            <ul className="divide-y divide-line" aria-live="polite">
              {jobs.map((j) => (
                <li key={j.id} className="flex items-center gap-3 px-4 py-3" data-testid="convert-job" data-status={j.status}>
                  <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-fill">
                    {j.thumb ? <img src={j.thumb} alt="" className="h-full w-full object-cover" /> : j.status === "done" ? <IconCheckCircle className="h-5 w-5 text-ok" aria-hidden /> : j.status === "failed" ? <IconWarning className="h-5 w-5 text-bad" aria-hidden /> : <IconFile className="h-5 w-5 text-muted" aria-hidden />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium" title={j.title}>{middleTruncate(j.title, 48)}</p>
                    {j.status === "failed"
                      ? <p className="text-[12.5px] text-bad" data-testid="convert-job-error">{j.error}</p>
                      : <p className="truncate text-[12.5px] text-muted">{j.status === "done" ? `${j.outputs.length > 1 ? `${j.outputs.length} files` : j.outputs[0] ? `${j.outputs[0].name} · ${sizeLabel(j.outputs[0].size)}` : ""}${j.local ? " · on your device" : ""}${j.ms != null ? ` · ${j.ms < 1000 ? `${j.ms} ms` : `${(j.ms / 1000).toFixed(1)} s`}` : ""}` : j.label}</p>}
                    {(j.status === "running" || j.status === "waiting") && (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(j.progress * 100)} aria-label={`${j.title} progress`}>
                        <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  {j.status === "done" && (
                    <Button size="sm" variant="secondary" onClick={() => void downloadJob(j)} data-testid="convert-download" aria-label={`Download ${j.outputs.length > 1 ? downloadName(j.title, j.outputs, j.to) : j.outputs[0]?.name}`}>
                      <IconDownload className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">{j.outputs.length > 1 ? "ZIP" : "Download"}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </ToolsFrame>
  );
}

function Choice({ label, value, onChange, options, testId }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; testId: string }) {
  return (
    <fieldset data-testid={testId}>
      <legend className="text-[13px] font-medium">{label}</legend>
      <div className="mt-1.5 inline-flex rounded-xl border border-line p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
            className={`h-8 rounded-[10px] px-3 text-[13px] font-medium transition-colors max-sm:min-h-10 ${value === o.value ? "bg-brand text-brand-fg" : "text-muted hover:text-fg"} ${ring}`}>{o.label}</button>
        ))}
      </div>
    </fieldset>
  );
}
