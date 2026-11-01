/**
 * R105: what leaves the app for an invoice or quote: the branded PDF (pdf-lib, the workspace brand colour), the email with
 * its view link, the logged out view, and the cron pass (repeating invoices, reminders before and after the due date).
 * Nothing is ever charged: payment is by bank transfer to the workspace's own account (BSB and account) and recorded by hand.
 * On the test site (CAMPAIGN_SEND_ALLOW set) emails only go to the allowed QA mailbox.
 */
import type { Deps } from "../../context";
import { HttpError } from "../../lib/errors";
import { sendSystemEmail } from "../system-mail";
import { getBrand } from "../../routes/branding";
import { allowedBy } from "@/shared/campaigns-r109";
import { centsText, formatAbn, formatBsb, money, qtyText } from "@/shared/invoices";
import { assertAdmin, docDetail, dueReminders, findByToken, getSettings, noteReminder, noteSent, runRepeats, type Actor } from "./invoices";
import { invoiceDocs, invoiceRepeats } from "../../db/schema";
import { eq } from "drizzle-orm";

type Found = NonNullable<Awaited<ReturnType<typeof findByToken>>>;

export function viewUrl(deps: Deps, token: string) { return `${deps.config.appUrl.replace(/\/$/, "")}/i/${token}`; }

/** The public view of one issued document: only what the buyer needs, never ids of other records. */
export function publicView(f: Found) {
  const d = f.doc, s = f.settings;
  return {
    kind: d.kind, title: d.title, number: d.number, status: d.status, state: d.state, issueDate: d.issueDate, dueDate: d.dueDate, currency: d.currency,
    priceMode: d.priceMode, gstRegistered: d.gstRegistered, buyerName: d.buyerName, buyerAbn: d.buyerAbn ? formatAbn(d.buyerAbn) : null, buyerAddress: d.buyerAddress,
    reference: d.reference, notes: d.notes, terms: d.terms, subtotalCents: d.subtotalCents, gstCents: d.gstCents, totalCents: d.totalCents, paidCents: d.paidCents,
    creditedCents: d.creditedCents, owingCents: d.owingCents, sourceNumber: f.sourceNumber, voided: d.status === "void",
    lines: f.lines.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli, unitCents: l.unitCents, gstFree: l.gstFree, netCents: l.netCents, gstCents: l.gstCents, totalCents: l.totalCents })),
    seller: { name: s.businessName, abn: s.abn ? formatAbn(s.abn) : null, address: s.address, email: s.email, phone: s.phone, footer: s.footer },
    pay: d.kind === "invoice" && (s.bsb || s.accountNumber || s.payNote) ? { bankName: s.bankName, accountName: s.accountName || s.businessName, bsb: s.bsb ? formatBsb(s.bsb) : null, accountNumber: s.accountNumber, note: s.payNote } : null,
  };
}
export type PublicInvoice = ReturnType<typeof publicView>;

