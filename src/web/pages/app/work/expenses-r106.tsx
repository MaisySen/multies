/**
 * R106: the Expenses tab in Contacts > Invoices and quotes (?tab=expenses). Add a receipt (file or phone camera), or
 * forward one to the workspace receipts address; fields are read for you and you check them, split, submit for
 * approval, re bill onto an invoice draft, export CSV, and see repeating costs. Behind the `expenses` flag.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCheck, IconCopy, IconDownload, IconFilePlus, IconPlus, IconReceipt, IconRepeat, IconSearch, IconSend, IconSettings, IconTrash, IconWarning } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, Switch, tableStyles } from "@/web/components/ui/misc";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { abnValid, centsText, money, parseMoney } from "@/shared/invoices";
import { EVERY, EVERY_LABEL, EXPENSE_CATEGORIES, GST_INVOICE_THRESHOLD_CENTS, RECEIPT_MAX_BYTES, STATUS_LABEL, gstOfTotal, needsTaxInvoice, type Every, type ExpenseStatus } from "@/shared/expenses";

export const useExpensesOn = () => !!useConfig().data?.expenses;

interface SplitRow { category: string; amountCents: number; gstCents?: number; note?: string | null }
export interface Expense {
  id: string; userId: string; userName: string; own: boolean; status: ExpenseStatus; supplier: string | null; supplierAbn: string | null; spentOn: string | null;
  totalCents: number; gstCents: number; currency: string; category: string | null; gstClaimable: boolean; reimbursable: boolean; note: string | null;
  source: "upload" | "camera" | "email"; hasFile: boolean; fileName: string | null; fileType: string | null; readState: "none" | "reading" | "done" | "failed" | "unavailable";
  readFields: string[]; splits: SplitRow[]; every: Every | null; rebillDocId: string | null; decidedByName: string | null; rejectReason: string | null; needsTaxInvoice: boolean;
  can: { edit: boolean; submit: boolean; delete: boolean; decide: boolean; rebill: boolean };
}
interface ListResp { expenses: Expense[]; next: number | null; waiting: number; canApprove: boolean; canManage: boolean }
interface SettingsResp { canManage: boolean; canApprove: boolean; receiptsAddress: string | null; approverIds: string[]; people: { id: string; name: string; role: string }[] }
interface SubRow { supplier: string; every: Every; amountCents: number; lastOn: string; nextOn: string; perYearCents: number; count: number; suggested: boolean; expenseId: string }

type View = "mine" | "approve" | "all" | "subs";
const STATUS_TONE: Record<ExpenseStatus, "neutral" | "ok" | "warn" | "bad" | "brand"> = { draft: "neutral", submitted: "brand", approved: "ok", rejected: "bad" };
const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" }, { id: "draft", label: "Draft" }, { id: "submitted", label: "Waiting" }, { id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" },
];
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.heic";
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

export function StatusBadge({ status }: { status: ExpenseStatus }) {
  return <Badge tone={STATUS_TONE[status]} dot>{STATUS_LABEL[status]}</Badge>;
}

/** Sends one receipt file; returns the new expense. */
async function uploadReceipt(file: File, source: "upload" | "camera"): Promise<Expense> {
  if (file.size > RECEIPT_MAX_BYTES) throw new Error(`Receipts can be up to ${RECEIPT_MAX_BYTES / (1024 * 1024)} MB.`);
  const res = await fetch(`/api/expenses/upload?source=${source}&name=${encodeURIComponent(file.name.slice(0, 150))}`, {
    method: "PUT", body: file, credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream", "x-multies-upload": "1" },
  });
  const body = (await res.json().catch(() => null)) as { expense?: Expense; error?: { message?: string } } | null;
  if (!res.ok || !body?.expense) throw new Error(body?.error?.message || "That receipt could not be added. Try again.");
  return body.expense;
}

