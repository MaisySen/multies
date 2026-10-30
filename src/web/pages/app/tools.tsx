/**
 * Tools: document tools inside Multies. One list of every tool (search, recent, five sections), and one focused screen
 * per tool: drop or choose files (or take photos on a phone), essential options with the rest folded away, one primary
 * button, staged progress with cancel, and a result with its next steps (download, attach to a new email, share, sign,
 * or run another tool on it). P2 tools and pages show only when their flag is on (GET /api/tools features).
 * The work runs on Multies' own document engine (Singapore); files are deleted from it within an hour.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  IconAlertCircle, IconArrowDown, IconArrowLeft, IconArrowUp, IconCamera, IconCheckCircle, IconChevronDown, IconClose, IconDownload,
  IconFile, IconFileUp, IconMail, IconSearch, IconWrench, IconArrowRight,
} from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { OptionField, defaultsFor, mb, optionsProblem, optionsToSend, resultLine, visibleOptions, waitLine } from "@/web/components/tools/tool-fields";
import { attachmentJob, uploadJob } from "@/web/lib/tool-jobs";
import { attachToNewEmail } from "@/web/lib/compose-files"; // Tools P2: the one "Attach to a new email" path
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import { ShareResultLinks } from "./tools-share-sign/entry"; // Tools P2: share links and e-sign
import { isToolOp, toolTakes, type ToolDef, type ToolJob, type ToolOp, type ToolsInfo } from "@/shared/tools";
import {
  SECTIONS, STARTERS, buildEntries, carryFiles, entryTakes, middleTruncate, recentKeys, rememberRecent, savedLine,
  searchEntries, sizeLabel, takeCarried, warmEngine, type Entry,
} from "@/web/components/tools/tool-directory";
import { ToolIcon } from "@/web/components/tools/tool-icon";

// Tools UX: the auto redact flow is only loaded when someone opens it.
const AutoRedactPanel = lazy(() => import("@/web/components/tools/auto-redact").then((m) => ({ default: m.AutoRedactPanel })));

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number; waking: boolean }
  | { kind: "working"; job: ToolJob; slow: boolean; since: number }
  | { kind: "done"; job: ToolJob }
  | { kind: "failed"; title: string; message: string; limit?: boolean };

/** Options folded under "More options" (only on tools with four or more choices). */
const ADVANCED: Partial<Record<ToolOp, string[]>> = {
  stamp: ["header", "footer", "ranges"],
  protect: ["allow_print", "allow_copy"],
  "excel-clean": ["dates", "drop_empty"],
  "scan-clean": ["mode"],
};