// ---------- PDF ----------
/** Helvetica in a PDF only carries Latin 1: anything else becomes a plain stand in so the file always builds. */
export function pdfSafe(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .split("").map((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? ch : "?"; }).join("");
}
function hexRgb(hex: string | null | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return [0.11, 0.33, 0.27];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export async function invoicePdf(v: PublicInvoice, brandHex?: string | null): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${v.title} ${v.number ?? ""}`.trim()));
  pdf.setCreator("Multies");
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [br, bg, bb] = hexRgb(brandHex);
  const brand = rgb(br, bg, bb), ink = rgb(0.1, 0.1, 0.12), soft = rgb(0.38, 0.38, 0.42), rule = rgb(0.86, 0.86, 0.88);
  const W = 595.28, H = 841.89, M = 48;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const text = (s: string, x: number, yy: number, o: { size?: number; b?: boolean; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const f = o.b ? bold : font, size = o.size ?? 10, t = pdfSafe(s);
    const xx = o.right ? x - f.widthOfTextAtSize(t, size) : x;
    page.drawText(t, { x: xx, y: yy, size, font: f, color: o.color ?? ink });
  };
  const wrap = (s: string, width: number, size = 10, f = font): string[] => {
    const out: string[] = [];
    for (const para of pdfSafe(s).split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) { // very long words break by characters
          let i = w.length; while (i > 1 && f.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
          if (line) { out.push(line); line = ""; }
          out.push(w.slice(0, i)); w = w.slice(i);
        }
        const next = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const need = (h: number) => { if (y - h < M + 30) { page = pdf.addPage([W, H]); y = H - M; } };

  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: brand });
  text(v.seller.name || "Your business", M, y - 6, { size: 16, b: true });
  text(v.title, W - M, y - 6, { size: 20, b: true, color: brand, right: true });
  y -= 26;
  const sellerLines = [v.seller.abn ? `ABN ${v.seller.abn}` : "", ...(v.seller.address ? wrap(v.seller.address, 240, 9) : []), v.seller.email ?? "", v.seller.phone ?? ""].filter(Boolean);
  const meta: [string, string][] = [["Number", v.number ?? "Draft"], ["Issue date", v.issueDate ?? ""], ...(v.dueDate ? [[v.kind === "quote" ? "Valid until" : "Due date", v.dueDate] as [string, string]] : []),
    ...(v.reference ? [["Reference", v.reference] as [string, string]] : []), ...(v.sourceNumber ? [[v.kind === "credit_note" ? "Adjusts" : "From", v.sourceNumber] as [string, string]] : [])];
  let ly = y, ry = y;
  for (const l of sellerLines) { text(l, M, ly, { size: 9, color: soft }); ly -= 12; }
  for (const [k, val] of meta) { text(k, W - M - 150, ry, { size: 9, color: soft }); text(val, W - M, ry, { size: 9, b: true, right: true }); ry -= 12; }
  y = Math.min(ly, ry) - 14;
  if (v.voided) { text("VOID", W - M, y, { size: 14, b: true, color: rgb(0.7, 0.1, 0.1), right: true }); }
  text(v.kind === "bill" ? "From" : "Bill to", M, y, { size: 9, b: true, color: soft }); y -= 13;
  for (const l of [v.buyerName ?? "", v.buyerAbn ? `ABN ${v.buyerAbn}` : "", ...(v.buyerAddress ? wrap(v.buyerAddress, 260, 9) : [])].filter(Boolean)) { text(l, M, y, { size: 10 }); y -= 13; }
  y -= 12;

  const cols = { desc: M, qty: 340, price: 410, gst: 470, amt: W - M };
  const head = () => {
    page.drawRectangle({ x: M - 6, y: y - 5, width: W - 2 * M + 12, height: 18, color: rgb(0.95, 0.95, 0.96) });
    text("Description", cols.desc, y, { size: 9, b: true }); text("Qty", cols.qty, y, { size: 9, b: true, right: true });
    text("Price", cols.price + 40, y, { size: 9, b: true, right: true }); text("GST", cols.gst + 40, y, { size: 9, b: true, right: true });
    text("Amount", cols.amt, y, { size: 9, b: true, right: true }); y -= 20;
  };
  head();
  for (const l of v.lines) {
    const rows = wrap(l.description || " ", 270, 10);
    need(rows.length * 12 + 6);
    if (y === H - M) head();
    text(qtyText(l.quantityMilli), cols.qty, y, { right: true });
    text(centsText(l.unitCents), cols.price + 40, y, { right: true });
    text(l.gstFree ? "GST free" : centsText(l.gstCents), cols.gst + 40, y, { right: true, size: l.gstFree ? 8 : 10, color: l.gstFree ? soft : ink });
    text(centsText(v.priceMode === "inclusive" ? l.totalCents : l.netCents), cols.amt, y, { right: true });
    for (const r of rows) { text(r, cols.desc, y); y -= 12; }
    y -= 4;
    page.drawLine({ start: { x: M - 6, y: y + 6 }, end: { x: W - M + 6, y: y + 6 }, thickness: 0.5, color: rule });
  }
  need(110);
  y -= 6;
  const sums: [string, number, boolean][] = [
    [v.gstRegistered ? "Subtotal excluding GST" : "Subtotal", v.subtotalCents, false],
    ...(v.gstRegistered ? [["GST", v.gstCents, false] as [string, number, boolean]] : []),
    [v.gstRegistered ? "Total including GST" : "Total", v.totalCents, true],
    ...(v.kind === "invoice" && v.paidCents ? [["Paid", -v.paidCents, false] as [string, number, boolean]] : []),
    ...(v.kind === "invoice" && v.creditedCents ? [["Credited", -v.creditedCents, false] as [string, number, boolean]] : []),
    ...(v.kind === "invoice" ? [["Amount owing", v.owingCents, true] as [string, number, boolean]] : []),
  ];
  for (const [k, c, b] of sums) { text(k, W - M - 110, y, { size: b ? 11 : 10, b, right: true }); text(money(c, v.currency), W - M, y, { size: b ? 11 : 10, b, right: true }); y -= b ? 16 : 13; }
  if (v.currency !== "AUD") { text(`Amounts in ${v.currency}`, W - M, y, { size: 8, color: soft, right: true }); y -= 12; }
  y -= 10;
  const block = (title: string, body: string[]) => {
    if (!body.length) return; need(14 + body.length * 12);
    text(title, M, y, { size: 9, b: true, color: soft }); y -= 13;
    for (const l of body) { text(l, M, y, { size: 9 }); y -= 12; }
    y -= 8;
  };
  if (v.pay) block("How to pay", [v.pay.accountName ? `Account name: ${v.pay.accountName}` : "", v.pay.bankName ? `Bank: ${v.pay.bankName}` : "", v.pay.bsb ? `BSB: ${v.pay.bsb}` : "",
    v.pay.accountNumber ? `Account number: ${v.pay.accountNumber}` : "", v.number ? `Reference: ${v.number}` : "", ...(v.pay.note ? wrap(v.pay.note, W - 2 * M, 9) : [])].filter(Boolean));
  if (v.notes) block("Notes", wrap(v.notes, W - 2 * M, 9));
  if (v.terms) block("Terms", wrap(v.terms, W - 2 * M, 9));
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const foot = pdfSafe(`${v.seller.footer ? `${v.seller.footer}  ·  ` : ""}${v.title} ${v.number ?? ""}  ·  Page ${i + 1} of ${pages.length}`);
    p.drawText(foot, { x: M, y: 28, size: 8, font, color: soft });
  });
  return pdf.save();
}

export async function pdfForDoc(deps: Deps, a: Actor, id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const d = await docDetail(deps, a, id);
  const s = await getSettings(deps, a.orgId);
  const brand = await getBrand(deps.db, a.orgId).catch(() => null);
  const v = publicView({ doc: d, raw: d as never, lines: d.lines, settings: s, sourceNumber: d.source?.number ?? null } as Found);
  return { bytes: await invoicePdf(v, brand?.primary ?? brand?.accent), name: fileName(d.title, d.number) };
}
export function fileName(title: string, number: string | null) { return `${title} ${number ?? "draft"}.pdf`.replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, " "); }
export async function pdfForToken(deps: Deps, token: string) {
  const f = await findByToken(deps, token);
  if (!f) return null;
  const brand = await getBrand(deps.db, f.raw.orgId).catch(() => null);
  return { bytes: await invoicePdf(publicView(f), brand?.primary ?? brand?.accent), name: fileName(f.doc.title, f.doc.number) };
}

// ---------- email ----------
export function mailAllowed(deps: Deps, to: string) { return allowedBy(deps.config.campaignSendAllow ?? [], to); }

export function docMail(v: PublicInvoice, url: string, kind: "send" | "before" | "after", message?: string | null) {
  const who = v.seller.name || "us";
  const owing = money(v.owingCents, v.currency), total = money(v.totalCents, v.currency);
  const name = v.buyerName ? `Hi ${v.buyerName},` : "Hi,";
  const what = `${v.title.toLowerCase()} ${v.number ?? ""}`.trim();
  const subject = kind === "send" ? `${v.title} ${v.number ?? ""} from ${who}`.replace(/\s+/g, " ")
    : kind === "before" ? `Reminder: ${what} is due on ${v.dueDate}` : `Overdue: ${what} was due on ${v.dueDate}`;
  const body = kind === "send"
    ? (message?.trim() || (v.kind === "quote" ? `Here is our quote for ${total}${v.dueDate ? `, valid until ${v.dueDate}` : ""}. You can accept or decline it online.`
      : v.kind === "credit_note" ? `Here is an adjustment note for ${total}${v.sourceNumber ? ` against ${v.sourceNumber}` : ""}.`
      : `Here is ${what} for ${total}${v.dueDate ? `, due on ${v.dueDate}` : ""}.`))
    : kind === "before" ? `A friendly reminder that ${what} for ${owing} is due on ${v.dueDate}.` : `Our records show ${what} for ${owing} is still unpaid. It was due on ${v.dueDate}. If you have already paid, thank you and please ignore this email.`;
  const pay = v.pay && v.kind === "invoice" ? `\n\nTo pay by bank transfer: ${[v.pay.accountName && `account name ${v.pay.accountName}`, v.pay.bsb && `BSB ${v.pay.bsb}`, v.pay.accountNumber && `account ${v.pay.accountNumber}`].filter(Boolean).join(", ")}, reference ${v.number}.` : "";
  const label = v.kind === "quote" ? "View quote" : v.kind === "credit_note" ? "View adjustment note" : "View invoice";
  const sign = `\n\n${who}${v.seller.email ? `\n${v.seller.email}` : ""}`;
  return { subject, text: `${name}\n\n${body}${pay}${sign}`, action: { label, url } };
}

export async function sendDoc(deps: Deps, a: Actor, id: string, input: { to?: string | null; message?: string | null }) {
  assertAdmin(a);
  const d = await docDetail(deps, a, id);
  if (d.kind === "bill") throw new HttpError(409, "bill", "Bills are documents you received, so there is nothing to send.");
  if (d.status === "draft") throw new HttpError(409, "draft", "Issue it first, then send it.");
  if (d.status === "void") throw new HttpError(409, "void", "This document is void, so it cannot be sent.");
  const to = (input.to ?? d.buyerEmail ?? "").trim().toLowerCase();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(422, "no_email", "Add the customer's email address first.");
  if (!mailAllowed(deps, to)) throw new HttpError(422, "test_site", "On this test site, emails only go to the QA mailbox.");
  const token = (await deps.db.select({ t: invoiceDocs.viewToken }).from(invoiceDocs).where(eq(invoiceDocs.id, id)).get())?.t;
  if (!token) throw new HttpError(409, "no_link", "This document has no view link.");
  const f = await findByToken(deps, token);
  if (!f) throw new HttpError(409, "no_link", "This document has no view link.");
  const m = docMail(publicView(f), viewUrl(deps, token), "send", input.message);
  const r = await sendSystemEmail(deps, { to, subject: m.subject, text: m.text, action: m.action, orgId: a.orgId });
  if (!r.delivered) throw new HttpError(502, "not_sent", "The email could not be sent right now. Copy the link and share it instead, or try again.");
  await noteSent(deps, id);
  if (!d.buyerEmail) await deps.db.update(invoiceDocs).set({ buyerEmail: to }).where(eq(invoiceDocs.id, id));
  return { sent: true, to, doc: await docDetail(deps, a, id) };
}

/** Cron: repeating invoices first (sent on when the repeat says so), then reminders. Bounded; mail only where allowed. */
export async function runInvoiceCron(deps: Deps) {
  const made = await runRepeats(deps);
  let sent = 0, reminded = 0;
  for (const id of made.ids) {
    const d = await deps.db.select().from(invoiceDocs).where(eq(invoiceDocs.id, id)).get();
    if (!d || d.status !== "issued" || !d.repeatId || !d.buyerEmail || !d.viewToken) continue;
    const r = await deps.db.select({ autoSend: invoiceRepeats.autoSend }).from(invoiceRepeats).where(eq(invoiceRepeats.id, d.repeatId)).get();
    if (!r?.autoSend || !mailAllowed(deps, d.buyerEmail)) continue;
    const f = await findByToken(deps, d.viewToken);
    if (!f) continue;
    const m = docMail(publicView(f), viewUrl(deps, d.viewToken), "send");
    const res = await sendSystemEmail(deps, { to: d.buyerEmail, subject: m.subject, text: m.text, action: m.action, orgId: d.orgId }).catch(() => null);
    if (res?.delivered) { await noteSent(deps, id); sent++; }
  }
  for (const due of await dueReminders(deps)) {
    const d = await deps.db.select().from(invoiceDocs).where(eq(invoiceDocs.id, due.id)).get();
    if (!d?.viewToken || !d.buyerEmail) continue;
    await noteReminder(deps, d.id); // noted first so a failure never repeats the same reminder in a loop
    if (!mailAllowed(deps, d.buyerEmail)) continue;
    const f = await findByToken(deps, d.viewToken);
    if (!f) continue;
    const m = docMail(publicView(f), viewUrl(deps, d.viewToken), due.when);
    const res = await sendSystemEmail(deps, { to: d.buyerEmail, subject: m.subject, text: m.text, action: m.action, orgId: d.orgId }).catch(() => null);
    if (res?.delivered) reminded++;
  }
  return { made: made.made, sent, reminded };
}