export function ExpensesTab() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("mine");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(0);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const settings = useQuery({ queryKey: ["expenses", "settings"], queryFn: () => api.get<SettingsResp>("/expenses/settings"), staleTime: 60_000 });
  const query = q.trim();
  const listView = view === "subs" ? "mine" : view;
  const list = useQuery({
    queryKey: ["expenses", "list", listView, status, query],
    queryFn: () => api.get<ListResp>(`/expenses?view=${listView}${status && view !== "approve" ? `&status=${status}` : ""}${query ? `&q=${encodeURIComponent(query.slice(0, 60))}` : ""}`),
    placeholderData: (p) => p, enabled: view !== "subs",
  });
  const canApprove = !!settings.data?.canApprove;

  const add = async (files: FileList | File[] | null, source: "upload" | "camera") => {
    const all = Array.from(files ?? []).slice(0, 10);
    if (!all.length) return;
    setBusy((n) => n + all.length);
    let last: Expense | null = null;
    for (const f of all) {
      try { last = await uploadReceipt(f, source); } catch (e) { showError(e as Error); } finally { setBusy((n) => n - 1); }
    }
    void qc.invalidateQueries({ queryKey: ["expenses", "list"] });
    if (last) {
      if (all.length === 1) setOpen(last.id);
      else toast.success(`${all.length} receipts added. Open each one to check it.`);
    }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void add(e.dataTransfer.files, "upload"); };
  const first = view === "mine" && list.data && list.data.expenses.length === 0 && !status && !query;
  const exportHref = `/api/expenses/export.csv?view=${listView === "approve" ? "all" : listView}${status ? `&status=${status}` : ""}${query ? `&q=${encodeURIComponent(query.slice(0, 60))}` : ""}`;
  const views: { id: View; label: string; count?: number }[] = [
    { id: "mine", label: "Mine" }, ...(canApprove ? [{ id: "approve" as View, label: "To approve", count: list.data?.waiting }, { id: "all" as View, label: "Everyone" }] : []), { id: "subs", label: "Subscriptions" },
  ];

  return (
    <div onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      className={cn("relative rounded-xl", drag && "outline-dashed outline-2 outline-offset-4 outline-brand")}>
      <input ref={fileRef} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void add(e.target.files, "upload"); e.target.value = ""; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void add(e.target.files, "camera"); e.target.value = ""; }} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-lg border border-line p-0.5" role="group" aria-label="Show">
          {views.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => { setView(v.id); setStatus(""); }}
              className={cn("rounded-md px-2.5 py-1 text-[12.5px]", view === v.id ? "bg-fill font-medium text-fg" : "text-muted hover:text-fg")}>
              {v.label}{v.count ? <span className="ml-1.5 rounded-full bg-brand px-1.5 text-[11px] text-white">{v.count}</span> : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {settings.data?.canManage && <Button variant="secondary" onClick={() => setSetup(true)} aria-label="Expense settings"><IconSettings className="h-4 w-4" /><span className="max-sm:sr-only">Settings</span></Button>}
          {view !== "subs" && !first && <a href={exportHref} download className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated"><IconDownload className="h-4 w-4" /><span className="max-sm:sr-only">Export CSV</span></a>}
          <Button variant="secondary" className="sm:hidden" onClick={() => camRef.current?.click()} disabled={busy > 0}><IconReceipt className="h-4 w-4" />Take photo</Button>
          <Button onClick={() => fileRef.current?.click()} disabled={busy > 0}><IconPlus className="h-4 w-4" />{busy > 0 ? "Adding" : "Add receipt"}</Button>
        </div>
      </div>
      {view === "subs" ? <Subscriptions onOpen={setOpen} /> : (
        <>
          {!first && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {view !== "approve" && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
                  {STATUS_FILTERS.map((f) => (
                    <button key={f.id} type="button" aria-pressed={status === f.id} onClick={() => setStatus(f.id)}
                      className={cn("rounded-full border px-3 py-1 text-[12.5px]", status === f.id ? "border-transparent bg-fg text-bg" : "border-line text-muted hover:text-fg")}>{f.label}</button>
                  ))}
                </div>
              )}
              <div className="relative ml-auto w-full sm:w-64">
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
                <Input aria-label="Search expenses" placeholder="Search supplier, category or note" maxLength={60} className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
          )}
          {list.isPending ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            : list.isError ? <Card className="p-6 text-center"><p className="text-sm">Expenses could not load.</p><Button className="mt-3" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></Card>
            : first ? (
              <EmptyState icon={<IconReceipt className="h-6 w-6" />} title="No expenses yet"
                body={<>Add a photo or PDF of a receipt and the details are filled in for you. You can also drop files here{settings.data?.receiptsAddress ? <>, or forward receipts to <span className="break-all font-medium text-fg">{settings.data.receiptsAddress}</span> from your sign in address</> : null}.</>}
                action={<Button onClick={() => fileRef.current?.click()}><IconFilePlus className="h-4 w-4" />Add receipt</Button>} />
            )
            : list.data.expenses.length === 0 ? <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">{view === "approve" ? "Nothing is waiting for approval." : "Nothing matches. Try another filter or search."}</p>
            : <ExpenseList rows={list.data.expenses} showPerson={view !== "mine"} onOpen={setOpen} />}
        </>
      )}
      {open && <ExpenseDialog id={open} onClose={() => setOpen(null)} />}
      {setup && settings.data && <SettingsDialog data={settings.data} onClose={() => setSetup(false)} />}
    </div>
  );
}

