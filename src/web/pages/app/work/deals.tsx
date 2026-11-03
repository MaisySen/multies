import { useEffect, useState } from "react";
import { useCommandHandlers } from "@/web/lib/commands"; // TD10
import { useCrmTd10On } from "./crm-suggestions-td10"; // TD10
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { IconArrowLeft, IconGrip, IconHandshake, IconPlus, IconReceipt } from "@/web/components/ui/icon";
import { useInvoicesOn } from "./invoices-r105"; // R105
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { aud } from "./contacts";
import type { Contact } from "./data";
import { useCrmTimelineOn } from "./crm-timeline"; // R94
import { CloseReasonDialog, DealDetailsDialog, ForecastStrip } from "./crm-contacts-r94"; // R94
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-contacts"; // R104B

interface Stage { id: string; name: string; total: number }
interface Deal { id: string; title: string; stage: string; value: number; position: number; contact: Contact | null; company: { id: string; name: string } | null; expectedClose: string | null; probability?: number; probabilitySet?: boolean; closeReason?: string | null }

function DealCard({ d, crm, onOpen }: { d: Deal; crm?: boolean; onOpen?: (d: Deal) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: d.id });
  return (
    <li ref={setNodeRef} {...listeners} style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn("touch-none rounded-lg border border-line bg-elevated p-3", isDragging && "z-10 border-brand/40 shadow-pop")} data-testid="deal-card">
      <div className="flex items-start gap-2">
        {crm && onOpen ? <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpen(d)} className="flex-1 text-left text-[13.5px] font-medium hover:underline" data-testid="deal-open">{d.title}</button> : <div className="flex-1 text-[13.5px] font-medium">{d.title}</div>}
        <button type="button" {...attributes} {...listeners} aria-roledescription="Draggable deal" aria-label={tr("contacts.move_title", { title: d.title })}
          className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-subtle hover:bg-surface hover:text-fg"><IconGrip className="h-3.5 w-3.5" aria-hidden /></button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[12px] text-muted">
        <span className="truncate">{d.company?.name ?? d.contact?.name ?? d.contact?.email ?? ""}</span>
        <span className="font-medium tabular-nums text-fg">{aud(d.value)}</span>
      </div>
      {crm && d.stage !== "won" && d.stage !== "lost" && d.probability !== undefined && <div className="mt-1 text-[12px] text-subtle" data-testid="deal-chance">{d.probability}{tr("contacts.chance")}{d.expectedClose ? ` · closes ${new Date(d.expectedClose).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}</div>}
      {crm && d.closeReason && <div className="mt-1 truncate text-[12px] text-subtle">{tr("contacts.why")} {d.closeReason}</div>}
      {d.contact && <Link to={`/app/contacts/${d.contact.id}`} onPointerDown={(e) => e.stopPropagation()} className="mt-1 block min-h-6 truncate py-1 text-[12px] text-subtle hover:text-fg">{d.contact.email}</Link>}
    </li>
  );
}

function StageColumn({ s, deals, crm, onOpen }: { s: Stage; deals: Deal[]; crm?: boolean; onOpen?: (d: Deal) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: s.id });
  return (
    <section aria-label={s.name} className={cn("flex w-[260px] shrink-0 flex-col rounded-xl border border-line bg-surface/70", isOver && "border-brand/40")}>
      <header className="px-3 py-2.5">
        <div className="flex items-center gap-2"><h2 className="text-[13px] font-semibold">{s.name}</h2><span className="text-[12px] text-subtle">{deals.length}</span></div>
        <div className="text-[12px] tabular-nums text-muted">{aud(s.total)}</div>
      </header>
      <ul ref={setNodeRef} className="flex min-h-[80px] flex-1 flex-col gap-2 px-2 pb-3">{deals.map((d) => <DealCard key={d.id} d={d} crm={crm} onOpen={onOpen} />)}</ul>
    </section>
  );
}

/** A simple pipeline: drag a deal to change its stage. Values in AUD, ex GST. */
export function DealsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["deals"], queryFn: () => api.get<{ stages: Stage[]; deals: Deal[] }>("/deals") });
  const [adding, setAdding] = useState(false);
  useCommandHandlers({ "crm-new": () => { setAdding(true); } }, useCrmTd10On()); // TD10: N adds a deal
  const invoicesOn = useInvoicesOn(); // R105
  const crm = useCrmTimelineOn(); // R94
  const [asking, setAsking] = useState<{ deal: Deal; stage: "won" | "lost" } | null>(null);
  const [openDeal, setOpenDeal] = useState<Deal | null>(null);
  // TD5: a mention links to /app/deals?deal=<id>; open that deal once the board is in.
  const [dealParams] = useSearchParams();
  const linkedDeal = dealParams.get("deal");
  useEffect(() => { if (linkedDeal && q.data) { const d = q.data.deals.find((x) => x.id === linkedDeal); if (d) setOpenDeal(d); } }, [linkedDeal, q.data]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || !q.data) return;
    const d = q.data.deals.find((x) => x.id === e.active.id);
    if (!d || d.stage === e.over.id) return;
    qc.setQueryData(["deals"], { ...q.data, deals: q.data.deals.map((x) => (x.id === d.id ? { ...x, stage: String(e.over!.id) } : x)) });
    try { await api.patch(`/deals/${d.id}`, { stage: e.over.id }); } catch (err) { showError(err as Error); }
    void qc.invalidateQueries({ queryKey: ["deals"] });
    if (crm.on) {
      void qc.invalidateQueries({ queryKey: ["crm-forecast"] });
      if (e.over.id === "won" || e.over.id === "lost") setAsking({ deal: d, stage: e.over.id });
    }
  };
  const saveReason = async (reason: string | null) => {
    const a = asking;
    setAsking(null);
    if (!a || !reason) return;
    try { await api.patch(`/deals/${a.deal.id}`, { closeReason: reason }); await qc.invalidateQueries({ queryKey: ["deals"] }); await qc.invalidateQueries({ queryKey: ["crm-forecast"] }); } catch (err) { showError(err as Error); }
  };
  const open = q.data?.deals.filter((d) => d.stage !== "won" && d.stage !== "lost").reduce((n, d) => n + d.value, 0) ?? 0;
  return (
    <div>
      <Link to="/app/contacts" className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />{tr("nav.contacts")}</Link>
      <PageHeader title={tr("nav.deals")} description={q.data ? `${aud(open)} open in the pipeline, ex GST.` : tr("contacts.your_sales_pipeline")} actions={<>{invoicesOn && <Link to="/app/contacts/invoices" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-sm hover:bg-elevated"><IconReceipt className="h-4 w-4" />{tr("contacts.invoices")}</Link>}<Button onClick={() => setAdding(true)}><IconPlus className="h-4 w-4" />{tr("contacts.new_deal")}</Button></>} />
      {crm.on && !!q.data?.deals.length && <ForecastStrip />}
      {q.isPending ? <Skeleton className="h-64" /> : !q.data?.deals.length ? (
        <EmptyState icon={<IconHandshake />} title={tr("contacts.no_deals_yet_2")} body="Add a deal from a contact, or here. Drag deals across stages as they move." action={<Button onClick={() => setAdding(true)}>{tr("contacts.new_deal")}</Button>} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4" data-testid="deals-board">
            {q.data.stages.map((s) => <StageColumn key={s.id} s={s} deals={q.data.deals.filter((d) => d.stage === s.id)} crm={crm.on} onOpen={setOpenDeal} />)}
          </div>
        </DndContext>
      )}
      {adding && <NewDeal onClose={() => setAdding(false)} />}
      {asking && <CloseReasonDialog stage={asking.stage} title={asking.deal.title} onDone={(r) => void saveReason(r)} />}
      {openDeal && <DealDetailsDialog deal={openDeal} onClose={() => setOpenDeal(null)} />}
    </div>
  );
}

function NewDeal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const contacts = useQuery({ queryKey: ["contacts", ""], queryFn: () => api.get<{ contacts: Contact[] }>("/contacts?limit=200") });
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [contactId, setContactId] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api.post("/deals", { title, value: Number(value) || 0, contactId: contactId || null }); await qc.invalidateQueries({ queryKey: ["deals"] }); onClose(); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={tr("contacts.new_deal")} footer={<><Button variant="secondary" onClick={onClose}>{tr("common.cancel")}</Button><Button loading={busy} disabled={!title.trim()} onClick={submit}>{tr("contacts.add_deal")}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label={tr("common.name")}>{(f) => <Input {...f} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("contacts.caf_fit_out")} />}</Field>
        <Field label={tr("contacts.value_a_ex_gst")}>{(f) => <Input {...f} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="12500" />}</Field>
        <Field label={tr("site.contact")}>{(f) => <Select {...f} value={contactId} onChange={(e) => setContactId(e.target.value)}><option value="">{tr("tasks.none")}</option>{contacts.data?.contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}</Select>}</Field>
      </form>
    </Dialog>
  );
}
