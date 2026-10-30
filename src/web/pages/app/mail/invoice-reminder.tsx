import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import type { ComposeDraft } from "./compose";

/** Fills a reminder for an unpaid invoice into a new message. The template is free: no AI action used. */
export function InvoiceReminderDialog({ open, onClose, onCompose }: { open: boolean; onClose: () => void; onCompose: (d: Partial<ComposeDraft>) => void }) {
  const me = useMe();
  const [f, setF] = useState({ customerName: "", email: "", invoiceNumber: "", amount: "", dueDate: "", stage: "", paymentDetails: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const make = useMutation({
    mutationFn: () => api.post<{ subject: string; text: string }>("/ai/invoice-chase", {
      customerName: f.customerName, invoiceNumber: f.invoiceNumber, amount: Number(f.amount.replace(/[^0-9.]/g, "")), dueDate: f.dueDate,
      businessName: me.data?.organization?.name ?? "Our team", senderName: me.data?.user.name, ...(f.stage ? { stage: f.stage } : {}), ...(f.paymentDetails.trim() ? { paymentDetails: f.paymentDetails } : {}),
    }),
    onSuccess: (r) => { onCompose({ to: f.email, subject: r.subject, text: r.text }); onClose(); },
  });
  const xero = useQuery({ queryKey: ["integrations"], queryFn: async () => (await api.get<{ xero: { connected: boolean } }>("/integrations")).xero, enabled: open });
  const invoices = useQuery({
    queryKey: ["xero-invoices"], enabled: open && !!xero.data?.connected,
    queryFn: async () => (await api.get<{ invoices: { invoiceNumber: string; customerName: string; email: string | null; amount: number; dueDate: string }[] }>("/integrations/xero/invoices")).invoices,
  });
  const pick = (n: string) => {
    const i = invoices.data?.find((x) => x.invoiceNumber === n);
    if (i) setF({ ...f, customerName: i.customerName, email: i.email ?? "", invoiceNumber: i.invoiceNumber, amount: String(i.amount), dueDate: i.dueDate });
  };
  const ready = f.customerName && f.invoiceNumber && Number(f.amount.replace(/[^0-9.]/g, "")) > 0 && f.dueDate;
  return (
    <Dialog open={open} onClose={onClose} title="Chase an unpaid invoice" description="We write the reminder; you check it and send. It gets firmer the longer the invoice is overdue."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={make.isPending} onClick={() => make.mutate()}>Write reminder</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) make.mutate(); }}>
        {!!invoices.data?.length && (
          <Field label="Unpaid in Xero">{(p) => <Select {...p} defaultValue="" onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>Pick an invoice</option>
            {invoices.data.map((i) => <option key={i.invoiceNumber} value={i.invoiceNumber}>{i.invoiceNumber}, {i.customerName}, A${i.amount.toFixed(2)}, due {i.dueDate}</option>)}
          </Select>}</Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name">{(p) => <Input {...p} autoFocus value={f.customerName} onChange={set("customerName")} placeholder="Tom Nguyen" />}</Field>
          <Field label="Their email">{(p) => <Input {...p} type="email" value={f.email} onChange={set("email")} placeholder="tom@example.com.au" />}</Field>
          <Field label="Invoice number">{(p) => <Input {...p} value={f.invoiceNumber} onChange={set("invoiceNumber")} placeholder="INV-1042" />}</Field>
          <Field label="Amount (A$)">{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="1,850.00" />}</Field>
          <Field label="Due date">{(p) => <Input {...p} type="date" value={f.dueDate} onChange={set("dueDate")} />}</Field>
          <Field label="Tone">{(p) => <Select {...p} value={f.stage} onChange={set("stage")}>
            <option value="">Based on how overdue it is</option><option value="friendly">Friendly reminder</option><option value="firm">Firm</option><option value="final">Final notice</option>
          </Select>}</Field>
        </div>
        <Field label="How to pay (optional)" hint="BSB and account, or a payment link." error={make.error instanceof ApiError ? make.error.message : undefined}>
          {(p) => <Textarea {...p} rows={2} value={f.paymentDetails} onChange={set("paymentDetails")} placeholder="BSB 062-000, account 1234 5678" />}
        </Field>
      </form>
    </Dialog>
  );
}
