/**
 * R105: invoices and quotes in the Contacts area (/app/contacts/invoices). Tabs: Invoices, Quotes, Credit notes, Bills,
 * Items, Reports. One document at /app/contacts/invoices/:id: an editor while it is a draft, a read view once issued.
 * Money is integer cents (src/shared/invoices.ts). Members view and draft; owners and admins issue, send, void, take
 * payments and change settings. Behind the `invoices` flag (INVOICES_ENABLED).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconArrowLeft, IconCheck, IconCopy, IconDownload, IconFilePlus, IconPlus, IconReceipt, IconRepeat, IconSearch, IconSend, IconSettings, IconTrash, IconWarning,
} from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { DateInput, Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Switch, tableStyles } from "@/web/components/ui/misc";
import { useConfig } from "@/web/lib/queries";
import { ExpensesTab, useExpensesOn } from "./expenses-r106"; // R106
import { cn } from "@/web/lib/cn";
import {
  CURRENCIES, PAYMENT_METHODS, abnValid, bsbValid, accountValid, centsText, docTotals, formatAbn, formatBsb, money, parseMoney, parseQty, qtyText,
  type DocKind, type PriceMode,
} from "@/shared/invoices";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";

export const useInvoicesOn = () => !!useConfig().data?.invoices;
const BASE = "/app/contacts/invoices";

// ---------- types ----------
interface Settings {
  businessName: string; abn: string | null; gstRegistered: boolean; priceMode: PriceMode; currency: string; termsDays: number; address: string | null; email: string | null;
  phone: string | null; bankName: string | null; bsb: string | null; accountNumber: string | null; accountName: string | null; payNote: string | null; footer: string | null;
  prefixInvoice: string | null; prefixQuote: string | null; prefixCredit: string | null; remindBeforeDays: number; remindAfterDays: number; ready: boolean;
}
interface DocRow {
  id: string; kind: DocKind; number: string | null; status: string; state: string; title: string; buyerName: string | null; buyerEmail: string | null; issueDate: string | null;
  dueDate: string | null; currency: string; totalCents: number; owingCents: number; paidCents: number; createdAt: string; reference: string | null;
}
interface Line { id: string; description: string; quantityMilli: number; unitCents: number; gstFree: boolean; itemId: string | null; netCents: number; gstCents: number; totalCents: number }
interface Payment { id: string; amountCents: number; paidOn: string; method: string; reference: string | null }
interface DocFull extends DocRow {
  contactId: string | null; supplierId: string | null; buyerAbn: string | null; buyerAddress: string | null; priceMode: PriceMode; gstRegistered: boolean; notes: string | null;
  terms: string | null; subtotalCents: number; gstCents: number; creditedCents: number; sourceId: string | null; convertedId: string | null; viewUrl: string | null;
  sentAt: string | null; viewedAt: string | null; answeredAt: string | null; voidReason: string | null; lines: Line[]; payments: Payment[];
  source: { id: string; number: string | null; kind: DocKind } | null; related: { id: string; number: string | null; totalCents: number; status: string }[];
  repeat: { every: string; nextRun: string; endDate: string | null; autoSend: boolean; active: boolean } | null; problems: { code: string; text: string }[]; canManage: boolean;
}
interface Item { id: string; name: string; description: string; unitCents: number; gstFree: boolean }
interface Supplier { id: string; name: string; abn: string | null; email: string | null }

const ALL_TABS = [
  { id: "invoices", label: "Invoices", kind: "invoice" as DocKind },
  { id: "quotes", label: "Quotes", kind: "quote" as DocKind },
  { id: "credits", label: "Credit notes", kind: "credit_note" as DocKind },
  { id: "bills", label: "Bills", kind: "bill" as DocKind },
  { id: "expenses", label: "Expenses" }, // R106, only with the expenses flag
  { id: "items", label: "Items" },
  { id: "reports", label: "Reports" },
] as const;
type TabId = (typeof ALL_TABS)[number]["id"];

const STATE_LABEL: Record<string, string> = { draft: "Draft", unpaid: "Unpaid", part_paid: "Part paid", paid: "Paid", overdue: "Overdue", void: "Void", issued: "Sent", accepted: "Accepted", declined: "Declined" };
const STATE_TONE: Record<string, "neutral" | "ok" | "warn" | "bad" | "brand"> = { draft: "neutral", unpaid: "brand", part_paid: "warn", paid: "ok", overdue: "bad", void: "neutral", issued: "brand", accepted: "ok", declined: "bad" };
const FILTERS: Record<string, { id: string; label: string }[]> = {
  invoice: [{ id: "", label: "All" }, { id: "draft", label: "Drafts" }, { id: "open", label: "Unpaid" }, { id: "overdue", label: "Overdue" }, { id: "paid", label: "Paid" }, { id: "void", label: "Void" }],
  quote: [{ id: "", label: "All" }, { id: "draft", label: "Drafts" }, { id: "issued", label: "Sent" }, { id: "accepted", label: "Accepted" }, { id: "declined", label: "Declined" }],
  credit_note: [{ id: "", label: "All" }, { id: "draft", label: "Drafts" }, { id: "issued", label: "Issued" }, { id: "void", label: "Void" }],
  bill: [{ id: "", label: "All" }, { id: "draft", label: "Drafts" }, { id: "open", label: "Unpaid" }, { id: "overdue", label: "Overdue" }, { id: "paid", label: "Paid" }],
};
const KIND_WORD: Record<DocKind, string> = { invoice: "invoice", quote: "quote", credit_note: "credit note", bill: "bill" };

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? "neutral"} dot>{STATE_LABEL[state] ?? state}</Badge>;
}
function useSettings() {
  return useQuery({ queryKey: ["invoices", "settings"], queryFn: () => api.get<{ settings: Settings; canManage: boolean }>("/invoices/settings"), staleTime: 60_000 });
}

// ---------- the area page ----------
export function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const expensesOn = useExpensesOn(); // R106
  const TABS = ALL_TABS.filter((t) => t.id !== "expenses" || expensesOn);
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "invoices") as TabId;
  const settings = useSettings();
  const [setup, setSetup] = useState(false);
  const canManage = !!settings.data?.canManage;
  const kindTab = TABS.find((t) => t.id === tab && "kind" in t) as { kind: DocKind } | undefined;
  const nav = useNavigate();
  const qc = useQueryClient();
  const want = params.get("new");
  useEffect(() => { // Create menu and command menu: ?new=invoice or ?new=quote opens a fresh draft
    if (want !== "invoice" && want !== "quote") return;
    let live = true;
    api.post<{ doc: DocFull }>("/invoices/docs", { kind: want, lines: [{ description: "", quantityMilli: 1000, unitCents: 0 }] })
      .then((r) => { if (live) { void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); nav(`${BASE}/${r.doc.id}`, { replace: true }); } })
      .catch((e: Error) => { showError(e); setParams({}, { replace: true }); });
    return () => { live = false; };
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <Link to="/app/contacts" className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />Contacts</Link>
      <PageHeader
        title="Invoices and quotes"
        description="Quote, invoice and get paid. Tax invoices follow the Australian rules."
        actions={<>
          {canManage && <Button variant="secondary" onClick={() => setSetup(true)}><IconSettings className="h-4 w-4" /><span className="max-sm:sr-only">Settings</span></Button>}
          {kindTab && <NewDocButton kind={kindTab.kind} />}
        </>}
      />
      {settings.data && !settings.data.settings.ready && tab !== "expenses" && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-warn/40 p-4" role="status">
          <IconWarning className="h-5 w-5 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0 flex-1 text-sm">{canManage ? "Add your business name and ABN before you issue your first tax invoice." : "An admin needs to add the business name and ABN before invoices can be issued. You can still make drafts."}</p>
          {canManage && <Button size="sm" onClick={() => setSetup(true)}>Set up invoicing</Button>}
        </Card>
      )}
      <div role="tablist" aria-label="Invoices and quotes" className="mb-4 flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-fill p-0.5 sm:inline-flex">
        {TABS.map((t) => (
          <button key={t.id} id={`inv-tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`inv-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === tab);
              const n = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : -1;
              if (n >= 0) { e.preventDefault(); setParams(n === 0 ? {} : { tab: TABS[n].id }); requestAnimationFrame(() => document.getElementById(`inv-tab-${TABS[n].id}`)?.focus()); }
            }}
            onClick={() => setParams(t.id === "invoices" ? {} : { tab: t.id })}
            className={cn("shrink-0 rounded-md px-3 py-1.5 text-[13px]", tab === t.id ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`inv-panel-${tab}`} aria-labelledby={`inv-tab-${tab}`}>
        {kindTab ? <DocList key={kindTab.kind} kind={kindTab.kind} /> : tab === "expenses" ? <ExpensesTab /> : tab === "items" ? <ItemsTab canManage={canManage} /> : <ReportsTab />}
      </div>
      {setup && settings.data && <SettingsDialog initial={settings.data.settings} onClose={() => setSetup(false)} />}
    </div>
  );
}

function NewDocButton({ kind, variant = "primary" }: { kind: DocKind; variant?: "primary" | "secondary" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const make = useMutation({
    mutationFn: () => api.post<{ doc: DocFull }>("/invoices/docs", { kind, lines: kind === "credit_note" ? undefined : [{ description: "", quantityMilli: 1000, unitCents: 0 }] }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); nav(`${BASE}/${r.doc.id}`); },
    onError: showError,
  });
  if (kind === "credit_note") return null; // credit notes start from an issued invoice
  return <Button variant={variant} onClick={() => make.mutate()} disabled={make.isPending}><IconPlus className="h-4 w-4" />New {KIND_WORD[kind]}</Button>;
}

function DocList({ kind }: { kind: DocKind }) {
  const [state, setState] = useState("");
  const [q, setQ] = useState("");
  const [pages, setPages] = useState(1);
  const query = q.trim();
  const list = useQuery({
    queryKey: ["invoices", "docs", kind, state, query, pages],
    queryFn: () => api.get<{ items: DocRow[]; more: boolean; totals: { openCents: number; overdueCents: number; count: number } }>(
      `/invoices/docs?kind=${kind}&limit=${50 * pages}${state ? `&state=${state}` : ""}${query ? `&q=${encodeURIComponent(query.slice(0, 40))}` : ""}`),
    placeholderData: (p) => p,
  });
  const first = list.data && list.data.totals.count === 0;
  return (
    <div>
      {(kind === "invoice" || kind === "bill") && list.data && !first && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
          <Card className="p-3"><p className="text-[12px] text-muted">{kind === "bill" ? "To pay" : "Owed to you"}</p><p className="mt-0.5 text-lg font-semibold tabular-nums">{money(list.data.totals.openCents)}</p></Card>
          <Card className="p-3"><p className="text-[12px] text-muted">Overdue</p><p className={cn("mt-0.5 text-lg font-semibold tabular-nums", list.data.totals.overdueCents > 0 && "text-bad")}>{money(list.data.totals.overdueCents)}</p></Card>
        </div>
      )}
      {!first && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {FILTERS[kind].map((f) => (
              <button key={f.id} type="button" aria-pressed={state === f.id} onClick={() => { setState(f.id); setPages(1); }}
                className={cn("rounded-full border px-3 py-1 text-[12.5px]", state === f.id ? "border-transparent bg-fg text-bg" : "border-line text-muted hover:text-fg")}>{f.label}</button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-64">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label={`Search ${KIND_WORD[kind]}s`} placeholder="Search number, name or reference" maxLength={60} className="pl-8" value={q} onChange={(e) => { setQ(e.target.value); setPages(1); }} />
          </div>
        </div>
      )}
      {list.isPending ? <ListSkeleton />
        : list.isError ? <Card className="p-6 text-center"><LoadError onRetry={() => list.refetch()} /></Card>
        : first ? <FirstTime kind={kind} />
        : list.data.items.length === 0 ? <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">Nothing matches. Try another filter or search.</p>
        : <>
          <div className={cn(tableStyles.wrap, "max-md:hidden")}>
            <table className={tableStyles.table}>
              <thead className={tableStyles.head}><tr>
                <th className={tableStyles.th}>Number</th><th className={tableStyles.th}>{kind === "bill" ? "Supplier" : "Customer"}</th><th className={tableStyles.th}>Issued</th>
                <th className={tableStyles.th}>{kind === "quote" ? "Valid until" : "Due"}</th><th className={tableStyles.th}>Status</th>
                <th className={cn(tableStyles.th, "text-right")}>Total</th>{kind !== "quote" && kind !== "credit_note" && <th className={cn(tableStyles.th, "text-right")}>Owing</th>}
              </tr></thead>
              <tbody className={tableStyles.body}>
                {list.data.items.map((d) => (
                  <tr key={d.id} className={cn(tableStyles.row, "cursor-pointer")}>
                    <td className={tableStyles.td}><Link to={`${BASE}/${d.id}`} className="font-medium text-fg hover:underline">{d.number ?? "Draft"}</Link></td>
                    <td className={cn(tableStyles.td, "max-w-[16rem] break-words")}>{d.buyerName || <span className="text-subtle">No name yet</span>}</td>
                    <td className={cn(tableStyles.td, "whitespace-nowrap tabular-nums")}>{d.issueDate ?? ""}</td>
                    <td className={cn(tableStyles.td, "whitespace-nowrap tabular-nums")}>{d.dueDate ?? ""}</td>
                    <td className={tableStyles.td}><StateBadge state={d.state} /></td>
                    <td className={cn(tableStyles.td, "text-right tabular-nums")}>{money(d.totalCents, d.currency)}</td>
                    {kind !== "quote" && kind !== "credit_note" && <td className={cn(tableStyles.td, "text-right tabular-nums")}>{d.status === "issued" ? money(d.owingCents, d.currency) : ""}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {list.data.items.map((d) => (
              <li key={d.id}><Link to={`${BASE}/${d.id}`} className="block rounded-xl border border-line bg-surface p-3 hover:bg-hover/50">
                <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-medium">{d.buyerName || "No name yet"}</span><span className="shrink-0 font-semibold tabular-nums">{money(d.totalCents, d.currency)}</span></div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted"><span>{d.number ?? "Draft"}</span>{d.dueDate && <span>{kind === "quote" ? "Valid until" : "Due"} {d.dueDate}</span>}<StateBadge state={d.state} /></div>
              </Link></li>
            ))}
          </ul>
          {list.data.more && <div className="mt-3 text-center"><Button variant="secondary" onClick={() => setPages((p) => p + 1)} disabled={list.isFetching}>Load more</Button></div>}
        </>}
      {kind === "bill" && <SuppliersCard />}
    </div>
  );
}
function ListSkeleton() { return <div className="space-y-2" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>; }

function FirstTime({ kind }: { kind: DocKind }) {
  const body: Record<DocKind, string> = {
    invoice: "Bill a customer for work or goods. When you are registered for GST it becomes a tax invoice with your ABN and the GST shown, and you can send it with a link to view and download.",
    quote: "Send a price before the work starts. Your customer can accept or decline it online, and an accepted quote turns into an invoice in one click.",
    credit_note: "A credit note reduces an invoice you already issued. Open an issued invoice and choose Credit to make one.",
    bill: "Keep the bills you receive from suppliers, so you know what you owe and the GST you can claim.",
  };
  return <EmptyState icon={<IconReceipt className="h-6 w-6" />} title={kind === "credit_note" ? "No credit notes yet" : `No ${KIND_WORD[kind]}s yet`} body={body[kind]} action={<NewDocButton kind={kind} />} />;
}

function SuppliersCard() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["invoices", "suppliers"], queryFn: () => api.get<{ suppliers: Supplier[] }>("/invoices/suppliers") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", abn: "", email: "" });
  const abnBad = !!f.abn.trim() && !abnValid(f.abn);
  const add = useMutation({
    mutationFn: () => api.post("/invoices/suppliers", { name: f.name.trim(), abn: f.abn.trim() || null, email: f.email.trim() || null }),
    onSuccess: () => { setOpen(false); setF({ name: "", abn: "", email: "" }); toast.success("Supplier added"); void qc.invalidateQueries({ queryKey: ["invoices", "suppliers"] }); },
    onError: showError,
  });
  return (
    <Card className="mt-6 p-4">
      <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Suppliers</h2><Button size="sm" variant="secondary" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Add supplier</Button></div>
      {list.isPending ? <Skeleton className="h-8 w-full" /> : !list.data?.suppliers.length ? <p className="text-sm text-muted">No suppliers yet. Add the businesses that send you bills.</p> : (
        <ul className="divide-y divide-line text-sm">{list.data.suppliers.map((s) => <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2"><span className="break-words font-medium">{s.name}</span><span className="text-muted">{s.abn ? `ABN ${formatAbn(s.abn)}` : s.email ?? ""}</span></li>)}</ul>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add supplier" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => add.mutate()} disabled={!f.name.trim() || abnBad || add.isPending}>Add supplier</Button></>}>
        <div className="space-y-3">
          <Field label="Name">{(p) => <Input {...p} value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="ABN" hint="Optional" error={abnBad ? "That ABN does not look right. Check the 11 digits." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.abn} maxLength={20} onChange={(e) => setF({ ...f, abn: e.target.value })} />}</Field>
          <Field label="Email" hint="Optional">{(p) => <Input {...p} type="email" value={f.email} maxLength={254} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}

// ---------- items ----------
function ItemsTab({ canManage: _c }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["invoices", "items", q], queryFn: () => api.get<{ items: Item[] }>(`/invoices/items${q.trim() ? `?q=${encodeURIComponent(q.trim().slice(0, 40))}` : ""}`), placeholderData: (p) => p });
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const archive = useMutation({
    mutationFn: (id: string) => api.patch(`/invoices/items/${id}`, { archived: true }),
    onSuccess: () => { toast.success("Item removed from the list"); void qc.invalidateQueries({ queryKey: ["invoices", "items"] }); }, onError: showError,
  });
  const empty = list.data && !list.data.items.length && !q.trim();
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label="Search items" placeholder="Search items" className="pl-8" maxLength={60} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button className="sm:ml-auto" onClick={() => setEdit("new")}><IconPlus className="h-4 w-4" />New item</Button>
      </div>
      {list.isPending ? <ListSkeleton /> : empty ? <EmptyState icon={<IconReceipt className="h-6 w-6" />} title="No items yet" body="Save the things you sell often with their price, then add them to an invoice or quote in one tap." action={<Button onClick={() => setEdit("new")}><IconPlus className="h-4 w-4" />New item</Button>} />
        : !list.data?.items.length ? <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">No items match.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {list.data.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 p-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEdit(i)}>
                  <span className="block break-words font-medium">{i.name}</span>
                  {i.description && <span className="block break-words text-[12.5px] text-muted">{i.description}</span>}
                </button>
                <span className="tabular-nums">{money(i.unitCents)}</span>
                {i.gstFree && <Badge>GST free</Badge>}
                <Button size="icon" variant="ghost" aria-label={`Remove ${i.name}`} onClick={() => archive.mutate(i.id)}><IconTrash className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      {edit && <ItemDialog item={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function ItemDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: item?.name ?? "", description: item?.description ?? "", price: item ? centsText(item.unitCents) : "", gstFree: item?.gstFree ?? false });
  const cents = parseMoney(f.price);
  const save = useMutation({
    mutationFn: () => { const b = { name: f.name.trim(), description: f.description.trim(), unitCents: cents ?? 0, gstFree: f.gstFree }; return item ? api.patch(`/invoices/items/${item.id}`, b) : api.post("/invoices/items", b); },
    onSuccess: () => { toast.success(item ? "Item saved" : "Item added"); void qc.invalidateQueries({ queryKey: ["invoices", "items"] }); onClose(); }, onError: showError,
  });
  return (
    <Dialog open onClose={onClose} title={item ? "Edit item" : "New item"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!f.name.trim() || cents === null || save.isPending}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(p) => <Input {...p} value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Description" hint="Optional">{(p) => <Textarea {...p} rows={2} value={f.description} maxLength={1000} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Price" hint="Before GST when your prices exclude GST" error={f.price && cents === null ? "Enter an amount like 120 or 99.50." : undefined}>{(p) => <Input {...p} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field>
        <Switch checked={f.gstFree} onChange={(v) => setF({ ...f, gstFree: v })} label="GST free" />
      </div>
    </Dialog>
  );
}

// ---------- reports ----------
const BUCKETS = [["current", "Not yet due"], ["d1_30", "1 to 30 days"], ["d31_60", "31 to 60 days"], ["d61_90", "61 to 90 days"], ["d90_plus", "Over 90 days"]] as const;
function ReportsTab() {
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");
  const aged = useQuery({ queryKey: ["invoices", "aged"], queryFn: () => api.get<{ asOf: string; rows: { name: string; buckets: Record<string, number>; totalCents: number }[]; totals: Record<string, number>; totalCents: number }>("/invoices/reports/aged") });
  const gst = useQuery({ queryKey: ["invoices", "gst", basis], queryFn: () => api.get<{ from: string; to: string; quarter: { label: string }; g1SalesCents: number; gstOnSalesCents: number; purchasesCents: number; gstOnPurchasesCents: number; netGstCents: number }>(`/invoices/reports/gst?basis=${basis}`) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Aged receivables</h2>
        <p className="mb-3 text-[12.5px] text-muted">What customers owe you, by how late it is.</p>
        {aged.isPending ? <Skeleton className="h-24 w-full" /> : aged.isError ? <LoadErrorInline onRetry={() => aged.refetch()} /> : (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {BUCKETS.map(([k, label]) => <div key={k} className="rounded-lg bg-fill/60 p-2"><dt className="text-[12px] text-muted">{label}</dt><dd className={cn("font-semibold tabular-nums", k !== "current" && (aged.data.totals[k] ?? 0) > 0 && "text-bad")}>{money(aged.data.totals[k] ?? 0)}</dd></div>)}
              <div className="rounded-lg bg-fill/60 p-2"><dt className="text-[12px] text-muted">Total owed</dt><dd className="font-semibold tabular-nums">{money(aged.data.totalCents)}</dd></div>
            </dl>
            {aged.data.rows.length > 0 && <ul className="mt-3 divide-y divide-line text-sm">{aged.data.rows.slice(0, 20).map((r, i) => <li key={i} className="flex justify-between gap-2 py-1.5"><span className="min-w-0 break-words">{r.name}</span><span className="tabular-nums">{money(r.totalCents)}</span></li>)}</ul>}
          </>
        )}
      </Card>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 className="text-sm font-semibold">GST for your BAS</h2><p className="text-[12.5px] text-muted">{gst.data ? `${gst.data.quarter.label}, ${gst.data.from} to ${gst.data.to}` : "This quarter"}</p></div>
          <div role="group" aria-label="Reporting basis" className="inline-flex rounded-lg bg-fill p-0.5">
            {(["accrual", "cash"] as const).map((b) => <button key={b} type="button" aria-pressed={basis === b} onClick={() => setBasis(b)} className={cn("rounded-md px-2.5 py-1 text-[12.5px]", basis === b ? "bg-surface font-medium shadow-sm" : "text-muted")}>{b === "accrual" ? "Accrual" : "Cash"}</button>)}
          </div>
        </div>
        {gst.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : gst.isError ? <LoadErrorInline onRetry={() => gst.refetch()} /> : (
          <dl className="mt-3 divide-y divide-line text-sm">
            {([["G1 Total sales", gst.data.g1SalesCents], ["1A GST on sales", gst.data.gstOnSalesCents], ["1B GST on purchases", gst.data.gstOnPurchasesCents], [gst.data.netGstCents >= 0 ? "GST to pay" : "GST refund", Math.abs(gst.data.netGstCents)]] as const).map(([k, v], i) => (
              <div key={k} className="flex justify-between gap-2 py-1.5"><dt className={cn(i === 3 && "font-semibold")}>{k}</dt><dd className={cn("tabular-nums", i === 3 && "font-semibold")}>{money(v)}</dd></div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-[12px] text-muted">Figures come from the invoices, credit notes and bills here. Check with your accountant before you lodge.</p>
      </Card>
    </div>
  );
}

// ---------- settings ----------
function SettingsDialog({ initial, onClose }: { initial: Settings; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ...initial, abn: initial.abn ? formatAbn(initial.abn) : "", bsb: initial.bsb ? formatBsb(initial.bsb) : "", termsDays: String(initial.termsDays) });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const abnBad = !!f.abn.trim() && !abnValid(f.abn);
  const bsbBad = !!f.bsb.trim() && !bsbValid(f.bsb);
  const accBad = !!(f.accountNumber ?? "").trim() && !accountValid(f.accountNumber);
  const days = Number(f.termsDays);
  const daysBad = !/^\d{1,3}$/.test(f.termsDays) || days > 365;
  const save = useMutation({
    mutationFn: () => api.put("/invoices/settings", {
      businessName: f.businessName.trim(), abn: f.abn.trim() || null, gstRegistered: f.gstRegistered, priceMode: f.priceMode, currency: f.currency, termsDays: days,
      address: f.address?.trim() || null, email: f.email?.trim() || null, phone: f.phone?.trim() || null, bankName: f.bankName?.trim() || null, bsb: f.bsb.trim() || null,
      accountNumber: f.accountNumber?.trim() || null, accountName: f.accountName?.trim() || null, payNote: f.payNote?.trim() || null, footer: f.footer?.trim() || null,
      prefixInvoice: f.prefixInvoice?.trim() || null, prefixQuote: f.prefixQuote?.trim() || null, prefixCredit: f.prefixCredit?.trim() || null,
      remindBeforeDays: f.remindBeforeDays, remindAfterDays: f.remindAfterDays,
    }),
    onSuccess: () => { toast.success("Invoice settings saved"); void qc.invalidateQueries({ queryKey: ["invoices"] }); onClose(); }, onError: showError,
  });
  const bad = abnBad || bsbBad || accBad || daysBad || (f.gstRegistered && !!f.businessName.trim() && !f.abn.trim() && false);
  return (
    <Dialog open onClose={onClose} title="Invoice settings" description="What every invoice and quote shows. Only owners and admins can change these." className="sm:max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={bad || save.isPending}>Save settings</Button></>}>
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">Your business</h3>
          <Field label="Business name">{(p) => <Input {...p} value={f.businessName} maxLength={200} onChange={(e) => set("businessName", e.target.value)} />}</Field>
          <Field label="ABN" hint="11 digits. Shown on every tax invoice." error={abnBad ? "That ABN does not look right. Check the 11 digits." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.abn} maxLength={20} onChange={(e) => set("abn", e.target.value)} />}</Field>
          <Switch checked={f.gstRegistered} onChange={(v) => set("gstRegistered", v)} label="Registered for GST (invoices become tax invoices and show GST)" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prices you type">{(p) => <Select {...p} value={f.priceMode} onChange={(e) => set("priceMode", e.target.value as PriceMode)}><option value="exclusive">Exclude GST</option><option value="inclusive">Include GST</option></Select>}</Field>
            <Field label="Currency">{(p) => <Select {...p} value={f.currency} onChange={(e) => set("currency", e.target.value)}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
          </div>
          <Field label="Address" hint="Optional">{(p) => <Textarea {...p} rows={2} value={f.address ?? ""} maxLength={500} onChange={(e) => set("address", e.target.value)} />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email on invoices" hint="Optional">{(p) => <Input {...p} type="email" value={f.email ?? ""} maxLength={254} onChange={(e) => set("email", e.target.value)} />}</Field>
            <Field label="Phone" hint="Optional">{(p) => <Input {...p} type="tel" value={f.phone ?? ""} maxLength={40} onChange={(e) => set("phone", e.target.value)} />}</Field>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">How customers pay you</h3>
          <p className="text-[12.5px] text-muted">Shown on invoices so customers can pay by bank transfer. You record payments yourself when they arrive.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account name">{(p) => <Input {...p} value={f.accountName ?? ""} maxLength={100} onChange={(e) => set("accountName", e.target.value)} />}</Field>
            <Field label="Bank" hint="Optional">{(p) => <Input {...p} value={f.bankName ?? ""} maxLength={100} onChange={(e) => set("bankName", e.target.value)} />}</Field>
            <Field label="BSB" error={bsbBad ? "A BSB has 6 digits." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.bsb} maxLength={10} onChange={(e) => set("bsb", e.target.value)} />}</Field>
            <Field label="Account number" error={accBad ? "An account number has 5 to 9 digits." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.accountNumber ?? ""} maxLength={12} onChange={(e) => set("accountNumber", e.target.value)} />}</Field>
          </div>
          <Field label="Payment note" hint="Optional, for example other ways to pay">{(p) => <Input {...p} value={f.payNote ?? ""} maxLength={500} onChange={(e) => set("payNote", e.target.value)} />}</Field>
        </section>
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">Numbers, terms and reminders</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Invoice prefix" hint="Default INV">{(p) => <Input {...p} value={f.prefixInvoice ?? ""} maxLength={8} onChange={(e) => set("prefixInvoice", e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />}</Field>
            <Field label="Quote prefix" hint="Default QU">{(p) => <Input {...p} value={f.prefixQuote ?? ""} maxLength={8} onChange={(e) => set("prefixQuote", e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />}</Field>
            <Field label="Credit note prefix" hint="Default CN">{(p) => <Input {...p} value={f.prefixCredit ?? ""} maxLength={8} onChange={(e) => set("prefixCredit", e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />}</Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Days to pay" error={daysBad ? "Enter 0 to 365 days." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.termsDays} maxLength={3} onChange={(e) => set("termsDays", e.target.value)} />}</Field>
            <Field label="Remind before due">{(p) => <Select {...p} value={String(f.remindBeforeDays)} onChange={(e) => set("remindBeforeDays", Number(e.target.value))}>{[0, 1, 3, 7].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : `${n} ${n === 1 ? "day" : "days"} before`}</option>)}</Select>}</Field>
            <Field label="Remind when overdue">{(p) => <Select {...p} value={String(f.remindAfterDays)} onChange={(e) => set("remindAfterDays", Number(e.target.value))}>{[0, 3, 7, 14].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : `Every ${n} days`}</option>)}</Select>}</Field>
          </div>
          <Field label="Footer" hint="Optional, printed at the bottom of every page">{(p) => <Input {...p} value={f.footer ?? ""} maxLength={500} onChange={(e) => set("footer", e.target.value)} />}</Field>
        </section>
      </div>
    </Dialog>
  );
}

// ---------- one document ----------
export function InvoiceDocPage() {
  const { id = "" } = useParams();
  const doc = useQuery({ queryKey: ["invoices", "doc", id], queryFn: () => api.get<{ doc: DocFull }>(`/invoices/docs/${id}`) });
  if (doc.isPending) return <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6" aria-busy="true"><Skeleton className="mb-4 h-8 w-64" /><Skeleton className="h-96 w-full rounded-xl" /></div>;
  if (doc.isError) return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 text-center sm:px-6">
      <p className="text-sm">This document could not be found. It may have been deleted, or you may not have access.</p>
      <Link to={BASE} className="mt-3 inline-block text-sm font-medium text-fg underline underline-offset-2 hover:no-underline">Back to invoices</Link>
    </div>
  );
  return doc.data.doc.status === "draft" ? <DraftEditor key={doc.data.doc.id + doc.data.doc.status} doc={doc.data.doc} /> : <IssuedView doc={doc.data.doc} />;
}
const tabOf = (k: DocKind) => (k === "quote" ? "?tab=quotes" : k === "credit_note" ? "?tab=credits" : k === "bill" ? "?tab=bills" : "");

interface EditLine { key: string; description: string; qty: string; price: string; gstFree: boolean; itemId: string | null }
const toEdit = (l: Line, i: number): EditLine => ({ key: `${l.id}-${i}`, description: l.description, qty: qtyText(l.quantityMilli), price: centsText(l.unitCents), gstFree: l.gstFree, itemId: l.itemId });
let keySeq = 0;

function DraftEditor({ doc }: { doc: DocFull }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const settings = useSettings();
  const s = settings.data?.settings;
  const items = useQuery({ queryKey: ["invoices", "items", ""], queryFn: () => api.get<{ items: Item[] }>("/invoices/items") });
  const suppliers = useQuery({ queryKey: ["invoices", "suppliers"], queryFn: () => api.get<{ suppliers: Supplier[] }>("/invoices/suppliers"), enabled: doc.kind === "bill" });
  const [f, setF] = useState({
    contactId: doc.contactId, supplierId: doc.supplierId, buyerName: doc.buyerName ?? "", buyerEmail: doc.buyerEmail ?? "", buyerAbn: doc.buyerAbn ? formatAbn(doc.buyerAbn) : "",
    buyerAddress: doc.buyerAddress ?? "", issueDate: doc.issueDate ?? "", dueDate: doc.dueDate ?? "", reference: doc.reference ?? "", notes: doc.notes ?? "", terms: doc.terms ?? "",
    priceMode: doc.priceMode, currency: doc.currency,
  });
  const [lines, setLines] = useState<EditLine[]>(doc.lines.length ? doc.lines.map(toEdit) : [{ key: `n${keySeq++}`, description: "", qty: "1", price: "", gstFree: false, itemId: null }]);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const upd = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setDirty(true); };
  const updLine = (key: string, p: Partial<EditLine>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l))); setDirty(true); };
  const parsed = lines.map((l) => ({ description: l.description, quantityMilli: parseQty(l.qty), unitCents: parseMoney(l.price || "0"), gstFree: l.gstFree, itemId: l.itemId }));
  const linesOk = parsed.every((l) => l.quantityMilli !== null && l.unitCents !== null);
  const totals = useMemo(() => docTotals(parsed.map((l) => ({ ...l, quantityMilli: l.quantityMilli ?? 0, unitCents: l.unitCents ?? 0 })), f.priceMode, doc.gstRegistered), [JSON.stringify(parsed), f.priceMode, doc.gstRegistered]); // eslint-disable-line react-hooks/exhaustive-deps
  const abnBad = !!f.buyerAbn.trim() && !abnValid(f.buyerAbn);
  const emailBad = !!f.buyerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.buyerEmail.trim());
  const body = () => ({
    contactId: f.contactId, supplierId: f.supplierId, buyerName: f.buyerName.trim() || null, buyerEmail: f.buyerEmail.trim() || null, buyerAbn: f.buyerAbn.trim() || null,
    buyerAddress: f.buyerAddress.trim() || null, issueDate: f.issueDate || null, dueDate: f.dueDate || null, reference: f.reference.trim() || null, notes: f.notes.trim() || null,
    terms: f.terms.trim() || null, priceMode: f.priceMode, currency: f.currency,
    lines: parsed.filter((l, i) => l.description.trim() || (l.unitCents ?? 0) !== 0 || i === 0 && parsed.length === 1).map((l) => ({ description: l.description, quantityMilli: l.quantityMilli ?? 0, unitCents: l.unitCents ?? 0, gstFree: l.gstFree, itemId: l.itemId })),
  });
  const save = useMutation({
    mutationFn: () => api.patch<{ doc: DocFull }>(`/invoices/docs/${doc.id}`, body()),
    onSuccess: (r) => { setDirty(false); qc.setQueryData(["invoices", "doc", doc.id], r); void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); toast.success("Draft saved"); },
    onError: showError,
  });
  const issue = useMutation({
    mutationFn: async () => { if (dirty) await api.patch(`/invoices/docs/${doc.id}`, body()); return api.post<{ doc: DocFull }>(`/invoices/docs/${doc.id}/issue`, {}); },
    onSuccess: (r) => { qc.setQueryData(["invoices", "doc", doc.id], r); void qc.invalidateQueries({ queryKey: ["invoices"] }); toast.success(`${r.doc.title} ${r.doc.number} issued`); },
    onError: (e) => { void qc.invalidateQueries({ queryKey: ["invoices", "doc", doc.id] }); showError(e as Error); },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/invoices/docs/${doc.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); toast.success("Draft deleted"); nav(`${BASE}${tabOf(doc.kind)}`); }, onError: showError,
  });
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  const word = KIND_WORD[doc.kind];
  const canManage = doc.canManage;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 sm:px-6 sm:pb-10">
      <Link to={`${BASE}${tabOf(doc.kind)}`} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />{doc.kind === "credit_note" ? "Credit notes" : `${word[0].toUpperCase()}${word.slice(1)}s`}</Link>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{doc.kind === "credit_note" ? "New credit note" : `New ${word}`}</h1>
        <StateBadge state="draft" />
        {doc.source && <span className="text-[13px] text-muted">for {doc.source.number}</span>}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold">{doc.kind === "bill" ? "Supplier" : "Customer"}</h2>
            {doc.kind === "bill" ? (
              <Field label="Supplier">{(p) => <Select {...p} value={f.supplierId ?? ""} onChange={(e) => { const sup = suppliers.data?.suppliers.find((x) => x.id === e.target.value); upd("supplierId", e.target.value || null); if (sup) { upd("buyerName", sup.name); upd("buyerAbn", sup.abn ? formatAbn(sup.abn) : ""); } }}>
                <option value="">Pick a supplier</option>{suppliers.data?.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
            ) : doc.kind !== "credit_note" && <ContactPicker onPick={(c) => { upd("contactId", c.id); upd("buyerName", c.name || c.email); upd("buyerEmail", c.email); }} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">{(p) => <Input {...p} value={f.buyerName} maxLength={200} disabled={doc.kind === "credit_note"} onChange={(e) => upd("buyerName", e.target.value)} />}</Field>
              {doc.kind !== "bill" && <Field label="Email" error={emailBad ? "Check this email address." : undefined}>{(p) => <Input {...p} type="email" value={f.buyerEmail} maxLength={254} onChange={(e) => upd("buyerEmail", e.target.value)} />}</Field>}
              <Field label="ABN" hint={doc.kind === "bill" ? "Optional" : "Needed on tax invoices of $1,000 or more if there is no name"} error={abnBad ? "That ABN does not look right. Check the 11 digits." : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.buyerAbn} maxLength={20} disabled={doc.kind === "credit_note"} onChange={(e) => upd("buyerAbn", e.target.value)} />}</Field>
              {doc.kind !== "bill" && <Field label="Address" hint="Optional">{(p) => <Input {...p} value={f.buyerAddress} maxLength={500} disabled={doc.kind === "credit_note"} onChange={(e) => upd("buyerAddress", e.target.value)} />}</Field>}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Lines</h2>
              {doc.gstRegistered && <span className="text-[12.5px] text-muted">Prices {f.priceMode === "inclusive" ? "include" : "exclude"} GST</span>}
            </div>
            <ul className="space-y-3">
              {lines.map((l, i) => (
                <li key={l.key} className="rounded-lg border border-line p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_auto]">
                    <Field label={`Description, line ${i + 1}`}>{(p) => <Textarea {...p} rows={1} value={l.description} maxLength={1000} placeholder="What you are charging for" onChange={(e) => updLine(l.key, { description: e.target.value })} />}</Field>
                    <Field label="Qty" error={parseQty(l.qty) === null ? "Check" : undefined}>{(p) => <Input {...p} inputMode="decimal" value={l.qty} onChange={(e) => updLine(l.key, { qty: e.target.value })} />}</Field>
                    <Field label="Price" error={l.price && parseMoney(l.price) === null ? "Check" : undefined}>{(p) => <Input {...p} inputMode="decimal" value={l.price} placeholder="0.00" onChange={(e) => updLine(l.key, { price: e.target.value })} />}</Field>
                    <div className="flex items-end justify-between gap-2 sm:flex-col sm:items-end sm:justify-end">
                      <span className="text-sm font-medium tabular-nums" aria-label={`Line ${i + 1} amount`}>{money(f.priceMode === "inclusive" ? totals.lines[i]?.totalCents ?? 0 : totals.lines[i]?.netCents ?? 0, f.currency)}</span>
                      <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true); }}><IconTrash className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  {doc.gstRegistered && <label className="mt-2 inline-flex items-center gap-2 text-[12.5px] text-muted"><input type="checkbox" checked={l.gstFree} onChange={(e) => updLine(l.key, { gstFree: e.target.checked })} />GST free</label>}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={lines.length >= 200} onClick={() => { setLines((ls) => [...ls, { key: `n${keySeq++}`, description: "", qty: "1", price: "", gstFree: false, itemId: null }]); setDirty(true); }}><IconPlus className="h-4 w-4" />Add line</Button>
              {!!items.data?.items.length && (
                <Select aria-label="Add a saved item" value="" className="w-auto" onChange={(e) => {
                  const it = items.data?.items.find((x) => x.id === e.target.value); if (!it) return;
                  setLines((ls) => [...ls.filter((x) => x.description.trim() || x.price), { key: `n${keySeq++}`, description: it.description ? `${it.name}\n${it.description}` : it.name, qty: "1", price: centsText(it.unitCents), gstFree: it.gstFree, itemId: it.id }]); setDirty(true);
                }}><option value="">Add a saved item</option>{items.data.items.map((it) => <option key={it.id} value={it.id}>{it.name} ({money(it.unitCents)})</option>)}</Select>
              )}
            </div>
          </Card>
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold">Details</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Issue date" hint="Today if left empty">{(p) => <DateInput {...p} value={f.issueDate} onChange={(e) => upd("issueDate", e.target.value)} />}</Field>
              {doc.kind !== "credit_note" && <Field label={doc.kind === "quote" ? "Valid until" : "Due date"} hint={doc.kind === "quote" ? "30 days if left empty" : `${s?.termsDays ?? 14} days if left empty`}>{(p) => <DateInput {...p} value={f.dueDate} onChange={(e) => upd("dueDate", e.target.value)} />}</Field>}
              <Field label="Reference" hint="Optional, like a PO number">{(p) => <Input {...p} value={f.reference} maxLength={100} onChange={(e) => upd("reference", e.target.value)} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Prices">{(p) => <Select {...p} value={f.priceMode} onChange={(e) => upd("priceMode", e.target.value as PriceMode)}><option value="exclusive">Exclude GST</option><option value="inclusive">Include GST</option></Select>}</Field>
              <Field label="Currency" hint={f.currency !== "AUD" ? "GST and BAS figures are in this currency as typed" : undefined}>{(p) => <Select {...p} value={f.currency} onChange={(e) => upd("currency", e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
            </div>
            <Field label="Notes" hint="Optional, shown to the customer">{(p) => <Textarea {...p} rows={2} value={f.notes} maxLength={2000} onChange={(e) => upd("notes", e.target.value)} />}</Field>
            {doc.kind !== "bill" && <Field label="Terms" hint="Optional">{(p) => <Textarea {...p} rows={2} value={f.terms} maxLength={2000} onChange={(e) => upd("terms", e.target.value)} />}</Field>}
          </Card>
        </div>
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card className="p-4">
            <Totals sub={totals.subtotalCents} gst={totals.gstCents} total={totals.totalCents} currency={f.currency} gstRegistered={doc.gstRegistered} />
          </Card>
          {doc.problems.length > 0 && doc.kind !== "bill" && (
            <Card className="p-4" role="status">
              <h2 className="mb-1.5 text-[13px] font-semibold">Before you issue it</h2>
              <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-muted">{doc.problems.map((p) => <li key={p.code}>{p.text}</li>)}</ul>
              {dirty && <p className="mt-2 text-[12px] text-subtle">Save to check again.</p>}
            </Card>
          )}
          <div className="max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:border-t max-lg:border-line max-lg:bg-surface max-lg:p-3">
            <div className="flex flex-wrap gap-2 lg:flex-col">
              <span className="text-sm font-semibold tabular-nums lg:hidden">{money(totals.totalCents, f.currency)}</span>
              <Button variant="secondary" className="max-lg:ml-auto lg:w-full" onClick={() => save.mutate()} disabled={!linesOk || abnBad || emailBad || save.isPending || !dirty}>{dirty ? "Save draft" : "Saved"}</Button>
              {canManage ? <Button className="lg:w-full" onClick={() => issue.mutate()} disabled={!linesOk || abnBad || emailBad || issue.isPending}><IconCheck className="h-4 w-4" />{doc.kind === "bill" ? "Save bill" : `Issue ${word}`}</Button>
                : <p className="w-full text-[12px] text-muted">An owner or admin issues it once your draft is ready.</p>}
              <Button variant="ghost" className="lg:w-full" onClick={() => setConfirmDelete(true)}><IconTrash className="h-4 w-4" />Delete draft</Button>
            </div>
          </div>
        </aside>
      </div>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => del.mutate()} title="Delete this draft?" description="It has no number yet, so nothing is skipped in your numbering." busy={del.isPending} />
    </div>
  );
}

function ContactPicker({ onPick }: { onPick: (c: { id: string; name: string; email: string }) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim();
  const res = useQuery({ queryKey: ["invoices", "contact-pick", query], queryFn: () => api.get<{ contacts: { id: string; name: string; email: string }[] }>(`/contacts?q=${encodeURIComponent(query.slice(0, 40))}`), enabled: query.length >= 2 });
  return (
    <div className="relative">
      <Field label="Find a contact" hint="Or type the details below">{(p) => <Input {...p} value={q} placeholder="Search by name or email" maxLength={60} onChange={(e) => setQ(e.target.value)} />}</Field>
      {query.length >= 2 && res.data && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg" role="listbox" aria-label="Contacts">
          {res.data.contacts.length === 0 ? <li className="p-2 text-[13px] text-muted">No contacts match.</li> : res.data.contacts.slice(0, 8).map((c) => (
            <li key={c.id} role="option" aria-selected={false}><button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => { onPick(c); setQ(""); }}>
              <span className="block break-words font-medium">{c.name || c.email}</span><span className="block break-words text-[12px] text-muted">{c.email}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Totals({ sub, gst, total, currency, gstRegistered, paid, credited, owing }: { sub: number; gst: number; total: number; currency: string; gstRegistered: boolean; paid?: number; credited?: number; owing?: number }) {
  const row = (k: string, v: number, strong = false) => <div className="flex justify-between gap-2 py-1"><dt className={cn(strong && "font-semibold")}>{k}</dt><dd className={cn("tabular-nums", strong && "font-semibold")}>{money(v, currency)}</dd></div>;
  return (
    <dl className="text-sm">
      {row(gstRegistered ? "Subtotal excluding GST" : "Subtotal", sub)}
      {gstRegistered && row("GST", gst)}
      {row(gstRegistered ? "Total including GST" : "Total", total, true)}
      {!!paid && row("Paid", -paid)}
      {!!credited && row("Credited", -credited)}
      {owing !== undefined && row("Amount owing", owing, true)}
    </dl>
  );
}

function IssuedView({ doc }: { doc: DocFull }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | "send" | "pay" | "void" | "repeat">(null);
  const refresh = (r: { doc: DocFull }) => { qc.setQueryData(["invoices", "doc", doc.id], r); void qc.invalidateQueries({ queryKey: ["invoices", "docs"] }); };
  const convert = useMutation({ mutationFn: () => api.post<{ doc: DocFull }>(`/invoices/docs/${doc.id}/convert`, {}), onSuccess: (r) => { toast.success("Invoice draft made from the quote"); void qc.invalidateQueries({ queryKey: ["invoices"] }); nav(`${BASE}/${r.doc.id}`); }, onError: showError });
  const credit = useMutation({ mutationFn: () => api.post<{ doc: DocFull }>("/invoices/docs", { kind: "credit_note", sourceId: doc.id, lines: [{ description: `Adjustment to ${doc.number}`, quantityMilli: 1000, unitCents: 0 }] }), onSuccess: (r) => nav(`${BASE}/${r.doc.id}`), onError: showError });
  const delPay = useMutation({ mutationFn: (pid: string) => api.del<{ doc: DocFull }>(`/invoices/docs/${doc.id}/payments/${pid}`), onSuccess: (r) => { refresh(r); toast.success("Payment removed"); }, onError: showError });
  const m = doc.canManage;
  const isSale = doc.kind !== "bill";
  const s = useSettings().data?.settings;
  const seller = doc.kind === "bill" ? null : s && <div className="text-sm"><p className="break-words text-base font-semibold">{s.businessName || "Your business"}</p>{s.abn && <p className="text-muted">ABN {formatAbn(s.abn)}</p>}</div>;
  const payable = (doc.kind === "invoice" || doc.kind === "bill") && doc.status === "issued" && doc.owingCents > 0;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <Link to={`${BASE}${tabOf(doc.kind)}`} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />Back</Link>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{doc.title} {doc.number}</h1>
        <StateBadge state={doc.state} />
        {doc.sentAt && <span className="text-[12.5px] text-muted">Sent{doc.viewedAt ? ", viewed" : ""}</span>}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {m && isSale && doc.status !== "void" && <Button onClick={() => setDialog("send")}><IconSend className="h-4 w-4" />{doc.sentAt ? "Send again" : "Send"}</Button>}
        {m && payable && <Button variant={isSale ? "secondary" : "primary"} onClick={() => setDialog("pay")}>Record payment</Button>}
        <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated" href={`/api/invoices/docs/${doc.id}/pdf?download=1`}><IconDownload className="h-4 w-4" />PDF</a>
        {doc.viewUrl && doc.status !== "void" && <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(doc.viewUrl ?? "").then(() => toast.success("Link copied")); }}><IconCopy className="h-4 w-4" />Copy link</Button>}
        {doc.kind === "quote" && (doc.status === "issued" || doc.status === "accepted") && !doc.convertedId && <Button variant="secondary" onClick={() => convert.mutate()} disabled={convert.isPending}><IconFilePlus className="h-4 w-4" />Make invoice</Button>}
        {doc.convertedId && <Link className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-fg underline underline-offset-2 hover:no-underline" to={`${BASE}/${doc.convertedId}`}>Open the invoice</Link>}
        {doc.kind === "invoice" && doc.status === "issued" && <Button variant="secondary" onClick={() => credit.mutate()} disabled={credit.isPending}>Credit</Button>}
        {m && doc.kind === "invoice" && doc.status === "issued" && <Button variant="secondary" onClick={() => setDialog("repeat")}><IconRepeat className="h-4 w-4" />{doc.repeat?.active ? "Repeating" : "Repeat"}</Button>}
        {m && doc.status !== "void" && <Button variant="ghost" onClick={() => setDialog("void")}>Void</Button>}
      </div>
      {doc.status === "void" && <Card className="mb-4 p-3 text-sm" role="status">This document is void{doc.voidReason ? `: ${doc.voidReason}` : "."} Its number stays used so your numbering has no gaps.</Card>}
      {doc.repeat?.active && <p className="mb-3 text-[13px] text-muted">Repeats every {doc.repeat.every}. Next on {doc.repeat.nextRun}{doc.repeat.autoSend ? ", sent automatically" : ""}.</p>}
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <DocPaper doc={doc} seller={seller} />
        <aside className="space-y-3">
          <Card className="p-4"><Totals sub={doc.subtotalCents} gst={doc.gstCents} total={doc.totalCents} currency={doc.currency} gstRegistered={doc.gstRegistered}
            {...(doc.kind === "invoice" || doc.kind === "bill" ? { paid: doc.paidCents, credited: doc.creditedCents, owing: doc.owingCents } : {})} /></Card>
          {(doc.kind === "invoice" || doc.kind === "bill") && (
            <Card className="p-4">
              <h2 className="mb-2 text-[13px] font-semibold">Payments</h2>
              {!doc.payments.length ? <p className="text-[12.5px] text-muted">No payments recorded yet.</p> : (
                <ul className="divide-y divide-line text-sm">{doc.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span><span className="tabular-nums">{money(p.amountCents, doc.currency)}</span><span className="block text-[12px] text-muted">{p.paidOn}, {p.method}{p.reference ? `, ${p.reference}` : ""}</span></span>
                    {m && doc.status !== "void" && <Button size="icon" variant="ghost" aria-label={`Remove payment of ${money(p.amountCents, doc.currency)}`} onClick={() => delPay.mutate(p.id)}><IconTrash className="h-4 w-4" /></Button>}
                  </li>
                ))}</ul>
              )}
            </Card>
          )}
          {doc.related.length > 0 && <Card className="p-4"><h2 className="mb-2 text-[13px] font-semibold">Credit notes</h2><ul className="text-sm">{doc.related.map((r) => <li key={r.id} className="flex justify-between gap-2 py-1"><Link to={`${BASE}/${r.id}`} className="text-fg underline underline-offset-2 hover:no-underline">{r.number ?? "Draft"}</Link><span className="tabular-nums">{money(r.totalCents, doc.currency)}</span></li>)}</ul></Card>}
        </aside>
      </div>
      {dialog === "send" && <SendDialog doc={doc} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "pay" && <PayDialog doc={doc} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "void" && <VoidDialog doc={doc} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "repeat" && <RepeatDialog doc={doc} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

/** The document as the customer sees it (also the logged out view). */
export function DocPaper({ doc, seller }: { doc: Pick<DocFull, "title" | "number" | "issueDate" | "dueDate" | "kind" | "buyerName" | "buyerAbn" | "buyerAddress" | "reference" | "priceMode" | "gstRegistered" | "currency" | "notes" | "terms"> & { lines: Pick<Line, "description" | "quantityMilli" | "unitCents" | "gstFree" | "gstCents" | "netCents" | "totalCents">[]; sourceNumber?: string | null; source?: { number: string | null } | null }; seller?: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="h-1.5 bg-brand" aria-hidden />
      <div className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">{seller}</div>
          <div className="text-right"><p className="text-lg font-semibold text-fg">{doc.title}</p><p className="text-sm font-medium">{doc.number}</p></div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
          <div><dt className="text-muted">Issue date</dt><dd>{doc.issueDate}</dd></div>
          {doc.dueDate && <div><dt className="text-muted">{doc.kind === "quote" ? "Valid until" : "Due date"}</dt><dd>{doc.dueDate}</dd></div>}
          {doc.reference && <div><dt className="text-muted">Reference</dt><dd className="break-words">{doc.reference}</dd></div>}
          {(doc.sourceNumber ?? doc.source?.number) && <div><dt className="text-muted">{doc.kind === "credit_note" ? "Adjusts" : "From"}</dt><dd>{doc.sourceNumber ?? doc.source?.number}</dd></div>}
        </dl>
        <div className="mt-4 text-sm">
          <p className="text-[12px] font-medium text-muted">{doc.kind === "bill" ? "From" : "Bill to"}</p>
          <p className="break-words font-medium">{doc.buyerName || "No name"}</p>
          {doc.buyerAbn && <p className="text-[13px] text-muted">ABN {formatAbn(doc.buyerAbn)}</p>}
          {doc.buyerAddress && <p className="whitespace-pre-line break-words text-[13px] text-muted">{doc.buyerAddress}</p>}
        </div>
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Lines">
          <table className="w-full min-w-[30rem] text-sm">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted"><th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Qty</th><th className="py-2 text-right font-medium">Price</th>{doc.gstRegistered && <th className="py-2 text-right font-medium">GST</th>}<th className="py-2 text-right font-medium">Amount</th></tr></thead>
            <tbody>{doc.lines.map((l, i) => (
              <tr key={i} className="border-b border-line align-top">
                <td className="whitespace-pre-line break-words py-2 pr-2">{l.description}</td>
                <td className="py-2 text-right tabular-nums">{qtyText(l.quantityMilli)}</td>
                <td className="py-2 text-right tabular-nums">{centsText(l.unitCents)}</td>
                {doc.gstRegistered && <td className="py-2 text-right tabular-nums">{l.gstFree ? <span className="text-[12px] text-muted">GST free</span> : centsText(l.gstCents)}</td>}
                <td className="py-2 text-right tabular-nums">{centsText(doc.priceMode === "inclusive" ? l.totalCents : l.netCents)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {doc.notes && <div className="mt-4 text-sm"><p className="text-[12px] font-medium text-muted">Notes</p><p className="whitespace-pre-line break-words">{doc.notes}</p></div>}
        {doc.terms && <div className="mt-3 text-sm"><p className="text-[12px] font-medium text-muted">Terms</p><p className="whitespace-pre-line break-words">{doc.terms}</p></div>}
      </div>
    </Card>
  );
}

function SendDialog({ doc, onClose, onDone }: { doc: DocFull; onClose: () => void; onDone: (r: { doc: DocFull }) => void }) {
  const [to, setTo] = useState(doc.buyerEmail ?? "");
  const [message, setMessage] = useState("");
  const bad = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());
  const send = useMutation({
    mutationFn: () => api.post<{ doc: DocFull; to: string }>(`/invoices/docs/${doc.id}/send`, { to: to.trim(), message: message.trim() || null }),
    onSuccess: (r) => { onDone(r); toast.success(`Sent to ${r.to}`); onClose(); }, onError: showError,
  });
  return (
    <Dialog open onClose={onClose} title={`Send ${doc.title.toLowerCase()} ${doc.number}`} description="Your customer gets an email with a link to view it and download the PDF."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => send.mutate()} disabled={bad || send.isPending}><IconSend className="h-4 w-4" />Send</Button></>}>
      <div className="space-y-3">
        <Field label="To" error={to && bad ? "Check this email address." : undefined}>{(p) => <Input {...p} type="email" value={to} maxLength={254} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Message" hint="Optional. A short default message is used if you leave this empty.">{(p) => <Textarea {...p} rows={3} value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
function PayDialog({ doc, onClose, onDone }: { doc: DocFull; onClose: () => void; onDone: (r: { doc: DocFull }) => void }) {
  const [amount, setAmount] = useState(centsText(doc.owingCents));
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>("bank");
  const [reference, setReference] = useState("");
  const cents = parseMoney(amount);
  const tooMuch = cents !== null && cents > doc.owingCents;
  const pay = useMutation({
    mutationFn: () => api.post<{ doc: DocFull }>(`/invoices/docs/${doc.id}/payments`, { amountCents: cents, paidOn, method, reference: reference.trim() || null }),
    onSuccess: (r) => { onDone(r); toast.success(r.doc.owingCents === 0 ? "Paid in full" : "Payment recorded"); onClose(); }, onError: showError,
  });
  return (
    <Dialog open onClose={onClose} title="Record a payment" description={`Amount owing ${money(doc.owingCents, doc.currency)}. This only records money you already received; nothing is charged.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => pay.mutate()} disabled={cents === null || cents <= 0 || tooMuch || !paidOn || pay.isPending}>Record payment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" error={amount && cents === null ? "Enter an amount like 120 or 99.50." : tooMuch ? "That is more than the amount owing." : undefined}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Date paid">{(p) => <DateInput {...p} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
        <Field label="Method">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value)}>{PAYMENT_METHODS.map((x) => <option key={x} value={x}>{({ bank: "Bank transfer", card: "Card", cash: "Cash", cheque: "Cheque", other: "Other" } as Record<string, string>)[x]}</option>)}</Select>}</Field>
        <Field label="Reference" hint="Optional">{(p) => <Input {...p} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
function VoidDialog({ doc, onClose, onDone }: { doc: DocFull; onClose: () => void; onDone: (r: { doc: DocFull }) => void }) {
  const [reason, setReason] = useState("");
  const v = useMutation({ mutationFn: () => api.post<{ doc: DocFull }>(`/invoices/docs/${doc.id}/void`, { reason: reason.trim() }), onSuccess: (r) => { onDone(r); toast.success(`${doc.number} is void`); onClose(); }, onError: showError });
  return (
    <Dialog open onClose={onClose} title={`Void ${doc.number}?`} description="A void document stays in your records with its number, so numbering has no gaps. This cannot be undone."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => v.mutate()} disabled={v.isPending}>Void</Button></>}>
      <Field label="Reason" hint="Optional">{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}
function RepeatDialog({ doc, onClose, onDone }: { doc: DocFull; onClose: () => void; onDone: (r: { doc: DocFull }) => void }) {
  const [every, setEvery] = useState(doc.repeat?.every ?? "month");
  const [start, setStart] = useState(doc.repeat?.active ? doc.repeat.nextRun : "");
  const [end, setEnd] = useState(doc.repeat?.endDate ?? "");
  const [autoSend, setAutoSend] = useState(doc.repeat?.autoSend ?? false);
  const save = useMutation({
    mutationFn: (off: boolean) => api.put<{ doc: DocFull }>(`/invoices/docs/${doc.id}/repeat`, off ? null : { every, ...(start ? { startDate: start } : {}), endDate: end || null, autoSend }),
    onSuccess: (r, off) => { onDone(r); toast.success(off ? "Repeat stopped" : "Repeat saved"); onClose(); }, onError: showError,
  });
  return (
    <Dialog open onClose={onClose} title="Repeat this invoice" description="A new invoice with the same lines is made on each date. Each one gets its own number."
      footer={<>{doc.repeat?.active && <Button variant="ghost" className="mr-auto" onClick={() => save.mutate(true)}>Stop repeating</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate(false)} disabled={save.isPending}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Every">{(p) => <Select {...p} value={every} onChange={(e) => setEvery(e.target.value)}>{[["week", "Week"], ["fortnight", "Fortnight"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
        <Field label="Next invoice on" hint="One period after this one if left empty">{(p) => <DateInput {...p} value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
        <Field label="Stop after" hint="Optional">{(p) => <DateInput {...p} value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
        <div className="flex items-end pb-2"><Switch checked={autoSend} onChange={setAutoSend} label="Email it to the customer" /></div>
      </div>
    </Dialog>
  );
}
