/**
 * R102 Smart document inbox (DOC_INBOX_R102): Files > Documents. Tabs To check, All, Unpaid bills, Tax documents,
 * Bills, Receipts; search inside documents; a detail panel with what was found (type, who sent it, dates, amount, GST,
 * paid) that a person can correct; the text found; Rules (owners and admins write them, everyone else reads them).
 * Every list and panel shows only files the person can open (checked on the server).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useDebounced } from "@/web/lib/search";
import { cn } from "@/web/lib/cn";
import { IconArrowDown, IconArrowUp, IconCheck, IconClose, IconFile, IconPencilLine, IconPlus, IconReceipt, IconRefresh, IconSearch, IconSliders, IconTrash, IconUpload } from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { sendFile } from "./files-drive-r101";
import {
  DOC_MATCH, DOC_MATCH_LABEL, DOC_TYPES, DOC_TYPE_LABEL, DOC_VIEWS, DOC_VIEW_LABEL, centsLabel, isDocView, parseCentsInput,
  type DocDetail, type DocField, type DocList, type DocMatch, type DocRow, type DocRule, type DocType, type DocView,
} from "@/shared/doc-inbox";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";

const dateLabel = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const centsInput = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

function statusOf(r: DocRow): { label: string; tone: "neutral" | "warn" | "bad" | "ok" | "brand" } | null {
  if (r.status === "reading") return { label: "Reading", tone: "neutral" };
  if (r.status === "queued") return r.capped ? { label: "Waiting for tomorrow", tone: "warn" } : { label: "Waiting", tone: "neutral" };
  if (r.status === "failed") return { label: "Could not read", tone: "bad" };
  if (r.status === "skipped") return { label: "Not readable", tone: "neutral" };
  if (!r.checked) return { label: "To check", tone: "brand" };
  return null;
}

export function DocumentsView({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams();
  const askedView = params.get("dv");
  const dv: DocView = isDocView(askedView) ? askedView : "check";
  const openId = params.get("doc");
  const rulesOpen = params.get("rules") === "1";
  const qc = useQueryClient();
  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set("view", "docs");
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  });
  const [raw, setRaw] = useState("");
  const q = useDebounced(raw.trim(), 250);
  const searching = q.length >= 2;
  const [space, setSpace] = useState<"private" | "team">("private");
  const fileInput = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const list = useInfiniteQuery({
    queryKey: ["docs", "list", searching ? `q:${q}` : dv],
    initialPageParam: "",
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => api.get<DocList>(`/doc-inbox/list?view=${dv}${searching ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.next ?? undefined,
    // While something is being read, look again every few seconds.
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((i) => i.status === "reading" || (i.status === "queued" && !i.capped))) ? 5000 : false),
  });
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = first?.counts;

  const upload = async (files: File[]) => {
    for (const f of files) {
      const t = toast.loading(`Uploading ${f.name}`);
      try {
        await sendFile(`/api/drive/upload?space=${space}&name=${encodeURIComponent(f.name)}`, f, () => undefined);
        toast.success(`${f.name} added. Reading it now.`, { id: t });
      } catch (e) { toast.error((e as Error).message, { id: t }); }
    }
    void qc.invalidateQueries({ queryKey: ["docs"] });
    void qc.invalidateQueries({ queryKey: ["drive"] });
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = DOC_VIEWS.indexOf(dv);
    const next = DOC_VIEWS[(i + (e.key === "ArrowRight" ? 1 : DOC_VIEWS.length - 1)) % DOC_VIEWS.length];
    set({ dv: next, doc: null });
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus());
  };

  return (
    <div className="min-w-0" data-testid="docs-view">
      <Card className="min-w-0 overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="text-[15px] font-semibold">Documents</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Search inside documents" aria-label="Search inside documents" className="pl-9" data-testid="docs-search" />
            </div>
            <Select value={space} onChange={(e) => setSpace(e.target.value as "private" | "team")} aria-label="Save uploads to" className="w-auto" data-testid="docs-space">
              <option value="private">Save to My files</option>
              <option value="team">Save to Team files</option>
            </Select>
            <Button size="sm" onClick={() => fileInput.current?.click()} data-testid="docs-upload"><IconUpload className="h-4 w-4" />Upload</Button>
            <Button size="sm" variant="secondary" onClick={() => set({ rules: "1" })} data-testid="docs-rules"><IconSliders className="h-4 w-4" />Rules</Button>
          </div>
        </div>
        <input ref={fileInput} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.txt,.csv,.md,.docx,.xlsx" data-testid="docs-file-input"
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
        {!searching && (
          <div ref={tabsRef} role="tablist" aria-label="Document views" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {DOC_VIEWS.map((v) => {
              const n = counts?.[v];
              const active = v === dv;
              return (
                <button key={v} type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} data-view={v} data-testid={`docs-tab-${v}`} onClick={() => set({ dv: v, doc: null })}
                  className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-150 max-sm:min-h-11",
                    active ? "bg-brand/10 font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                  {DOC_VIEW_LABEL[v]}
                  {n !== undefined && n > 0 && <span className="text-xs tabular-nums text-subtle">{n}</span>}
                </button>
              );
            })}
          </div>
        )}
        {counts?.capped && (
          <p className="border-b border-line bg-fill px-4 py-2 text-xs text-muted" data-testid="docs-capped">Today's reading limit is reached. The rest are read tomorrow.</p>
        )}
        <div role={searching ? undefined : "tabpanel"} aria-label={searching ? undefined : DOC_VIEW_LABEL[dv]}>
          {list.isPending ? (
            <div className="space-y-3 p-4" data-testid="docs-loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : list.isError ? (
            <LoadError onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <DocsEmpty view={dv} searching={searching} q={q} total={counts?.all ?? 0} isAdmin={isAdmin} onUpload={() => fileInput.current?.click()} onRules={() => set({ rules: "1" })} />
          ) : (
            <ul className="divide-y divide-line" data-testid="docs-list">
              {items.map((r) => <DocLine key={r.id} r={r} active={r.id === openId} onOpen={() => set({ doc: r.id })} />)}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <button type="button" className="text-sm text-brand-hover hover:underline max-sm:min-h-11" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>Show more</button>
            </div>
          )}
        </div>
      </Card>
      {openId && <DocPanel id={openId} onClose={() => set({ doc: null })} />}
      {rulesOpen && <RulesDialog isAdmin={isAdmin} onClose={() => set({ rules: null })} />}
    </div>
  );
}

function DocsEmpty({ view, searching, q, total, isAdmin, onUpload, onRules }: { view: DocView; searching: boolean; q: string; total: number; isAdmin: boolean; onUpload: () => void; onRules: () => void }) {
  if (searching) return <EmptyState icon={<IconSearch />} title={`Nothing found for "${q}"`} body="Try another word. Documents that are still being read show up once they are done." />;
  if (total === 0) {
    return (
      <div className="p-6" data-testid="docs-empty">
        <EmptyState icon={<IconReceipt />} title="No documents yet" body={(
          <ul className="mx-auto mt-1 max-w-sm space-y-1 text-left">
            <li>1. Upload a bill, receipt or tax paper, or add one from your mail.</li>
            <li>2. We read the text and find the dates, amounts and GST.</li>
            <li>3. Rules tag and file them for you. You check and fix anything off.</li>
          </ul>
        )} action={(
          <div className="flex justify-center gap-2">
            <Button size="sm" onClick={onUpload}><IconUpload className="h-4 w-4" />Upload</Button>
            {isAdmin && <Button size="sm" variant="secondary" onClick={onRules}><IconPlus className="h-4 w-4" />Add a rule</Button>}
          </div>
        )} />
      </div>
    );
  }
  const body: Record<DocView, string> = {
    check: "All caught up. New documents land here after they are read.",
    all: "No documents yet.",
    unpaid: "No unpaid bills. Bills you mark as paid leave this list.",
    tax: "No tax documents yet. Notices of assessment, payment summaries and BAS land here.",
    bills: "No bills yet.",
    receipts: "No receipts yet.",
  };
  return <EmptyState icon={view === "check" ? <IconCheck /> : <IconReceipt />} title={view === "check" ? "All caught up" : `No ${DOC_VIEW_LABEL[view].toLowerCase()}`} body={body[view]} />;
}

function DocLine({ r, active, onOpen }: { r: DocRow; active: boolean; onOpen: () => void }) {
  const st = statusOf(r);
  const f = r.fields;
  const meta = [f.sender, dateLabel(f.docDate), f.amount !== null ? centsLabel(f.amount, f.currency) : ""].filter(Boolean).join(" · ");
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? "true" : undefined} data-testid="docs-row"
        className={cn("flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover sm:flex-row sm:items-center sm:gap-4", active && "bg-brand/5")}>
        <span className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fill text-muted">{f.type === "bill" || f.type === "receipt" ? <IconReceipt className="h-4 w-4" /> : <IconFile className="h-4 w-4" />}</span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-fg" title={r.name}>{r.name}</span>
            <span className="block truncate text-xs text-subtle">{meta || (r.status === "done" ? "Nothing found yet. Open to fill in." : "Added " + new Date(r.addedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }))}</span>
            {r.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{r.snippet}</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pl-11 sm:pl-0">
          {f.type && <Badge>{DOC_TYPE_LABEL[f.type]}</Badge>}
          {f.type === "bill" && <Badge tone={f.paid ? "ok" : "warn"}>{f.paid ? "Paid" : "Unpaid"}</Badge>}
          {st && <Badge tone={st.tone} dot>{st.label}</Badge>}
        </span>
      </button>
    </li>
  );
}

interface Draft { type: string; sender: string; docDate: string; dueDate: string; amount: string; gst: string; paid: boolean }
const draftOf = (d: DocDetail): Draft => ({ type: d.fields.type ?? "", sender: d.fields.sender ?? "", docDate: d.fields.docDate ?? "", dueDate: d.fields.dueDate ?? "", amount: centsInput(d.fields.amount), gst: centsInput(d.fields.gst), paid: d.fields.paid });

function DocPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ["docs", "item", id],
    queryFn: () => api.get<DocDetail>(`/doc-inbox/items/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data && (query.state.data.status === "reading" || (query.state.data.status === "queued" && !query.state.data.capped)) ? 4000 : false),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (doc.data) setDraft(draftOf(doc.data)); }, [doc.data]);
  useEffect(() => { closeRef.current?.focus(); }, [id]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const done = (d: DocDetail) => { qc.setQueryData(["docs", "item", id], d); void qc.invalidateQueries({ queryKey: ["docs", "list"] }); };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<DocDetail>(`/doc-inbox/items/${encodeURIComponent(id)}`, body),
    onSuccess: (d, body) => { done(d); toast.success(body.checked === true && Object.keys(body).length === 1 ? "Marked as checked" : "Saved"); },
    onError: (e) => showError(e),
  });
  const act = useMutation({
    mutationFn: (what: "read" | "apply-rules") => api.post<DocDetail>(`/doc-inbox/items/${encodeURIComponent(id)}/${what}`),
    onSuccess: (d, what) => { done(d); toast.success(what === "read" ? "Reading it again" : "Rules applied"); },
    onError: (e) => showError(e),
  });
  const d = doc.data;
  const f = draft;
  const changed = d && f ? JSON.stringify(draftOf(d)) !== JSON.stringify(f) : false;
  const submit = () => {
    if (!d || !f) return;
    const amount = parseCentsInput(f.amount); const gst = parseCentsInput(f.gst);
    if (Number.isNaN(amount) || Number.isNaN(gst)) { toast.error("Use an amount like 120.50."); return; }
    const o = draftOf(d);
    const body: Record<string, unknown> = {};
    if (f.type !== o.type) body.type = f.type || null;
    if (f.sender !== o.sender) body.sender = f.sender || null;
    if (f.docDate !== o.docDate) body.docDate = f.docDate || null;
    if (f.dueDate !== o.dueDate) body.dueDate = f.dueDate || null;
    if (f.amount !== o.amount) body.amount = amount;
    if (f.gst !== o.gst) body.gst = gst;
    if (f.paid !== o.paid) body.paid = f.paid;
    save.mutate(body);
  };
  const edited = (k: DocField) => d?.edited.includes(k) ? <span className="ml-1.5 text-[11px] font-normal text-subtle">Edited by you</span> : null;
  const ro = !d?.canEdit;
  const isImage = d?.contentType?.startsWith("image/");
  const contentUrl = `/api/drive/items/${encodeURIComponent(id)}/content?inline=1`;

  return (
    <aside role="dialog" aria-modal="false" aria-label={d ? `Document ${d.name}` : "Document"} data-testid="docs-panel"
      className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-y-0 md:left-auto md:right-0 md:w-[440px] md:border-l md:border-line md:shadow-xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={d?.name}>{d?.name ?? "Document"}</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {doc.isPending ? (
          <div className="space-y-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : doc.isError || !d || !f ? (
          <EmptyState icon={<IconFile />} title="This document did not open" body="It may have been moved to Trash, or you no longer have access." action={<Button size="sm" variant="secondary" onClick={() => void doc.refetch()}>Try again</Button>} />
        ) : (
          <div className="space-y-5">
            {isImage ? (
              <img src={contentUrl} alt={`Preview of ${d.name}`} className="max-h-56 w-full rounded-lg border border-line bg-fill object-contain" />
            ) : (
              <a href={contentUrl} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-line p-3 text-sm hover:bg-hover" data-testid="docs-open-file">
                <IconFile className="h-5 w-5 text-muted" /><span className="min-w-0 flex-1 truncate">{d.name}</span><span className="text-xs text-brand-hover">Open file</span>
              </a>
            )}
            {d.status !== "done" && (
              <div className="rounded-lg bg-fill px-3 py-2 text-xs text-muted" data-testid="docs-status">
                {d.status === "reading" ? "Reading this document. It takes a few seconds." : d.status === "queued" ? (d.capped ? "Today's reading limit is reached. This one is read tomorrow." : "Waiting to be read.") : d.status === "failed" ? "This document could not be read. Try reading it again, or fill in the details yourself." : "This kind of file cannot be read. You can still fill in the details."}
              </div>
            )}
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="What was found">
              <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">What was found</h3>{ro && <span className="text-xs text-subtle">View only</span>}</div>
              <label className="block text-xs font-medium text-muted">Type{edited("type")}
                <Select value={f.type} disabled={ro} onChange={(e) => setDraft({ ...f, type: e.target.value })} className="mt-1" data-testid="docs-field-type">
                  <option value="">Not set</option>
                  {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
                </Select>
              </label>
              <label className="block text-xs font-medium text-muted">Who sent it{edited("sender")}
                <Input value={f.sender} disabled={ro} maxLength={120} onChange={(e) => setDraft({ ...f, sender: e.target.value })} className="mt-1" data-testid="docs-field-sender" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-muted">Date{edited("docDate")}
                  <Input type="date" value={f.docDate} disabled={ro} onChange={(e) => setDraft({ ...f, docDate: e.target.value })} className="mt-1" data-testid="docs-field-date" />
                </label>
                <label className="block text-xs font-medium text-muted">Due date{edited("dueDate")}
                  <Input type="date" value={f.dueDate} disabled={ro} onChange={(e) => setDraft({ ...f, dueDate: e.target.value })} className="mt-1" data-testid="docs-field-due" />
                </label>
                <label className="block text-xs font-medium text-muted">Amount{edited("amount")}
                  <Input inputMode="decimal" value={f.amount} disabled={ro} placeholder="0.00" onChange={(e) => setDraft({ ...f, amount: e.target.value })} className="mt-1 tabular-nums" data-testid="docs-field-amount" />
                </label>
                <label className="block text-xs font-medium text-muted">GST{edited("gst")}
                  <Input inputMode="decimal" value={f.gst} disabled={ro} placeholder="0.00" onChange={(e) => setDraft({ ...f, gst: e.target.value })} className="mt-1 tabular-nums" data-testid="docs-field-gst" />
                </label>
              </div>
              <div className="flex items-center justify-between">
                <Switch checked={f.paid} disabled={ro} onChange={(v) => setDraft({ ...f, paid: v })} label="Paid" />
                {edited("paid")}
              </div>
              {!ro && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="submit" size="sm" disabled={!changed || save.isPending} data-testid="docs-save">Save</Button>
                  {d.checked
                    ? <Button type="button" size="sm" variant="secondary" onClick={() => save.mutate({ checked: false })} data-testid="docs-uncheck">Move back to To check</Button>
                    : <Button type="button" size="sm" variant="secondary" disabled={changed} onClick={() => save.mutate({ checked: true })} data-testid="docs-check"><IconCheck className="h-4 w-4" />Mark as checked</Button>}
                </div>
              )}
            </form>
            <div className="space-y-1.5 text-xs text-muted">
              <p>In <span className="text-fg">{d.folder.name}</span>{d.tags.length ? <> · Tags <span className="text-fg">{d.tags.join(", ")}</span></> : null}</p>
              {d.rulesApplied.length > 0 && <p data-testid="docs-rules-applied">Rules used: <span className="text-fg">{d.rulesApplied.map((r) => r.name).join(", ")}</span></p>}
            </div>
            {!ro && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={act.isPending || d.status !== "done"} onClick={() => act.mutate("apply-rules")} data-testid="docs-apply-rules"><IconSliders className="h-4 w-4" />Apply rules</Button>
                <Button size="sm" variant="secondary" disabled={act.isPending || d.status === "reading"} onClick={() => act.mutate("read")} data-testid="docs-read-again"><IconRefresh className="h-4 w-4" />Read again</Button>
              </div>
            )}
            <details className="rounded-lg border border-line" data-testid="docs-text">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium max-sm:min-h-11">Text found</summary>
              {d.text ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2 font-sans text-xs text-muted">{d.text}</pre>
                : <p className="border-t border-line px-3 py-2 text-xs text-subtle">No text yet.</p>}
            </details>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- rules

const HINT: Record<DocMatch, string> = {
  any: "Matches when the text has at least one of these words. Separate words with spaces.",
  all: "Matches when the text has every one of these words, in any order.",
  exact: "Matches this exact phrase.",
  regex: "For advanced use. Simple patterns only, up to 200 characters.",
  fuzzy: "Like Any of these words, but small typos from the scan still match.",
};

function ruleSummary(r: DocRule): string {
  const then = [r.setType ? `type ${DOC_TYPE_LABEL[r.setType]}` : "", r.setSender ? `who sent it ${r.setSender}` : "", r.setTags.length ? `tags ${r.setTags.join(", ")}` : "", r.setFolderName ? `file in ${r.setFolderName}` : ""].filter(Boolean).join(", ");
  return `${DOC_MATCH_LABEL[r.match]}: ${r.pattern}. Then ${then || "nothing"}.`;
}

function RulesDialog({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["docs", "rules"], queryFn: () => api.get<{ rules: DocRule[] }>("/doc-inbox/rules") });
  const [editing, setEditing] = useState<DocRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<DocRule | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["docs"] });
  const order = useMutation({ mutationFn: (ids: string[]) => api.post("/doc-inbox/rules/order", { ids }), onSuccess: refresh, onError: (e) => showError(e) });
  const toggle = useMutation({ mutationFn: (r: DocRule) => api.put(`/doc-inbox/rules/${r.id}`, ruleBody(r, { enabled: !r.enabled })), onSuccess: refresh, onError: (e) => showError(e) });
  const remove = useMutation({ mutationFn: (r: DocRule) => api.del(`/doc-inbox/rules/${r.id}`), onSuccess: () => { setDeleting(null); refresh(); toast.success("Rule deleted"); }, onError: (e) => showError(e) });
  const list = rules.data?.rules ?? [];
  const move = (i: number, by: number) => { const ids = list.map((r) => r.id); const [x] = ids.splice(i, 1); ids.splice(i + by, 0, x); order.mutate(ids); };

  return (
    <Dialog open onClose={onClose} title="Document rules" className="max-w-xl"
      description="Rules run on each new document from top to bottom. Tags add up. For type, who sent it and folder, the first matching rule wins. Anything you corrected yourself stays as you set it."
      footer={<div className="flex w-full items-center justify-between gap-2">
        {isAdmin ? <Button size="sm" onClick={() => setEditing("new")} data-testid="docs-rule-add"><IconPlus className="h-4 w-4" />Add a rule</Button> : <span className="text-xs text-subtle">Only owners and admins can change rules.</span>}
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>}>
      {rules.isPending ? <Skeleton className="h-20 w-full" /> : rules.isError ? (
        <LoadErrorInline onRetry={() => rules.refetch()} />
      ) : list.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted" data-testid="docs-rules-empty">No rules yet. {isAdmin ? "Add one to tag and file documents for you, like every Telstra bill into a Phone folder." : "An admin can add them."}</p>
      ) : (
        <ol className="divide-y divide-line rounded-lg border border-line" data-testid="docs-rule-list">
          {list.map((r, i) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5" data-testid="docs-rule">
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", !r.enabled && "text-subtle")}>{i + 1}. {r.name}{!r.enabled && <span className="ml-2 text-xs font-normal">Off</span>}</p>
                <p className="mt-0.5 break-words text-xs text-muted">{ruleSummary(r)}</p>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconBtn label={`Move ${r.name} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)}><IconArrowUp className="h-4 w-4" /></IconBtn>
                  <IconBtn label={`Move ${r.name} down`} disabled={i === list.length - 1 || order.isPending} onClick={() => move(i, 1)}><IconArrowDown className="h-4 w-4" /></IconBtn>
                  <Switch checked={r.enabled} onChange={() => toggle.mutate(r)} label={`Turn ${r.name} ${r.enabled ? "off" : "on"}`} />
                  <IconBtn label={`Edit ${r.name}`} onClick={() => setEditing(r)}><IconPencilLine className="h-4 w-4" /></IconBtn>
                  <IconBtn label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><IconTrash className="h-4 w-4" /></IconBtn>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && <RuleForm rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} busy={remove.isPending}
        title="Delete this rule?" description="Documents it already tagged or filed stay as they are." confirmLabel="Delete rule" />
    </Dialog>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg disabled:opacity-40 max-sm:h-11 max-sm:w-11">{children}</button>;
}

const ruleBody = (r: Pick<DocRule, "name" | "match" | "pattern" | "caseSensitive" | "setTags" | "setSender" | "setType" | "setFolderId" | "enabled">, patch: Partial<DocRule> = {}) => {
  const x = { ...r, ...patch };
  return { name: x.name, match: x.match, pattern: x.pattern, caseSensitive: x.caseSensitive, setTags: x.setTags, setSender: x.setSender, setType: x.setType, setFolderId: x.setFolderId, enabled: x.enabled };
};

function RuleForm({ rule, onClose, onSaved }: { rule: DocRule | null; onClose: () => void; onSaved: () => void }) {
  const folders = useQuery({ queryKey: ["docs", "folders"], queryFn: () => api.get<{ folders: { id: string; name: string }[] }>("/doc-inbox/folders") });
  const [name, setName] = useState(rule?.name ?? "");
  const [match, setMatch] = useState<DocMatch>(rule?.match ?? "any");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [caseSensitive, setCase] = useState(rule?.caseSensitive ?? false);
  const [type, setType] = useState<string>(rule?.setType ?? "");
  const [sender, setSender] = useState(rule?.setSender ?? "");
  const [tags, setTags] = useState((rule?.setTags ?? []).join(", "));
  const [folder, setFolder] = useState(rule?.setFolderId ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, match, pattern, caseSensitive, setTags: tags.split(",").map((t) => t.trim()).filter(Boolean), setSender: sender.trim() || null, setType: (type || null) as DocType | null, setFolderId: folder || null, enabled };
      return rule ? api.put(`/doc-inbox/rules/${rule.id}`, body) : api.post("/doc-inbox/rules", body);
    },
    onSuccess: () => { toast.success(rule ? "Rule saved" : "Rule added"); onSaved(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open onClose={onClose} title={rule ? "Edit rule" : "Add a rule"} className="max-w-lg"
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button><Button size="sm" disabled={save.isPending} onClick={() => save.mutate()} data-testid="docs-rule-save">{rule ? "Save rule" : "Add rule"}</Button></div>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="block text-xs font-medium text-muted">Name<Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Phone bills" className="mt-1" data-testid="docs-rule-name" /></label>
        <label className="block text-xs font-medium text-muted">When the text has
          <Select value={match} onChange={(e) => setMatch(e.target.value as DocMatch)} className="mt-1" data-testid="docs-rule-match">
            {DOC_MATCH.map((m) => <option key={m} value={m}>{DOC_MATCH_LABEL[m]}</option>)}
          </Select>
        </label>
        <label className="block text-xs font-medium text-muted">{match === "regex" ? "Pattern" : match === "exact" ? "Phrase" : "Words"}
          <Input value={pattern} maxLength={200} onChange={(e) => setPattern(e.target.value)} placeholder={match === "regex" ? "INV-\\d{4}" : "telstra optus"} className="mt-1" data-testid="docs-rule-pattern" />
          <span className="mt-1 block font-normal text-subtle">{HINT[match]}</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCase(e.target.checked)} className="h-4 w-4" />Match upper and lower case exactly</label>
        <p className="pt-1 text-sm font-semibold">Then</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted">Set the type
            <Select value={type} onChange={(e) => setType(e.target.value)} className="mt-1" data-testid="docs-rule-type">
              <option value="">Leave as found</option>
              {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
            </Select>
          </label>
          <label className="block text-xs font-medium text-muted">Set who sent it<Input value={sender} maxLength={120} onChange={(e) => setSender(e.target.value)} placeholder="Telstra" className="mt-1" /></label>
          <label className="block text-xs font-medium text-muted">Add tags<Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="phone, monthly" className="mt-1" data-testid="docs-rule-tags" /></label>
          <label className="block text-xs font-medium text-muted">File in a Team folder
            <Select value={folder} onChange={(e) => setFolder(e.target.value)} className="mt-1" data-testid="docs-rule-folder">
              <option value="">Do not move</option>
              {(folders.data?.folders ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </label>
        </div>
        <p className="text-xs text-subtle">Files in someone's My files are tagged but never moved into Team files.</p>
        <Switch checked={enabled} onChange={setEnabled} label="Rule is on" />
      </form>
    </Dialog>
  );
}