/** "a Word file" for a file name, to say plainly why a tool does not take it. */
function kindOf(name: string): string | null {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "a Word file";
  if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "a spreadsheet";
  if (["ppt", "pptx", "odp"].includes(ext)) return "a slide deck";
  if (["jpg", "jpeg", "png", "webp", "heic", "gif"].includes(ext)) return "an image";
  if (ext === "pdf") return "a PDF";
  if (ext === "zip") return "a ZIP file";
  return null;
}

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** One entry in the list: a tile on the landing, a compact row in the side rail. */
function EntryButton({ e, compact, active, onPick, testId }: { e: Entry; compact?: boolean; active?: boolean; onPick: (e: Entry) => void; testId?: string }) {
  const id = testId ?? (e.tool && !e.tool.path ? `tool-${e.key}` : e.tool ? `tool-${e.key}` : `toolpage-${e.key}`);
  if (compact) {
    return (
      <button type="button" onClick={() => onPick(e)} aria-current={active ? "page" : undefined} data-testid={id}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px] transition-colors ${ring} ${active ? "bg-brand/10 font-semibold text-fg" : "text-fg/85 hover:bg-hover"}`}>
        <ToolIcon e={e} size="sm" />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={() => onPick(e)} data-testid={id}
      className={`group flex h-full w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left transition-[border-color,background-color,box-shadow] duration-150 hover:border-line-strong hover:bg-hover/50 hover:shadow-[0_1px_3px_rgb(0_0_0/0.06)] max-sm:min-h-[60px] ${ring}`}>
      <ToolIcon e={e} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-tight">{e.name}</span>
        <span className="mt-0.5 block truncate text-[13px] text-muted sm:line-clamp-2 sm:whitespace-normal">{e.line}</span>
      </span>
      <IconArrowRight className="h-4 w-4 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden" aria-hidden />
    </button>
  );
}

/** Warm the engine when Tools opens (the free host sleeps). */
function useWarmEngine(enabled: boolean): boolean {
  const [cold, setCold] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void warmEngine().then((c) => { if (live && c) setCold(true); });
    return () => { live = false; };
  }, [enabled]);
  return cold;
}

export function ToolsPage() {
  const config = useConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const enabled = !!config.data?.tools;
  // Tools UX: the catalogue changes only with a deploy; usage refreshes after each run.
  const info = useQuery({ queryKey: ["tools"], enabled, staleTime: 10 * 60_000, queryFn: () => api.get<ToolsInfo>("/tools") });
  const cold = useWarmEngine(enabled);
  const [params, setParams] = useSearchParams();
  const asked = params.get("op");
  const op: ToolOp | null = isToolOp(asked) ? asked : null;
  const askedAttachment = params.get("attachment");
  const fromMailName = params.get("name") ?? "Attachment";
  const [fromMail, setFromMail] = useState<{ id: string; name: string } | null>(askedAttachment ? { id: askedAttachment, name: fromMailName } : null);
  useEffect(() => { setFromMail(askedAttachment ? { id: askedAttachment, name: fromMailName } : null); }, [askedAttachment, fromMailName]);

  const features = useMemo(() => info.data?.features ?? [], [info.data]);
  const entries = useMemo(() => buildEntries(info.data?.tools ?? [], features), [info.data, features]);
  const tool = op ? (info.data?.tools ?? []).find((t) => t.op === op && !t.hidden && !t.path) : undefined;
  const entry = entries.find((e) => e.key === op);

  // The list: search, a file dropped on it (show only what takes it), recent.
  const [query, setQuery] = useState("");
  const [listFiles, setListFiles] = useState<File[]>(() => (op ? [] : takeCarried()));
  const search = useRef<HTMLInputElement>(null);

  // The tool screen.
  const [options, setOptions] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [fileProblem, setFileProblem] = useState<{ text: string; switchTo?: Entry; files?: File[] } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const extraInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const limits = info.data?.limits;
  const maxFiles = tool ? (tool.maxFiles === "plan" ? limits?.maxMergeFiles ?? 10 : tool.maxFiles) : 1;
  const busy = phase.kind === "uploading" || phase.kind === "working";
  const cap = tool?.maxBytes && limits ? Math.min(tool.maxBytes, limits.maxBytes) : limits?.maxBytes;

  /** Adds files after checking type, count and size, so a wrong file is caught before any upload. */
  const add = useCallback((list: FileList | File[] | null, t: ToolDef | undefined = tool) => {
    if (!list || !t) return;
    const incoming = [...list];
    if (!incoming.length) return;
    setPhase({ kind: "idle" });
    const fits = incoming.filter((f) => toolTakes(t, f.name));
    const wrong = incoming.filter((f) => !toolTakes(t, f.name));
    if (wrong.length) {
      const name = wrong[0].name;
      const other = entries.find((e) => e.tool && !e.tool.path && e.key !== t.op && entryTakes(e, name));
      setFileProblem({ text: `${middleTruncate(name, 40)} is ${kindOf(name) ?? `not ${t.acceptLabel}`}. ${t.label} takes ${t.acceptLabel}.`, switchTo: other, files: wrong });
    } else setFileProblem(null);
    if (!fits.length) return;
    const limit = t.maxFiles === "plan" ? limits?.maxMergeFiles ?? 10 : t.maxFiles;
    setFiles((cur) => {
      const next = limit === 1 ? fits.slice(0, 1) : [...cur, ...fits];
      if (next.length > limit) setFileProblem({ text: `${t.label} takes up to ${limit} files at a time. The first ${limit} are kept.` });
      return next.slice(0, limit);
    });
  }, [tool, entries, limits]);

  // A new tool: fresh options and state; files carried from the last screen stay when the new tool takes them.
  useEffect(() => {
    setPhase({ kind: "idle" }); setExtraFiles([]); setFileProblem(null); setMoreOpen(false);
    setOptions(defaultsFor(tool));
    const carried = takeCarried();
    setFiles([]);
    if (tool && carried.length) add(carried, tool);
    if (op) window.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.op]);

  // Elapsed time while a run is going.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Poll the job until it is done or failed. Polling costs the server no database read.
  const workingToken = phase.kind === "working" ? phase.job.token : null;
  useEffect(() => {
    if (!workingToken) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const j = await api.get<ToolJob>(`/tools/jobs/${encodeURIComponent(workingToken)}`);
        if (stop) return;
        if (j.status === "done") { setPhase({ kind: "done", job: j }); qc.invalidateQueries({ queryKey: ["tools"] }); return; }
        if (j.status === "failed") { setPhase({ kind: "failed", title: "That didn't work", message: j.error ?? "This file could not be processed. Check that it opens on your computer, then try again." }); return; }
        if (j.status === "expired") { setPhase({ kind: "failed", title: "This result has expired", message: "Results are kept for an hour. Run the tool again." }); return; }
        setPhase((p) => (p.kind === "working" ? { ...p, job: { ...p.job, progress: j.progress }, slow: Date.now() - started > 8000 } : p));
      } catch (err) {
        if (stop) return;
        if ((err as { status?: number }).status !== 503) { setPhase({ kind: "failed", title: "That didn't work", message: (err as Error).message || "Couldn't check on the file. Try again." }); return; }
      }
      if (!stop) setTimeout(tick, Date.now() - started > 20_000 ? 3000 : 1200);
    };
    const t = setTimeout(tick, 900);
    return () => { stop = true; clearTimeout(t); };
  }, [workingToken, qc]);

  // Paste a file (Ctrl or Cmd V) on the list or a tool.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pasted = e.clipboardData?.files;
      if (!pasted?.length || busy) return;
      e.preventDefault();
      if (tool) add(pasted); else setListFiles([...pasted]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [tool, add, busy]);

  // "/" jumps to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || el?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault(); search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mailQuery = (id: string, name: string) => `attachment=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
  const pick = (e: Entry, carry?: File[]) => {
    if (busy) return;
    if (e.key === op) return;
    rememberRecent(e.key);
    if (e.to) {
      navigate(fromMail && e.takesAttachment ? `${e.to}${e.to.includes("?") ? "&" : "?"}${mailQuery(fromMail.id, fromMail.name)}` : e.to);
      return;
    }
    const keep = carry ?? (files.length ? files : listFiles);
    if (keep.length) carryFiles(keep);
    setListFiles([]);
    const next = new URLSearchParams({ op: e.key });
    if (fromMail) { next.set("attachment", fromMail.id); next.set("name", fromMail.name); }
    setParams(next);
  };
  const backToList = () => {
    if (busy) return;
    const next = new URLSearchParams();
    if (fromMail) { next.set("attachment", fromMail.id); next.set("name", fromMail.name); }
    setParams(next);
  };
  const dropMail = () => { setFromMail(null); setPhase({ kind: "idle" }); const next = new URLSearchParams(params); next.delete("attachment"); next.delete("name"); setParams(next, { replace: true }); };

  const move = (i: number, by: number) => setFiles((cur) => { const n = [...cur]; const j = i + by; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i: number) => { setFiles((cur) => cur.filter((_, k) => k !== i)); setFileProblem(null); };
  const onDragOver = (e: DragEvent) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); if (!busy) setDragging(true); };
  const onDragLeave = (e: DragEvent) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (busy || !e.dataTransfer.files.length) return;
    if (tool) add(e.dataTransfer.files); else { setListFiles([...e.dataTransfer.files]); setQuery(""); }
  };

  const run = async () => {
    if (!tool || (!fromMail && files.length < tool.minFiles)) return;
    rememberRecent(tool.op);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase({ kind: "uploading", pct: 0, waking: false });
    const sent = optionsToSend(tool, options);
    // A sleeping engine answers 503 before any work starts (nothing counted); wait and try again for up to a minute.
    for (let attempt = 0; ; attempt++) {
      try {
        const job = fromMail
          ? await attachmentJob(tool.op, [fromMail.id], sent)
          : await uploadJob(tool.op, files, sent, (pct) => setPhase((p) => (p.kind === "uploading" ? { ...p, pct } : p)), { def: tool, files: extraFiles, signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "working", job, slow: false, since: Date.now() });
        return;
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const e = err as { message: string; code?: string; status?: number };
        if (e.status === 503 && attempt < 7) {
          setPhase({ kind: "uploading", pct: 0, waking: true });
          await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 9000)));
          if (ctrl.signal.aborted) return;
          continue;
        }
        const limit = e.code === "plan_limit" || e.status === 413;
        setPhase({
          kind: "failed", limit,
          title: limit ? "Over your plan's limit" : e.status === 503 ? "Tools are still starting" : e.status === 0 ? "No connection" : "That didn't work",
          message: e.status === 429 ? `${e.message} Your files were not used.` : e.status === 503 ? "The document engine is taking longer than usual to start. Try again in a few seconds." : e.message,
        });
        return;
      }
    }
  };
  const cancel = () => { abort.current?.abort(); abort.current = null; setPhase({ kind: "idle" }); };
  const startOver = () => { setFiles([]); setExtraFiles([]); setPhase({ kind: "idle" }); setFileProblem(null); setOptions(defaultsFor(tool)); };
  // Tools UX: run another tool on a finished result (it is fetched once and handed to the list).
  const [chaining, setChaining] = useState(false);
  const chain = async (job: ToolJob) => {
    if (!job.downloadUrl) return;
    setChaining(true);
    try {
      const res = await fetch(job.downloadUrl, { credentials: "include" });
      if (!res.ok) throw new Error("expired");
      const blob = await res.blob();
      const next = new File([blob], job.name, { type: blob.type });
      setListFiles([next]);
      const q = new URLSearchParams();
      setParams(q);
    } catch {
      setPhase({ kind: "failed", title: "This result has expired", message: "Results are kept for an hour. Run the tool again, then pick the next tool." });
    } finally { setChaining(false); }
  };

  if (config.isLoading) return <div className="mx-auto max-w-5xl space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-40 w-full" /></div>;
  if (!enabled || info.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState icon={<IconWrench />} title="Tools are not on for this workspace" body="Document tools are not available here. If your workspace turned them off, an admin can turn them back on in Settings, General." />
      </div>
    );
  }

  const left = limits && info.data ? Math.max(0, limits.runsMonthly - info.data.usage.month) : null;
  const usage = left === null ? null : (
    <span className="inline-flex shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full border border-line px-2.5 py-1 text-[12.5px] text-muted tabular-nums sm:self-auto" title={`Up to ${limits?.runsDaily} a day. Runs reset on the 1st.`} data-testid="tools-usage">
      <span className={`h-1.5 w-1.5 rounded-full ${left === 0 ? "bg-bad" : left < 10 ? "bg-warn" : "bg-ok"}`} aria-hidden />
      {left === 0 ? "No runs left this month" : `${left} runs left this month`}
    </span>
  );

  // Entries that take what is in hand (a dropped file, a result, a mail attachment).
  const handName = listFiles[0]?.name ?? (fromMail && !tool ? fromMail.name : null);
  const shownEntries = handName
    ? entries.filter((e) => entryTakes(e, handName) && (listFiles.length ? !e.to : true))
    : entries;
  const found = searchEntries(shownEntries, query);
  const recents = (() => {
    const keys = recentKeys();
    const list = (keys.length ? keys : STARTERS).map((k) => entries.find((e) => e.key === k)).filter((e): e is Entry => !!e);
    return list.slice(0, 4);
  })();

  const searchBox = (compact?: boolean) => (
    <label className={`relative block ${compact ? "" : "max-w-xl"}`}>
      <span className="sr-only">Search tools</span>
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
      <input ref={compact ? undefined : search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={compact ? "Search tools" : "Search tools, like compress or merge"}
        onKeyDown={(e) => { if (e.key === "Enter") { const first = searchEntries(shownEntries, query)[0]; if (first) pick(first); } if (e.key === "Escape") setQuery(""); }}
        data-testid={compact ? "tools-search-rail" : "tools-search"}
        className={`w-full rounded-xl border border-line bg-surface pl-9 pr-9 text-[14px] placeholder:text-subtle ${ring} ${compact ? "h-9" : "h-11 max-sm:h-12 max-sm:text-[16px]"}`} />
      {!compact && <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 text-[11px] text-subtle max-sm:hidden" aria-hidden>/</kbd>}
    </label>
  );

  const sections = (compact: boolean) => SECTIONS.map((s) => {
    const list = found.filter((e) => e.section === s);
    if (!list.length) return null;
    return (
      <section key={s} aria-labelledby={`tools-sec-${s}-${compact ? "r" : "g"}`}>
        <h2 id={`tools-sec-${s}-${compact ? "r" : "g"}`} className={compact ? "mb-1 mt-3 px-2 text-[11.5px] font-semibold uppercase tracking-wide text-subtle" : "mb-2 text-[13px] font-semibold text-muted"}>{s}</h2>
        {compact
          ? <div className="space-y-0.5">{list.map((e) => <EntryButton key={e.key} e={e} compact active={e.key === op} onPick={pick} />)}</div>
          : <div className="grid gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">{list.map((e) => <EntryButton key={e.key} e={e} onPick={pick} />)}</div>}
      </section>
    );
  });

  // ---------- The list ----------
  if (!op || !tool) {
    if (op && info.isLoading) return <ToolSkeleton />;
    return (
      <div className="mx-auto w-full max-w-5xl pb-10" data-testid="tools-page" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="large-title">Tools</h1>
            <p className="mt-1 text-sm text-muted">Edit, convert and secure files without leaving Multies.</p>
          </div>
          {usage}
        </div>

        <div className="space-y-6">
          <div className="space-y-3">
            {searchBox()}
            {handName ? (
              <div className="flex items-center gap-3 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2.5 text-sm" data-testid="tools-hand">
                <IconFile className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                <span className="min-w-0 flex-1"><span className="text-muted">{listFiles.length ? "Pick a tool for " : "From your mail: "}</span><span className="font-medium" title={handName}>{middleTruncate(handName, 44)}</span></span>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setListFiles([]); if (fromMail) dropMail(); }}>Clear</Button>
              </div>
            ) : (
              <DropAny onFiles={(l) => { setListFiles(l); setQuery(""); }} dragging={dragging} />
            )}
          </div>

          {info.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading tools">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-[62px] rounded-xl" />)}</div>
          ) : (
            <>
              {!query && !handName && recents.length > 0 && (
                <section aria-labelledby="tools-recent">
                  <h2 id="tools-recent" className="mb-2 text-[13px] font-semibold text-muted">{recentKeys().length ? "Recent" : "Popular"}</h2>
                  <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                    {recents.map((e) => (
                      <button key={e.key} type="button" onClick={() => pick(e)} data-testid={`recent-${e.key}`}
                        className={`flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-1.5 pr-3.5 text-[13.5px] font-medium hover:bg-hover max-sm:min-h-11 ${ring}`}>
                        <ToolIcon e={e} size="sm" />{e.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {found.length ? <div className="space-y-6" role="group" aria-label="Choose a tool">{sections(false)}</div> : (
                <EmptyState icon={<IconSearch />} title={handName ? "No tool takes this file yet" : `No tool matches “${query}”`}
                  body={handName ? "Try another file, or clear it to see every tool." : "Try a shorter word, like PDF, Word or smaller."}
                  action={<Button variant="secondary" onClick={() => { setQuery(""); setListFiles([]); }}>Show all tools</Button>} />
              )}
            </>
          )}
          <p className="text-[12.5px] text-subtle">Files are processed on our document server in Singapore and deleted within an hour.</p>
        </div>
      </div>
    );
  }

  // ---------- One tool ----------
  const total = files.reduce((n, f) => n + f.size, 0);
  const tooBig = !!cap && total > cap;
  const problem = optionsProblem(tool, options);
  const extraOk = !tool.extra || (extraFiles.length >= tool.extra.min && extraFiles.length <= tool.extra.max);
  const mailFits = !!fromMail && tool.minFiles <= 1 && toolTakes(tool, fromMail.name);
  const haveFiles = fromMail ? mailFits : files.length >= tool.minFiles;
  const ready = haveFiles && !tooBig && !busy && !problem && extraOk;
  const shown = visibleOptions(tool, options);
  const folded = shown.length >= 4 ? (ADVANCED[tool.op] ?? []) : [];
  const essential = shown.filter((o) => !folded.includes(o.name));
  const advanced = shown.filter((o) => folded.includes(o.name));
  const advancedChanged = advanced.some((o) => (options[o.name] ?? "") !== String(o.default ?? ""));
  const hint = !haveFiles
    ? (fromMail ? `${tool.label} does not take this file.` : files.length && tool.minFiles > files.length ? `Add ${tool.minFiles - files.length} more to start.` : `Add ${tool.acceptLabel} to start.`)
    : tooBig ? null : problem ?? (!extraOk && tool.extra ? `Add ${tool.extra.label.toLowerCase()}.` : null);
  const e0 = entry ?? { icon: IconFile, section: "Edit PDF" as const, name: tool.label, line: tool.blurb };
  const elapsed = phase.kind === "working" ? Math.round((now - phase.since) / 1000) : 0;
  const waking = (phase.kind === "uploading" && phase.waking) || (phase.kind === "working" && cold && elapsed >= 4 && !phase.job.progress);

  return (
    <div className="mx-auto w-full max-w-6xl pb-6" data-testid="tools-page" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-6">
        <nav className="hidden lg:block" aria-label="All tools">
          <div className="sticky top-2 max-h-[calc(100dvh-5rem)] space-y-2 overflow-y-auto pb-6 pr-1">
            <button type="button" onClick={backToList} className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted hover:text-fg ${ring}`} data-testid="tools-back-rail"><IconArrowLeft className="h-3.5 w-3.5" aria-hidden />All tools</button>
            {searchBox(true)}
            {found.length ? sections(true) : <p className="px-2 py-3 text-[13px] text-muted">No tool matches.</p>}
          </div>
        </nav>

        <main className="min-w-0">
          <button type="button" onClick={backToList} className={`mb-3 flex min-h-11 items-center gap-1.5 rounded-lg pr-2 text-[14px] font-medium text-brand lg:hidden ${ring}`} data-testid="tools-back"><IconArrowLeft className="h-4 w-4" aria-hidden />All tools</button>
          <section className="relative space-y-5 rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:p-6" data-testid="tools-panel" aria-labelledby="tool-title"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) { e.preventDefault(); void run(); } }}>
            {dragging && !busy && !fromMail && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-brand bg-brand/10 text-[15px] font-semibold text-brand" aria-hidden>Drop to add</div>
            )}
            <header className="flex items-start gap-3.5">
              <ToolIcon e={e0} size="lg" />
              <div className="min-w-0 flex-1">
                <h1 id="tool-title" className="text-[20px] font-semibold leading-tight tracking-[-0.01em]">{tool.label}</h1>
                <p className="mt-1 text-[14px] text-muted">{tool.blurb}</p>
              </div>
              <div className="max-sm:hidden">{usage}</div>
            </header>
            {tool.note && <p className="flex gap-2 rounded-lg bg-fill/60 px-3 py-2 text-[13px] text-muted" data-testid="tools-note"><IconAlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{tool.note}</p>}

            {phase.kind === "done" && phase.job.downloadUrl && !tool.flow ? (
              <ResultCard job={phase.job} tool={tool} before={tool.op === "compress" ? files[0]?.size ?? null : null}
                onAttach={() => attachToNewEmail(navigate, { jobs: [phase.job] })} onChain={() => chain(phase.job)} chaining={chaining}
                onAgain={() => setPhase({ kind: "idle" })} onStartOver={startOver} />
            ) : (
              <>
                {fromMail && (
                  <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-3 text-sm" data-testid="tools-from-mail">
                    <IconMail className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate"><span className="text-muted">From your mail: </span><span title={fromMail.name}>{fromMail.name}</span></span>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={dropMail}>Use another file</Button>
                  </div>
                )}
                {!fromMail && (files.length === 0 || maxFiles > 1) && (
                  <div className={`rounded-2xl border-2 border-dashed text-center transition-colors ${dragging ? "border-brand bg-brand/5" : "border-line hover:border-line-strong"} ${files.length ? "px-4 py-3" : "px-4 py-9 max-sm:py-7"}`} data-testid="tools-drop">
                    {files.length === 0 ? (
                      <>
                        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand [&_svg]:h-6 [&_svg]:w-6" aria-hidden><IconFileUp /></span>
                        <p className="text-[15px] font-semibold"><span className="max-sm:hidden">Drop {tool.acceptLabel} here</span><span className="sm:hidden">Choose {tool.acceptLabel}</span></p>
                        <p className="mt-1 text-[13px] text-muted">Up to {cap ? mb(cap) : "20 MB"}{maxFiles > 1 ? `, ${maxFiles} files` : ""}{tool.maxPages ? `, ${tool.maxPages} pages` : ""}<span className="max-sm:hidden">. You can also paste a file.</span></p>
                      </>
                    ) : null}
                    <div className={`flex flex-wrap items-center justify-center gap-2 ${files.length ? "" : "mt-4"}`}>
                      {tool.camera && (
                        <Button type="button" className="sm:hidden" disabled={busy || files.length >= maxFiles} onClick={() => camera.current?.click()} data-testid="tools-camera"><IconCamera className="h-4 w-4" aria-hidden />{files.length ? "Take the next photo" : "Take photo"}</Button>
                      )}
                      {(files.length === 0 || maxFiles > 1) && (
                        <Button type="button" variant={tool.camera || files.length ? "secondary" : "primary"} disabled={busy || files.length >= maxFiles} onClick={() => input.current?.click()} data-testid="tools-choose">
                          {files.length ? "Add more" : maxFiles === 1 ? "Choose a file" : "Choose files"}
                        </Button>
                      )}
                    </div>
                    {tool.camera && files.length > 0 && <p className="mt-2 text-[12.5px] text-muted sm:hidden">{files.length} of {maxFiles} pages.</p>}
                  </div>
                )}

                {!fromMail && (
                  <>
                    <input ref={input} type="file" className="sr-only" accept={tool.accept} multiple={maxFiles > 1} data-testid="tools-input" aria-label={`Choose ${tool.acceptLabel}`}
                      onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
                    {tool.camera && <input ref={camera} type="file" className="sr-only" accept="image/*" capture="environment" data-testid="tools-camera-input" aria-label="Take a photo of a page"
                      onChange={(e) => { add(e.target.files); e.target.value = ""; }} />}
                  </>
                )}
                {fileProblem && (
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-2 rounded-xl border border-warn/40 bg-warn/10 py-2 pl-3 pr-1 text-[13.5px] sm:items-center" role="alert" data-testid="tools-file-problem">
                    <IconAlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warn sm:mt-0" aria-hidden />
                    <span className="py-0.5 sm:flex sm:items-center sm:justify-between sm:gap-3">
                      <span>{fileProblem.text}</span>
                      {fileProblem.switchTo && <Button type="button" size="sm" variant="outline" className="mt-2 shrink-0 sm:mt-0" onClick={() => pick(fileProblem.switchTo!, fileProblem.files)}>Use {fileProblem.switchTo.name}</Button>}
                    </span>
                    <Button type="button" size="icon" variant="ghost" onClick={() => setFileProblem(null)} aria-label="Dismiss"><IconClose className="h-4 w-4" /></Button>
                  </div>
                )}

                {files.length > 0 && (
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Files to use">
                    {files.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center gap-2.5 px-3 py-2 text-sm max-sm:min-h-[52px]">
                        {files.length > 1 && <span className="w-5 shrink-0 text-right text-[12.5px] text-subtle tabular-nums">{i + 1}</span>}
                        <FileBadge name={f.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium" title={f.name}>{middleTruncate(f.name, 38)}</span>
                          <span className="block text-[12px] text-muted tabular-nums">{sizeLabel(f.size)}</span>
                        </span>
                        {files.length > 1 && tool.ordered && (
                          <>
                            <Button type="button" variant="ghost" size="icon" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.name} up`}><IconArrowUp className="h-4 w-4" /></Button>
                            <Button type="button" variant="ghost" size="icon" disabled={busy || i === files.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.name} down`}><IconArrowDown className="h-4 w-4" /></Button>
                          </>
                        )}
                        {maxFiles === 1 && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => input.current?.click()} data-testid="tools-replace">Replace</Button>}
                        <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => remove(i)} aria-label={`Remove ${f.name}`}><IconClose className="h-4 w-4" /></Button>
                      </li>
                    ))}
                  </ul>
                )}
                {tooBig && cap && <p className="text-sm text-bad" role="alert">These files add up to {mb(total)}. {tool.maxBytes && limits && tool.maxBytes < limits.maxBytes ? `${tool.label} takes up to ${mb(cap)}.` : `Your plan allows ${mb(cap)} a run.`} Remove a file or compress it first.</p>}

                {tool.extra && !fromMail && (
                  <div className="space-y-2" data-testid="tools-extra">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-medium">{tool.extra.label}</span>
                      <Button type="button" variant="secondary" size="sm" disabled={busy || extraFiles.length >= tool.extra.max} onClick={() => extraInput.current?.click()}>Add</Button>
                    </div>
                    <input ref={extraInput} type="file" className="sr-only" accept={tool.extra.accept} multiple={tool.extra.max > 1} aria-label={tool.extra.label}
                      onChange={(e) => { const l = e.target.files ? [...e.target.files] : []; setExtraFiles((cur) => [...cur, ...l].slice(0, tool.extra!.max)); e.target.value = ""; }} />
                    {extraFiles.map((f, i) => (
                      <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-line px-3 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate" title={f.name}>{middleTruncate(f.name, 36)}</span><span className="text-[12.5px] text-muted">{sizeLabel(f.size)}</span>
                        <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => setExtraFiles((cur) => cur.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}><IconClose className="h-4 w-4" /></Button>
                      </div>
                    ))}
                  </div>
                )}

                {tool.flow === "autoredact" ? (
                  <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                    <AutoRedactPanel tool={tool} fromMail={fromMail} file={files[0] ?? null} disabled={!(fromMail ? mailFits : files.length >= 1 && !tooBig)} onUsage={() => qc.invalidateQueries({ queryKey: ["tools"] })} />
                  </Suspense>
                ) : (
                  <>
                    {essential.length > 0 && (
                      <div className="space-y-4" data-testid="tools-options">
                        {essential.map((o) => <OptionField key={o.name} o={o} value={options[o.name] ?? ""} disabled={busy} onChange={(v) => setOptions((cur) => ({ ...cur, [o.name]: v }))} />)}
                      </div>
                    )}
                    {advanced.length > 0 && (
                      <div className="rounded-xl border border-line" data-testid="tools-more">
                        <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen || advancedChanged}
                          className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium hover:bg-hover/50 max-sm:min-h-11 ${ring}`}>
                          <span>More options <span className="font-normal text-muted">({advanced.map((o) => o.label.toLowerCase()).join(", ")})</span></span>
                          <IconChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${moreOpen || advancedChanged ? "rotate-180" : ""}`} aria-hidden />
                        </button>
                        {(moreOpen || advancedChanged) && (
                          <div className="space-y-4 border-t border-line px-3 py-3">
                            {advanced.map((o) => <OptionField key={o.name} o={o} value={options[o.name] ?? ""} disabled={busy} onChange={(v) => setOptions((cur) => ({ ...cur, [o.name]: v }))} />)}
                          </div>
                        )}
                      </div>
                    )}

                    {phase.kind === "failed" && (
                      <div className="flex flex-wrap items-start gap-x-3 gap-y-3 rounded-xl border border-bad/30 bg-bad/5 p-4" role="alert" data-testid="tools-error">
                        <IconAlertCircle className="h-5 w-5 shrink-0 text-bad" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="text-[14.5px] font-semibold">{phase.title}</p>
                          <p className="mt-0.5 text-[13.5px] text-muted">{phase.message}</p>
                        </div>
                        {phase.limit && (
                          <div className="flex shrink-0 gap-2 max-sm:w-full max-sm:pl-8">
                            <Link to="/app/settings/billing" className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-hover max-sm:min-h-11">See plans</Link>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="max-sm:sticky max-sm:bottom-0 max-sm:z-20 max-sm:-mx-4 max-sm:-mb-4 max-sm:rounded-b-2xl max-sm:border-t max-sm:border-line max-sm:bg-surface/95 max-sm:px-4 max-sm:pb-[max(12px,env(safe-area-inset-bottom))] max-sm:pt-3 max-sm:backdrop-blur" data-testid="tools-actions">
                      {busy ? (
                        <Progress phase={phase} tool={tool} elapsed={elapsed} waking={waking} onCancel={cancel} />
                      ) : (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                          <Button type="button" size="lg" onClick={run} disabled={!ready} data-testid="tools-run" className="max-sm:w-full">{tool.label}</Button>
                          {hint && <span className="text-[13px] text-muted max-sm:text-center" data-testid="tools-hint">{hint}</span>}
                          {tool.op === "merge" && files.length >= 2 && !hint && <span className="text-[13px] text-muted max-sm:text-center">The order above is the order in the result.</span>}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
          <p className="mt-3 px-1 text-[12.5px] text-subtle">Files are processed on our document server in Singapore and deleted within an hour.</p>
        </main>
      </div>
    </div>
  );
}

function ToolSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-6" aria-busy="true" aria-label="Loading tool">
      <div className="hidden space-y-2 lg:block">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
      <div className="space-y-4 rounded-2xl border border-line p-6"><Skeleton className="h-11 w-64" /><Skeleton className="h-40 w-full rounded-2xl" /><Skeleton className="h-11 w-40" /></div>
    </div>
  );
}

/** The landing's "drop any file" bar: drop, choose or paste a file and the list shows only what takes it. */
function DropAny({ onFiles, dragging }: { onFiles: (f: File[]) => void; dragging: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={`flex items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-3.5 transition-colors ${dragging ? "border-brand bg-brand/5" : "border-line"}`} data-testid="tools-drop-any">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconFileUp /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-semibold"><span className="max-sm:hidden">Drop any file here</span><span className="sm:hidden">Start with a file</span></p>
        <p className="text-[13px] text-muted">See only the tools that work on it.</p>
      </div>
      <Button type="button" variant="secondary" onClick={() => ref.current?.click()}>Choose a file</Button>
      <input ref={ref} type="file" className="sr-only" aria-label="Choose a file to see its tools" data-testid="tools-any-input" onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
    </div>
  );
}

/** The type of a file as a small badge (PDF, DOCX, JPG). */
function FileBadge({ name, big }: { name: string; big?: boolean }) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "file").toUpperCase();
  const tone = ext === "PDF" ? "bg-[#FF3B30]/12 text-[#D70015] dark:text-[#FF6961]" : /DOCX?|ODT/.test(ext) ? "bg-[#0A84FF]/12 text-[#0060DF] dark:text-[#64A8FF]" : /XLSX?|CSV|ODS/.test(ext) ? "bg-[#34C759]/14 text-[#1E8E3E] dark:text-[#5BD87A]" : /ZIP/.test(ext) ? "bg-[#8E8E93]/16 text-muted" : "bg-[#FF9F0A]/14 text-[#B25F00] dark:text-[#FFB340]";
  return <span className={`grid shrink-0 place-items-center rounded-lg font-bold tracking-wide ${tone} ${big ? "h-14 w-12 text-[12px]" : "h-9 w-8 text-[9.5px]"}`} aria-hidden>{ext.slice(0, 4)}</span>;
}

function Progress({ phase, tool, elapsed, waking, onCancel }: { phase: Phase; tool: ToolDef; elapsed: number; waking: boolean; onCancel: () => void }) {
  const uploading = phase.kind === "uploading";
  const p = phase.kind === "working" ? phase.job.progress : undefined;
  const pct = uploading ? (phase.waking ? null : phase.pct) : p && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
  const line = uploading ? (phase.waking ? "Starting up" : phase.pct >= 100 ? "Sending to the document engine" : `Uploading ${phase.pct}%`) : phase.kind === "working" ? waitLine(tool, phase.job, phase.slow) : "";
  const steps = ["Upload", "Work", "Done"];
  const at = uploading ? 0 : 1;
  return (
    <div className="space-y-2.5" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[14px] font-medium" role="status" data-testid="tools-progress">{line}</span>
            {phase.kind === "working" && elapsed > 2 && <span className="text-[12.5px] text-subtle tabular-nums">{elapsed}s</span>}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fill" role="progressbar" aria-label={line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            {pct === null
              ? <div className="h-full w-1/3 rounded-full bg-brand motion-safe:animate-[tools-indeterminate_1.4s_ease-in-out_infinite]" />
              : <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${Math.max(4, pct)}%` }} />}
          </div>
        </div>
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="tools-cancel">Cancel</Button>
      </div>
      <ol className="flex items-center gap-2 text-[12px] text-subtle" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s} className={`flex items-center gap-1.5 ${i <= at ? "text-fg/80" : ""}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${i < at ? "bg-ok" : i === at ? "bg-brand" : "bg-line-strong"}`} aria-hidden />{s}
            {i < steps.length - 1 && <span className="ml-1 text-line-strong" aria-hidden>·</span>}
          </li>
        ))}
      </ol>
      {waking && <p className="rounded-lg bg-brand/5 px-3 py-2 text-[13px] text-muted" data-testid="tools-waking">Starting up. The first run after a quiet while can take up to a minute. You can leave this page open.</p>}
    </div>
  );
}

