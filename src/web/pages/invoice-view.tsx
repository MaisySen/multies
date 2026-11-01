/**
 * R105: the buyer's logged out view of one issued invoice, quote or credit note (/i/:token): the document, Download PDF,
 * bank details to pay, and Accept or Decline on a quote. Shows that one document only.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/web/components/ui/button";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { IconCheck, IconDownload, IconReceipt } from "@/web/components/ui/icon";
import { formatAbn, money } from "@/shared/invoices";
import { DocPaper } from "./app/work/invoices-r105";

interface PublicDoc {
  kind: "invoice" | "quote" | "credit_note"; title: string; number: string | null; status: string; state: string; issueDate: string | null; dueDate: string | null; currency: string;
  priceMode: "exclusive" | "inclusive"; gstRegistered: boolean; buyerName: string | null; buyerAbn: string | null; buyerAddress: string | null; reference: string | null;
  notes: string | null; terms: string | null; subtotalCents: number; gstCents: number; totalCents: number; paidCents: number; creditedCents: number; owingCents: number;
  sourceNumber: string | null; voided: boolean;
  lines: { description: string; quantityMilli: number; unitCents: number; gstFree: boolean; netCents: number; gstCents: number; totalCents: number }[];
  seller: { name: string; abn: string | null; address: string | null; email: string | null; phone: string | null; footer: string | null };
  pay: { bankName: string | null; accountName: string | null; bsb: string | null; accountNumber: string | null; note: string | null } | null;
}

export function InvoiceViewPage() {
  const { token = "" } = useParams();
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/invoice-view/${encodeURIComponent(token)}`);
      const j = (await r.json().catch(() => ({}))) as { doc?: PublicDoc; error?: { message?: string } };
      if (!r.ok || !j.doc) { setErr(r.status === 404 ? "This link is not valid. Ask the sender for a new one." : "This page could not load. Try again in a moment."); return; }
      setDoc(j.doc);
    } catch { setErr("This page could not load. Check your connection and try again."); }
  };
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (doc) document.title = `${doc.title} ${doc.number ?? ""} from ${doc.seller.name || "your supplier"}`; }, [doc]);
  const answer = async (a: "accepted" | "declined") => {
    setBusy(true);
    try {
      const r = await fetch(`/api/invoice-view/${encodeURIComponent(token)}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: a }) });
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!r.ok) setErr(j.error?.message ?? "That did not work. Try again.");
      await load();
    } finally { setBusy(false); }
  };
  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-fg sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        {!doc && !err && <div aria-busy="true"><Skeleton className="mb-4 h-8 w-56" /><Skeleton className="h-96 w-full rounded-xl" /></div>}
        {err && !doc && (
          <Card className="p-8 text-center" role="alert">
            <IconReceipt className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden />
            <p className="text-sm">{err}</p>
            {!err.startsWith("This link") && <Button className="mt-4" variant="secondary" onClick={() => void load()}>Try again</Button>}
          </Card>
        )}
        {doc && (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold">{doc.title} {doc.number}</h1>
              <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm hover:bg-elevated" href={`/api/invoice-view/${encodeURIComponent(token)}/pdf?download=1`}><IconDownload className="h-4 w-4" />Download PDF</a>
            </div>
            {err && <p className="mb-3 rounded-lg border border-line bg-surface p-3 text-sm" role="alert">{err}</p>}
            {doc.voided && <p className="mb-3 rounded-lg border border-line bg-surface p-3 text-sm" role="status">This document has been cancelled by the sender. Nothing is owed on it.</p>}
            {doc.kind === "quote" && !doc.voided && (
              <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
                {doc.status === "issued" ? <>
                  <p className="min-w-0 flex-1 text-sm">Happy with this quote{doc.dueDate ? ` (valid until ${doc.dueDate})` : ""}?</p>
                  <Button variant="secondary" disabled={busy} onClick={() => void answer("declined")}>Decline</Button>
                  <Button disabled={busy} onClick={() => void answer("accepted")}><IconCheck className="h-4 w-4" />Accept quote</Button>
                </> : <p className="text-sm" role="status">{doc.status === "accepted" ? "You accepted this quote. Thank you." : doc.status === "declined" ? "You declined this quote." : "This quote is closed."}</p>}
              </Card>
            )}
            <DocPaper doc={doc} seller={<div className="text-sm"><p className="break-words text-base font-semibold">{doc.seller.name}</p>{doc.seller.abn && <p className="text-muted">ABN {formatAbn(doc.seller.abn)}</p>}{doc.seller.address && <p className="whitespace-pre-line break-words text-muted">{doc.seller.address}</p>}{doc.seller.email && <p className="break-words text-muted">{doc.seller.email}</p>}{doc.seller.phone && <p className="text-muted">{doc.seller.phone}</p>}</div>} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {doc.kind === "invoice" && doc.pay && !doc.voided && doc.owingCents > 0 ? (
                <Card className="p-4">
                  <h2 className="mb-2 text-sm font-semibold">How to pay</h2>
                  <dl className="space-y-1 text-sm">
                    {doc.pay.accountName && <div className="flex justify-between gap-2"><dt className="text-muted">Account name</dt><dd className="break-words text-right">{doc.pay.accountName}</dd></div>}
                    {doc.pay.bankName && <div className="flex justify-between gap-2"><dt className="text-muted">Bank</dt><dd className="text-right">{doc.pay.bankName}</dd></div>}
                    {doc.pay.bsb && <div className="flex justify-between gap-2"><dt className="text-muted">BSB</dt><dd className="tabular-nums">{doc.pay.bsb}</dd></div>}
                    {doc.pay.accountNumber && <div className="flex justify-between gap-2"><dt className="text-muted">Account number</dt><dd className="tabular-nums">{doc.pay.accountNumber}</dd></div>}
                    {doc.number && <div className="flex justify-between gap-2"><dt className="text-muted">Reference</dt><dd>{doc.number}</dd></div>}
                  </dl>
                  {doc.pay.note && <p className="mt-2 whitespace-pre-line text-[13px] text-muted">{doc.pay.note}</p>}
                </Card>
              ) : <div />}
              <Card className="p-4">
                <dl className="text-sm">
                  <div className="flex justify-between py-1"><dt>{doc.gstRegistered ? "Subtotal excluding GST" : "Subtotal"}</dt><dd className="tabular-nums">{money(doc.subtotalCents, doc.currency)}</dd></div>
                  {doc.gstRegistered && <div className="flex justify-between py-1"><dt>GST</dt><dd className="tabular-nums">{money(doc.gstCents, doc.currency)}</dd></div>}
                  <div className="flex justify-between py-1 font-semibold"><dt>{doc.gstRegistered ? "Total including GST" : "Total"}</dt><dd className="tabular-nums">{money(doc.totalCents, doc.currency)}</dd></div>
                  {doc.kind === "invoice" && <>
                    {doc.paidCents > 0 && <div className="flex justify-between py-1"><dt>Paid</dt><dd className="tabular-nums">{money(-doc.paidCents, doc.currency)}</dd></div>}
                    {doc.creditedCents > 0 && <div className="flex justify-between py-1"><dt>Credited</dt><dd className="tabular-nums">{money(-doc.creditedCents, doc.currency)}</dd></div>}
                    <div className="flex justify-between py-1 font-semibold"><dt>Amount owing</dt><dd className="tabular-nums">{money(doc.voided ? 0 : doc.owingCents, doc.currency)}</dd></div>
                  </>}
                </dl>
              </Card>
            </div>
            {doc.seller.footer && <p className="mt-6 text-center text-[12px] text-muted">{doc.seller.footer}</p>}
          </>
        )}
      </div>
    </main>
  );
}
