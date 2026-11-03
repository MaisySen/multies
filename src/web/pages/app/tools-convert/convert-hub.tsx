/**
 * R78 Convert hub (/app/tools/convert): file first, not tool first. Drop any file, or many at once; Multies reads what
 * each one is and shows what it can become (src/shared/convert-routes.ts plans the route, up to three steps). Images,
 * PDF basics and spreadsheets run in the browser with nothing uploaded; anything the browser cannot do goes to the
 * Multies engine through the normal Tools job. Results land in a tray with progress per file, a download for each,
 * and one ZIP for all of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ACTIONS, actionEngineRuns, actionsFor, commonTargets, formatDef, formatOf, parseRanges, routeLine, routeTo, FORMATS,
  type ActionDef, type BrowserCaps, type FormatId, type PlanOptions, type Route,
} from "@/shared/convert-routes";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { useToolsInfo } from "@/web/components/tools/use-tools-info";
import { runsLeft, sizeLabel, middleTruncate, takeCarried } from "@/web/components/tools/tool-directory";
import { Button } from "@/web/components/ui/button";
import {
  IconArrowDown, IconArrowUp, IconCheckCircle, IconClose, IconDownload, IconFile, IconImage, IconServer, IconSheet,
  IconShieldCheck, IconUpload, IconWarning, IconDocs, IconVideo, IconVolume, IconBook, IconArchive,
} from "@/web/components/ui/icon";
import { measureCaps } from "@/web/lib/convert/caps";
import { downloadName, loadOps, runEngine, runRoute, type Progress } from "@/web/lib/convert/run";
import { catalogueFor, toolDef, type ToolOp } from "@/shared/tools";
import { saveFile } from "@/web/lib/tool-jobs";
import { useLeaveGuard } from "@/web/components/tools/leave-guard"; // R82F (MB-286)
import { toast } from "sonner";
import { Select } from "@/web/components/ui/input";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const MAX_FILES = 50;
const MAX_LOCAL_BYTES = 200 * 1024 * 1024;

interface Picked { id: string; file: File; fmt: FormatId | null; note?: string; hint?: string }
type JobStatus = "waiting" | "running" | "done" | "failed";
interface Job {
  id: string; title: string; status: JobStatus; progress: number; label: string; local: boolean;
  outputs: File[]; error?: string; to?: FormatId; thumb?: string; startedAt?: number; ms?: number;
  /** R86: compress shows the size before and after. */
  sizes?: { before: number; after: number };
}

/** Plain words for what went wrong; a converter that could not load is a connection problem, not a code. */
function friendly(err: unknown): string {
  const m = (err as Error)?.message ?? "";
  if (/dynamically imported module|Failed to fetch|Loading chunk|NetworkError|Load failed/i.test(m)) return "Couldn't load the converter. Check your connection, then try again.";
  if (/encrypted/i.test(m)) return "This PDF is locked with a password. Take the password off with Remove password, then try again here.";
  if (/Failed to parse|No PDF header|Invalid PDF|PDFParse|Expected instance of PDF/i.test(m)) return "This PDF can't be opened. It may be damaged.";
  if (/could not be decoded|decode|InvalidStateError/i.test(m)) return "This image can't be opened. It may be damaged, or in a format this browser doesn't read.";
  if (/out of memory|allocation failed|RangeError/i.test(m)) return "This file is too big for your device to convert here. Try a smaller one.";
  // Anything that reads like code is a fault on our side, not something the person can act on.
  if (!m || /undefined|null|is not a function|properties of|Unexpected token|TypeError|ReferenceError/.test(m)) return "Something went wrong converting this file. Try again, or pick another format.";
  return m;
}
/** True when the PDF's trailer names an /Encrypt dictionary (read from the start and the end, never the whole file). */
async function pdfLooksLocked(f: File): Promise<boolean> {
  const look = async (b: Blob) => /\/Encrypt\b/.test(new TextDecoder("latin1").decode(await b.arrayBuffer()));
  return (await look(f.slice(Math.max(0, f.size - 262144)))) || (await look(f.slice(0, 65536)));
}
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "\u2318" : "Ctrl";

