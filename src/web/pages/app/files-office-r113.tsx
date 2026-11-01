/**
 * R113 Office files in the browser (flag OFFICE_EDIT_R113), at /app/files/edit/:id inside Files.
 * DOCX opens in a Docs style editor, XLSX and CSV in a grid with basic formulas, PPTX as slides (drawn by the engine;
 * a plain text outline when the engine is not available). All reading and writing happens in this browser; every save
 * is a NEW Files version (the server refuses a save that started from an older version). Basic fidelity, said plainly.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { api, ApiError } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconArrowLeft, IconBold, IconDownload, IconHeading1, IconHeading2, IconInfo, IconItalic, IconLink, IconList, IconListOrdered, IconLock, IconPlus, IconQuote, IconTable, IconUndo, IconWarning } from "@/web/components/ui/icon";
import { sizeLabel, type DriveDetail, type DriveItem } from "@/shared/drive";
import { OFFICE_CAPS, OfficeError } from "@/shared/office-r113/xml";
import { readDocx, writeDocx, type PMNode } from "@/shared/office-r113/docx";
import { readCsv, readXlsx, writeCsv, writeXlsx } from "@/shared/office-r113/xlsx";
import { readPptxOutline, type SlideOutline } from "@/shared/office-r113/pptx";
import { Calc, FErr, SHEET_CAPS, addr, colName, display, emptySheet, inputOf, parseInput, type Workbook } from "@/shared/office-r113/sheet";
import { loadPdfjs } from "@/web/components/tools/pdf-thumb";
import { runEngine } from "@/web/lib/convert/run";
import type { ToolOp } from "@/shared/tools";
import { officeKindOf, type OfficeKind } from "@/shared/office-r113/kind";
import { useLeaveGuard } from "@/web/components/tools/leave-guard";
import { LoadError } from "@/web/components/load-error-t1g";
import { LOAD_ERROR_TITLE } from "@/web/lib/load-errors-t1g";

/** F12 (MB-296): what the leave question says while the editor has unsaved edits. */
const NOT_AVAILABLE = "This file is not available to you.";
export const OFFICE_LEAVE_TEXT = "Your changes are not saved yet. If you leave, they will be lost.";

const capOf = (k: OfficeKind) => (k === "pptx" ? OFFICE_CAPS.slideBytes : k === "csv" ? OFFICE_CAPS.csvBytes : OFFICE_CAPS.editBytes);
const MIME: Record<OfficeKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const contentUrl = (id: string, v?: string, download = false) => `/api/drive/items/${encodeURIComponent(id)}/content${v || download ? "?" : ""}${v ? `v=${encodeURIComponent(v)}` : ""}${v && download ? "&" : ""}${download ? "download=1" : ""}`;