function ResultCard({ job, tool, before, onAttach, onChain, chaining, onAgain, onStartOver }: {
  job: ToolJob; tool: ToolDef; before: number | null; onAttach: () => void; onChain: () => void; chaining: boolean; onAgain: () => void; onStartOver: () => void;
}) {
  const facts = resultLine(job);
  const saved = before && job.bytes ? savedLine(before, job.bytes) : null;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(job.name)?.[1]?.toLowerCase();
  const pct = before && job.bytes && job.bytes < before ? Math.round((job.bytes / before) * 100) : null;
  return (
    <div className="space-y-4" data-testid="tools-result">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-ok"><IconCheckCircle className="h-5 w-5" aria-hidden />Done</div>
      <div className="flex items-center gap-3.5 rounded-xl border border-line bg-bg/40 p-3.5">
        <FileBadge name={job.name} big />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold" title={job.name}>{middleTruncate(job.name, 40)}</p>
          {saved ? <p className="mt-0.5 text-[13.5px] font-medium" data-testid="tools-saved">{saved}</p> : null}
          {pct !== null && <div className="mt-1.5 h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-fill" aria-hidden><div className="h-full rounded-full bg-ok" style={{ width: `${Math.max(3, pct)}%` }} /></div>}
          {facts && <p className="mt-0.5 text-[13px]" data-testid="tools-facts">{facts}</p>}
          <p className="mt-0.5 text-[12.5px] text-muted">{job.bytes && !saved ? `${sizeLabel(job.bytes)}. ` : ""}Ready to download for an hour.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
        <a href={job.downloadUrl} download={job.name} className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand px-5 text-sm font-medium text-brand-fg hover:opacity-90 max-sm:h-11 max-sm:text-[15px] ${ring}`} data-testid="tools-download"><IconDownload className="h-4 w-4" aria-hidden />Download</a>
        <button type="button" onClick={onAttach} data-testid="tools-attach" className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-hover disabled:opacity-40 max-sm:h-11 max-sm:text-[15px] ${ring}`}><IconMail className="h-4 w-4" aria-hidden />Attach to a new email</button>
        <ShareResultLinks job={job} />{/* Tools P2: share links and e-sign */}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[13.5px]">
        {ext !== "zip" && <button type="button" onClick={onChain} disabled={chaining} data-testid="tools-chain" className={`inline-flex min-h-9 items-center gap-1.5 font-medium text-brand hover:underline disabled:opacity-50 max-sm:min-h-11 ${ring}`}>{chaining ? "Opening" : "Use in another tool"}<IconArrowRight className="h-3.5 w-3.5" aria-hidden /></button>}
        {tool.options.some((o) => o.kind !== "json") && <button type="button" onClick={onAgain} className={`min-h-9 font-medium text-brand hover:underline max-sm:min-h-11 ${ring}`}>Change options and run again</button>}
        <button type="button" onClick={onStartOver} className={`min-h-9 font-medium text-brand hover:underline max-sm:min-h-11 ${ring}`} data-testid="tools-start-over">Start over</button>
      </div>
    </div>
  );
}