function ExpenseList({ rows, showPerson, onOpen }: { rows: Expense[]; showPerson: boolean; onOpen: (id: string) => void }) {
  const flag = (e: Expense) => e.needsTaxInvoice && <span title="Over $82.50 with no supplier ABN" className="ml-1.5 inline-flex align-middle text-warn"><IconWarning className="h-3.5 w-3.5" aria-label="Needs a tax invoice" /></span>;
  return (
    <>
      <div className={cn(tableStyles.wrap, "max-md:hidden")}>
        <table className={tableStyles.table}>
          <thead className={tableStyles.head}><tr>
            <th className={tableStyles.th}>Date</th><th className={tableStyles.th}>Supplier</th><th className={tableStyles.th}>Category</th>
            {showPerson && <th className={tableStyles.th}>Person</th>}<th className={tableStyles.th}>Status</th>
            <th className={cn(tableStyles.th, "text-right")}>GST</th><th className={cn(tableStyles.th, "text-right")}>Total</th>
          </tr></thead>
          <tbody className={tableStyles.body}>
            {rows.map((e) => (
              <tr key={e.id} className={tableStyles.row}>
                <td className={cn(tableStyles.td, "whitespace-nowrap tabular-nums")}>{dmy(e.spentOn)}</td>
                <td className={cn(tableStyles.td, "max-w-[16rem]")}>
                  <button type="button" onClick={() => onOpen(e.id)} className="max-w-full truncate text-left font-medium text-fg hover:underline" title={e.supplier ?? undefined}>{e.supplier || <span className="text-subtle">{e.readState === "reading" ? "Reading" : "No supplier yet"}</span>}</button>{flag(e)}
                </td>
                <td className={cn(tableStyles.td, "text-muted")}>{e.splits.length ? "Split" : e.category ?? ""}</td>
                {showPerson && <td className={cn(tableStyles.td, "max-w-[10rem] truncate")} title={e.userName}>{e.userName}</td>}
                <td className={tableStyles.td}><StatusBadge status={e.status} /></td>
                <td className={cn(tableStyles.td, "text-right tabular-nums text-muted")}>{money(e.gstCents, e.currency)}</td>
                <td className={cn(tableStyles.td, "text-right font-medium tabular-nums")}>{money(e.totalCents, e.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => onOpen(e.id)} className="w-full rounded-xl border border-line bg-surface p-3 text-left hover:bg-elevated">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate font-medium">{e.supplier || (e.readState === "reading" ? "Reading" : "No supplier yet")}{flag(e)}</p>
                <p className="shrink-0 font-medium tabular-nums">{money(e.totalCents, e.currency)}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                <StatusBadge status={e.status} /><span>{dmy(e.spentOn)}</span><span>{e.splits.length ? "Split" : e.category ?? ""}</span>{showPerson && <span className="truncate">{e.userName}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

interface Form { supplier: string; supplierAbn: string; spentOn: string; total: string; gst: string; category: string; gstClaimable: boolean; reimbursable: boolean; note: string; every: string; splits: { category: string; amount: string }[] }
const toForm = (e: Expense): Form => ({
  supplier: e.supplier ?? "", supplierAbn: e.supplierAbn ?? "", spentOn: e.spentOn ?? "", total: e.totalCents ? centsText(e.totalCents) : "", gst: e.gstCents ? centsText(e.gstCents) : "",
  category: e.category ?? "", gstClaimable: e.gstClaimable, reimbursable: e.reimbursable, note: e.note ?? "", every: e.every ?? "",
  splits: e.splits.map((s) => ({ category: s.category, amount: centsText(s.amountCents) })),
});

function ExpenseDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["expenses", "one", id], queryFn: () => api.get<{ expense: Expense }>(`/expenses/${id}`) });
  const e = q.data?.expense;
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [target, setTarget] = useState("");
  const tries = useRef(0);
  const put = (x: Expense) => { qc.setQueryData(["expenses", "one", id], { expense: x }); setForm(toForm(x)); void qc.invalidateQueries({ queryKey: ["expenses", "list"] }); };
  useEffect(() => { if (e && !form) setForm(toForm(e)); }, [e]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = useMutation({
    mutationFn: () => api.post<{ expense: Expense; note: string | null }>(`/expenses/${id}/read`, {}),
    onSuccess: (r) => { put(r.expense); setNote(r.note); },
    onError: (err: Error) => setNote(err.message),
  });
  // Reads a new receipt once, then checks every 2 seconds while the text engine is still reading (up to a minute).
  useEffect(() => {
    if (!e || !e.own || !e.hasFile || read.isPending) return;
    if (e.readState === "none" && tries.current === 0) { tries.current = 1; read.mutate(); return; }
    if (e.readState === "reading" && tries.current < 30) { const t = setTimeout(() => { tries.current += 1; read.mutate(); }, 2000); return () => clearTimeout(t); }
  }, [e?.readState, read.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCents = form ? parseMoney(form.total) ?? 0 : 0;
  const gstCents = form ? (form.gst.trim() ? parseMoney(form.gst) ?? 0 : 0) : 0;
  const abnOk = !form?.supplierAbn.trim() || abnValid(form.supplierAbn);
  const needsInvoice = !!form && needsTaxInvoice(totalCents, abnOk ? form.supplierAbn : null);
  const splitSum = form?.splits.reduce((n, s) => n + (parseMoney(s.amount) ?? 0), 0) ?? 0;
  const patch = () => {
    if (!form) return {};
    return {
      supplier: form.supplier.trim() || null, supplierAbn: form.supplierAbn.trim() || null, spentOn: form.spentOn || null, totalCents, gstCents, category: form.category || null,
      gstClaimable: form.gstClaimable && !needsInvoice && gstCents > 0, reimbursable: form.reimbursable, note: form.note.trim() || null, every: (form.every || null) as Every | null,
      splits: form.splits.map((s) => ({ category: s.category, amountCents: parseMoney(s.amount) ?? 0 })),
    };
  };
  const save = useMutation({ mutationFn: () => api.patch<{ expense: Expense }>(`/expenses/${id}`, patch()), onSuccess: (r) => { put(r.expense); toast.success("Saved"); }, onError: showError });
  const submit = useMutation({
    mutationFn: async () => { await api.patch(`/expenses/${id}`, patch()); return api.post<{ expense: Expense }>(`/expenses/${id}/submit`, {}); },
    onSuccess: (r) => { put(r.expense); toast.success(r.expense.status === "submitted" ? "Sent for approval" : "Saved"); }, onError: showError,
  });
  const act = useMutation({
    mutationFn: (what: "approve" | "reject" | "withdraw") => api.post<{ expense: Expense }>(`/expenses/${id}/${what}`, what === "reject" ? { reason } : {}),
    onSuccess: (r) => { put(r.expense); setRejecting(false); toast.success(r.expense.status === "approved" ? "Approved" : r.expense.status === "rejected" ? "Sent back" : "Withdrawn"); },
    onError: showError,
  });
  const del = useMutation({ mutationFn: () => api.del(`/expenses/${id}`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["expenses", "list"] }); toast.success("Deleted"); onClose(); }, onError: showError });
  const targets = useQuery({ queryKey: ["expenses", "rebill-targets"], queryFn: () => api.get<{ invoices: { id: string; buyerName: string | null; totalCents: number; createdAt: string; reference: string | null }[] }>("/expenses/rebill-targets"), enabled: !!e?.can.rebill });
  const rebill = useMutation({
    mutationFn: () => api.post<{ expense: Expense; docId: string }>(`/expenses/${id}/rebill`, { docId: target }),
    onSuccess: (r) => { put(r.expense); void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); toast.success("Added to the invoice draft"); }, onError: showError,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const edit = !!e?.can.edit;
  const filledHint = (k: string) => (e?.readFields.includes(k) ? "Read from the receipt" : undefined);

  return (
    <Dialog open onClose={onClose} title={e?.supplier || "Expense"} className="sm:max-w-3xl"
      description={e ? <span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={e.status} />{!e.own && <span>{e.userName}</span>}{e.source === "email" && <span>Forwarded by mail</span>}</span> : undefined}
      footer={e && form ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          {e.can.delete && <Button variant="ghost" onClick={() => setConfirmDel(true)} aria-label="Delete expense"><IconTrash className="h-4 w-4" /></Button>}
          <div className="ml-auto flex flex-wrap gap-2">
            {e.own && e.status === "submitted" && <Button variant="secondary" onClick={() => act.mutate("withdraw")} disabled={act.isPending}>Withdraw</Button>}
            {e.can.decide && !rejecting && <Button variant="secondary" onClick={() => setRejecting(true)}>Send back</Button>}
            {e.can.decide && !rejecting && <Button onClick={() => act.mutate("approve")} disabled={act.isPending}><IconCheck className="h-4 w-4" />Approve</Button>}
            {edit && <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending || !abnOk}>Save</Button>}
            {e.can.submit && <Button onClick={() => submit.mutate()} disabled={submit.isPending || !abnOk}><IconSend className="h-4 w-4" />Submit for approval</Button>}
            {!edit && !e.can.decide && !(e.own && e.status === "submitted") && <Button variant="secondary" onClick={onClose}>Close</Button>}
          </div>
        </div>
      ) : undefined}>
      {q.isPending || !form ? <div className="space-y-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-9 w-full" /></div>
        : q.isError || !e ? <p className="text-sm">This expense could not load.</p>
        : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <div className="space-y-2">
              {e.hasFile ? (
                e.fileType?.startsWith("image/") && e.fileType !== "image/heic" && e.fileType !== "image/heif"
                  ? <a href={`/api/expenses/${id}/receipt?inline=1`} target="_blank" rel="noreferrer"><img src={`/api/expenses/${id}/receipt?inline=1`} alt={`Receipt from ${e.supplier ?? "the supplier"}`} className="max-h-72 w-full rounded-lg border border-line object-contain bg-fill md:max-h-96" /></a>
                  : <a href={`/api/expenses/${id}/receipt?inline=1`} target="_blank" rel="noreferrer" className="flex h-32 items-center justify-center gap-2 rounded-lg border border-line bg-fill text-sm hover:bg-elevated"><IconReceipt className="h-5 w-5" />Open receipt</a>
              ) : <p className="rounded-lg border border-dashed border-line p-4 text-center text-[13px] text-muted">No receipt attached</p>}
              {e.readState === "reading" && <p className="text-[12.5px] text-muted" role="status">Reading the receipt</p>}
              {note && <p className="text-[12.5px] text-muted" role="status">{note}</p>}
              {e.own && e.hasFile && edit && (e.readState === "failed" || e.readState === "unavailable") && <Button size="sm" variant="ghost" onClick={() => { tries.current = 1; read.mutate(); }} disabled={read.isPending}>Read again</Button>}
              {e.status === "rejected" && e.rejectReason && <Card className="border-bad/40 p-3 text-[13px]" role="status"><p className="font-medium">Sent back{e.decidedByName ? ` by ${e.decidedByName}` : ""}</p><p className="mt-1 break-words">{e.rejectReason}</p></Card>}
              {e.status === "approved" && e.decidedByName && <p className="text-[12.5px] text-muted">Approved by {e.decidedByName}</p>}
            </div>
            <div className="space-y-3">
              {needsInvoice && (
                <Card className="flex gap-2 border-warn/40 p-3 text-[13px]" role="status">
                  <IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                  <p>Over {money(GST_INVOICE_THRESHOLD_CENTS)} you need a tax invoice that shows the supplier ABN to claim GST. Add the ABN, or ask the supplier for a tax invoice.</p>
                </Card>
              )}
              <fieldset disabled={!edit} className="grid gap-3 sm:grid-cols-2">
                <Field label="Supplier" hint={filledHint("supplier")}>{(p) => <Input {...p} value={form.supplier} maxLength={200} onChange={(x) => set("supplier", x.target.value)} />}</Field>
                <Field label="Supplier ABN" hint={filledHint("supplierAbn")} error={abnOk ? undefined : "An ABN has 11 digits. Check it."}>
                  {(p) => <Input {...p} value={form.supplierAbn} inputMode="numeric" maxLength={20} placeholder="11 digits" onChange={(x) => set("supplierAbn", x.target.value)} />}</Field>
                <Field label="Date" hint={filledHint("spentOn")}>{(p) => <Input {...p} type="date" value={form.spentOn} onChange={(x) => set("spentOn", x.target.value)} />}</Field>
                <Field label="Category" hint={filledHint("category")}>
                  {(p) => <Select {...p} value={form.category} onChange={(x) => set("category", x.target.value)}>
                    <option value="">Choose</option>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>}</Field>
                <Field label="Total including GST" hint={filledHint("totalCents")}>
                  {(p) => <Input {...p} value={form.total} inputMode="decimal" placeholder="0.00" onChange={(x) => set("total", x.target.value)}
                    onBlur={() => { if (!form.gst.trim() && totalCents && abnOk && form.supplierAbn.trim()) set("gst", centsText(gstOfTotal(totalCents))); }} />}</Field>
                <Field label="GST" hint={[filledHint("gstCents"), totalCents ? `One eleventh is ${money(gstOfTotal(totalCents))}` : ""].filter(Boolean).join(". ") || undefined}>
                  {(p) => <Input {...p} value={form.gst} inputMode="decimal" placeholder="0.00" onChange={(x) => set("gst", x.target.value)} />}</Field>
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Switch checked={form.gstClaimable && !needsInvoice && gstCents > 0} onChange={(v) => set("gstClaimable", v)} label="GST can be claimed" disabled={!edit || needsInvoice || gstCents <= 0} />
                  <Switch checked={form.reimbursable} onChange={(v) => set("reimbursable", v)} label="Pay me back (I paid with my own money)" disabled={!edit} />
                </div>
                <Field label="Repeats" className="sm:col-span-1">
                  {(p) => <Select {...p} value={form.every} onChange={(x) => set("every", x.target.value)}>
                    <option value="">Does not repeat</option>{EVERY.map((v) => <option key={v} value={v}>{EVERY_LABEL[v]}</option>)}
                  </Select>}</Field>
                <Field label="Note" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={form.note} onChange={(x) => set("note", x.target.value)} placeholder="What it was for" />}</Field>
              </fieldset>
              <SplitEditor form={form} edit={edit} totalCents={totalCents} splitSum={splitSum} onChange={(s) => set("splits", s)} />
              {e.rebillDocId ? <p className="text-[13px] text-muted">On an invoice. <Link to={`/app/contacts/invoices/${e.rebillDocId}`} className="text-fg underline">Open the invoice</Link></p>
                : e.can.rebill ? (
                  <div className="rounded-lg border border-line p-3">
                    <p className="text-[13px] font-medium">Re bill to a customer</p>
                    {targets.data && targets.data.invoices.length === 0 ? <p className="mt-1 text-[12.5px] text-muted">There are no invoice drafts. <Link to="/app/contacts/invoices?new=invoice" className="text-fg underline">Make one</Link>, then come back.</p> : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Select aria-label="Invoice draft" value={target} onChange={(x) => setTarget(x.target.value)} className="min-w-0 flex-1">
                          <option value="">Choose an invoice draft</option>
                          {targets.data?.invoices.map((d) => <option key={d.id} value={d.id}>{(d.buyerName || "No customer yet") + ", " + money(d.totalCents)}</option>)}
                        </Select>
                        <Button variant="secondary" onClick={() => rebill.mutate()} disabled={!target || rebill.isPending}>Add to invoice</Button>
                      </div>
                    )}
                  </div>
                ) : null}
              {rejecting && (
                <div className="rounded-lg border border-line p-3">
                  <Field label="Why are you sending it back?">{(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(x) => setReason(x.target.value)} autoFocus />}</Field>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                    <Button onClick={() => act.mutate("reject")} disabled={!reason.trim() || act.isPending}>Send back</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={() => del.mutate()} busy={del.isPending} title="Delete this expense?" description="The receipt is deleted too." />
    </Dialog>
  );
}

function SplitEditor({ form, edit, totalCents, splitSum, onChange }: { form: Form; edit: boolean; totalCents: number; splitSum: number; onChange: (s: Form["splits"]) => void }) {
  const left = totalCents - splitSum;
  if (!form.splits.length) {
    return edit && totalCents > 0 ? <Button size="sm" variant="ghost" onClick={() => onChange([{ category: form.category || "", amount: centsText(totalCents) }, { category: "", amount: "" }])}><IconPlus className="h-4 w-4" />Split across categories</Button> : null;
  }
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-[13px] font-medium">Split</p>
      <ul className="mt-2 space-y-2">
        {form.splits.map((s, i) => (
          <li key={i} className="flex gap-2">
            <Select aria-label={`Part ${i + 1} category`} value={s.category} disabled={!edit} className="min-w-0 flex-1" onChange={(x) => onChange(form.splits.map((p, j) => (j === i ? { ...p, category: x.target.value } : p)))}>
              <option value="">Category</option>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Input aria-label={`Part ${i + 1} amount`} value={s.amount} inputMode="decimal" disabled={!edit} className="w-28" onChange={(x) => onChange(form.splits.map((p, j) => (j === i ? { ...p, amount: x.target.value } : p)))} />
            {edit && <Button size="sm" variant="ghost" aria-label={`Remove part ${i + 1}`} onClick={() => onChange(form.splits.filter((_, j) => j !== i))}><IconTrash className="h-4 w-4" /></Button>}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
        {edit && form.splits.length < 10 && <Button size="sm" variant="ghost" onClick={() => onChange([...form.splits, { category: "", amount: left > 0 ? centsText(left) : "" }])}><IconPlus className="h-4 w-4" />Add part</Button>}
        <span className={cn("ml-auto tabular-nums", left === 0 ? "text-muted" : "text-bad")} role="status">{left === 0 ? "Adds up to the total" : left > 0 ? `${money(left)} left to split` : `${money(-left)} over the total`}</span>
      </div>
    </div>
  );
}

function Subscriptions({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["expenses", "subs"], queryFn: () => api.get<{ subscriptions: SubRow[]; perYearCents: number }>("/expenses/subscriptions") });
  if (q.isPending) return <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (q.isError) return <Card className="p-6 text-center"><p className="text-sm">Subscriptions could not load.</p><Button className="mt-3" variant="secondary" onClick={() => void q.refetch()}>Try again</Button></Card>;
  if (!q.data.subscriptions.length) return <EmptyState icon={<IconRepeat className="h-6 w-6" />} title="No repeating costs yet" body="Mark an expense as repeating, or add two from the same supplier a month apart, and it shows here with the next date and the yearly cost." />;
  return (
    <div>
      <Card className="mb-3 inline-block p-3"><p className="text-[12px] text-muted">A year at this rate</p><p className="mt-0.5 text-lg font-semibold tabular-nums">{money(q.data.perYearCents)}</p></Card>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {q.data.subscriptions.map((s) => (
          <li key={s.supplier}>
            <button type="button" onClick={() => onOpen(s.expenseId)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-3 text-left hover:bg-elevated">
              <span className="min-w-0 flex-1 truncate font-medium" title={s.supplier}>{s.supplier}</span>
              {s.suggested && <Badge tone="brand">Looks like it repeats</Badge>}
              <span className="text-[13px] text-muted">{EVERY_LABEL[s.every]}</span>
              <span className="text-[13px] text-muted">Next {dmy(s.nextOn)}</span>
              <span className="w-24 text-right font-medium tabular-nums">{money(s.amountCents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsDialog({ data, onClose }: { data: SettingsResp; onClose: () => void }) {
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>(data.approverIds);
  const [reset, setReset] = useState(false);
  const save = useMutation({
    mutationFn: (body: { approverIds?: string[]; resetAddress?: boolean }) => api.put<SettingsResp>("/expenses/settings", body),
    onSuccess: (r, body) => { qc.setQueryData(["expenses", "settings"], r); setReset(false); toast.success(body.resetAddress ? "New address made" : "Saved"); if (!body.resetAddress) onClose(); },
    onError: showError,
  });
  const current = (qc.getQueryData<SettingsResp>(["expenses", "settings"]) ?? data).receiptsAddress;
  const members = data.people.filter((p) => p.role === "member");
  return (
    <Dialog open onClose={onClose} title="Expense settings" description="Owners and admins always approve. Pick anyone else who should approve and see everyone's expenses."
      footer={<div className="flex w-full justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate({ approverIds: ids })} disabled={save.isPending}>Save</Button></div>}>
      <div className="space-y-5">
        <section>
          <h3 className="text-[13px] font-medium">Receipts address</h3>
          {current ? (
            <>
              <p className="mt-1 text-[12.5px] text-muted">People in the workspace forward receipts here from their sign in address. Each photo or PDF becomes a draft expense for them.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 break-all rounded-md bg-fill px-2 py-1 text-[13px]">{current}</code>
                <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(current).then(() => toast.success("Copied")); }}><IconCopy className="h-4 w-4" />Copy</Button>
                <Button size="sm" variant="ghost" onClick={() => setReset(true)}>Make a new address</Button>
              </div>
            </>
          ) : <p className="mt-1 text-[12.5px] text-muted">A receipts address is not available here yet. Add receipts from the Expenses tab instead.</p>}
        </section>
        <section>
          <h3 className="text-[13px] font-medium">Approvers</h3>
          {members.length === 0 ? <p className="mt-1 text-[12.5px] text-muted">Everyone else here is an owner or admin, so they can already approve.</p> : (
            <ul className="mt-2 max-h-60 space-y-1.5 overflow-y-auto">
              {members.map((p) => (
                <li key={p.id}><label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={ids.includes(p.id)} onChange={(x) => setIds((s) => (x.target.checked ? [...s, p.id] : s.filter((v) => v !== p.id)))} />
                  <span className="truncate">{p.name}</span>
                </label></li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <ConfirmDialog open={reset} onClose={() => setReset(false)} onConfirm={() => save.mutate({ resetAddress: true })} busy={save.isPending} tone="primary" confirmLabel="Make a new address"
        title="Make a new receipts address?" description="The old address stops working at once. Tell people the new one." />
    </Dialog>
  );
}