function useNarrow() {
  const q = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.(q).matches);
  useEffect(() => { const m = window.matchMedia?.(q); if (!m) return; const on = () => setNarrow(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  return !!narrow;
}

type Save = { bytes: Uint8Array; type: string };
type SaveState = { saving: boolean; conflict: boolean; dirty: boolean };

export function OfficeEditorPage() {
  const { id = "" } = useParams();
  const config = useConfig();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["drive", "item", id], queryFn: () => api.get<DriveDetail>(`/drive/items/${encodeURIComponent(id)}`), retry: false });
  const it = detail.data?.item;
  const current = detail.data?.versions.find((v) => v.current);
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => { if (current && !base) setBase(current.id); }, [current, base]);
  const kind = it ? officeKindOf(it.name) : null;
  const canEdit = !!it?.canEdit && kind !== "pptx";
  const [state, setState] = useState<SaveState>({ saving: false, conflict: false, dirty: false });
  const builder = useRef<(() => Save) | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [noteHidden, setNoteHidden] = useState(() => sessionStorage.getItem("office-note-hidden") === "1");

  useEffect(() => { if (it) document.title = `${it.name} · Files`; }, [it]);
  // F12 (MB-296): unsaved edits ask before leaving (rail, links, Back, reload or close), the same guard Convert uses.
  // A failed Save leaves state.dirty on, so the guard stays until a Save goes through.
  const leaveGuard = useLeaveGuard(state.dirty, "your changes", OFFICE_LEAVE_TEXT);
  const narrow = useNarrow();

  const save = useCallback(async (force = false) => {
    if (!builder.current || !it || state.saving) return;
    setState((s) => ({ ...s, saving: true }));
    try {
      const out = builder.current();
      if (out.bytes.length > 20 * 1024 * 1024) throw new Error("This file is now over the 20 MB Files limit, so it can't be saved. Remove some content and try again.");
      const q = new URLSearchParams({ via: "editor" });
      if (!force && base) q.set("base", base);
      const res = await fetch(`/api/drive/items/${encodeURIComponent(it.id)}/content?${q}`, { method: "PUT", credentials: "include", headers: { "x-multies-upload": "1", "content-type": out.type }, body: out.bytes as BodyInit });
      const body = await res.json().catch(() => null) as (DriveDetail & { error?: { code?: string; message?: string } }) | null;
      if (res.status === 409) { setState((s) => ({ ...s, saving: false, conflict: true })); return; }
      if (!res.ok || !body) throw new Error(body?.error?.message ?? "That didn't save. Check your connection and try again.");
      const now = body.versions.find((v) => v.current);
      if (now) setBase(now.id);
      qc.setQueryData(["drive", "item", it.id], body);
      void qc.invalidateQueries({ queryKey: ["drive"] });
      setState({ saving: false, conflict: false, dirty: false });
      toast.success(`Saved as version ${body.item.versions}`);
    } catch (e) {
      setState((s) => ({ ...s, saving: false }));
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    }
  }, [it, base, state.saving, qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (canEdit) void save(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, canEdit]);

  const openNewest = async () => {
    const d = await detail.refetch();
    const v = d.data?.versions.find((x) => x.current);
    setBase(v?.id ?? null); setState({ saving: false, conflict: false, dirty: false }); setReloadKey((k) => k + 1);
  };

  if (config.data && !config.data.officeEditR113) return <Shell><EmptyState icon={<IconInfo className="h-6 w-6" />} title="Editing office files is not on yet" body="You can still preview and download this file in Files." action={<BackLink />} /></Shell>;
  if (detail.isError) {
    const status = detail.error instanceof ApiError ? detail.error.status : 0;
    if (status !== 404 && status !== 403) return <Shell><LoadError onRetry={() => detail.refetch()} /></Shell>; // F12 (MB-299)
    return <Shell><EmptyState icon={<IconLock className="h-6 w-6" />} title="This file is not available to you" body="It may have been moved to trash, or it is not shared with you." action={<BackLink />} /></Shell>;
  }

  if (!it || !kind || !current) {
    if (it && !kind) return <Shell><EmptyState icon={<IconInfo className="h-6 w-6" />} title="No editor for this kind of file" body="Word (.docx), Excel (.xlsx), CSV and PowerPoint (.pptx) files open here. Download this one to open it on your computer." action={<BackLink />} /></Shell>;
    return <Shell><HeaderSkeleton /><Skeleton className="mx-auto mt-4 h-[60vh] w-full max-w-[816px] rounded-xl" /></Shell>;
  }
  const tooBig = it.sizeBytes > capOf(kind);
  return (
    <Shell>
      {leaveGuard}
      <header className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
        <BackLink compact />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold text-fg" title={it.name}>{it.name}</h1>
          <p className="text-xs text-subtle">
            Version {it.versions}{state.dirty ? " · Unsaved changes" : ""}{!canEdit && kind !== "pptx" ? " · View only" : ""}
          </p>
        </div>
        <a href={contentUrl(it.id, undefined, true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-fg transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11" download>
          <IconDownload className="h-4 w-4" /><span className="max-sm:sr-only">Download</span>
        </a>
        {canEdit && !tooBig && !(narrow && (kind === "xlsx" || kind === "csv")) && <Button onClick={() => void save()} disabled={state.saving || !state.dirty} aria-keyshortcuts="Control+S" className="max-sm:h-11">{state.saving ? "Saving" : "Save"}</Button>}
        {!canEdit && kind !== "pptx" && <span className="inline-flex items-center gap-1 rounded-full bg-fill px-2.5 py-1 text-xs text-muted"><IconLock className="h-3.5 w-3.5" />View only</span>}
      </header>
      {state.conflict && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 text-[13px]">
          <IconWarning className="h-4 w-4 text-warn" />
          <span className="min-w-0 flex-1 text-fg">Someone saved a newer version while you were editing. Your changes are still here.</span>
          <Button size="sm" onClick={() => void save(true)}>Save mine as a new version</Button>
          <Button size="sm" variant="secondary" onClick={() => void openNewest()}>Open the newest</Button>
        </div>
      )}
      {!noteHidden && !tooBig && kind !== "pptx" && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-fill px-3 py-2 text-[13px] text-muted">
          <IconInfo className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">Some formatting may look different. The original stays in Versions.</span>
          <button type="button" className="rounded px-1 text-xs text-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11" onClick={() => { sessionStorage.setItem("office-note-hidden", "1"); setNoteHidden(true); }}>Hide</button>
        </div>
      )}
      {tooBig ? (
        <EmptyState icon={<IconInfo className="h-6 w-6" />} title="This file is too big to open here"
          body={`Files up to ${sizeLabel(capOf(kind))} open in the browser and this one is ${sizeLabel(it.sizeBytes)}. Download it to open it on your computer.`}
          action={<a className="text-[13px] text-brand-hover hover:underline" href={contentUrl(it.id, undefined, true)} download>Download</a>} />
      ) : (
        <Loader key={`${reloadKey}:${base ?? ""}`} item={it} kind={kind} version={base ?? current.id} canEdit={canEdit}
          onDirty={() => setState((s) => (s.dirty ? s : { ...s, dirty: true }))} builder={builder} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) { return <div className="mx-auto w-full max-w-[1400px] px-3 py-4 sm:px-6">{children}</div>; }
function BackLink({ compact }: { compact?: boolean }) {
  return <Link to="/app/files" className={cn("inline-flex items-center gap-1.5 rounded-lg text-[13px] text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", compact ? "h-9 px-2 max-sm:h-11" : "")}><IconArrowLeft className="h-4 w-4" />{compact ? <span className="max-sm:sr-only">Files</span> : "Back to Files"}</Link>;
}
function HeaderSkeleton() { return <div className="flex items-center gap-3"><Skeleton className="h-8 w-16" /><Skeleton className="h-8 w-64" /><div className="flex-1" /><Skeleton className="h-9 w-24" /></div>; }

type Loaded = { kind: "docx"; doc: PMNode; notes: string[] } | { kind: "sheet"; wb: Workbook; notes: string[]; overCap: string | null; csv: boolean } | { kind: "pptx"; bytes: Uint8Array; name: string };

function Loader({ item, kind, version, canEdit, onDirty, builder }: { item: DriveItem; kind: OfficeKind; version: string; canEdit: boolean; onDirty: () => void; builder: React.MutableRefObject<(() => Save) | null> }) {
  const q = useQuery({
    queryKey: ["office", item.id, version],
    staleTime: Infinity, gcTime: 0, retry: false,
    queryFn: async (): Promise<Loaded> => {
      const res = await fetch(contentUrl(item.id, version), { credentials: "include" });
      if (!res.ok) throw new Error(res.status === 404 ? NOT_AVAILABLE : LOAD_ERROR_TITLE);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (kind === "docx") return { kind: "docx", ...readDocx(bytes) };
      if (kind === "xlsx") return { kind: "sheet", csv: false, ...readXlsx(bytes) };
      if (kind === "csv") return { kind: "sheet", csv: true, ...readCsv(new TextDecoder().decode(bytes), item.name.replace(/\.csv$/i, "").slice(0, 31) || "Sheet1") };
      return { kind: "pptx", bytes, name: item.name };
    },
  });
  if (q.isPending) return kind === "docx" ? <Skeleton className="mx-auto h-[60vh] w-full max-w-[816px] rounded-xl" /> : <GridSkeleton />;
  if (q.isError) {
    const office = q.error instanceof OfficeError;
    const gone = q.error instanceof Error && q.error.message === NOT_AVAILABLE;
    if (!office && !gone) return <LoadError onRetry={() => q.refetch()} />; // F12 (MB-299)
    return <EmptyState icon={<IconWarning className="h-6 w-6" />} title={office ? "This file could not be opened here" : NOT_AVAILABLE} body={office && q.error instanceof Error ? q.error.message : "It may have been moved to trash, or it is not shared with you."}
      action={office ? <a className="text-[13px] text-brand-hover hover:underline" href={contentUrl(item.id, undefined, true)} download>Download</a> : <BackLink />} />;
  }
  const d = q.data;
  if (d.kind === "docx") return <WordEditor doc={d.doc} notes={d.notes} canEdit={canEdit} onDirty={onDirty} builder={builder} />;
  if (d.kind === "sheet") return <SheetEditor wb={d.wb} notes={d.notes} overCap={d.overCap} csv={d.csv} canEdit={canEdit} onDirty={onDirty} builder={builder} />;
  return <SlidesViewer bytes={d.bytes} name={d.name} />;
}
function GridSkeleton() { return <div className="space-y-1.5 rounded-xl border border-line bg-surface p-3">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>; }

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <details className="mb-3 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted">
      <summary className="cursor-pointer select-none text-fg">What changes in this editor ({notes.length})</summary>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </details>
  );
}

// ---------------- Word ----------------
function WordEditor({ doc, notes, canEdit, onDirty, builder }: { doc: PMNode; notes: string[]; canEdit: boolean; onDirty: () => void; builder: React.MutableRefObject<(() => Save) | null> }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true } }), Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, Image.configure({ allowBase64: true })],
    content: doc as never,
    editable: canEdit,
    immediatelyRender: true,
    editorProps: { attributes: { class: "mm-prose min-h-[50vh] px-6 py-6 outline-none sm:px-12 sm:py-10", "aria-label": "Document", role: "textbox", "aria-multiline": "true" } },
    onUpdate: () => onDirty(),
  });
  useEffect(() => { builder.current = editor ? () => ({ bytes: writeDocx(editor.getJSON() as PMNode), type: MIME.docx }) : null; return () => { builder.current = null; }; }, [editor, builder]);
  const empty = !doc.content?.some((b) => b.content?.length || b.type !== "paragraph");
  return (
    <div>
      <Notes notes={notes} />
      {canEdit && editor && <WordToolbar editor={editor} />}
      <div className="mx-auto w-full max-w-[816px] rounded-xl border border-line bg-surface shadow-sm">
        {empty && canEdit && <p className="px-6 pt-6 text-[13px] text-subtle sm:px-12">This document is empty. Start typing.</p>}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
function TB({ label, on, onClick, children, disabled }: { label: string; on?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
    className={cn("inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 max-sm:h-11 max-sm:min-w-11", on && "bg-brand/10 text-fg")}>{children}</button>;
}
function WordToolbar({ editor }: { editor: Editor }) {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); editor.on("transaction", f); return () => { editor.off("transaction", f); }; }, [editor]);
  const [link, setLink] = useState<string | null>(null);
  const c = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 mx-auto mb-2 flex w-full max-w-[816px] items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-surface/95 p-1 backdrop-blur">
      <TB label="Undo" onClick={() => c().undo().run()} disabled={!editor.can().undo()}><IconUndo className="h-4 w-4" /></TB>
      <TB label="Redo" onClick={() => c().redo().run()} disabled={!editor.can().redo()}><IconUndo className="h-4 w-4 -scale-x-100" /></TB>
      <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
      <TB label="Heading 1" on={editor.isActive("heading", { level: 1 })} onClick={() => c().toggleHeading({ level: 1 }).run()}><IconHeading1 className="h-4 w-4" /></TB>
      <TB label="Heading 2" on={editor.isActive("heading", { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()}><IconHeading2 className="h-4 w-4" /></TB>
      <TB label="Bold" on={editor.isActive("bold")} onClick={() => c().toggleBold().run()}><IconBold className="h-4 w-4" /></TB>
      <TB label="Italic" on={editor.isActive("italic")} onClick={() => c().toggleItalic().run()}><IconItalic className="h-4 w-4" /></TB>
      <TB label="Underline" on={editor.isActive("underline")} onClick={() => c().toggleUnderline().run()}><span className="font-semibold underline">U</span></TB>
      <TB label="Strikethrough" on={editor.isActive("strike")} onClick={() => c().toggleStrike().run()}><span className="font-semibold line-through">S</span></TB>
      <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
      <TB label="Bulleted list" on={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()}><IconList className="h-4 w-4" /></TB>
      <TB label="Numbered list" on={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()}><IconListOrdered className="h-4 w-4" /></TB>
      <TB label="Quote" on={editor.isActive("blockquote")} onClick={() => c().toggleBlockquote().run()}><IconQuote className="h-4 w-4" /></TB>
      <TB label="Link" on={editor.isActive("link")} onClick={() => setLink(editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : "https://")}><IconLink className="h-4 w-4" /></TB>
      <TB label="Insert table" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><IconTable className="h-4 w-4" /></TB>
      {link !== null && (
        <form className="ml-1 flex shrink-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); const href = link.trim(); if (!href || href === "https://") c().unsetLink().run(); else if (/^(https?:\/\/|mailto:)/i.test(href)) c().extendMarkRange("link").setLink({ href }).run(); else { toast.error("Links start with https:// or mailto:"); return; } setLink(null); }}>
          <label className="sr-only" htmlFor="office-link">Link address</label>
          <input id="office-link" autoFocus value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setLink(null); }} className="h-8 w-48 rounded-md border border-line bg-surface px-2 text-[13px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" />
          <Button size="sm" type="submit">Apply</Button>
        </form>
      )}
    </div>
  );
}