let seq = 0;
const nextId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;
const familyIcon = (f: FormatId | null) => {
  if (!f) return IconFile;
  const fam = formatDef(f).family;
  return fam === "image" ? IconImage : fam === "sheet" ? IconSheet : fam === "pdf" ? IconDocs
    : fam === "video" ? IconVideo : fam === "audio" ? IconVolume : fam === "ebook" ? IconBook : fam === "archive" ? IconArchive : IconFile;
};
/** R86: before and after, in plain words ("2.4 MB to 610 KB, 75% smaller"). */
export function sizeChange(before: number, after: number): string {
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  if (after >= before || pct < 2) return `${sizeLabel(before)}, already small, kept as it is`;
  return `${sizeLabel(before)} to ${sizeLabel(after)}, ${pct}% smaller`;
}
/** R86: the engine op an action uses for one kind of file. */
function engineOpFor(id: ActionDef["id"], f: FormatId): ToolOp {
  if (id === "compress") return f === "pdf" ? "compress" : "media-compress";
  return "ocr";
}
const LEVELS = [{ v: "light", label: "A little" }, { v: "medium", label: "Balanced" }, { v: "strong", label: "Smallest" }] as const;
const ARCHIVE_KINDS = [{ v: "zip", label: "ZIP" }, { v: "tgz", label: "TAR.GZ" }, { v: "tar", label: "TAR" }] as const;
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
  const [level, setLevel] = useState<"light" | "medium" | "strong">("medium");
  const [ocrLang, setOcrLang] = useState("eng");
  const [packAs, setPackAs] = useState<"zip" | "tgz" | "tar">("zip");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const thumbs = useRef<string[]>([]);
  const runners = useRef(new Map<string, () => Promise<void>>());
  const trayRef = useRef<HTMLElement>(null);
  const [announce, setAnnounce] = useState("");
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const startRef = useRef<() => void>(() => {});

  const caps: BrowserCaps = useMemo(() => measureCaps(heicOk), [heicOk]);
  const left = info.data ? runsLeft(info.data.usage, info.data.limits) : null;
  const plan: PlanOptions = useMemo(() => ({ features: info.data?.features ?? [], engine: !!info.data?.enabled && (left?.left ?? 0) > 0, caps }), [info.data, left?.left, caps]);

  const planRef = useRef(plan);
  planRef.current = plan;
  const usable = files.filter((f) => f.fmt && !f.note);
  // R86: any file that is not empty can go into an archive, even a kind Multies can't convert.
  const packable = files.filter((f) => f.file.size > 0);
  const fmts = usable.map((f) => f.fmt!) as FormatId[];
  const targets = useMemo(() => commonTargets(fmts, plan), [fmts.join(","), plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useMemo(() => {
    const fit = actionsFor(fmts, { engine: plan.engine, features: plan.features });
    if (!fmts.length && packable.length) return ACTIONS.filter((a) => a.anyFile);
    return fit;
  }, [fmts.join(","), plan.engine, plan.features, packable.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const ocrChoices = useMemo(() => catalogueFor(info.data?.features ?? []).find((t) => t.op === "ocr")?.options.find((o) => o.name === "language")?.choices ?? [{ value: "eng", label: "English" }], [info.data?.features]);

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
    setSaved(false);
    const heic = picked.find((p) => p.fmt === "heic");
    if (heic) {
      void loadOps().then((o) => o.browserOpensHeic(heic.file)).then((ok) => {
        setHeicOk(ok);
        if (ok) return;
        // R86: outside Safari, HEIC photos become JPG or PNG on the Multies engine (uploaded, converted, then deleted).
        const engine = planRef.current.engine;
        setFiles((cur) => cur.map((p) => (p.fmt !== "heic" ? p : engine
          ? { ...p, hint: "This browser can't open HEIC, so it is converted on the Multies engine." }
          : { ...p, note: "This browser can't open HEIC photos. Turn on Tools to convert them on the Multies engine, or open Multies in Safari." })));
      });
    }
  }, []);

  // A file handed over from the Tools list (dropped there) arrives here.
  useEffect(() => { const c = takeCarried(); if (c.length) add(c); }, [add]);

  // Paste a copied image or file straight in (Ctrl V), unless the person is typing in a field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const list = [...(e.clipboardData?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      add(list.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${i + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }))));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  // A drag that ends outside the page never sends dragleave here; reset on any drop or drag end.
  useEffect(() => {
    const reset = () => setDragging(false);
    window.addEventListener("drop", reset); window.addEventListener("dragend", reset);
    return () => { window.removeEventListener("drop", reset); window.removeEventListener("dragend", reset); };
  }, []);

  // Ctrl (or Cmd) Enter converts; Ctrl O chooses files.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key === "Enter") { e.preventDefault(); startRef.current(); }
      else if (e.key.toLowerCase() === "o") { e.preventDefault(); inputRef.current?.click(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const actionDef = action ? ACTIONS.find((a) => a.id === action) ?? null : null;
  const engineRuns = actionDef ? actionEngineRuns(actionDef, fmts) : (targets.find((t) => t.to === target)?.engineRuns ?? 0);
  const allLocal = actionDef ? engineRuns === 0 : chosenRoutes.every((r) => r.local);
  // The engine's own size limits (videos, e-books) and notes for what the chosen work sends there.
  const engineOps = useMemo(() => {
    const ops = new Set<ToolOp>();
    if (actionDef) for (const f of fmts) { if (actionDef.engine?.(f)) ops.add(engineOpFor(actionDef.id, f)); }
    else for (const r of chosenRoutes) for (const s of r.steps) if (s.op) ops.add(s.op as ToolOp);
    return [...ops];
  }, [actionDef, chosenRoutes, fmts.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const workFiles = actionDef?.anyFile ? packable : usable;
  // Files that go to the engine are checked against the engine's own limit there; the device limit is for local work.
  const tooBigLocal = workFiles.some((f) => f.file.size > MAX_LOCAL_BYTES && !(actionDef?.engine?.(f.fmt as FormatId) ?? (!!target && !chosenRoutes.find((r) => r.from === f.fmt)?.local)));
  const busy = jobs.some((j) => j.status === "running" || j.status === "waiting");
  const ready = !!workFiles.length && (!!target || !!action) && !tooBigLocal;

  const patch = (id: string, p: Partial<Job>) => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, ...p } : j)));

  // R86 (R78 leftover): a picture is known by its type or, when the browser gave none (PNG to PNG from some file
  // pickers and from mail), by its name; the tick only shows when there is no picture at all.
  const makeThumb = (out: File[]): string | undefined => {
    const isPic = (f: File) => /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(f.type) || (!/^image\//.test(f.type) && ["png", "jpg", "webp", "gif", "avif", "bmp"].includes(formatOf(f.name, "") ?? ""));
    const img = out.find(isPic);
    if (!img || img.size > 15 * 1024 * 1024) return undefined;
    const typed = img.type.startsWith("image/") ? img : new File([img], img.name, { type: formatDef(formatOf(img.name, "")!).mime });
    const u = URL.createObjectURL(typed); thumbs.current.push(u); return u;
  };

  async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t); }));
  }

  async function start() {
    if (!ready) return;
    const list = [...workFiles];
    if (action) {
      const def = ACTIONS.find((a) => a.id === action)!;
      const units = def.combine ? [list] : list.map((p) => [p]);
      const made: Job[] = units.map((u) => ({ id: nextId(), title: def.combine ? `${def.label}: ${u.length} ${u.length === 1 ? "file" : "files"}` : u[0].file.name, status: "waiting", progress: 0, label: "Waiting", local: !u.some((p) => def.engine?.(p.fmt as FormatId)), outputs: [] }));
      setJobs((cur) => [...made, ...cur]);
      showTray();
      const work = async (u: Picked[], job: Job) => {
        const t0 = performance.now();
        const onEngine = !!def.engine?.(u[0].fmt as FormatId);
        patch(job.id, { status: "running", label: onEngine ? `Starting ${def.label.toLowerCase()} on the Multies engine` : `${def.label} on your device`, progress: onEngine ? 0.03 : 0.15, startedAt: Date.now() });
        const engineProgress = (pr: Progress) => patch(job.id, { progress: Math.max(0.03, pr.fraction), label: pr.label });
        try {
          const o = await loadOps();
          let outputs: File[] = [];
          let sizes: Job["sizes"];
          const first = u[0].file;
          const fmt = u[0].fmt as FormatId;
          const base = first.name.replace(/\.[^.]+$/, "") || "file";
          if (def.id === "merge") outputs = [await o.mergePdfs(u.map((p) => p.file), first.name.replace(/\.pdf$/i, "-merged.pdf"))];
          else if (def.id === "images-pdf") outputs = [await o.imagesToPdf(u.map((p) => ({ file: p.file, from: p.fmt! })), `${first.name.replace(/\.[^.]+$/, "")}-images.pdf`, { pageSize })];
          else if (def.id === "split") {
            const n = await o.pageCount(first);
            const r = ranges.trim() ? parseRanges(ranges, n) : null;
            if (ranges.trim() && !r) throw new Error(`Those pages don't fit this PDF (${n} pages). Try 1-3, 5.`);
            outputs = await o.splitPdf(first, r);
          } else if (def.id === "rotate") outputs = [await o.rotatePdf(first, turn)];
          else if (def.id === "numbers") outputs = [await o.numberPdf(first, { style: numStyle, position: numPos })];
          else if (def.id === "compress") {
            if (onEngine) {
              // A password protected PDF can't be made smaller; say so before it goes to the engine.
              if (fmt === "pdf" && (await pdfLooksLocked(first))) throw new Error("encrypted");
              const op = engineOpFor("compress", fmt);
              const run = await runEngine(op, first, { level }, `Making ${formatDef(fmt).label} smaller on the Multies engine`, engineProgress);
              const after = run.result?.out_bytes ?? run.file.size;
              const kept = !!run.result?.already_optimised || after >= first.size;
              outputs = [kept ? first : run.file];
              sizes = { before: first.size, after: kept ? first.size : after };
            } else {
              const r = await o.compressImage(first, fmt, level);
              outputs = [r.file];
              sizes = { before: first.size, after: r.file.size };
            }
          } else if (def.id === "ocr-pdf" || def.id === "ocr-text") {
            // A photo goes onto a page first (on the device), then the engine reads it.
            const pdf = fmt === "pdf" ? first : await o.imagesToPdf([{ file: first, from: fmt }], `${base}.pdf`);
            const run = await runEngine("ocr", pdf, { language: ocrLang }, "Reading the words on the Multies engine", engineProgress, { name: `${base}-searchable.pdf`, type: "application/pdf" });
            outputs = def.id === "ocr-pdf" ? [run.file] : [await o.pdfText(run.file, `${base}.txt`)];
          } else if (def.id === "extract") {
            patch(job.id, { label: "Unpacking on your device" });
            outputs = await o.extractArchive(first, (d, t) => patch(job.id, { progress: 0.1 + 0.85 * (d / t), label: `Unpacking on your device, ${d} of ${t}` }));
          } else if (def.id === "archive") {
            const name = u.length === 1 ? `${base}.${packAs === "tgz" ? "tar.gz" : packAs}` : `files-${new Date().toISOString().slice(0, 10)}.${packAs === "tgz" ? "tar.gz" : packAs}`;
            outputs = [await o.makeArchive(u.map((p) => p.file), packAs, name)];
            sizes = { before: u.reduce((n, p) => n + p.file.size, 0), after: outputs[0].size };
          }
          patch(job.id, { status: "done", progress: 1, label: onEngine ? "Done" : "Done on your device", outputs, sizes, thumb: def.id === "compress" ? makeThumb(outputs) : undefined, ms: Math.round(performance.now() - t0) });
        } catch (err) {
          patch(job.id, { status: "failed", progress: 1, label: "Not done", error: friendly(err) });
        }
      };
      made.forEach((job, i) => runners.current.set(job.id, () => work(units[i], job)));
      await pool(units.map((u, i) => ({ u, job: made[i] })), 2, ({ u, job }) => work(u, job));
      finished(made.map((j) => j.id));
      if (def.engine) void info.refetch();
      return;
    }
    const to = target!;
    const made: Job[] = list.map((p) => ({ id: nextId(), title: p.file.name, status: "waiting", progress: 0, label: "Waiting", local: p.fmt === to || !!routeTo(p.fmt!, to, plan)?.local, outputs: [], to }));
    setJobs((cur) => [...made, ...cur]);
    showTray();
    const work = async (p: Picked, job: Job) => {
      const t0 = performance.now();
      // R82F (R78 leftover): a file already in the chosen format shows its own picture too, not only a tick.
      if (p.fmt === to) { patch(job.id, { status: "done", progress: 1, label: `Already ${formatDef(to).label}, kept as it is`, outputs: [p.file], thumb: makeThumb([p.file]) }); return; }
      const route = routeTo(p.fmt!, to, plan);
      if (!route) { patch(job.id, { status: "failed", progress: 1, label: "Not done", error: `${formatDef(p.fmt!).label} can't become ${formatDef(to).label} here.` }); return; }
      patch(job.id, { status: "running", startedAt: Date.now() });
      try {
        const outputs = await runRoute(route, p.file, { quality: IMAGE_OUT.has(to) ? quality : undefined, onProgress: (pr: Progress) => patch(job.id, { progress: Math.max(0.03, pr.fraction), label: pr.label }) });
        patch(job.id, { status: "done", progress: 1, label: route.local ? "Done on your device" : "Done", outputs, thumb: makeThumb(outputs), ms: Math.round(performance.now() - t0) });
      } catch (err) {
        patch(job.id, { status: "failed", progress: 1, label: "Not done", error: friendly(err) });
      }
    };
    made.forEach((job, i) => runners.current.set(job.id, () => work(list[i], job)));
    await pool(list.map((p, i) => ({ p, job: made[i] })), 2, ({ p, job }) => work(p, job));
    finished(made.map((j) => j.id));
    void info.refetch();
  }

  function showTray() {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => trayRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" }));
  }
  function finished(ids: string[]) {
    // Read the tray after React has applied the last patches.
    setTimeout(() => {
      const mine = jobsRef.current.filter((j) => ids.includes(j.id));
      const failed = mine.filter((j) => j.status === "failed").length, n = mine.length;
      setAnnounce(failed ? `${n - failed} of ${n} ready. ${failed} not done.` : `${n} ${n === 1 ? "result" : "results"} ready to download.`);
    }, 0);
  }
  async function retry(j: Job) {
    const run = runners.current.get(j.id);
    if (!run) return;
    patch(j.id, { status: "waiting", progress: 0, label: "Trying again", error: undefined });
    await run();
  }
  function clearFiles() {
    const before = files;
    setFiles([]);
    toast("Files cleared", { action: { label: "Undo", onClick: () => setFiles(before) } });
  }

  async function downloadJob(j: Job) {
    setSaved(true);
    if (j.outputs.length === 1) { saveFile(j.outputs[0], j.outputs[0].name); return; }
    const o = await loadOps();
    saveFile(await o.zipFiles(j.outputs), downloadName(j.title, j.outputs, j.to));
  }
  const done = jobs.filter((j) => j.status === "done");
  async function downloadAll() {
    setSaved(true);
    setZipping(true);
    try {
      const o = await loadOps();
      saveFile(await o.zipFiles(done.flatMap((j) => j.outputs)), `multies-converted-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally { setZipping(false); }
  }
  const clearTray = () => { thumbs.current.forEach((u) => URL.revokeObjectURL(u)); thumbs.current = []; setJobs((cur) => cur.filter((j) => j.status === "running" || j.status === "waiting")); };

  startRef.current = () => { void start(); };
  // R82F (MB-286): files picked here live only in this tab. Reloading or leaving before anything is downloaded asks
  // first (the browser's own question on reload, ours on a link inside Multies).
  const leaveGuard = useLeaveGuard(files.length > 0 && !saved, files.length > 1 ? "your files" : "your file");
  const runLabel = action
    ? `${ACTIONS.find((a) => a.id === action)!.label}${workFiles.length > 1 && !ACTIONS.find((a) => a.id === action)!.combine ? ` (${workFiles.length} files)` : ""}`
    : target ? `Convert ${usable.length} ${usable.length === 1 ? "file" : "files"} to ${formatDef(target).label}` : "Choose what to make";

  return (
    <ToolsFrame entryKey="convert-any" title="Convert any file" description="Drop files first. Multies shows what each one can become, and most jobs never leave your device." wide testId="convert-hub">
      {leaveGuard}
      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop} className="relative space-y-5">
        <button type="button" onClick={() => inputRef.current?.click()} data-testid="convert-drop"
          className={`group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 text-center transition-[background-color,border-color,padding] duration-200 ${files.length ? "py-6" : "py-12 sm:py-16"} ${dragging ? "border-brand bg-brand/10" : "border-line-strong bg-surface hover:border-brand/60 hover:bg-brand/5"} ${ring}`}>
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5 ${dragging ? "motion-safe:scale-110" : ""}`}><IconUpload className="h-6 w-6" aria-hidden /></span>
          <span className="text-[16px] font-semibold text-fg">{dragging ? "Drop to add" : files.length ? "Add more files" : "Drop any files here, or choose files"}</span>
          <span className="max-w-xl text-[13.5px] text-muted">Many at once. Photos, PDFs, spreadsheets, Word and PowerPoint files, videos, sound, e-books and archives. Up to {MAX_FILES} files.</span>
        </button>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label="Choose files to convert" data-testid="convert-input" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />

        {!files.length && (
          <div className="space-y-4" data-testid="convert-empty">
            <ol className="grid gap-2 sm:grid-cols-3" aria-label="How it works">
              {[["Drop files", "One or fifty, any mix."], ["Pick what to make", "Only formats that work are shown."], ["Download", "One by one, or all as a ZIP."]].map(([t, d], i) => (
                <li key={t} className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[12px] font-semibold text-brand-hover" aria-hidden>{i + 1}</span>
                  <span className="min-w-0"><span className="block text-[13.5px] font-medium">{t}</span><span className="block text-[12.5px] text-muted">{d}</span></span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap justify-center gap-1.5" aria-label="Formats Multies reads" data-testid="convert-formats">
              {FORMATS.map((f) => <span key={f.id} className="rounded-full border border-line px-2.5 py-1 text-[12px] font-medium text-muted">{f.label}</span>)}
            </div>
            <p className="text-center text-[12.5px] text-subtle max-sm:hidden">Tip: paste a copied image with <Kbd>{MOD}</Kbd> <Kbd>V</Kbd>, or press <Kbd>{MOD}</Kbd> <Kbd>O</Kbd> to choose files.</p>
          </div>
        )}

        {!!files.length && (
          <section aria-labelledby="cv-files" className="rounded-2xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 id="cv-files" className="text-[14px] font-semibold">Your files <span className="font-normal text-muted">{files.length}</span></h2>
              <button type="button" onClick={clearFiles} className={`rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg max-sm:min-h-11 ${ring}`} data-testid="convert-clear-files">Clear</button>
            </div>
            <ul className="divide-y divide-line sm:max-h-72 sm:overflow-y-auto" data-testid="convert-file-list">
              {files.map((p, i) => {
                const Icon = familyIcon(p.fmt);
                return (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="convert-file">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill text-muted"><Icon className="h-4 w-4" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium" title={p.file.name}>{middleTruncate(p.file.name, 46)}</p>
                      <p className={`text-[12px] ${p.note ? "text-warn" : "text-muted"}`}>{p.note ?? `${p.fmt ? formatDef(p.fmt).label : ""} · ${sizeLabel(p.file.size)}`}</p>
                      {p.hint && !p.note && <p className="text-[12px] text-muted" data-testid="convert-file-hint">{p.hint}</p>}
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

        {(!!usable.length || !!packable.length) && (
          <section aria-labelledby="cv-make" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
            <div>
              <h2 id="cv-make" className="text-[14px] font-semibold">{usable.length ? `Turn ${usable.length === 1 ? "it" : "them"} into` : "What to do"}</h2>
              {!usable.length ? null : targets.length ? (
                <div role="group" aria-labelledby="cv-make" className="mt-2.5 flex flex-wrap gap-2" data-testid="convert-targets">
                  {targets.map((t) => {
                    const on = target === t.to;
                    return (
                      <button key={t.to} type="button" aria-pressed={on} onClick={() => { setTarget(on ? null : t.to); setAction(null); }} data-testid={`convert-to-${t.to}`}
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
                {!!usable.length && <h3 className="text-[13px] font-semibold text-muted">Or do this</h3>}
                <div className="mt-2 flex flex-wrap gap-2" data-testid="convert-actions">
                  {actions.map((a) => {
                    const on = action === a.id;
                    const runs = actionEngineRuns(a, fmts);
                    return (
                      <button key={a.id} type="button" aria-pressed={on} onClick={() => { setAction(on ? null : a.id); setTarget(null); }} data-testid={`convert-action-${a.id}`} title={runs ? `${a.line}. Uses the Multies engine (${runs} ${runs === 1 ? "run" : "runs"})` : a.line}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[13.5px] font-medium transition-colors max-sm:min-h-11 ${on ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-fg hover:border-brand/60 hover:bg-brand/5"} ${ring}`}>
                        {a.label}
                        {runs > 0 && <IconServer className={`h-3.5 w-3.5 ${on ? "text-brand-fg/80" : "text-subtle"}`} aria-label="uses the Multies engine" />}
                      </button>
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
            {action === "compress" && <Choice label="How small" value={level} onChange={(v) => setLevel(v as typeof level)} options={LEVELS.map((l) => ({ value: l.v, label: l.label }))} testId="convert-level" />}
            {(action === "ocr-pdf" || action === "ocr-text") && (
              <label className="block max-w-xs">
                <span className="text-[13px] font-medium">Language of the words</span>
                <Select value={ocrLang} onChange={(e) => setOcrLang(e.target.value)} data-testid="convert-ocr-language" className="mt-1">
                  {ocrChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </label>
            )}
            {action === "archive" && <Choice label="Kind" value={packAs} onChange={(v) => setPackAs(v as typeof packAs)} options={ARCHIVE_KINDS.map((k) => ({ value: k.v, label: k.label }))} testId="convert-pack-as" />}
            {action === "images-pdf" && <Choice label="Page size" value={pageSize} onChange={(v) => setPageSize(v as "image" | "a4")} options={[{ value: "image", label: "Same as each image" }, { value: "a4", label: "A4" }]} testId="convert-page-size" />}

            {(target || action) && (
              <div className={`flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px] ${allLocal ? "bg-ok-soft text-fg" : "bg-fill text-fg"}`} data-testid={allLocal ? "convert-local-note" : "convert-engine-note"} role="note">
                {allLocal ? <IconShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> : <IconServer className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />}
                <div>
                  {allLocal
                    ? <p><span className="font-semibold">Stays on your device.</span> Nothing is uploaded and no run is used.</p>
                    : <p><span className="font-semibold">Part of this uses the Multies engine</span> ({engineRuns} {engineRuns === 1 ? "run" : "runs"}). Files are sent over a secure connection and deleted from the engine within an hour.</p>}
                  {engineOps.map((op) => toolDef(op).note).filter(Boolean).map((n) => <p key={n} className="mt-0.5 text-muted" data-testid="convert-engine-limit">{n}</p>)}
                  {!allLocal && <p className="mt-0.5 text-muted">Each file can be up to {sizeLabel(Math.min(...engineOps.map((op) => toolDef(op).maxBytes ?? Infinity), info.data?.limits.maxBytes ?? Infinity))} on your plan.</p>}
                  {!action && chosenRoutes.some((r) => r.steps.length > 1 || !r.local) && <p className="mt-0.5 text-muted" data-testid="convert-route">{chosenRoutes.filter((r) => r.steps.length > 1 || !r.local).map((r) => (chosenRoutes.length > 1 ? `${formatDef(r.from).label}: ${routeLine(r)}` : routeLine(r))).join(". ")}.</p>}
                </div>
              </div>
            )}
            {tooBigLocal && <p className="flex items-center gap-2 text-[13px] text-warn"><IconWarning className="h-4 w-4" aria-hidden />A file is over {sizeLabel(MAX_LOCAL_BYTES)}, too large to convert here.</p>}

            <div className="flex flex-wrap items-center gap-3 max-sm:sticky max-sm:bottom-0 max-sm:z-20 max-sm:-mx-4 max-sm:-mb-4 max-sm:rounded-b-2xl max-sm:border-t max-sm:border-line max-sm:bg-surface/95 max-sm:px-4 max-sm:pb-[max(12px,env(safe-area-inset-bottom))] max-sm:pt-3 max-sm:backdrop-blur" data-testid="convert-actions-bar">
              <Button size="lg" onClick={() => void start()} disabled={!ready} data-testid="convert-run" className="max-sm:w-full">{runLabel}</Button>
              {busy ? <span className="text-[13px] text-muted" role="status">Working. You can add more files while this runs.</span>
                : ready ? <span className="text-[12.5px] text-subtle max-sm:hidden"><Kbd>{MOD}</Kbd> <Kbd>Enter</Kbd></span> : null}
            </div>
          </section>
        )}

        {!!jobs.length && (
          <section ref={trayRef} aria-labelledby="cv-tray" className="scroll-mt-4 rounded-2xl border border-line bg-surface" data-testid="convert-tray">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 id="cv-tray" className="flex items-center gap-2 text-[14px] font-semibold">
                {!busy && done.length === jobs.length ? <IconCheckCircle className="h-4 w-4 text-ok" aria-hidden /> : null}
                Results <span className="font-normal text-muted" data-testid="convert-tray-count">{!busy && done.length === jobs.length ? `all ${jobs.length} ready` : `${done.length} of ${jobs.length} ready`}</span>
              </h2>
              <div className="flex items-center gap-2">
                {done.length > 1 && <Button size="sm" onClick={() => void downloadAll()} loading={zipping} className="max-sm:min-h-11" data-testid="convert-download-all"><IconDownload className="h-4 w-4" aria-hidden />Download all as ZIP</Button>}
                {!busy && <Button size="sm" variant="ghost" onClick={clearTray} className="max-sm:min-h-11" data-testid="convert-clear-tray">Clear</Button>}
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
                      : j.status === "done" && j.sizes ? <p className="truncate text-[12.5px] text-muted" data-testid="convert-job-sizes">{sizeChange(j.sizes.before, j.sizes.after)}{j.local ? " · on your device" : ""}</p>
                      : <p className="truncate text-[12.5px] text-muted">{j.status === "done" ? `${j.outputs.length > 1 ? `${j.outputs.length} files` : j.outputs[0] ? `${j.outputs[0].name} · ${sizeLabel(j.outputs[0].size)}` : ""}${j.local ? " · on your device" : ""}${j.ms != null ? ` · ${j.ms < 1000 ? `${j.ms} ms` : `${(j.ms / 1000).toFixed(1)} s`}` : ""}` : j.label}</p>}
                    {j.status === "done" && j.outputs.length > 1 && j.outputs.length <= 300 && (
                      <details className="mt-1" data-testid="convert-job-files">
                        <summary className={`cursor-pointer rounded text-[12.5px] font-medium text-brand-hover max-sm:py-2 ${ring}`}>Show the {j.outputs.length} files</summary>
                        <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1">
                          {j.outputs.map((f, k) => (
                            <li key={k} className="flex items-center gap-2 text-[12.5px]">
                              <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                              <span className="shrink-0 text-subtle">{sizeLabel(f.size)}</span>
                              <button type="button" onClick={() => { setSaved(true); saveFile(f, f.name); }} aria-label={`Download ${f.name}`} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11 ${ring}`}><IconDownload className="h-3.5 w-3.5" aria-hidden /></button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {(j.status === "running" || j.status === "waiting") && (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(j.progress * 100)} aria-label={`${j.title} progress`}>
                        <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  {j.status === "failed" && runners.current.has(j.id) && (
                    <Button size="sm" variant="outline" onClick={() => void retry(j)} className="max-sm:min-h-11" data-testid="convert-retry">Try again</Button>
                  )}
                  {j.status === "done" && (
                    <Button size="sm" variant="secondary" className="max-sm:min-h-11" onClick={() => void downloadJob(j)} data-testid="convert-download" aria-label={`Download ${j.outputs.length > 1 ? downloadName(j.title, j.outputs, j.to) : j.outputs[0]?.name}`}>
                      <IconDownload className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">{j.outputs.length > 1 ? "ZIP" : "Download"}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-testid="convert-announce">{announce}</p>
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
            className={`h-8 rounded-[10px] px-3 text-[13px] font-medium transition-colors duration-150 max-sm:min-h-11 ${value === o.value ? "bg-brand text-brand-fg" : "text-muted hover:text-fg"} ${ring}`}>{o.label}</button>
        ))}
      </div>
    </fieldset>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-md border border-line bg-fill px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted">{children}</kbd>;
}
