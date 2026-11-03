/**
 * R125: tables, a doc type. A table opens at /app/docs/:id like any doc (DocPage hands over when kind is "table").
 * Views: grid (keyboard, paste a block, resize, sort, filter, group, hide, frozen first column), kanban by a single
 * select, calendar by a date, and a form. Row detail opens as a sheet with comments and history. CSV in and out,
 * three templates, undo of the last changes. Behind the `tablesR125` flag. All copy sentence case, no dashes.
 */
import { usePageTitle } from "@/web/lib/page-title-pol1"; // POL1
import { quickRetry } from "@/web/lib/quick-retry-pol1"; // POL1
import { MoreMenu, useTrashAction } from "@/web/components/trash-pol1"; // POL1 (MB-313)
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconCalendar, IconChat, IconChevronDown, IconClose, IconColumns, IconDownload, IconEye, IconEyeOff, IconFilter, IconGrid, IconHistory, IconList, IconLock, IconMaximize,
  IconPlus, IconSearch, IconSettings, IconSort, IconTable, IconTrash, IconUndo, IconUpload,
} from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import {
  cellText, coerceCell, FIELD_TYPES, guessType, isComputed, LIMITS, OP_LABELS, opsFor, parseCsv, showDate, TEMPLATES, TYPE_LABELS,
  type FilterOp, type LinkLabel, type TCell, type TField, type TFieldType, type TFilter, type TSort, type ViewConfig, type ViewType,
} from "@/shared/tables-r125";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";

/** On when the server flag is on and this workspace is not excluded (an excluded workspace gets 404 from the list). */
export function useTablesOn() {
  const flag = !!useConfig().data?.tablesR125;
  const list = useQuery({ queryKey: ["tables-list"], enabled: flag, staleTime: 300_000, retry: false, queryFn: () => api.get<{ tables: { id: string; title: string }[] }>("/tables") });
  return flag && list.isSuccess;
}

interface View { id: string; name: string; type: ViewType; config: ViewConfig; position: number }
interface Detail {
  table: { id: string; title: string; editAccess: "everyone" | "admins"; rowCount: number; canEdit: boolean; canManage: boolean; canDelete?: boolean; guest: boolean };
  fields: TField[]; views: View[]; linked: Record<string, { title: string; fields: TField[] }>;
}
export interface Row { id: string; seq: number; version: number; values: Record<string, TCell>; labels: Record<string, LinkLabel[]>; hidden?: Record<string, number>; errors?: Record<string, string> }
interface Page { rows: Row[]; nextCursor: string | null; total: number }
type Undo = { kind: "cells"; before: { id: string; cells: Record<string, TCell> }[] } | { kind: "create"; ids: string[] } | { kind: "delete"; ids: string[] } | { kind: "multi"; parts: Undo[] };
type Linked = Detail["linked"];

const VIEW_ICONS: Record<ViewType, ReactNode> = { grid: <IconGrid className="h-4 w-4" />, kanban: <IconColumns className="h-4 w-4" />, calendar: <IconCalendar className="h-4 w-4" />, form: <IconList className="h-4 w-4" /> };
const VIEW_LABELS: Record<ViewType, string> = { grid: "Grid", kanban: "Kanban", calendar: "Calendar", form: "Form" };
const qk = (id: string) => ["table", id] as const;
const label13 = "mb-1 block text-[13px] font-medium";

function display(f: TField, r: Row): string {
  if (r.errors?.[f.id]) return "Error";
  return cellText(f, r.values[f.id] ?? null, r.labels[f.id]);
}
const rawForEdit = (f: TField, r: Row): string => {
  const v = r.values[f.id];
  if (v === null || v === undefined) return "";
  if (f.type === "currency" && typeof v === "number") return (v / 100).toFixed(2);
  if (f.type === "date" && typeof v === "string") return showDate(v);
  return cellText(f, v, r.labels[f.id]);
};

// ---------- new table (Docs > New table) ----------
export function NewTableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"pick" | "csv">("pick");
  const make = useMutation({
    mutationFn: (template: string | null) => api.post<{ table: { id: string } }>("/tables", { template, title: template ? undefined : "Untitled table" }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["docs"] }); onClose(); navigate(`/app/docs/${r.table.id}`); },
    onError: (e) => showError(e as Error),
  });
  useEffect(() => { if (!open) setMode("pick"); }, [open]);
  if (mode === "csv") return <CsvImportDialog open={open} onClose={onClose} onDone={(id) => { onClose(); navigate(`/app/docs/${id}`); }} />;
  return (
    <Dialog open={open} onClose={onClose} title="New table" description="Start blank, from a CSV file or from a template. You can change everything later." className="max-w-2xl">
      <div className="grid gap-3 sm:grid-cols-2" data-testid="table-templates">
        <TemplateCard title="Blank table" body="Name, notes and status to start with." onClick={() => make.mutate(null)} busy={make.isPending} />
        <TemplateCard title="Import a CSV file" body="Bring in up to 5,000 rows. You check the columns first." onClick={() => setMode("csv")} />
        {TEMPLATES.map((t) => <TemplateCard key={t.id} title={t.name} body={t.description} onClick={() => make.mutate(t.id)} busy={make.isPending} />)}
      </div>
    </Dialog>
  );
}
function TemplateCard({ title, body, onClick, busy }: { title: string; body: string; onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="min-h-[44px] rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60">
      <div className="text-[14px] font-medium text-fg">{title}</div>
      <div className="mt-1 text-[13px] text-muted">{body}</div>
    </button>
  );
}