// ---------------- Sheet ----------------
const ROW_H = 28; const HEAD_W = 48; const COL_W = 104;
function SheetEditor({ wb, notes, overCap, csv, canEdit, onDirty, builder }: { wb: Workbook; notes: string[]; overCap: string | null; csv: boolean; canEdit: boolean; onDirty: () => void; builder: React.MutableRefObject<(() => Save) | null> }) {
  const narrow = useNarrow();
  const editable = canEdit && !overCap && !narrow;
  const [rev, setRev] = useState(0);
  const [si, setSi] = useState(0);
  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [edit, setEdit] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(480);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const calc = useMemo(() => new Calc(wb), [wb]);
  useMemo(() => calc.reset(), [calc, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const sh = wb.sheets[si] ?? wb.sheets[0];
  useEffect(() => { builder.current = editable ? () => (csv ? { bytes: new TextEncoder().encode(writeCsv(wb, 0)), type: MIME.csv } : { bytes: writeXlsx(wb), type: MIME.xlsx }) : null; return () => { builder.current = null; }; }, [wb, csv, editable, builder]);
  useEffect(() => { const el = scroller.current; if (!el) return; const ro = new ResizeObserver(() => setHeight(el.clientHeight)); ro.observe(el); return () => ro.disconnect(); }, []);
  const widths = useMemo(() => Array.from({ length: sh.colCount }, (_, c) => Math.max(48, Math.min(480, sh.colWidths?.[c] ?? COL_W))), [sh, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalW = HEAD_W + widths.reduce((s, w) => s + w, 0);
  const first = Math.max(0, Math.floor(top / ROW_H) - 6); const last = Math.min(sh.rowCount - 1, Math.ceil((top + height) / ROW_H) + 6);
  const cellKey = addr(sel.r, sel.c);
  const commit = (raw: string, move: { dr: number; dc: number } | null) => {
    const cell = parseInput(raw);
    const old = sh.cells.get(cellKey);
    const keepDate = old?.date && typeof cell.v === "number";
    if (cell.v === undefined && cell.f == null) sh.cells.delete(cellKey); else sh.cells.set(cellKey, keepDate ? { ...cell, date: true } : cell);
    if (inputOf(old) !== raw) { onDirty(); setRev((n) => n + 1); }
    setEdit(null);
    if (move) go(sel.r + move.dr, sel.c + move.dc);
    grid.current?.focus();
  };
  const go = (r: number, c: number) => {
    const nr = Math.max(0, Math.min(sh.rowCount - 1, r)), nc = Math.max(0, Math.min(sh.colCount - 1, c));
    setSel({ r: nr, c: nc });
    const el = scroller.current; if (!el) return;
    const y = nr * ROW_H; if (y < el.scrollTop) el.scrollTop = y; else if (y + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H * 2 - el.clientHeight;
    const x = HEAD_W + widths.slice(0, nc).reduce((s, w) => s + w, 0);
    if (x - HEAD_W < el.scrollLeft) el.scrollLeft = x - HEAD_W; else if (x + widths[nc] > el.scrollLeft + el.clientWidth) el.scrollLeft = x + widths[nc] - el.clientWidth;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (edit !== null) return;
    const k = e.key;
    const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (mv[k]) { e.preventDefault(); go(sel.r + mv[k][0], sel.c + mv[k][1]); return; }
    if (k === "Tab") { e.preventDefault(); go(sel.r, sel.c + (e.shiftKey ? -1 : 1)); return; }
    if (k === "Home") { e.preventDefault(); go(e.ctrlKey ? 0 : sel.r, 0); return; }
    if (k === "PageDown" || k === "PageUp") { e.preventDefault(); go(sel.r + (k === "PageDown" ? 1 : -1) * Math.floor(height / ROW_H), sel.c); return; }
    if (!editable) return;
    if (k === "Enter" || k === "F2") { e.preventDefault(); setEdit(inputOf(sh.cells.get(cellKey))); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); if (sh.cells.has(cellKey)) { sh.cells.delete(cellKey); onDirty(); setRev((n) => n + 1); } return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setEdit(k); }
  };
  const addRows = () => { sh.rowCount = Math.min(SHEET_CAPS.rows, sh.rowCount + 20); setRev((n) => n + 1); };
  const addCol = () => { sh.colCount = Math.min(SHEET_CAPS.cols, sh.colCount + 1); setRev((n) => n + 1); };
  const addSheet = () => { if (wb.sheets.length >= SHEET_CAPS.sheets) return; let n = wb.sheets.length + 1; while (wb.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++; wb.sheets.push(emptySheet(`Sheet${n}`)); onDirty(); setSi(wb.sheets.length - 1); setSel({ r: 0, c: 0 }); setRev((x) => x + 1); };
  const val = calc.value(si, sel.r, sel.c);
  return (
    <div>
      {overCap && <div role="status" className="mb-3 flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-fg"><IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span>{overCap} Download it to edit the whole file.</span></div>}
      {narrow && canEdit && !overCap && <div role="status" className="mb-3 flex items-start gap-2 rounded-xl bg-fill px-3 py-2 text-[13px] text-muted"><IconInfo className="mt-0.5 h-4 w-4 shrink-0" /><span>Edit sheets on a bigger screen. You can view here.</span></div>}
      <Notes notes={notes} />
      <div className="flex items-center gap-2 rounded-t-xl border border-b-0 border-line bg-surface px-2 py-1.5">
        <span className="w-14 shrink-0 rounded bg-fill px-2 py-1 text-center font-mono text-xs text-muted" aria-label="Selected cell">{cellKey}</span>
        <label htmlFor="office-fx" className="sr-only">Cell contents</label>
        <input id="office-fx" className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-[13px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand read-only:bg-fill max-sm:h-11"
          readOnly={!editable} value={edit ?? inputOf(sh.cells.get(cellKey))}
          onFocus={() => { if (editable && edit === null) setEdit(inputOf(sh.cells.get(cellKey))); }}
          onChange={(e) => setEdit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(edit ?? "", { dr: 1, dc: 0 }); } else if (e.key === "Escape") { setEdit(null); grid.current?.focus(); } }} />
        <span className={cn("hidden max-w-[30%] truncate text-xs sm:block", val instanceof FErr ? "text-bad" : "text-subtle")} aria-live="polite">{val instanceof FErr ? errorHelp(val) : ""}</span>
      </div>
      <div ref={scroller} className="relative h-[calc(100vh-280px)] min-h-[320px] overflow-auto border border-line bg-surface" onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}>
        <div ref={grid} role="grid" tabIndex={0} aria-label={`${sh.name} sheet`} aria-rowcount={sh.rowCount + 1} aria-colcount={sh.colCount + 1} aria-readonly={!editable}
          aria-activedescendant={`cell-${si}-${cellKey}`} onKeyDown={onKey} className="relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" style={{ width: totalW, height: (sh.rowCount + 1) * ROW_H }}>
          <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b border-line bg-fill" style={{ height: ROW_H, width: totalW }}>
            <div role="columnheader" className="sticky left-0 z-30 border-r border-line bg-fill" style={{ width: HEAD_W }} aria-label="Row numbers" />
            {widths.map((w, c) => <div key={c} role="columnheader" aria-colindex={c + 2} className={cn("flex items-center justify-center border-r border-line text-xs text-muted", c === sel.c && "bg-brand/10 text-fg")} style={{ width: w }}>{colName(c)}</div>)}
          </div>
          {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((r) => (
            <div key={r} role="row" aria-rowindex={r + 2} className="absolute left-0 flex border-b border-line" style={{ top: (r + 1) * ROW_H, height: ROW_H, width: totalW }}>
              <div role="rowheader" className={cn("sticky left-0 z-10 flex items-center justify-center border-r border-line bg-fill text-xs text-muted", r === sel.r && "bg-brand/10 text-fg")} style={{ width: HEAD_W }}>{r + 1}</div>
              {widths.map((w, c) => {
                const a = addr(r, c); const cell = sh.cells.get(a); const active = r === sel.r && c === sel.c;
                const v = cell ? calc.value(si, r, c) : null; const err = v instanceof FErr;
                return (
                  <div key={c} id={`cell-${si}-${a}`} role="gridcell" aria-colindex={c + 2} aria-selected={active}
                    onMouseDown={() => { if (edit !== null && !active) commit(edit, null); setSel({ r, c }); }} onDoubleClick={() => { if (editable) setEdit(inputOf(cell)); }}
                    className={cn("relative truncate border-r border-line px-1.5 text-[13px] leading-[27px] text-fg", typeof v === "number" && "text-right tabular-nums", err && "text-bad", active && "z-[5] outline outline-2 -outline-offset-1 outline-brand")}
                    style={{ width: w }} title={err ? errorHelp(v) : undefined}>
                    {active && edit !== null ? (
                      <input aria-label={`Edit ${a}`} autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} className="absolute inset-0 z-10 w-full bg-surface px-1.5 font-mono text-[13px] text-fg outline outline-2 outline-brand"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(edit, { dr: e.shiftKey ? -1 : 1, dc: 0 }); } else if (e.key === "Tab") { e.preventDefault(); commit(edit, { dr: 0, dc: e.shiftKey ? -1 : 1 }); } else if (e.key === "Escape") { e.preventDefault(); setEdit(null); grid.current?.focus(); } }}
                        onBlur={() => { if (edit !== null) commit(edit, null); }} />
                    ) : display(v, cell?.date)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 rounded-b-xl border border-t-0 border-line bg-surface px-2 py-1.5">
        <div role="tablist" aria-label="Sheets" className="flex min-w-0 flex-wrap items-center gap-1">
        {wb.sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === si} onClick={() => { if (edit !== null) commit(edit, null); setSi(i); setSel({ r: 0, c: 0 }); }}
          className={cn("h-8 max-w-[160px] truncate rounded-md px-3 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11", i === si ? "bg-brand/10 font-medium text-fg" : "text-muted hover:bg-hover")}>{s.name}</button>)}
        </div>
        {editable && !csv && wb.sheets.length < SHEET_CAPS.sheets && <TB label="Add sheet" onClick={addSheet}><IconPlus className="h-4 w-4" /></TB>}
        <div className="flex-1" />
        {editable && <><Button size="sm" variant="ghost" onClick={addRows} disabled={sh.rowCount >= SHEET_CAPS.rows}>Add 20 rows</Button><Button size="sm" variant="ghost" onClick={addCol} disabled={sh.colCount >= SHEET_CAPS.cols}>Add column</Button></>}
        <span className="text-xs text-subtle">Up to {SHEET_CAPS.rows.toLocaleString("en")} rows and {SHEET_CAPS.cols} columns</span>
      </div>
    </div>
  );
}
function errorHelp(v: FErr): string {
  switch (v.code) {
    case "#DIV/0!": return "Dividing by zero, or averaging no numbers";
    case "#REF!": return "Points at a sheet or cell that does not exist";
    case "#NAME?": return "Unknown function. SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, ABS, AND, OR, NOT and CONCAT work here";
    case "#CYCLE!": return "This formula refers back to itself";
    default: return "A value here is not a number, or the formula is incomplete";
  }
}

// ---------------- Slides ----------------
function SlidesViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [state, setState] = useState<{ step: "drawing"; pct: number } | { step: "pages"; pages: string[] } | { step: "outline"; slides: SlideOutline[]; why: string } | { step: "failed"; why: string }>({ step: "drawing", pct: 0 });
  const [i, setI] = useState(0);
  useEffect(() => {
    const ctl = new AbortController(); let alive = true;
    (async () => {
      try {
        const file = new File([bytes as BlobPart], name, { type: MIME.pptx });
        const run = await runEngine("convert" as ToolOp, file, {}, "Getting your slides ready", (p) => alive && setState({ step: "drawing", pct: Math.round(p.fraction * 100) }), { signal: ctl.signal, type: "application/pdf" });
        const lib = await loadPdfjs();
        const pdf = await lib.getDocument({ data: new Uint8Array(await run.file.arrayBuffer()) }).promise;
        const pages: string[] = [];
        for (let n = 1; n <= Math.min(pdf.numPages, 200); n++) {
          const page = await pdf.getPage(n);
          const vp = page.getViewport({ scale: 1600 / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement("canvas"); canvas.width = vp.width; canvas.height = vp.height;
          const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("no canvas");
          await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
          pages.push(canvas.toDataURL("image/jpeg", 0.85));
          if (!alive) return;
        }
        void (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
        if (alive) setState({ step: "pages", pages });
      } catch {
        if (!alive) return;
        try { setState({ step: "outline", slides: readPptxOutline(bytes), why: "The slides could not be drawn right now, so here is the text of each slide." }); }
        catch (e) { setState({ step: "failed", why: e instanceof Error ? e.message : "This deck could not be opened." }); }
      }
    })();
    return () => { alive = false; ctl.abort(); };
  }, [bytes, name]);
  const count = state.step === "pages" ? state.pages.length : state.step === "outline" ? state.slides.length : 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,[contenteditable=true]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") setI((x) => Math.min(count - 1, x + 1));
      else if (e.key === "ArrowLeft" || e.key === "PageUp") setI((x) => Math.max(0, x - 1));
      else if (e.key === "Home") setI(0); else if (e.key === "End") setI(Math.max(0, count - 1));
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [count]);
  if (state.step === "drawing") return (
    <div className="rounded-xl border border-line bg-surface p-6" role="status" aria-live="polite">
      <p className="text-[13.5px] font-medium text-fg">Getting your slides ready</p>
      <p className="mt-1 text-xs text-subtle">Drawing slides uses one Tools run. Nothing is changed.</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-fill"><div className="h-full bg-brand transition-[width] duration-200" style={{ width: `${Math.max(4, state.pct)}%` }} /></div>
      <Skeleton className="mt-4 aspect-video w-full rounded-lg" />
    </div>
  );
  if (state.step === "failed") return <EmptyState icon={<IconWarning className="h-6 w-6" />} title="This deck could not be opened here" body={state.why} />;
  if (!count) return <EmptyState icon={<IconInfo className="h-6 w-6" />} title="This deck has no slides" body="Add slides on your computer, then upload it again as a new version." />;
  const cur = Math.min(i, count - 1);
  return (
    <div>
      {state.step === "outline" && <div role="status" className="mb-3 flex items-start gap-2 rounded-xl bg-fill px-3 py-2 text-[13px] text-muted"><IconInfo className="mt-0.5 h-4 w-4 shrink-0" /><span>{state.why}</span></div>}
      <div className="flex flex-col gap-3 md:flex-row">
        <nav aria-label="Slides" className="flex gap-2 overflow-x-auto md:max-h-[calc(100vh-220px)] md:w-40 md:shrink-0 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          {Array.from({ length: count }, (_, n) => (
            <button key={n} type="button" onClick={() => setI(n)} aria-current={n === cur ? "true" : undefined} aria-label={`Slide ${n + 1}`}
              className={cn("relative shrink-0 overflow-hidden rounded-lg border bg-surface text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-md:w-28", n === cur ? "border-brand" : "border-line hover:border-line-strong")}>
              {state.step === "pages" ? <img src={state.pages[n]} alt="" className="aspect-video w-full object-contain" /> : <span className="block aspect-video truncate p-2 text-[11px] text-muted">{state.slides[n].title || `Slide ${n + 1}`}</span>}
              <span className="absolute bottom-1 left-1 rounded bg-surface/90 px-1 text-[10px] text-muted">{n + 1}</span>
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1" aria-label={`Slide ${cur + 1} of ${count}`}>
          {state.step === "pages"
            ? <img src={state.pages[cur]} alt={`Slide ${cur + 1}`} className="aspect-video w-full rounded-xl border border-line bg-white object-contain" />
            : <div className="aspect-video w-full overflow-auto rounded-xl border border-line bg-surface p-6 sm:p-10"><h2 className="text-xl font-semibold text-fg">{state.slides[cur].title || `Slide ${cur + 1}`}</h2><ul className="mt-4 list-disc space-y-1.5 pl-5 text-[15px] text-fg">{state.slides[cur].lines.map((l, k) => <li key={k}>{l}</li>)}</ul></div>}
          <div className="mt-2 flex items-center justify-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => setI(Math.max(0, cur - 1))} disabled={cur === 0} className="max-sm:h-11">Previous</Button>
            <span className="text-[13px] text-muted" aria-live="polite">Slide {cur + 1} of {count}</span>
            <Button size="sm" variant="secondary" onClick={() => setI(Math.min(count - 1, cur + 1))} disabled={cur >= count - 1} className="max-sm:h-11">Next</Button>
          </div>
        </section>
      </div>
    </div>
  );
}