// ---------- CSV import ----------
interface ImportResult { docId: string; imported: number; skipped: number; problems: { row: number; field: string; error: string }[]; problemCount: number }
function CsvImportDialog({ open, onClose, onDone, into }: { open: boolean; onClose: () => void; onDone: (docId: string) => void; into?: { id: string; fields: TField[] } }) {
  const [file, setFile] = useState<{ name: string; rows: string[][]; tooMany: boolean } | null>(null);
  const [cols, setCols] = useState<{ name: string; type: TFieldType; fieldId: string | null; skip: boolean }[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [err, setErr] = useState("");
  const usable = (f: TField) => !isComputed(f.type) && f.type !== "link" && f.type !== "attachment";
  const read = async (f: File) => {
    setErr("");
    if (f.size > 20_000_000) { setErr("That file is over 20 MB. Split it and try again."); return; }
    const all = parseCsv(await f.text(), LIMITS.importRows + 2);
    if (all.length < 2) { setErr("That file has no rows under its header."); return; }
    const [header, ...rows] = all;
    setFile({ name: f.name.replace(/\.csv$/i, ""), rows: rows.slice(0, LIMITS.importRows), tooMany: rows.length > LIMITS.importRows });
    setCols(header.map((h, i) => {
      const match = into?.fields.find((x) => x.name.toLowerCase() === h.trim().toLowerCase() && usable(x));
      return { name: h.trim() || `Column ${i + 1}`, type: guessType(rows.slice(0, 500).map((r) => r[i] ?? "")), fieldId: match?.id ?? null, skip: !!into && !match };
    }));
  };
  const go = useMutation({
    mutationFn: () => {
      const body = { columns: cols.map((c) => ({ name: c.name, type: c.type, fieldId: c.fieldId, skip: c.skip })), rows: file!.rows };
      return into ? api.post<ImportResult>(`/tables/${into.id}/import`, body) : api.post<ImportResult>("/tables/import", { ...body, title: file!.name });
    },
    onSuccess: (r) => setResult({ ...r, docId: r.docId ?? into?.id ?? "" }),
    onError: (e) => showError(e as Error),
  });
  const importable: TFieldType[] = FIELD_TYPES.filter((t) => !isComputed(t) && t !== "link" && t !== "attachment");
  const setCol = (i: number, p: Partial<(typeof cols)[number]>) => setCols((cs) => cs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <Dialog open={open} onClose={onClose} title={result ? "Import finished" : "Import a CSV file"} className="max-w-3xl"
      footer={result ? <Button onClick={() => onDone(result.docId)}>Open the table</Button>
        : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => go.mutate()} disabled={!file || go.isPending || cols.every((c) => c.skip)} data-testid="csv-import-go">{go.isPending ? "Bringing it in" : file ? `Import ${file.rows.length.toLocaleString("en-AU")} rows` : "Import"}</Button></>}>
      {result ? (
        <div className="space-y-3 text-[14px]" data-testid="csv-import-result">
          <p><strong>{result.imported.toLocaleString("en-AU")}</strong> rows imported{result.skipped ? `, ${result.skipped} empty rows left out` : ""}.</p>
          {result.problemCount > 0 && <div className="rounded-lg border border-warn/40 p-3">
            <p className="font-medium text-warn">{result.problemCount} cells did not fit their column and were left empty.</p>
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-[13px] text-muted">{result.problems.map((p, i) => <li key={i}>Row {p.row}{p.field ? `, ${p.field}` : ""}: {p.error}</li>)}</ul>
          </div>}
        </div>
      ) : !file ? (
        <label className="flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line p-6 text-center hover:bg-hover/50">
          <IconUpload className="h-6 w-6 text-muted" />
          <span className="text-[14px] font-medium">Choose a CSV file</span>
          <span className="text-[13px] text-muted">The first row names the columns. Dates are read day first (02/11/2026).</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" data-testid="csv-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
          {err && <span className="text-[13px] text-bad" role="alert">{err}</span>}
        </label>
      ) : (
        <div className="space-y-3">
          {file.tooMany && <p className="text-[13px] text-warn" role="status">This file has more than 5,000 rows. Only the first 5,000 will come in.</p>}
          <p className="text-[13px] text-muted">Check each column. Types were guessed from the first rows.</p>
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-fill/60 text-left text-muted"><tr><th className="px-3 py-2 font-medium">Column</th><th className="px-3 py-2 font-medium">{into ? "Goes into" : "Type"}</th><th className="px-3 py-2 font-medium">First values</th></tr></thead>
              <tbody className="divide-y divide-line">
                {cols.map((c, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">{into ? c.name : <Input aria-label={`Name for column ${i + 1}`} value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} />}</td>
                    <td className="px-3 py-2">
                      {into ? (
                        <Select aria-label={`Field for ${c.name}`} value={c.skip ? "" : c.fieldId ?? ""} onChange={(e) => setCol(i, { fieldId: e.target.value || null, skip: !e.target.value })}>
                          <option value="">Leave out</option>
                          {into.fields.filter(usable).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </Select>
                      ) : (
                        <Select aria-label={`Type for ${c.name}`} value={c.skip ? "skip" : c.type} onChange={(e) => setCol(i, e.target.value === "skip" ? { skip: true } : { skip: false, type: e.target.value as TFieldType })}>
                          {importable.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                          <option value="skip">Leave out</option>
                        </Select>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-muted">{file.rows.slice(0, 3).map((r) => r[i] ?? "").filter(Boolean).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------- the table page ----------
export function TableDoc({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: qk(docId), ...quickRetry, queryFn: () => api.get<Detail>(`/tables/${docId}`) }); // POL1: the shared quick retry
  const [viewId, setViewId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [fieldDlg, setFieldDlg] = useState<{ field?: TField } | null>(null);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  const [newView, setNewView] = useState(false);
  const undo = useRef<Undo[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const { confirm: ask, dialogs } = useDialogs();
  useEffect(() => { const t = setTimeout(() => setSearch(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const d = detail.data;
  usePageTitle(d ? [d.table.title || "Untitled table", "Docs"] : null); // POL1 (MB-321)
  const trash = useTrashAction("table", docId, d?.table.title ?? "", { rows: d?.table.rowCount }); // POL1 (MB-313)
  const [focusRow, setFocusRow] = useState<{ id: string; n: number } | null>(null); // POL1 (MB-314)
  // POL3 (MB-314): Row stays focusable while the row is made (a disabled button dropped focus to the page), and keys typed
  // in that gap are kept here and become the new row's first cell text once the grid has the row.
  const typedAhead = useRef("");
  const awaitingRow = useRef(false);
  const [ownKeys, setOwnKeys] = useState(false); // while true, plain keys on Row are ours (no app shortcut reads them)
  const takeTyped = useCallback(() => { const t = typedAhead.current; typedAhead.current = ""; awaitingRow.current = false; setOwnKeys(false); return t; }, []);
  const view = d?.views.find((v) => v.id === viewId) ?? d?.views[0];
  const [local, setLocal] = useState<ViewConfig>({});
  useEffect(() => { setLocal({}); }, [view?.id]);
  const cfg: ViewConfig = { ...(view?.config ?? {}), ...local };
  const sort: TSort[] = [...(cfg.groupBy && view?.type === "grid" ? [{ fieldId: cfg.groupBy, dir: "asc" as const }] : []), ...(cfg.sort ?? [])];
  const filters = cfg.filters ?? [];
  const rows = useInfiniteQuery({
    queryKey: ["table-rows", docId, view?.id ?? "", search, JSON.stringify(sort), JSON.stringify(filters)],
    enabled: !!view && view.type !== "form" && view.type !== "calendar", initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ view: view!.id, limit: view!.type === "kanban" ? "500" : "100", sort: JSON.stringify(sort), filters: JSON.stringify(filters) });
      if (pageParam) p.set("cursor", pageParam);
      if (search) p.set("q", search);
      return api.get<Page>(`/tables/${docId}/rows?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const all = useMemo(() => rows.data?.pages.flatMap((p) => p.rows) ?? [], [rows.data]);
  const total = rows.data?.pages[0]?.total ?? 0;
  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: ["table-rows", docId] }); void qc.invalidateQueries({ queryKey: ["table-row", docId] }); }, [qc, docId]);
  const pushUndo = useCallback((u: Undo) => { undo.current = [...undo.current.slice(-19), u]; setUndoCount(undo.current.length); }, []);
  const write = useMutation({
    mutationFn: (list: { id: string; cells: Record<string, unknown> }[]) => api.patch<{ rows: Row[] }>(`/tables/${docId}/rows`, { rows: list }),
    onSuccess: () => refresh(),
    onError: (e) => { showError(e as Error); refresh(); },
  });
  const saveCells = useCallback((changes: { row: Row; cells: Record<string, unknown> }[]) => {
    if (!changes.length) return;
    pushUndo({ kind: "cells", before: changes.map((c) => ({ id: c.row.id, cells: Object.fromEntries(Object.keys(c.cells).map((k) => [k, c.row.values[k] ?? null])) })) });
    write.mutate(changes.map((c) => ({ id: c.row.id, cells: c.cells })));
  }, [pushUndo, write]);
  const runUndo = useCallback(async () => {
    const u = undo.current.pop();
    setUndoCount(undo.current.length);
    if (!u) return;
    const one = async (x: Undo): Promise<void> => {
      if (x.kind === "cells") await api.patch(`/tables/${docId}/rows`, { rows: x.before.map((b) => ({ id: b.id, cells: b.cells })) });
      if (x.kind === "create") await api.post(`/tables/${docId}/rows/delete`, { ids: x.ids });
      if (x.kind === "delete") await api.post(`/tables/${docId}/rows/restore`, { ids: x.ids });
      if (x.kind === "multi") for (const p of [...x.parts].reverse()) await one(p);
    };
    try {
      await one(u);
      toast("Undone");
    } catch (e) { showError(e as Error); }
    refresh();
  }, [docId, refresh]);
  const addRows = useMutation({
    mutationFn: (list: Record<string, unknown>[]) => api.post<{ rows: Row[] }>(`/tables/${docId}/rows`, { rows: list }),
    onSuccess: (r) => { pushUndo({ kind: "create", ids: r.rows.map((x) => x.id) }); refresh(); },
    onError: (e) => showError(e as Error),
  });
  /** A paste is one step to undo: the changed cells and any rows it added. */
  const paste = useCallback(async (changes: { row: Row; cells: Record<string, unknown> }[], extra: Record<string, unknown>[]) => {
    const parts: Undo[] = [];
    try {
      if (changes.length) {
        await api.patch(`/tables/${docId}/rows`, { rows: changes.map((c) => ({ id: c.row.id, cells: c.cells })) });
        parts.push({ kind: "cells", before: changes.map((c) => ({ id: c.row.id, cells: Object.fromEntries(Object.keys(c.cells).map((k) => [k, c.row.values[k] ?? null])) })) });
      }
      if (extra.length) {
        const r = await api.post<{ rows: Row[] }>(`/tables/${docId}/rows`, { rows: extra });
        parts.push({ kind: "create", ids: r.rows.map((x) => x.id) });
      }
    } catch (e) { showError(e as Error); }
    if (parts.length) pushUndo({ kind: "multi", parts });
    refresh();
  }, [docId, pushUndo, refresh]);
  const removeRows = useMutation({
    mutationFn: (ids: string[]) => api.post(`/tables/${docId}/rows/delete`, { ids }),
    onSuccess: (_r, ids) => { pushUndo({ kind: "delete", ids }); refresh(); toast(ids.length === 1 ? "Row deleted" : `${ids.length} rows deleted`, { action: { label: "Undo", onClick: () => void runUndo() } }); },
    onError: (e) => showError(e as Error),
  });
  const saveView = useMutation({
    mutationFn: (patch: { name?: string; config?: ViewConfig }) => api.patch(`/tables/${docId}/views/${view!.id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk(docId) }),
    onError: (e) => showError(e as Error),
  });
  /** Editors save view changes for everyone; people who can only view keep them for this visit. */
  const changeView = (c: ViewConfig) => { setLocal((l) => ({ ...l, ...c })); if (d?.table.canEdit) saveView.mutate({ config: c }); };
  const delView = useMutation({
    mutationFn: (id: string) => api.del(`/tables/${docId}/views/${id}`),
    onSuccess: () => { setViewId(null); void qc.invalidateQueries({ queryKey: qk(docId) }); },
    onError: (e) => showError(e as Error),
  });
  const rename = useMutation({
    mutationFn: (title: string) => api.patch(`/docs/${docId}`, { title }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk(docId) }); void qc.invalidateQueries({ queryKey: ["docs"] }); },
    onError: (e) => showError(e as Error),
  });

  if (detail.isPending) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-9 w-1/3" /><Skeleton className="h-10" />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>;
  // POL1: a missing table says so (no Retry that can't work); any other failure is the shared card with Retry.
  if (detail.error instanceof ApiError && detail.error.status === 404) return <EmptyState icon={<IconTable />} title="This table was deleted or moved" body="If it was deleted in the last 30 days, you can restore it from Docs, Trash." action={<Button variant="secondary" onClick={() => navigate("/app/docs")}>All docs</Button>} />;
  if (detail.error || !d || !view) return <Card data-testid="table-load-error"><LoadError onRetry={() => detail.refetch()} /><div className="-mt-10 pb-6 text-center"><Link to="/app/docs" className="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline">All docs</Link></div></Card>;
  const fields = d.fields;
  const shown = fields.filter((f) => !(cfg.hidden ?? []).includes(f.id));
  const canEdit = d.table.canEdit;

  return (
    <div className="min-w-0 space-y-3" data-testid="table-doc">
      <div className="flex flex-wrap items-center gap-2">
        <IconTable className="h-5 w-5 text-muted" aria-hidden />
        <TitleInput value={d.table.title} disabled={!canEdit} onSave={(t) => rename.mutate(t)} />
        {!canEdit && <Badge tone="neutral"><IconLock className="mr-1 inline h-3 w-3" />You can view this table</Badge>}
        <span className="ml-auto text-[12.5px] text-muted" aria-live="polite">{view.type === "grid" || view.type === "kanban" ? `${total.toLocaleString("en-AU")} ${total === 1 ? "row" : "rows"}` : ""}</span>
        {d.table.canManage && <Button variant="ghost" size="sm" onClick={() => setSettings(true)} aria-label="Who can edit"><IconSettings className="h-4 w-4" /></Button>}
        {d.table.canDelete && <MoreMenu label="More table actions" testId="table-more" onTrash={() => void trash.run()} />}
        {trash.dialogs}
      </div>

      {/* F12 (R125 low): the tab row scrolls sideways at 390 instead of the View button covering the last tabs. */}
      {/* POL1 (MB-315): only the tabs scroll; New view sits outside the scroller so it is always on screen at 390. */}
      <div className="flex min-w-0 max-w-full items-center gap-1">
      <div className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 pb-1" data-testid="table-view-tabs">
      <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label="Views">
        {d.views.map((v) => (
          <button key={v.id} role="tab" aria-selected={v.id === view.id} onClick={() => setViewId(v.id)}
            className={cn("flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors", v.id === view.id ? "bg-fill text-fg" : "text-muted hover:bg-hover")}>
            {VIEW_ICONS[v.type]}{v.name}
          </button>
        ))}
      </div>
        {/* tabs scroller ends */}</div>
        {canEdit && <button type="button" onClick={() => setNewView(true)} className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg px-3 text-[13px] text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label="New view" data-testid="add-view"><IconPlus className="h-4 w-4" />New view</button>}
      </div>

      {view.type !== "form" && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] flex-1 sm:max-w-xs">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input aria-label="Search this table" placeholder="Search" className="pl-9" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
          </div>
          <FilterButton fields={fields} filters={filters} onChange={(f) => changeView({ filters: f })} />
          {view.type === "grid" && <SortButton fields={fields} sort={cfg.sort ?? []} onChange={(s) => changeView({ sort: s })} />}
          {view.type === "grid" && <GroupButton fields={fields} groupBy={cfg.groupBy ?? null} onChange={(g) => changeView({ groupBy: g })} />}
          {view.type === "grid" && <HideButton fields={fields} hidden={cfg.hidden ?? []} onChange={(h) => changeView({ hidden: h })} />}
          {(view.type === "kanban" || view.type === "calendar") && <ByButton type={view.type} fields={fields} by={cfg.by ?? null} onChange={(b) => changeView({ by: b })} />}
          <div className="ml-auto flex items-center gap-1">
            {canEdit && <Button variant="ghost" size="sm" onClick={() => void runUndo()} disabled={!undoCount} aria-label="Undo the last change" title="Undo (Ctrl Z)" data-testid="undo"><IconUndo className="h-4 w-4" /></Button>}
            {canEdit && <Button variant="ghost" size="sm" onClick={() => setImporting(true)} aria-label="Import a CSV file"><IconUpload className="h-4 w-4" /></Button>}
            <a className="inline-flex min-h-[36px] items-center rounded-lg px-2 text-muted hover:bg-hover" href={`/api/tables/${docId}/export.csv?view=${view.id}`} aria-label="Export as CSV" data-testid="export-csv" download><IconDownload className="h-4 w-4" /></a>
            {canEdit && d.views.length > 1 && <Button variant="ghost" size="sm" aria-label={`Delete the view ${view.name}`} onClick={() => void ask({ title: `Delete the view "${view.name}"?`, description: "The rows stay.", confirmLabel: "Delete view", tone: "danger" }).then((ok) => { if (ok) delView.mutate(view.id); })}><IconTrash className="h-4 w-4" /></Button>}
            {canEdit && view.type === "grid" && <Button size="sm" onClick={() => { if (addRows.isPending) return; typedAhead.current = ""; awaitingRow.current = true; setOwnKeys(true); addRows.mutate([{}], { onSuccess: (r) => { if (r.rows[0]) setFocusRow({ id: r.rows[0].id, n: Date.now() }); else { awaitingRow.current = false; setOwnKeys(false); } }, onError: () => { awaitingRow.current = false; setOwnKeys(false); } }); }} onKeyDown={(e) => { if (awaitingRow.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { typedAhead.current += e.key; e.preventDefault(); e.stopPropagation(); } }} aria-disabled={addRows.isPending || undefined} data-keys-own={ownKeys || undefined} data-testid="add-row"><IconPlus className="h-4 w-4" />Row</Button>}
          </div>
        </div>
      )}

      {rows.error && (view.type === "grid" || view.type === "kanban") ? (
        <LoadError onRetry={() => rows.refetch()} />
      ) : view.type === "grid" ? (
        <Grid fields={shown} rows={all} loading={rows.isPending} canEdit={canEdit} widths={cfg.widths ?? {}} groupBy={cfg.groupBy ? fields.find((f) => f.id === cfg.groupBy) ?? null : null}
          filtered={!!search || filters.length > 0} onClearFilters={() => { setQ(""); changeView({ filters: [] }); }}
          onSave={saveCells} onPaste={(c, x) => void paste(c, x)} onAdd={(list) => addRows.mutate(list)} onOpen={setOpenRow} onUndo={() => void runUndo()} onDelete={(ids) => removeRows.mutate(ids)}
          onField={(f) => setFieldDlg({ field: f })} onAddField={() => setFieldDlg({})} onImport={() => setImporting(true)}
          onResize={(fid, w) => changeView({ widths: { ...(cfg.widths ?? {}), [fid]: w } })}
          more={rows.hasNextPage ? () => void rows.fetchNextPage() : undefined} loadingMore={rows.isFetchingNextPage} focusRow={focusRow} takeTyped={takeTyped} />
      ) : view.type === "kanban" ? (
        <Kanban fields={fields} rows={all} by={fields.find((f) => f.id === cfg.by && f.type === "select") ?? null} canEdit={canEdit} loading={rows.isPending}
          onMove={(r, f, v) => saveCells([{ row: r, cells: { [f.id]: v } }])} onOpen={setOpenRow} onAdd={(f, v) => addRows.mutate([{ [f.id]: v }])} more={rows.hasNextPage ? () => void rows.fetchNextPage() : undefined} />
      ) : view.type === "calendar" ? (
        <CalendarView docId={docId} viewId={view.id} fields={fields} by={fields.find((f) => f.id === cfg.by && f.type === "date") ?? null} canEdit={canEdit} search={search} filters={filters}
          onOpen={setOpenRow} onMove={(r, f, day) => saveCells([{ row: r, cells: { [f.id]: day } }])} onAdd={(f, day) => addRows.mutate([{ [f.id]: day }])} />
      ) : (
        <FormView docId={docId} view={view} fields={fields} canEdit={canEdit} linked={d.linked} onSaved={(c) => saveView.mutate({ config: c })} />
      )}

      {openRow && <RowSheet docId={docId} rowId={openRow} initial={all.find((r) => r.id === openRow) ?? null} fields={fields} linked={d.linked} canEdit={canEdit} onClose={() => setOpenRow(null)}
        onSave={(row, cells) => saveCells([{ row, cells }])} onDelete={(id) => { removeRows.mutate([id]); setOpenRow(null); }} />}
      {fieldDlg && <FieldDialog docId={docId} field={fieldDlg.field} fields={fields} canEdit={canEdit} onClose={() => setFieldDlg(null)} onDone={() => { setFieldDlg(null); void qc.invalidateQueries({ queryKey: qk(docId) }); refresh(); }} />}
      {importing && <CsvImportDialog open onClose={() => setImporting(false)} into={{ id: docId, fields }} onDone={() => { setImporting(false); refresh(); void qc.invalidateQueries({ queryKey: qk(docId) }); }} />}
      {settings && <SettingsDialog docId={docId} access={d.table.editAccess} onClose={() => setSettings(false)} onDone={() => { setSettings(false); void qc.invalidateQueries({ queryKey: qk(docId) }); }} />}
      {dialogs}
      {newView && <NewViewDialog docId={docId} onClose={() => setNewView(false)} onDone={(id) => { setNewView(false); void qc.invalidateQueries({ queryKey: qk(docId) }).then(() => setViewId(id)); }} />}
    </div>
  );
}

function TitleInput({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (t: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (disabled) return <h1 className="min-w-0 truncate text-xl font-semibold">{value}</h1>;
  return <input aria-label="Table name" className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-xl font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand" value={v} maxLength={200}
    onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v !== value) onSave(v.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}

// ---------- toolbar popovers ----------
function Pop({ label, icon, count, children, testId }: { label: string; icon: ReactNode; count?: number; children: (close: () => void) => ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={testId}>{icon}{label}{count ? <span className="ml-1 rounded bg-fill px-1.5 text-[11px]">{count}</span> : null}<IconChevronDown className="h-3.5 w-3.5" /></Button>
      {open && <div className="absolute left-0 z-30 mt-1 w-[min(92vw,380px)] rounded-xl border border-line bg-surface p-3 shadow-card">{children(() => setOpen(false))}</div>}
    </div>
  );
}
function FilterButton({ fields, filters, onChange }: { fields: TField[]; filters: TFilter[]; onChange: (f: TFilter[]) => void }) {
  const usable = fields.filter((f) => !isComputed(f.type));
  return (
    <Pop label="Filter" icon={<IconFilter className="h-4 w-4" />} count={filters.length} testId="filter-button">
      {() => (
        <div className="space-y-2">
          {filters.length === 0 && <p className="text-[13px] text-muted">No filters yet.</p>}
          {filters.map((flt, i) => {
            const f = fields.find((x) => x.id === flt.fieldId);
            if (!f) return null;
            const needs = !["empty", "not_empty", "checked", "unchecked"].includes(flt.op);
            const set = (p: Partial<TFilter>) => onChange(filters.map((x, k) => (k === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <Select aria-label="Filter field" value={f.id} className="w-32" onChange={(e) => { const nf = fields.find((x) => x.id === e.target.value)!; set({ fieldId: nf.id, op: opsFor(nf.type)[0], value: "" }); }}>{usable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
                <Select aria-label="Condition" value={flt.op} className="w-32" onChange={(e) => set({ op: e.target.value as FilterOp })}>{opsFor(f.type).map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}</Select>
                {needs && (f.type === "select" || f.type === "multiselect"
                  ? <Select aria-label="Filter value" value={flt.value ?? ""} className="w-32" onChange={(e) => set({ value: e.target.value })}><option value="">Choose</option>{(f.config.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
                  : <Input aria-label="Filter value" value={flt.value ?? ""} maxLength={200} className="w-32" placeholder={f.type === "date" ? "dd/mm/yyyy" : ""} onChange={(e) => set({ value: e.target.value })} />)}
                <Button variant="ghost" size="sm" aria-label="Remove this filter" onClick={() => onChange(filters.filter((_, k) => k !== i))}><IconClose className="h-4 w-4" /></Button>
              </div>
            );
          })}
          {usable.length > 0 && filters.length < 10 && <Button variant="ghost" size="sm" onClick={() => onChange([...filters, { fieldId: usable[0].id, op: opsFor(usable[0].type)[0], value: "" }])}><IconPlus className="h-4 w-4" />Add a filter</Button>}
        </div>
      )}
    </Pop>
  );
}
function SortButton({ fields, sort, onChange }: { fields: TField[]; sort: TSort[]; onChange: (s: TSort[]) => void }) {
  const usable = fields.filter((f) => !isComputed(f.type) && f.type !== "link" && f.type !== "attachment");
  return (
    <Pop label="Sort" icon={<IconSort className="h-4 w-4" />} count={sort.length}>
      {() => (
        <div className="space-y-2">
          {sort.length === 0 && <p className="text-[13px] text-muted">Rows are in the order they were added.</p>}
          {sort.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select aria-label="Sort by" value={s.fieldId} className="flex-1" onChange={(e) => onChange(sort.map((x, k) => (k === i ? { ...x, fieldId: e.target.value } : x)))}>{usable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
              <Select aria-label="Direction" value={s.dir} className="w-32" onChange={(e) => onChange(sort.map((x, k) => (k === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}><option value="asc">First to last</option><option value="desc">Last to first</option></Select>
              <Button variant="ghost" size="sm" aria-label="Remove this sort" onClick={() => onChange(sort.filter((_, k) => k !== i))}><IconClose className="h-4 w-4" /></Button>
            </div>
          ))}
          {usable.length > 0 && sort.length < 3 && <Button variant="ghost" size="sm" onClick={() => onChange([...sort, { fieldId: usable[0].id, dir: "asc" }])}><IconPlus className="h-4 w-4" />Add a sort</Button>}
        </div>
      )}
    </Pop>
  );
}
function GroupButton({ fields, groupBy, onChange }: { fields: TField[]; groupBy: string | null; onChange: (g: string | null) => void }) {
  return (
    <Pop label="Group" icon={<IconList className="h-4 w-4" />} count={groupBy ? 1 : 0}>
      {(close) => (
        <Select aria-label="Group by" value={groupBy ?? ""} onChange={(e) => { onChange(e.target.value || null); close(); }}>
          <option value="">No grouping</option>
          {fields.filter((f) => f.type === "select").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      )}
    </Pop>
  );
}
function HideButton({ fields, hidden, onChange }: { fields: TField[]; hidden: string[]; onChange: (h: string[]) => void }) {
  return (
    <Pop label="Fields" icon={<IconEye className="h-4 w-4" />} count={hidden.length}>
      {() => (
        <ul className="max-h-72 space-y-1 overflow-auto">
          {fields.map((f, i) => (
            <li key={f.id}><label className="flex min-h-[36px] items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover">
              <input type="checkbox" checked={!hidden.includes(f.id)} disabled={i === 0} onChange={(e) => onChange(e.target.checked ? hidden.filter((x) => x !== f.id) : [...hidden, f.id])} />
              {hidden.includes(f.id) ? <IconEyeOff className="h-4 w-4 text-muted" /> : <IconEye className="h-4 w-4 text-muted" />}{f.name}
            </label></li>
          ))}
        </ul>
      )}
    </Pop>
  );
}
function ByButton({ type, fields, by, onChange }: { type: "kanban" | "calendar"; fields: TField[]; by: string | null; onChange: (b: string) => void }) {
  const opts = fields.filter((f) => f.type === (type === "kanban" ? "select" : "date"));
  return (
    <Select aria-label={type === "kanban" ? "Columns from" : "Dates from"} value={by ?? ""} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-[150px]">
      {!by && <option value="">{type === "kanban" ? "Choose a single select" : "Choose a date field"}</option>}
      {opts.map((f) => <option key={f.id} value={f.id}>{type === "kanban" ? "Columns: " : "Dates: "}{f.name}</option>)}
    </Select>
  );
}

// ---------- grid ----------
const ROWNUM_W = 56;
const DEFAULT_W = 180;
interface GridProps {
  fields: TField[]; rows: Row[]; loading: boolean; canEdit: boolean; widths: Record<string, number>; groupBy: TField | null; filtered: boolean;
  onClearFilters: () => void; onSave: (c: { row: Row; cells: Record<string, unknown> }[]) => void; onAdd: (list: Record<string, unknown>[]) => void; onOpen: (id: string) => void;
  onPaste: (changes: { row: Row; cells: Record<string, unknown> }[], extra: Record<string, unknown>[]) => void;
  onUndo: () => void; onDelete: (ids: string[]) => void; onField: (f: TField) => void; onAddField: () => void; onImport: () => void; onResize: (fid: string, w: number) => void;
  more?: () => void; loadingMore: boolean;
  /** POL1 (MB-314): a row just added with Row; its first typable cell becomes active and the grid takes focus. */
  focusRow?: { id: string; n: number } | null;
  /** POL3 (MB-314): keys typed on Row while the row was being made; read once when the row is focused. */
  takeTyped?: () => string;
}
function Grid(props: GridProps) {
  const { fields, rows, canEdit } = props;
  const [act, setAct] = useState<{ r: number; c: number } | null>(null);
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null);
  const [edit, setEdit] = useState<{ value: string } | null>(null);
  // Keys typed before the editor has rendered append here, so a quick "Acme" never loses its first letter.
  const editRef = useRef<string | null>(null);
  useEffect(() => { if (!edit) editRef.current = null; }, [edit]);
  const [err, setErr] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ fid: string; x: number; w: number } | null>(null);
  const [liveW, setLiveW] = useState<Record<string, number>>({});
  const width = (f: TField) => liveW[f.id] ?? props.widths[f.id] ?? f.width ?? DEFAULT_W;
  const { onResize } = props;
  useEffect(() => {
    if (!drag) return;
    let last = drag.w;
    const move = (e: MouseEvent) => { last = Math.max(80, Math.min(600, drag.w + e.clientX - drag.x)); setLiveW((w) => ({ ...w, [drag.fid]: last })); };
    const up = () => { onResize(drag.fid, last); setDrag(null); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [drag, onResize]);
  const sel = act ? (anchor ? { r0: Math.min(act.r, anchor.r), r1: Math.max(act.r, anchor.r), c0: Math.min(act.c, anchor.c), c1: Math.max(act.c, anchor.c) } : { r0: act.r, r1: act.r, c0: act.c, c1: act.c }) : null;
  const inSel = (r: number, c: number) => !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
  const typable = (f: TField) => canEdit && !isComputed(f.type) && !["link", "attachment", "multiselect", "longtext", "select", "checkbox"].includes(f.type);
  // POL1 (MB-314): after Row, the new row's first cell you can type in is active and focused, so typing starts at once.
  const doneFocus = useRef(0);
  useEffect(() => {
    const want = props.focusRow;
    if (!want || doneFocus.current === want.n) return;
    const r = rows.findIndex((x) => x.id === want.id);
    if (r < 0) return;
    doneFocus.current = want.n;
    const c = Math.max(0, fields.findIndex((f) => typable(f)));
    setAnchor(null); setAct({ r, c });
    wrap.current?.focus({ preventScroll: true });
    const typed = props.takeTyped?.() ?? "";
    const f = fields[c];
    if (typed && f && typable(f)) { editRef.current = typed; setErr(""); setEdit({ value: typed }); }
    requestAnimationFrame(() => document.getElementById(`cell-${r}-${c}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }, [props.focusRow, rows, fields]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusGrid = () => { const a = document.activeElement; if (a instanceof HTMLInputElement && wrap.current?.contains(a)) return; wrap.current?.focus({ preventScroll: true }); };
  const commit = (move?: "down" | "right") => {
    if (!act || !edit) return;
    const f = fields[act.c], r = rows[act.r];
    if (f && r) {
      const res = coerceCell(f, edit.value);
      if (!res.ok) { setErr(res.error); return; }
      if (JSON.stringify(res.value ?? null) !== JSON.stringify(r.values[f.id] ?? null)) props.onSave([{ row: r, cells: { [f.id]: res.value } }]);
    }
    setErr(""); editRef.current = null; setEdit(null); setAnchor(null);
    if (move === "down") setAct({ r: Math.min(rows.length - 1, act.r + 1), c: act.c });
    if (move === "right") setAct({ r: act.r, c: Math.min(fields.length - 1, act.c + 1) });
    setTimeout(focusGrid, 0);
  };
  const startEdit = (initial?: string) => {
    if (!act) return;
    const f = fields[act.c], r = rows[act.r];
    if (!f || !r) return;
    if (f.type === "checkbox" && canEdit) { props.onSave([{ row: r, cells: { [f.id]: !(r.values[f.id] === true) } }]); return; }
    if (!typable(f)) { props.onOpen(r.id); return; }
    const value = initial ?? rawForEdit(f, r);
    editRef.current = value;
    setErr(""); setEdit({ value });
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editRef.current !== null && !edit && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // The editor is opening but has not rendered yet: keep the key instead of starting over.
      e.preventDefault();
      const value = editRef.current + e.key;
      editRef.current = value;
      setEdit({ value });
      return;
    }
    if (edit) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (canEdit) props.onUndo(); return; }
    if (!act) { if (rows.length && ["ArrowDown", "ArrowRight", "Enter", "Tab"].includes(e.key)) { e.preventDefault(); setAct({ r: 0, c: 0 }); } return; }
    const go = (r: number, c: number, extend: boolean) => {
      e.preventDefault();
      const next = { r: Math.max(0, Math.min(rows.length - 1, r)), c: Math.max(0, Math.min(fields.length - 1, c)) };
      if (extend) setAnchor((a) => a ?? act); else setAnchor(null);
      setAct(next);
      document.getElementById(`cell-${next.r}-${next.c}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown": return go(act.r + 1, act.c, e.shiftKey);
      case "ArrowUp": return go(act.r - 1, act.c, e.shiftKey);
      case "ArrowRight": return go(act.r, act.c + 1, e.shiftKey);
      case "ArrowLeft": return go(act.r, act.c - 1, e.shiftKey);
      case "Tab": return go(act.r, act.c + (e.shiftKey ? -1 : 1), false);
      case "Home": return go(act.r, 0, false);
      case "End": return go(act.r, fields.length - 1, false);
      case "Enter": case "F2": e.preventDefault(); return startEdit();
      case " ": e.preventDefault(); if (rows[act.r]) props.onOpen(rows[act.r].id); return;
      case "Escape": setAnchor(null); return;
      case "Delete": case "Backspace": {
        e.preventDefault();
        if (!canEdit || !sel) return;
        const changes: { row: Row; cells: Record<string, unknown> }[] = [];
        for (let r = sel.r0; r <= sel.r1; r++) {
          const cells: Record<string, unknown> = {};
          for (let c = sel.c0; c <= sel.c1; c++) { const f = fields[c]; if (f && !isComputed(f.type)) cells[f.id] = f.type === "checkbox" ? false : null; }
          if (rows[r] && Object.keys(cells).length) changes.push({ row: rows[r], cells });
        }
        props.onSave(changes);
        return;
      }
      default:
        if (e.key.length === 1 && !mod && !e.altKey && fields[act.c] && typable(fields[act.c])) { e.preventDefault(); startEdit(e.key); }
    }
  };
  const onCopy = (e: React.ClipboardEvent) => {
    if (edit || !sel) return;
    e.preventDefault();
    const lines: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) { const f = fields[c]; cells.push(f ? display(f, row).replace(/[\t\n]/g, " ") : ""); }
      lines.push(cells.join("\t"));
    }
    e.clipboardData.setData("text/plain", lines.join("\n"));
    toast(`Copied ${lines.length} ${lines.length === 1 ? "row" : "rows"}`);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (edit || !act || !canEdit) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const block = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t")).slice(0, LIMITS.pasteRows);
    const changes: { row: Row; cells: Record<string, unknown> }[] = [];
    const extra: Record<string, unknown>[] = [];
    let bad = 0;
    block.forEach((line, i) => {
      const cells: Record<string, unknown> = {};
      line.forEach((val, j) => {
        const f = fields[act.c + j];
        if (!f || isComputed(f.type) || f.type === "link" || f.type === "attachment") return;
        const res = coerceCell(f, val);
        if (res.ok) cells[f.id] = res.value; else bad++;
      });
      if (!Object.keys(cells).length) return;
      const row = rows[act.r + i];
      if (row) changes.push({ row, cells }); else extra.push(cells);
    });
    if (changes.length || extra.length) props.onPaste(changes, extra);
    toast(`Pasted ${block.length} ${block.length === 1 ? "row" : "rows"}${bad ? `. ${bad} cells did not fit and were skipped.` : ""}`);
  };

  if (props.loading) return <div className="space-y-2" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>;
  if (!rows.length) {
    return props.filtered
      ? <EmptyState icon={<IconFilter />} title="No rows match" body="Try other words or clear the filters." action={<Button variant="secondary" onClick={props.onClearFilters}>Clear filters</Button>} />
      : <EmptyState icon={<IconTable />} title="No rows yet" body={canEdit ? "Add a row, paste from a spreadsheet, or import a CSV file." : "Nothing has been added to this table yet."}
          action={canEdit ? <div className="flex flex-wrap justify-center gap-2"><Button onClick={() => props.onAdd([{}])}><IconPlus className="h-4 w-4" />Add a row</Button><Button variant="secondary" onClick={props.onImport}><IconUpload className="h-4 w-4" />Import a CSV file</Button></div> : undefined} />;
  }
  const groupKey = (r: Row) => (props.groupBy ? String(r.values[props.groupBy.id] ?? "") : "");
  const selRows = sel ? rows.slice(sel.r0, sel.r1 + 1).map((r) => r.id) : [];
  return (
    <div>
      {err && <p className="mb-2 text-[13px] text-bad" role="alert">{err}</p>}
      <div ref={wrap} tabIndex={0} role="grid" aria-label="Table rows" aria-rowcount={rows.length + 1} aria-colcount={fields.length + 1} onKeyDown={onKey} onCopy={onCopy} onPaste={onPaste}
        className="max-h-[70vh] overflow-auto rounded-xl border border-line outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="table-grid">
        <div className="inline-block min-w-full text-[13px]">
          <div role="row" className="sticky top-0 z-20 flex border-b border-line bg-fill">
            <div role="columnheader" className="sticky left-0 z-30 flex shrink-0 items-center justify-center border-r border-line bg-fill text-[12px] text-muted" style={{ width: ROWNUM_W }}>#</div>
            {fields.map((f, c) => (
              <div key={f.id} role="columnheader" className={cn("relative flex shrink-0 items-center border-r border-line bg-fill", c === 0 && "sticky z-30")} style={{ width: width(f), left: c === 0 ? ROWNUM_W : undefined }}>
                <button className="flex min-h-[36px] w-full min-w-0 items-center gap-1 px-2 text-left text-[12px] font-medium text-muted hover:text-fg" onClick={() => props.onField(f)} title={`${f.name}, ${TYPE_LABELS[f.type]}`}><span className="truncate">{f.name}</span></button>
                <span aria-hidden className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand/40" onMouseDown={(e) => { e.preventDefault(); setDrag({ fid: f.id, x: e.clientX, w: width(f) }); }} />
              </div>
            ))}
            {canEdit && <div role="columnheader" className="flex shrink-0"><button className="flex min-h-[36px] w-11 items-center justify-center text-muted hover:bg-hover" onClick={props.onAddField} aria-label="Add a field" data-testid="add-field"><IconPlus className="h-4 w-4" /></button></div>}
          </div>
          {rows.map((r, ri) => (
            <div key={r.id} role="rowgroup">
              {props.groupBy && (ri === 0 || groupKey(rows[ri - 1]) !== groupKey(r)) && (
                <div role="row" className="border-b border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-muted"><span role="gridcell">{cellText(props.groupBy, r.values[props.groupBy.id] ?? null) || "Not set"}</span></div>
              )}
              <div role="row" aria-rowindex={ri + 2} className="flex border-b border-line bg-surface hover:bg-hover/40">
                <div role="rowheader" className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-line bg-surface px-1.5 text-[12px] text-muted" style={{ width: ROWNUM_W }}>
                  <span>{ri + 1}</span>
                  <button className="flex h-8 w-8 items-center justify-center rounded hover:bg-hover" aria-label={`Open row ${ri + 1}`} onClick={() => props.onOpen(r.id)}><IconMaximize className="h-3.5 w-3.5" /></button>
                </div>
                {fields.map((f, ci) => {
                  const active = act?.r === ri && act?.c === ci;
                  const text = display(f, r);
                  return (
                    <div key={f.id} id={`cell-${ri}-${ci}`} role="gridcell" aria-selected={inSel(ri, ci)} title={r.errors?.[f.id] ?? (text.length > 28 ? text : undefined)}
                      className={cn("relative flex min-h-[36px] shrink-0 items-center border-r border-line px-2", ci === 0 && "sticky z-10 bg-surface font-medium", inSel(ri, ci) && "bg-brand/10", active && "outline outline-2 -outline-offset-2 outline-brand", (f.type === "number" || f.type === "currency") && "justify-end", r.errors?.[f.id] && "text-bad")}
                      style={{ width: width(f), left: ci === 0 ? ROWNUM_W : undefined }}
                      onMouseDown={(e) => { if (edit && !active) commit(); if (e.shiftKey && act) setAnchor((a) => a ?? act); else setAnchor(null); setAct({ r: ri, c: ci }); setTimeout(focusGrid, 0); }}
                      onDoubleClick={() => startEdit()}>
                      {active && edit ? (
                        <input autoFocus aria-label={`Edit ${f.name}`} className="absolute inset-0 z-20 w-full bg-surface px-2 text-[13px] outline outline-2 outline-brand" value={edit.value}
                          onChange={(e) => { editRef.current = e.target.value; setEdit({ value: e.target.value }); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit("down"); } else if (e.key === "Tab") { e.preventDefault(); commit("right"); } else if (e.key === "Escape") { e.preventDefault(); editRef.current = null; setEdit(null); setErr(""); setTimeout(focusGrid, 0); } }}
                          onBlur={() => commit()} />
                      ) : f.type === "checkbox" ? (
                        <input type="checkbox" checked={r.values[f.id] === true} disabled={!canEdit} aria-label={`${f.name}, row ${ri + 1}`} tabIndex={-1} onChange={() => props.onSave([{ row: r, cells: { [f.id]: !(r.values[f.id] === true) } }])} />
                      ) : f.type === "select" || f.type === "multiselect" ? (
                        <span className="flex min-w-0 gap-1 overflow-hidden">{chips(f, r.values[f.id])}</span>
                      ) : (
                        <span className="truncate">{text}{r.hidden?.[f.id] ? <span className="ml-1 text-muted">({r.hidden[f.id]} hidden)</span> : null}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        {props.more && <Button variant="secondary" size="sm" onClick={props.more} disabled={props.loadingMore}>{props.loadingMore ? "Loading" : "Load more rows"}</Button>}
        <span className="hidden lg:inline">Arrows move, Enter edits, Shift and arrows select, Ctrl C and Ctrl V copy and paste, Space opens a row.</span>
        {canEdit && selRows.length > 0 && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => props.onDelete(selRows)} data-testid="delete-rows"><IconTrash className="h-4 w-4" />Delete {selRows.length > 1 ? `${selRows.length} rows` : "row"}</Button>}
      </div>
    </div>
  );
}
function chips(f: TField, v: TCell) {
  const ids = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return ids.map((id) => { const o = (f.config.options ?? []).find((x) => x.id === id); return o ? <span key={id} className="truncate rounded-full px-2 py-0.5 text-[12px] text-fg" style={{ background: `${o.color}2e` }}>{o.label}</span> : null; });
}

// ---------- kanban ----------
function Kanban({ fields, rows, by, canEdit, loading, onMove, onOpen, onAdd, more }: {
  fields: TField[]; rows: Row[]; by: TField | null; canEdit: boolean; loading: boolean; onMove: (r: Row, f: TField, v: string | null) => void; onOpen: (id: string) => void; onAdd: (f: TField, v: string | null) => void; more?: () => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  if (!by) return <EmptyState icon={<IconColumns />} title="Kanban needs a single select field" body="Add a single select field, like Status, and choose it above." />;
  if (loading) return <div className="flex min-w-0 max-w-full gap-3 overflow-hidden" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-64 shrink-0" />)}</div>; // POL1 (MB-315): the skeleton never widens the page
  const primary = fields[0];
  const cols = [...(by.config.options ?? []).map((o) => ({ id: o.id, label: o.label, color: o.color })), { id: "", label: "Not set", color: "#64748b" }];
  const extra = fields.slice(1).filter((f) => f.id !== by.id && !isComputed(f.type) && f.type !== "longtext").slice(0, 2);
  return (
    <div className="min-w-0 max-w-full">
      <div className="relative flex w-0 min-w-full gap-3 overflow-x-auto overscroll-x-contain pb-2" data-testid="kanban">{/* POL1 (MB-315): w-0 min-w-full so the columns never count toward the page width */}
        {cols.map((c) => {
          const items = rows.filter((r) => (r.values[by.id] ?? "") === c.id);
          return (
            <section key={c.id || "none"} aria-label={c.label} data-testid={`kanban-col-${c.label}`}
              onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(c.id); } }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); const r = rows.find((x) => x.id === id); if (r && (r.values[by.id] ?? "") !== c.id) onMove(r, by, c.id || null); }}
              className={cn("flex w-[78vw] max-w-[280px] shrink-0 flex-col rounded-xl border border-line bg-fill/60 p-2 sm:w-64", over === c.id && "ring-2 ring-brand")}>
              <h3 className="mb-2 flex items-center gap-2 px-1 text-[13px] font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} aria-hidden />{c.label}<span className="text-muted">{items.length}</span></h3>
              <div className="flex flex-col gap-2">
                {items.map((r) => (
                  <article key={r.id} draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} data-testid="kanban-card" className="rounded-lg border border-line bg-surface p-2.5 text-[13px] shadow-sm">
                    <button className="w-full text-left font-medium hover:underline" onClick={() => onOpen(r.id)}>{display(primary, r) || "Untitled"}</button>
                    {extra.map((f) => { const t = display(f, r); return t ? <div key={f.id} className="mt-1 truncate text-[12px] text-muted">{f.name}: {t}</div> : null; })}
                    {canEdit && <div className="mt-2 sm:hidden"><Select aria-label="Move to" value={String(r.values[by.id] ?? "")} onChange={(e) => onMove(r, by, e.target.value || null)}>{cols.map((x) => <option key={x.id || "none"} value={x.id}>{x.label}</option>)}</Select></div>}
                  </article>
                ))}
                {canEdit && <button className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:bg-hover" onClick={() => onAdd(by, c.id || null)}><IconPlus className="h-4 w-4" />Add to {c.label}</button>}
              </div>
            </section>
          );
        })}
      </div>
      {more && <Button variant="secondary" size="sm" onClick={more}>Load more cards</Button>}
    </div>
  );
}

// ---------- calendar ----------
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function CalendarView({ docId, viewId, fields, by, canEdit, search, filters, onOpen, onMove, onAdd }: {
  docId: string; viewId: string; fields: TField[]; by: TField | null; canEdit: boolean; search: string; filters: TFilter[]; onOpen: (id: string) => void; onMove: (r: Row, f: TField, day: string) => void; onAdd: (f: TField, day: string) => void;
}) {
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const start = new Date(month); start.setDate(1 - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const q = useQuery({
    queryKey: ["table-rows", docId, viewId, "cal", isoDay(days[0]), search, JSON.stringify(filters), by?.id ?? ""], enabled: !!by,
    queryFn: () => {
      const before = new Date(days[0]); before.setDate(before.getDate() - 1);
      const after = new Date(days[41]); after.setDate(after.getDate() + 1);
      const f = [...filters, { fieldId: by!.id, op: "gt", value: isoDay(before) }, { fieldId: by!.id, op: "lt", value: isoDay(after) }];
      const p = new URLSearchParams({ view: viewId, limit: "500", filters: JSON.stringify(f), sort: JSON.stringify([{ fieldId: by!.id, dir: "asc" }]) });
      if (search) p.set("q", search);
      return api.get<Page>(`/tables/${docId}/rows?${p}`);
    },
  });
  if (!by) return <EmptyState icon={<IconCalendar />} title="Calendar needs a date field" body="Add a date field and choose it above." />;
  const byDay = new Map<string, Row[]>();
  for (const r of q.data?.rows ?? []) { const k = String(r.values[by.id] ?? ""); byDay.set(k, [...(byDay.get(k) ?? []), r]); }
  const primary = fields[0];
  const today = isoDay(new Date());
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const inMonth = days.filter((d) => d.getMonth() === month.getMonth());
  return (
    <div data-testid="calendar">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => shift(-1)}>Previous</Button>
        <h2 className="min-w-[140px] text-center text-[15px] font-semibold" aria-live="polite">{month.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}</h2>
        <Button variant="secondary" size="sm" onClick={() => shift(1)}>Next</Button>
        <Button variant="ghost" size="sm" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)); }}>Today</Button>
      </div>
      {q.error ? <LoadError onRetry={() => q.refetch()} /> : <>
        <div className="hidden grid-cols-7 overflow-hidden rounded-xl border border-line sm:grid">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="border-b border-line bg-fill/60 px-2 py-1.5 text-[12px] font-medium text-muted">{d}</div>)}
          {days.map((d) => {
            const k = isoDay(d);
            const items = byDay.get(k) ?? [];
            return (
              <div key={k} className={cn("group min-h-[96px] border-b border-r border-line p-1.5", d.getMonth() !== month.getMonth() && "bg-fill/40 text-muted")}
                onDragOver={(e) => { if (canEdit) e.preventDefault(); }} onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); const r = q.data?.rows.find((x) => x.id === id); if (r) onMove(r, by, k); }}>
                <div className="flex items-center justify-between text-[12px]"><span className={cn(k === today && "rounded-full bg-brand px-1.5 text-white")}>{d.getDate()}</span>
                  {canEdit && <button className="rounded p-0.5 text-muted opacity-0 hover:bg-hover focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Add on ${showDate(k)}`} onClick={() => onAdd(by, k)}><IconPlus className="h-3.5 w-3.5" /></button>}</div>
                <div className="mt-1 space-y-1">{items.slice(0, 4).map((r) => <button key={r.id} draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} onClick={() => onOpen(r.id)} className="block w-full truncate rounded bg-brand/10 px-1.5 py-0.5 text-left text-[12px] hover:bg-brand/20" data-testid="calendar-item">{display(primary, r) || "Untitled"}</button>)}
                  {items.length > 4 && <div className="px-1 text-[11px] text-muted">{items.length - 4} more</div>}</div>
              </div>
            );
          })}
        </div>
        <ul className="space-y-2 sm:hidden" aria-label="Days with items">
          {inMonth.filter((d) => byDay.has(isoDay(d))).map((d) => (
            <li key={isoDay(d)} className="rounded-xl border border-line p-3">
              <div className="text-[13px] font-medium">{d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</div>
              <div className="mt-1 space-y-1">{(byDay.get(isoDay(d)) ?? []).map((r) => <button key={r.id} onClick={() => onOpen(r.id)} className="block min-h-[40px] w-full truncate rounded-lg bg-brand/10 px-2 text-left text-[13px]" data-testid="calendar-item">{display(primary, r) || "Untitled"}</button>)}</div>
            </li>
          ))}
          {!inMonth.some((d) => byDay.has(isoDay(d))) && <li className="text-[13px] text-muted">Nothing this month.</li>}
          {canEdit && <li><Button variant="secondary" size="sm" onClick={() => onAdd(by, today)}><IconPlus className="h-4 w-4" />Add for today</Button></li>}
        </ul>
      </>}
    </div>
  );
}

// ---------- form ----------
function FormView({ docId, view, fields, canEdit, linked, onSaved }: { docId: string; view: View; fields: TField[]; canEdit: boolean; linked: Linked; onSaved: (c: ViewConfig) => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [done, setDone] = useState(false);
  const [setup, setSetup] = useState(false);
  const formFields = (view.config.formFields ?? []).map((id) => fields.find((f) => f.id === id)).filter((f): f is TField => !!f && !isComputed(f.type));
  const submit = useMutation({
    mutationFn: () => {
      const cells: Record<string, unknown> = {};
      for (const f of formFields) { const v = vals[f.id]; if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) cells[f.id] = v; }
      return api.post(`/tables/${docId}/views/${view.id}/submit`, { cells });
    },
    onSuccess: () => { setDone(true); setVals({}); },
    onError: (e) => showError(e as Error),
  });
  return (
    <div className="mx-auto max-w-xl">
      {canEdit && <div className="mb-3 flex justify-end"><Button variant="secondary" size="sm" onClick={() => setSetup(true)}><IconSettings className="h-4 w-4" />Form settings</Button></div>}
      <div className="rounded-xl border border-line bg-surface p-5" data-testid="table-form">
        <h2 className="text-lg font-semibold">{view.config.formTitle || view.name}</h2>
        {view.config.formNote && <p className="mt-1 whitespace-pre-wrap text-[14px] text-muted">{view.config.formNote}</p>}
        {done ? (
          <div className="mt-4 space-y-3" role="status"><p className="text-[14px]">Thanks, your answer is in.</p><Button variant="secondary" onClick={() => setDone(false)}>Send another</Button></div>
        ) : formFields.length === 0 ? (
          <p className="mt-4 text-[14px] text-muted">This form has no fields yet.</p>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
            {formFields.map((f) => (
              <div key={f.id}><label className={label13} htmlFor={`form-${f.id}`}>{f.name}</label>
                <CellInput id={`form-${f.id}`} field={f} value={vals[f.id]} linked={linked} onChange={(v) => setVals((x) => ({ ...x, [f.id]: v }))} /></div>
            ))}
            <Button type="submit" disabled={submit.isPending} data-testid="form-submit">{submit.isPending ? "Sending" : "Send"}</Button>
          </form>
        )}
      </div>
      {setup && <FormSetup view={view} fields={fields} onClose={() => setSetup(false)} onSave={(c) => { onSaved(c); setSetup(false); }} />}
    </div>
  );
}
function FormSetup({ view, fields, onClose, onSave }: { view: View; fields: TField[]; onClose: () => void; onSave: (c: ViewConfig) => void }) {
  const [picked, setPicked] = useState<string[]>(view.config.formFields ?? []);
  const [title, setTitle] = useState(view.config.formTitle ?? "");
  const [note, setNote] = useState(view.config.formNote ?? "");
  return (
    <Dialog open onClose={onClose} title="Form settings" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onSave({ formFields: picked, formTitle: title, formNote: note })}>Save</Button></>}>
      <div className="space-y-3">
        <div><label className={label13} htmlFor="form-title">Title</label><Input id="form-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></div>
        <div><label className={label13} htmlFor="form-note">Note under the title</label><Textarea id="form-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></div>
        <fieldset><legend className="mb-1 text-[13px] font-medium">Fields on the form</legend>
          {fields.filter((f) => !isComputed(f.type) && f.type !== "attachment").map((f) => <label key={f.id} className="flex min-h-[36px] items-center gap-2 text-[13px]"><input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.id] : p.filter((x) => x !== f.id)))} />{f.name}</label>)}
        </fieldset>
        <p className="text-[12.5px] text-muted">Anyone who can open this table can send the form. A public link comes later.</p>
      </div>
    </Dialog>
  );
}

// ---------- one input for a field (row sheet and form) ----------
function CellInput({ id, field: f, value, onChange, linked, disabled }: { id?: string; field: TField; value: unknown; onChange: (v: unknown) => void; linked: Linked; disabled?: boolean }) {
  const s = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  switch (f.type) {
    case "longtext": return <Textarea id={id} value={s} disabled={disabled} maxLength={LIMITS.longtext} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox": return <input id={id} type="checkbox" className="h-5 w-5" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "select": return <Select id={id} disabled={disabled} value={s} onChange={(e) => onChange(e.target.value || null)}><option value="">Not set</option>{(f.config.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>;
    case "multiselect": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return <div id={id} className="flex flex-wrap gap-1.5" role="group" aria-label={f.name}>{(f.config.options ?? []).map((o) => <label key={o.id} className="flex min-h-[32px] items-center gap-1.5 rounded-full border border-line px-2.5 text-[13px]"><input type="checkbox" disabled={disabled} checked={ids.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id))} />{o.label}</label>)}</div>;
    }
    case "date": return <Input id={id} disabled={disabled} placeholder="dd/mm/yyyy" value={s} onChange={(e) => onChange(e.target.value)} />;
    case "number": case "currency": return <Input id={id} disabled={disabled} inputMode="decimal" value={s} placeholder={f.type === "currency" ? "0.00" : ""} onChange={(e) => onChange(e.target.value)} />;
    case "link": return <LinkPicker id={id} field={f} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} linked={linked} disabled={disabled} />;
    case "attachment": return <p className="text-[13px] text-muted">Attach files from Files for now.</p>;
    default: return <Input id={id} disabled={disabled} value={s} type={f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "phone" ? "tel" : "text"} maxLength={LIMITS.text} onChange={(e) => onChange(e.target.value)} />;
  }
}
function LinkPicker({ id, field, value, onChange, linked, disabled, labels }: { id?: string; field: TField; value: string[]; onChange: (v: string[]) => void; linked: Linked; disabled?: boolean; labels?: LinkLabel[] }) {
  const target = field.config.tableId ?? "";
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((labels ?? []).map((l) => [l.id, l.label])));
  const t = linked[target];
  const res = useQuery({ queryKey: ["table-rows", target, "pick", q], enabled: open && !!t, queryFn: () => api.get<Page>(`/tables/${target}/rows?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`) });
  if (!t) return <p className="text-[13px] text-muted">The linked table is not open to you.</p>;
  const primary = t.fields[0];
  return (
    <div id={id} className="space-y-2">
      <div className="flex flex-wrap gap-1.5">{value.map((v) => <span key={v} className="flex items-center gap-1 rounded-full bg-fill px-2.5 py-1 text-[13px]">{names[v] ?? "Linked row"}{!disabled && <button type="button" aria-label={`Remove ${names[v] ?? "linked row"}`} onClick={() => onChange(value.filter((x) => x !== v))}><IconClose className="h-3.5 w-3.5" /></button>}</span>)}</div>
      {!disabled && (open ? (
        <div className="rounded-lg border border-line p-2">
          <Input aria-label={`Find a row in ${t.title}`} placeholder={`Find in ${t.title}`} value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} autoFocus />
          <ul className="mt-1 max-h-48 overflow-auto">
            {(res.data?.rows ?? []).map((r) => {
              const label = (primary ? cellText(primary, r.values[primary.id] ?? null) : "") || `Row ${r.seq}`;
              return <li key={r.id}><button type="button" className="flex min-h-[36px] w-full items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-hover" onClick={() => { setNames((n) => ({ ...n, [r.id]: label })); onChange(value.includes(r.id) ? value.filter((x) => x !== r.id) : [...value, r.id]); }}>
                <span aria-hidden className="w-4">{value.includes(r.id) ? "✓" : ""}</span>{label}</button></li>;
            })}
            {res.data && !res.data.rows.length && <li className="px-2 py-1 text-[13px] text-muted">No rows found.</li>}
          </ul>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      ) : <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Link a row from {t.title}</Button>)}
    </div>
  );
}

// ---------- row sheet ----------
function RowSheet({ docId, rowId, initial, fields, linked, canEdit, onClose, onSave, onDelete }: {
  docId: string; rowId: string; initial: Row | null; fields: TField[]; linked: Linked; canEdit: boolean; onClose: () => void; onSave: (row: Row, cells: Record<string, unknown>) => void; onDelete: (id: string) => void;
}) {
  const row = useQuery({ queryKey: ["table-row", docId, rowId], queryFn: async () => (await api.get<{ row: Row }>(`/tables/${docId}/rows/${rowId}`)).row, placeholderData: initial ?? undefined });
  const [tab, setTab] = useState<"fields" | "comments" | "history">("fields");
  const [err, setErr] = useState<Record<string, string>>({});
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("keydown", esc); back?.focus?.(); };
  }, [onClose]);
  const r = row.data;
  const save = (f: TField, v: unknown) => {
    if (!r) return;
    const res = coerceCell(f, v);
    if (!res.ok) { setErr((x) => ({ ...x, [f.id]: res.error })); return; }
    setErr((x) => { const n = { ...x }; delete n[f.id]; return n; });
    if (JSON.stringify(res.value ?? null) === JSON.stringify(r.values[f.id] ?? null)) return;
    onSave(r, { [f.id]: res.value });
  };
  const title = r && fields[0] ? display(fields[0], r) || "Untitled" : "Row";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-testid="row-sheet" className="flex h-full w-full flex-col bg-surface shadow-card outline-none sm:max-w-[440px] sm:border-l sm:border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{title}</h2>
          {canEdit && r && <Button variant="ghost" size="sm" aria-label="Delete this row" onClick={() => onDelete(r.id)}><IconTrash className="h-4 w-4" /></Button>}
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}><IconClose className="h-4 w-4" /></Button>
        </div>
        <div className="flex gap-1 border-b border-line px-3" role="tablist" aria-label="Row">
          {(["fields", "comments", "history"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("flex min-h-[44px] items-center gap-1.5 px-3 text-[13px] font-medium", tab === t ? "border-b-2 border-brand text-fg" : "text-muted")}>
              {t === "fields" ? <IconList className="h-4 w-4" /> : t === "comments" ? <IconChat className="h-4 w-4" /> : <IconHistory className="h-4 w-4" />}{t === "fields" ? "Fields" : t === "comments" ? "Comments" : "History"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!r ? (row.error ? <EmptyState icon={<IconTable />} title="Couldn't open this row" body="It may have been deleted." /> : <Skeleton className="h-40" />)
            : tab === "fields" ? (
              <div className="space-y-4">
                {fields.map((f) => (
                  <div key={f.id}>
                    <label className="mb-1 block text-[12.5px] font-medium text-muted" htmlFor={`sheet-${f.id}`}>{f.name}</label>
                    {isComputed(f.type) || !canEdit || f.type === "attachment" ? (
                      <div id={`sheet-${f.id}`} className={cn("min-h-[24px] whitespace-pre-wrap break-words text-[14px]", r.errors?.[f.id] && "text-bad")}>{r.errors?.[f.id] ?? (display(f, r) || <span className="text-muted">Empty</span>)}{r.hidden?.[f.id] ? <span className="ml-1 text-[12px] text-muted">({r.hidden[f.id]} not open to you)</span> : null}</div>
                    ) : (
                      <SheetField key={`${f.id}-${r.version}`} f={f} r={r} save={save} linked={linked} />
                    )}
                    {err[f.id] && <p className="mt-1 text-[12.5px] text-bad" role="alert">{err[f.id]}</p>}
                  </div>
                ))}
              </div>
            ) : tab === "comments" ? <RowComments docId={docId} rowId={rowId} canComment={canEdit} /> : <RowHistory docId={docId} rowId={rowId} />}
        </div>
      </div>
    </div>
  );
}
function SheetField({ f, r, save, linked }: { f: TField; r: Row; save: (f: TField, v: unknown) => void; linked: Linked }) {
  const instant = f.type === "checkbox" || f.type === "select" || f.type === "multiselect" || f.type === "link";
  const [draft, setDraft] = useState<unknown>(instant ? r.values[f.id] ?? null : rawForEdit(f, r));
  if (f.type === "link") return <LinkPicker id={`sheet-${f.id}`} field={f} value={Array.isArray(draft) ? (draft as string[]) : []} labels={r.labels[f.id]} linked={linked} onChange={(v) => { setDraft(v); save(f, v); }} />;
  return (
    <div onBlur={(e) => { if (!instant && !e.currentTarget.contains(e.relatedTarget as Node)) save(f, draft); }}>
      <CellInput id={`sheet-${f.id}`} field={f} value={draft} linked={linked} onChange={(v) => { setDraft(v); if (instant) save(f, v); }} />
    </div>
  );
}
interface RComment { id: string; body: string; authorName: string | null; createdAt: string; mine: boolean }
function RowComments({ docId, rowId, canComment }: { docId: string; rowId: string; canComment: boolean }) {
  const qc = useQueryClient();
  const key = ["table-row-comments", docId, rowId];
  const list = useQuery({ queryKey: key, queryFn: () => api.get<{ comments: RComment[] }>(`/tables/${docId}/rows/${rowId}/comments`) });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.post(`/tables/${docId}/rows/${rowId}/comments`, { body: text.trim() }),
    onSuccess: () => { setText(""); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => showError(e as Error),
  });
  const del = useMutation({
    mutationFn: (cid: string) => api.del(`/tables/${docId}/comments/${cid}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => showError(e as Error),
  });
  return (
    <div className="space-y-3" data-testid="row-comments">
      {list.isPending ? <Skeleton className="h-16" /> : list.error ? <LoadErrorInline onRetry={() => list.refetch()} />
        : !list.data.comments.length ? <p className="text-[13px] text-muted">No comments yet.</p>
        : <ul className="space-y-3">{list.data.comments.map((c) => (
            <li key={c.id} className="rounded-lg bg-fill/60 p-3 text-[13px]">
              <div className="flex items-center gap-2 text-[12px] text-muted"><span className="font-medium text-fg">{c.authorName ?? "Someone"}</span>{new Date(c.createdAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                {c.mine && <button className="ml-auto rounded px-1 hover:bg-hover" aria-label="Delete this comment" onClick={() => del.mutate(c.id)}><IconTrash className="h-3.5 w-3.5" /></button>}</div>
              <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
            </li>))}</ul>}
      {canComment && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
        <label htmlFor="row-comment" className="sr-only">Add a comment</label>
        <Textarea id="row-comment" placeholder="Add a comment" value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" size="sm" disabled={!text.trim() || add.isPending}>Post</Button>
      </form>}
    </div>
  );
}
interface RHistory { id: number; verb: string; who: string; at: string; changes: { field: string; from: string; to: string }[]; text: string | null }
function RowHistory({ docId, rowId }: { docId: string; rowId: string }) {
  const list = useQuery({ queryKey: ["table-row-history", docId, rowId], queryFn: () => api.get<{ history: RHistory[] }>(`/tables/${docId}/rows/${rowId}/history`) });
  if (list.isPending) return <Skeleton className="h-24" />;
  if (list.error) return <LoadErrorInline onRetry={() => list.refetch()} />;
  if (!list.data.history.length) return <p className="text-[13px] text-muted">No changes yet.</p>;
  return (
    <ol className="space-y-3" data-testid="row-history">
      {list.data.history.map((h) => (
        <li key={h.id} className="border-l-2 border-line pl-3 text-[13px]">
          <div className="text-[12px] text-muted"><span className="font-medium text-fg">{h.who}</span> {new Date(h.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
          {h.text && <p className="mt-0.5">{h.text}</p>}
          {h.changes.map((c, i) => <p key={i} className="mt-0.5 break-words"><span className="font-medium">{c.field}</span>: {c.from || "empty"} to {c.to || "empty"}</p>)}
        </li>
      ))}
    </ol>
  );
}

// ---------- field editor ----------
function FieldDialog({ docId, field, fields, canEdit, onClose, onDone }: { docId: string; field?: TField; fields: TField[]; canEdit: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<TFieldType>(field?.type ?? "text");
  const [options, setOptions] = useState<{ id: string; label: string; color: string }[]>(field?.config.options ?? []);
  const [newOpt, setNewOpt] = useState("");
  const [tableId, setTableId] = useState(field?.config.tableId ?? "");
  const [linkFieldId, setLinkFieldId] = useState(field?.config.linkFieldId ?? "");
  const [targetFieldId, setTargetFieldId] = useState(field?.config.targetFieldId ?? "");
  const [formula, setFormula] = useState(field?.config.formula ?? "");
  const { confirm: ask, dialogs } = useDialogs();
  const tables = useQuery({ queryKey: ["tables-list"], enabled: type === "link", queryFn: () => api.get<{ tables: { id: string; title: string }[] }>("/tables") });
  const linkField = fields.find((f) => f.id === linkFieldId && f.type === "link");
  const target = useQuery({ queryKey: qk(linkField?.config.tableId ?? ""), enabled: type === "lookup" && !!linkField?.config.tableId, queryFn: () => api.get<Detail>(`/tables/${linkField!.config.tableId}`) });
  const isPrimary = !!field && fields[0]?.id === field.id;
  const config = (): Record<string, unknown> => {
    if (type === "select" || type === "multiselect") return { options };
    if (type === "link") return { tableId };
    if (type === "lookup") return { linkFieldId, targetFieldId };
    if (type === "formula") return { formula };
    if (type === "currency") return { currency: "AUD" };
    return {};
  };
  const save = useMutation({
    mutationFn: () => field ? api.patch(`/tables/${docId}/fields/${field.id}`, { name: name.trim(), type, config: config() }) : api.post(`/tables/${docId}/fields`, { name: name.trim(), type, config: config() }),
    onSuccess: () => { toast(field ? "Field saved" : "Field added"); onDone(); },
    onError: (e) => showError(e as Error),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/tables/${docId}/fields/${field!.id}`),
    onSuccess: () => { toast("Field deleted"); onDone(); },
    onError: (e) => showError(e as Error),
  });
  const changingType = !!field && field.type !== type;
  const ready = name.trim().length > 0 && (type !== "link" || !!tableId) && (type !== "lookup" || (!!linkFieldId && !!targetFieldId)) && (type !== "formula" || !!formula.trim());
  if (!canEdit && field) {
    return <Dialog open onClose={onClose} title={field.name} footer={<Button onClick={onClose}>Close</Button>}><p className="text-[14px]">{TYPE_LABELS[field.type]}{field.config.formula ? `: ${field.config.formula}` : ""}</p></Dialog>;
  }
  return (
    <Dialog open onClose={onClose} title={field ? "Edit field" : "Add a field"} className="max-w-lg"
      footer={<>{field && !isPrimary && <Button variant="danger" className="mr-auto" onClick={() => void ask({ title: `Delete the field "${field.name}"?`, description: "Everything in it goes too.", confirmLabel: "Delete field", tone: "danger" }).then((ok) => { if (ok) del.mutate(); })}>Delete</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!ready || save.isPending} data-testid="field-save">{field ? "Save" : "Add field"}</Button></>}>
      <div className="space-y-3">
        <div><label className={label13} htmlFor="field-name">Name</label><Input id="field-name" value={name} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        <div><label className={label13} htmlFor="field-type">Type</label>
          <Select id="field-type" value={type} onChange={(e) => setType(e.target.value as TFieldType)}>
            {FIELD_TYPES.filter((t) => !isPrimary || (!isComputed(t) && t !== "link" && t !== "attachment")).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </Select>
          {changingType && <p className="mt-1 text-[12.5px] text-warn">Changing the type converts what is there. Values that do not fit are cleared. You can undo with history.</p>}</div>
        {(type === "select" || type === "multiselect") && (
          <div><span className={label13}>Options</span>
            <ul className="space-y-1.5">{options.map((o, i) => (
              <li key={o.id} className="flex items-center gap-2"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: o.color }} aria-hidden />
                <Input aria-label={`Option ${i + 1}`} value={o.label} maxLength={LIMITS.name} onChange={(e) => setOptions((os) => os.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
                <Button variant="ghost" size="sm" aria-label={`Remove ${o.label}`} onClick={() => setOptions((os) => os.filter((_, k) => k !== i))}><IconClose className="h-4 w-4" /></Button></li>))}</ul>
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); const l = newOpt.trim(); if (!l || options.length >= LIMITS.options) return; setOptions((os) => [...os, { id: `o${Date.now().toString(36)}${os.length}`, label: l, color: ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#ff5a36", "#64748b"][os.length % 8] }]); setNewOpt(""); }}>
              <Input aria-label="New option" placeholder="New option" value={newOpt} maxLength={LIMITS.name} onChange={(e) => setNewOpt(e.target.value)} /><Button type="submit" variant="secondary" size="sm">Add</Button>
            </form></div>
        )}
        {type === "link" && (
          <div><label className={label13} htmlFor="field-link">Links to</label>
            <Select id="field-link" value={tableId} onChange={(e) => setTableId(e.target.value)} disabled={!!field && field.type === "link"}>
              <option value="">Choose a table</option>{(tables.data?.tables ?? []).map((t) => <option key={t.id} value={t.id}>{t.id === docId ? `${t.title} (this table)` : t.title}</option>)}
            </Select>
            <p className="mt-1 text-[12.5px] text-muted">People only see linked rows from tables they can open.</p></div>
        )}
        {type === "lookup" && (
          <>
            <div><label className={label13} htmlFor="field-lookup-link">Through</label>
              <Select id="field-lookup-link" value={linkFieldId} onChange={(e) => { setLinkFieldId(e.target.value); setTargetFieldId(""); }}>
                <option value="">Choose a linked record field</option>{fields.filter((f) => f.type === "link").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
              {!fields.some((f) => f.type === "link") && <p className="mt-1 text-[12.5px] text-muted">Add a linked record field first.</p>}</div>
            {linkField && <div><label className={label13} htmlFor="field-lookup-target">Show</label>
              <Select id="field-lookup-target" value={targetFieldId} onChange={(e) => setTargetFieldId(e.target.value)}>
                <option value="">Choose a field</option>{(target.data?.fields ?? []).filter((f) => f.type !== "link" && f.type !== "lookup").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select></div>}
          </>
        )}
        {type === "formula" && (
          <div><label className={label13} htmlFor="field-formula">Formula</label>
            <Textarea id="field-formula" value={formula} maxLength={1000} placeholder="{Qty} * {Unit price}" onChange={(e) => setFormula(e.target.value)} className="font-mono text-[13px]" />
            <p className="mt-1 text-[12.5px] text-muted">Put field names in braces. You can use + minus * / and ROUND, SUM, MIN, MAX, IF, CONCAT, LEN, UPPER, LOWER, TODAY, DAYS.</p>
            <div className="mt-1 flex flex-wrap gap-1">{fields.filter((f) => f.id !== field?.id).slice(0, 12).map((f) => <button key={f.id} type="button" className="rounded bg-fill px-1.5 py-0.5 text-[12px] hover:bg-hover" onClick={() => setFormula((x) => `${x}{${f.name}}`)}>{f.name}</button>)}</div></div>
        )}
      </div>
      {dialogs}
    </Dialog>
  );
}

function SettingsDialog({ docId, access, onClose, onDone }: { docId: string; access: "everyone" | "admins"; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(access);
  const save = useMutation({ mutationFn: () => api.patch(`/tables/${docId}/settings`, { editAccess: v }), onSuccess: () => { toast("Saved"); onDone(); }, onError: (e) => showError(e as Error) });
  return (
    <Dialog open onClose={onClose} title="Who can edit" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <fieldset className="space-y-2"><legend className="sr-only">Who can edit</legend>
        <label className="flex min-h-[44px] items-start gap-2 text-[14px]"><input type="radio" name="edit" checked={v === "everyone"} onChange={() => setV("everyone")} className="mt-1" /><span>Everyone in the workspace<span className="block text-[12.5px] text-muted">Members can add and change rows, fields and views.</span></span></label>
        <label className="flex min-h-[44px] items-start gap-2 text-[14px]"><input type="radio" name="edit" checked={v === "admins"} onChange={() => setV("admins")} className="mt-1" /><span>Admins and the person who made it<span className="block text-[12.5px] text-muted">Everyone else can view, search and export.</span></span></label>
      </fieldset>
      <p className="mt-3 text-[12.5px] text-muted">Guests see the table when the doc is shared with their project, and can only view.</p>
    </Dialog>
  );
}

function NewViewDialog({ docId, onClose, onDone }: { docId: string; onClose: () => void; onDone: (id: string) => void }) {
  const [type, setType] = useState<ViewType>("grid");
  const [name, setName] = useState("");
  const make = useMutation({
    mutationFn: () => api.post<{ view: { id: string } }>(`/tables/${docId}/views`, { name: name.trim() || VIEW_LABELS[type], type }),
    onSuccess: (r) => onDone(r.view.id),
    onError: (e) => showError(e as Error),
  });
  return (
    <Dialog open onClose={onClose} title="Add a view" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => make.mutate()} disabled={make.isPending} data-testid="view-save">Add view</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="View type">
          {(["grid", "kanban", "calendar", "form"] as ViewType[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={cn("flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-[14px]", type === t ? "border-brand bg-brand/10" : "border-line hover:bg-hover")}>{VIEW_ICONS[t]}{VIEW_LABELS[t]}</button>
          ))}
        </div>
        <div><label className={label13} htmlFor="view-name">Name</label><Input id="view-name" value={name} placeholder={VIEW_LABELS[type]} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} /></div>
      </div>
    </Dialog>
  );
}
