/**
 * R105: invoices and quotes. Quotes convert to invoices; tax invoices, adjustment notes (credit notes) and bills received;
 * an items catalogue; manual payments; repeating invoices; suppliers; aged receivables and GST for BAS.
 * Rules live in src/shared/invoices.ts. Money is integer cents. A number is given only when a document is issued, from a
 * per workspace counter, and is never reused: an issued document can be voided, never deleted.
 * Members can view and draft; owners and admins issue, void, take payments and change settings.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { flagOrgCond, passWorkspaces } from "../console/flags"; // OPS1 security review N1
import { containsAny, containsText } from "../../lib/like-search";
import type { Deps } from "../../context";
import { contacts, invoiceDocs, invoiceItems, invoiceLines, invoicePayments, invoiceRepeats, invoiceSettings, invoiceSuppliers } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { randomToken } from "../../lib/crypto";
import { sortableId, type SuiteActor } from "../suite/common";
import {
  ATO_PROBLEM_TEXT, MAX_CENTS, MAX_LINES, addDays, ageBucket, atoProblems, abnValid, accountValid, bsbValid, cleanAbn, docNumber, docTitle, docTotals,
  gstInPayment, nextRun, payState, type AgeBucket, type DocKind, type LineInput, type PriceMode, type Repeat,
} from "@/shared/invoices";
import { releaseBilledTime } from "./bill-release-td4"; // TD4

export type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
type Doc = typeof invoiceDocs.$inferSelect;
type Settings = typeof invoiceSettings.$inferSelect;

const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";
export function assertAdmin(a: Actor) { if (!isAdmin(a)) throw new HttpError(403, "admin_only", "Only owners and admins can do this."); }
function today(deps: Deps) { return deps.now().toISOString().slice(0, 10); }
const SEQ_COL: Record<DocKind, string> = { invoice: "next_invoice", quote: "next_quote", credit_note: "next_credit_note", bill: "next_bill" };

// ---------- settings ----------
export async function getSettings(deps: Deps, orgId: string): Promise<Settings> {
  const row = await deps.db.select().from(invoiceSettings).where(eq(invoiceSettings.orgId, orgId)).get();
  if (row) return row;
  return {
    orgId, businessName: "", abn: null, gstRegistered: true, priceMode: "exclusive", currency: "AUD", termsDays: 14, address: null, email: null, phone: null,
    bankName: null, bsb: null, accountNumber: null, accountName: null, payNote: null, footer: null, prefixInvoice: null, prefixQuote: null, prefixCredit: null,
    nextInvoice: 1, nextQuote: 1, nextCreditNote: 1, nextBill: 1, remindBeforeDays: 3, remindAfterDays: 7, updatedAt: deps.now(),
  };
}
export function presentSettings(s: Settings) {
  const { nextInvoice, nextQuote, nextCreditNote, nextBill, ...rest } = s;
  return { ...rest, next: { invoice: nextInvoice, quote: nextQuote, credit_note: nextCreditNote, bill: nextBill }, ready: !!s.businessName.trim() && (!s.gstRegistered || abnValid(s.abn)) };
}
export interface SettingsPatch {
  businessName?: string; abn?: string | null; gstRegistered?: boolean; priceMode?: PriceMode; currency?: string; termsDays?: number; address?: string | null;
  email?: string | null; phone?: string | null; bankName?: string | null; bsb?: string | null; accountNumber?: string | null; accountName?: string | null;
  payNote?: string | null; footer?: string | null; prefixInvoice?: string | null; prefixQuote?: string | null; prefixCredit?: string | null;
  remindBeforeDays?: number; remindAfterDays?: number;
}
export async function saveSettings(deps: Deps, a: Actor, p: SettingsPatch) {
  assertAdmin(a);
  if (p.abn && !abnValid(p.abn)) throw new HttpError(422, "bad_abn", "That ABN does not look right. Check the 11 digits.");
  if (p.bsb && !bsbValid(p.bsb)) throw new HttpError(422, "bad_bsb", "A BSB has 6 digits.");
  if (p.accountNumber && !accountValid(p.accountNumber)) throw new HttpError(422, "bad_account", "An account number has 5 to 9 digits.");
  const cur = await getSettings(deps, a.orgId);
  const clean = { ...p, ...(p.abn !== undefined ? { abn: p.abn ? cleanAbn(p.abn) : null } : {}), ...(p.bsb !== undefined ? { bsb: p.bsb ? p.bsb.replace(/[\s-]/g, "") : null } : {}),
    ...(p.accountNumber !== undefined ? { accountNumber: p.accountNumber ? p.accountNumber.replace(/[\s-]/g, "") : null } : {}) };
  const next = { ...cur, ...clean, orgId: a.orgId, updatedAt: deps.now() };
  await deps.db.insert(invoiceSettings).values(next).onConflictDoUpdate({ target: invoiceSettings.orgId, set: { ...clean, updatedAt: deps.now() } });
  return presentSettings(await getSettings(deps, a.orgId));
}
async function takeNumber(deps: Deps, orgId: string, kind: DocKind): Promise<number> {
  await deps.db.run(sql`insert into invoice_settings (org_id, updated_at) values (${orgId}, ${deps.now().getTime()}) on conflict(org_id) do nothing`);
  const col = sql.raw(SEQ_COL[kind]);
  const r = await deps.db.get<{ n: number }>(sql`update invoice_settings set ${col} = ${col} + 1 where org_id = ${orgId} returning ${col} - 1 as n`);
  if (!r) throw new HttpError(500, "number_failed", "Could not give this document a number. Try again.");
  return r.n;
}

// ---------- items and suppliers ----------
export interface ItemInput { name: string; description?: string; unitCents: number; gstFree?: boolean }
function checkCents(n: number, what = "amount") { if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_CENTS) throw new HttpError(422, "bad_amount", `That ${what} is not a valid amount.`); }
export async function listItems(deps: Deps, orgId: string, q?: string) {
  const where = and(eq(invoiceItems.orgId, orgId), sql`${invoiceItems.archivedAt} is null`, q ? containsText(invoiceItems.name, q) : undefined);
  return deps.db.select().from(invoiceItems).where(where).orderBy(asc(invoiceItems.name)).limit(500).all();
}
export async function createItem(deps: Deps, a: Actor, i: ItemInput) {
  checkCents(i.unitCents, "price");
  const id = sortableId("itm", deps.now().getTime());
  await deps.db.insert(invoiceItems).values({ id, orgId: a.orgId, name: i.name.trim(), description: (i.description ?? "").trim(), unitCents: i.unitCents, gstFree: !!i.gstFree, createdAt: deps.now(), updatedAt: deps.now() });
  return deps.db.select().from(invoiceItems).where(eq(invoiceItems.id, id)).get();
}
export async function updateItem(deps: Deps, a: Actor, id: string, i: Partial<ItemInput> & { archived?: boolean }) {
  if (i.unitCents !== undefined) checkCents(i.unitCents, "price");
  const row = await deps.db.select().from(invoiceItems).where(and(eq(invoiceItems.id, id), eq(invoiceItems.orgId, a.orgId))).get();
  if (!row) throw notFound("Item");
  await deps.db.update(invoiceItems).set({
    ...(i.name !== undefined ? { name: i.name.trim() } : {}), ...(i.description !== undefined ? { description: i.description.trim() } : {}),
    ...(i.unitCents !== undefined ? { unitCents: i.unitCents } : {}), ...(i.gstFree !== undefined ? { gstFree: i.gstFree } : {}),
    ...(i.archived !== undefined ? { archivedAt: i.archived ? deps.now() : null } : {}), updatedAt: deps.now(),
  }).where(eq(invoiceItems.id, id));
  return deps.db.select().from(invoiceItems).where(eq(invoiceItems.id, id)).get();
}
export interface SupplierInput { name: string; abn?: string | null; email?: string | null; phone?: string | null; notes?: string }
export async function listSuppliers(deps: Deps, orgId: string) {
  return deps.db.select().from(invoiceSuppliers).where(eq(invoiceSuppliers.orgId, orgId)).orderBy(asc(invoiceSuppliers.name)).limit(500).all();
}
export async function createSupplier(deps: Deps, a: Actor, s: SupplierInput) {
  if (s.abn && !abnValid(s.abn)) throw new HttpError(422, "bad_abn", "That ABN does not look right. Check the 11 digits.");
  const id = sortableId("sup", deps.now().getTime());
  await deps.db.insert(invoiceSuppliers).values({ id, orgId: a.orgId, name: s.name.trim(), abn: s.abn ? cleanAbn(s.abn) : null, email: s.email ?? null, phone: s.phone ?? null, notes: s.notes ?? "", createdAt: deps.now() });
  return deps.db.select().from(invoiceSuppliers).where(eq(invoiceSuppliers.id, id)).get();
}

// ---------- documents ----------
export interface LineIn { description: string; quantityMilli: number; unitCents: number; gstFree?: boolean; itemId?: string | null }
export interface DocInput {
  contactId?: string | null; supplierId?: string | null; dealId?: string | null; buyerName?: string | null; buyerEmail?: string | null; buyerAbn?: string | null;
  buyerAddress?: string | null; issueDate?: string | null; dueDate?: string | null; currency?: string; priceMode?: PriceMode; reference?: string | null;
  notes?: string | null; terms?: string | null; sourceId?: string | null; lines?: LineIn[];
}

async function docRow(deps: Deps, orgId: string, id: string) {
  const d = await deps.db.select().from(invoiceDocs).where(and(eq(invoiceDocs.id, id), eq(invoiceDocs.orgId, orgId))).get();
  if (!d) throw notFound("Document");
  return d;
}
function checkLines(lines: LineIn[]) {
  if (lines.length > MAX_LINES) throw new HttpError(422, "too_many_lines", `A document can have up to ${MAX_LINES} lines.`);
  for (const l of lines) {
    checkCents(l.unitCents, "price");
    if (!Number.isSafeInteger(l.quantityMilli) || l.quantityMilli < 0 || l.quantityMilli > 1_000_000_000) throw new HttpError(422, "bad_quantity", "That quantity is not valid.");
    checkCents(Math.round((l.quantityMilli * l.unitCents) / 1000), "line total");
  }
}
async function writeLines(deps: Deps, d: Pick<Doc, "id" | "orgId" | "priceMode" | "gstRegistered">, lines: LineIn[]) {
  checkLines(lines);
  const t = docTotals(lines, d.priceMode, d.gstRegistered);
  await deps.db.delete(invoiceLines).where(eq(invoiceLines.docId, d.id));
  if (lines.length) {
    const now = deps.now().getTime();
    const rows = lines.map((l, i) => ({ id: sortableId("iln", now + i), docId: d.id, orgId: d.orgId, position: i, itemId: l.itemId ?? null, description: l.description.trim(),
      quantityMilli: l.quantityMilli, unitCents: l.unitCents, gstFree: !!l.gstFree, netCents: t.lines[i].netCents, gstCents: t.lines[i].gstCents, totalCents: t.lines[i].totalCents }));
    for (let i = 0; i < rows.length; i += 20) await deps.db.insert(invoiceLines).values(rows.slice(i, i + 20));
  }
  await deps.db.update(invoiceDocs).set({ subtotalCents: t.subtotalCents, gstCents: t.gstCents, totalCents: t.totalCents, updatedAt: deps.now() }).where(eq(invoiceDocs.id, d.id));
}
async function buyerFromContact(deps: Deps, orgId: string, contactId: string) {
  const c = await deps.db.select({ name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId))).get();
  if (!c) throw notFound("Contact");
  return { buyerName: c.name || c.email, buyerEmail: c.email };
}

export async function createDoc(deps: Deps, a: Actor, kind: DocKind, input: DocInput) {
  const s = await getSettings(deps, a.orgId);
  const id = sortableId(kind === "quote" ? "quo" : kind === "credit_note" ? "crn" : kind === "bill" ? "bil" : "inv", deps.now().getTime());
  let buyer = {};
  if (input.contactId && !input.buyerName) buyer = await buyerFromContact(deps, a.orgId, input.contactId);
  if (kind === "credit_note") {
    if (!input.sourceId) throw new HttpError(422, "credit_source", ATO_PROBLEM_TEXT.credit_source);
    const src = await docRow(deps, a.orgId, input.sourceId);
    if (src.kind !== "invoice" || src.status !== "issued") throw new HttpError(409, "source_not_issued", "Pick an issued invoice to credit.");
    buyer = { contactId: src.contactId, buyerName: src.buyerName, buyerEmail: src.buyerEmail, buyerAbn: src.buyerAbn, buyerAddress: src.buyerAddress };
  }
  if (input.buyerAbn && !abnValid(input.buyerAbn)) throw new HttpError(422, "bad_abn", ATO_PROBLEM_TEXT.buyer_abn);
  const row = {
    id, orgId: a.orgId, kind, status: "draft" as const, contactId: input.contactId ?? null, supplierId: input.supplierId ?? null, dealId: input.dealId ?? null,
    buyerName: input.buyerName ?? null, buyerEmail: input.buyerEmail ?? null, buyerAbn: input.buyerAbn ? cleanAbn(input.buyerAbn) : null, buyerAddress: input.buyerAddress ?? null,
    issueDate: input.issueDate ?? null, dueDate: input.dueDate ?? null, currency: input.currency ?? s.currency, priceMode: input.priceMode ?? s.priceMode,
    gstRegistered: kind === "bill" ? true : s.gstRegistered, reference: input.reference ?? null, notes: input.notes ?? null, terms: input.terms ?? null,
    sourceId: input.sourceId ?? null, createdBy: a.userId, createdAt: deps.now(), updatedAt: deps.now(), ...buyer,
  };
  await deps.db.insert(invoiceDocs).values(row);
  await writeLines(deps, row, input.lines ?? []);
  return docDetail(deps, a, id);
}

export async function updateDoc(deps: Deps, a: Actor, id: string, input: DocInput) {
  const d = await docRow(deps, a.orgId, id);
  if (d.status !== "draft") throw new HttpError(409, "not_draft", "Issued documents cannot be changed. Void it or make an adjustment note.");
  if (input.buyerAbn && !abnValid(input.buyerAbn)) throw new HttpError(422, "bad_abn", ATO_PROBLEM_TEXT.buyer_abn);
  let buyer = {};
  if (input.contactId && input.contactId !== d.contactId && input.buyerName === undefined) buyer = await buyerFromContact(deps, a.orgId, input.contactId);
  const { lines, sourceId: _s, ...rest } = input;
  const patch = Object.fromEntries(Object.entries({ ...rest, ...buyer }).filter(([, v]) => v !== undefined));
  if (patch.buyerAbn) patch.buyerAbn = cleanAbn(patch.buyerAbn as string);
  await deps.db.update(invoiceDocs).set({ ...patch, updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  const after = await docRow(deps, a.orgId, id);
  if (lines) await writeLines(deps, after, lines);
  else if (input.priceMode && input.priceMode !== d.priceMode) await writeLines(deps, after, await linesOf(deps, id));
  return docDetail(deps, a, id);
}

export async function deleteDraft(deps: Deps, a: Actor, id: string) {
  const d = await docRow(deps, a.orgId, id);
  if (d.status !== "draft") throw new HttpError(409, "issued_cannot_delete", "Issued documents keep their number. Void it instead.");
  await deps.db.delete(invoiceLines).where(eq(invoiceLines.docId, id));
  await deps.db.delete(invoiceDocs).where(eq(invoiceDocs.id, id));
  await releaseBilledTime(deps, a, id, "draft_deleted"); // TD4: billed time on this draft can be billed again
  return { ok: true };
}

async function linesOf(deps: Deps, docId: string): Promise<LineIn[]> {
  const rows = await deps.db.select().from(invoiceLines).where(eq(invoiceLines.docId, docId)).orderBy(asc(invoiceLines.position)).all();
  return rows.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli, unitCents: l.unitCents, gstFree: l.gstFree, itemId: l.itemId }));
}

function problemsOf(d: Doc, s: Settings, lines: LineInput[], sourceNumber: string | null) {
  return atoProblems({ kind: d.kind, gstRegistered: d.gstRegistered, supplierName: s.businessName, supplierAbn: s.abn, issueDate: d.issueDate, buyerName: d.buyerName,
    buyerAbn: d.buyerAbn, totalCents: d.totalCents, lines, sourceNumber });
}

export async function issueDoc(deps: Deps, a: Actor, id: string) {
  assertAdmin(a);
  const d = await docRow(deps, a.orgId, id);
  if (d.status !== "draft") throw new HttpError(409, "already_issued", "This document is already issued.");
  const s = await getSettings(deps, a.orgId);
  const issueDate = d.issueDate ?? today(deps);
  const dueDate = d.dueDate ?? (d.kind === "credit_note" ? null : addDays(issueDate, d.kind === "quote" ? 30 : s.termsDays));
  const src = d.sourceId ? await docRow(deps, a.orgId, d.sourceId) : null;
  const lines = await linesOf(deps, id);
  const problems = problemsOf({ ...d, issueDate }, s, lines, src?.number ?? null);
  if (problems.length) throw new HttpError(422, "not_ready", problems.map((p) => ATO_PROBLEM_TEXT[p]).join(" "));
  if (d.kind === "credit_note" && src) {
    const owing = src.totalCents - src.paidCents - src.creditedCents;
    if (d.totalCents > owing + src.paidCents) throw new HttpError(422, "credit_too_big", "An adjustment note cannot be more than the invoice.");
  }
  const seq = await takeNumber(deps, a.orgId, d.kind);
  const prefix = d.kind === "invoice" ? s.prefixInvoice : d.kind === "quote" ? s.prefixQuote : d.kind === "credit_note" ? s.prefixCredit : null;
  await deps.db.update(invoiceDocs).set({ status: "issued", seq, number: docNumber(d.kind, seq, prefix), issueDate, dueDate,
    viewToken: d.kind === "bill" ? null : randomToken(18), updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  if (d.kind === "credit_note" && src) await deps.db.update(invoiceDocs).set({ creditedCents: sql`${invoiceDocs.creditedCents} + ${d.totalCents}`, updatedAt: deps.now() }).where(eq(invoiceDocs.id, src.id));
  return docDetail(deps, a, id);
}

export async function voidDoc(deps: Deps, a: Actor, id: string, reason: string) {
  assertAdmin(a);
  const d = await docRow(deps, a.orgId, id);
  if (d.status === "draft") throw new HttpError(409, "draft", "A draft has no number yet. Delete it instead.");
  if (d.status === "void") return docDetail(deps, a, id);
  if (d.paidCents > 0) throw new HttpError(409, "has_payments", "Remove the payments first, or make an adjustment note.");
  if (d.creditedCents > 0) throw new HttpError(409, "has_credits", "Void its adjustment notes first.");
  await deps.db.update(invoiceDocs).set({ status: "void", voidedAt: deps.now(), voidReason: reason.trim().slice(0, 300) || null, updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  if (d.kind === "credit_note" && d.sourceId) await deps.db.update(invoiceDocs).set({ creditedCents: sql`max(0, ${invoiceDocs.creditedCents} - ${d.totalCents})`, updatedAt: deps.now() }).where(eq(invoiceDocs.id, d.sourceId));
  if (d.kind === "invoice") await releaseBilledTime(deps, a, id, "voided"); // TD4
  return docDetail(deps, a, id);
}

/** A quote becomes a draft invoice with the same lines; the quote is marked accepted and points at it. */
export async function convertQuote(deps: Deps, a: Actor, id: string) {
  const q = await docRow(deps, a.orgId, id);
  if (q.kind !== "quote") throw new HttpError(409, "not_quote", "Only quotes convert to invoices.");
  if (q.convertedId) return docDetail(deps, a, q.convertedId);
  if (q.status === "void" || q.status === "declined") throw new HttpError(409, "quote_closed", "This quote is closed.");
  const inv = await createDoc(deps, a, "invoice", { contactId: q.contactId, dealId: q.dealId, buyerName: q.buyerName, buyerEmail: q.buyerEmail, buyerAbn: q.buyerAbn,
    buyerAddress: q.buyerAddress, currency: q.currency, priceMode: q.priceMode, reference: q.number ?? q.reference, notes: q.notes, terms: q.terms, lines: await linesOf(deps, id) });
  await deps.db.update(invoiceDocs).set({ sourceId: id }).where(eq(invoiceDocs.id, inv.id));
  await deps.db.update(invoiceDocs).set({ convertedId: inv.id, status: q.status === "draft" ? "draft" : "accepted", answeredAt: q.answeredAt ?? deps.now(), updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  return docDetail(deps, a, inv.id);
}

// ---------- payments ----------
export async function recordPayment(deps: Deps, a: Actor, id: string, p: { amountCents: number; paidOn?: string; method?: string; reference?: string | null }) {
  assertAdmin(a);
  checkCents(p.amountCents);
  const d = await docRow(deps, a.orgId, id);
  if (!(d.kind === "invoice" || d.kind === "bill") || d.status !== "issued") throw new HttpError(409, "not_payable", "Payments go on issued invoices and bills.");
  const owing = d.totalCents - d.paidCents - d.creditedCents;
  if (p.amountCents <= 0) throw new HttpError(422, "bad_amount", "Enter an amount above zero.");
  if (p.amountCents > owing) throw new HttpError(422, "overpaid", "That is more than what is owing.");
  await deps.db.insert(invoicePayments).values({ id: sortableId("pay", deps.now().getTime()), orgId: a.orgId, docId: id, amountCents: p.amountCents, paidOn: p.paidOn ?? today(deps),
    method: p.method ?? "bank", reference: p.reference ?? null, createdBy: a.userId, createdAt: deps.now() });
  await deps.db.update(invoiceDocs).set({ paidCents: sql`${invoiceDocs.paidCents} + ${p.amountCents}`, updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  return docDetail(deps, a, id);
}
export async function deletePayment(deps: Deps, a: Actor, id: string, paymentId: string) {
  assertAdmin(a);
  const p = await deps.db.select().from(invoicePayments).where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.docId, id), eq(invoicePayments.orgId, a.orgId))).get();
  if (!p) throw notFound("Payment");
  await deps.db.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
  await deps.db.update(invoiceDocs).set({ paidCents: sql`max(0, ${invoiceDocs.paidCents} - ${p.amountCents})`, updatedAt: deps.now() }).where(eq(invoiceDocs.id, id));
  return docDetail(deps, a, id);
}

// ---------- reading ----------
export function presentDoc(d: Doc, t: string) {
  const { viewToken: _v, ...rest } = d;
  return { ...rest, owingCents: Math.max(0, d.totalCents - d.paidCents - d.creditedCents), state: d.kind === "quote" ? d.status : payState({ issued: d.status !== "draft", voided: d.status === "void",
    totalCents: d.totalCents, paidCents: d.paidCents, creditedCents: d.creditedCents, dueDate: d.dueDate }, t), title: docTitle(d.kind, d.gstRegistered) };
}
export type PresentedDoc = ReturnType<typeof presentDoc>;

export async function listDocs(deps: Deps, orgId: string, q: { kind: DocKind; state?: string; q?: string; contactId?: string; limit?: number; offset?: number }) {
  const t = today(deps);
  const where = [eq(invoiceDocs.orgId, orgId), eq(invoiceDocs.kind, q.kind)];
  if (q.contactId) where.push(eq(invoiceDocs.contactId, q.contactId));
  if (q.q) where.push(containsAny([invoiceDocs.number, invoiceDocs.buyerName, invoiceDocs.buyerEmail, invoiceDocs.reference], q.q)); // LK1 helper: long searches stay under D1 pattern limits
  if (q.state === "draft") where.push(eq(invoiceDocs.status, "draft"));
  else if (q.state === "void") where.push(eq(invoiceDocs.status, "void"));
  else if (q.state === "paid") where.push(eq(invoiceDocs.status, "issued"), sql`${invoiceDocs.paidCents} + ${invoiceDocs.creditedCents} >= ${invoiceDocs.totalCents}`);
  else if (q.state === "overdue") where.push(eq(invoiceDocs.status, "issued"), sql`${invoiceDocs.paidCents} + ${invoiceDocs.creditedCents} < ${invoiceDocs.totalCents}`, sql`${invoiceDocs.dueDate} < ${t}`);
  else if (q.state === "open") where.push(inArray(invoiceDocs.status, ["issued"]), sql`${invoiceDocs.paidCents} + ${invoiceDocs.creditedCents} < ${invoiceDocs.totalCents}`);
  else if (q.state && ["issued", "accepted", "declined"].includes(q.state)) where.push(eq(invoiceDocs.status, q.state as "issued"));
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = await deps.db.select().from(invoiceDocs).where(and(...where)).orderBy(desc(invoiceDocs.createdAt)).limit(limit + 1).offset(q.offset ?? 0).all();
  const sums = await deps.db.get<{ open: number; overdue: number; n: number }>(sql`select
      coalesce(sum(case when status = 'issued' then max(0, total_cents - paid_cents - credited_cents) else 0 end), 0) as open,
      coalesce(sum(case when status = 'issued' and due_date < ${t} then max(0, total_cents - paid_cents - credited_cents) else 0 end), 0) as overdue,
      count(*) as n
    from invoice_docs where org_id = ${orgId} and kind = ${q.kind}`);
  return { items: rows.slice(0, limit).map((d) => presentDoc(d, t)), more: rows.length > limit, totals: { openCents: sums?.open ?? 0, overdueCents: sums?.overdue ?? 0, count: sums?.n ?? 0 } };
}

export async function docDetail(deps: Deps, a: Actor, id: string) {
  const d = await docRow(deps, a.orgId, id);
  const [lines, payments, s, credits, repeat] = await Promise.all([
    deps.db.select().from(invoiceLines).where(eq(invoiceLines.docId, id)).orderBy(asc(invoiceLines.position)).all(),
    deps.db.select().from(invoicePayments).where(eq(invoicePayments.docId, id)).orderBy(asc(invoicePayments.paidOn)).all(),
    getSettings(deps, a.orgId),
    deps.db.select({ id: invoiceDocs.id, number: invoiceDocs.number, totalCents: invoiceDocs.totalCents, status: invoiceDocs.status }).from(invoiceDocs)
      .where(and(eq(invoiceDocs.orgId, a.orgId), eq(invoiceDocs.sourceId, id))).all(),
    d.repeatId ? deps.db.select().from(invoiceRepeats).where(eq(invoiceRepeats.id, d.repeatId)).get() : deps.db.select().from(invoiceRepeats).where(and(eq(invoiceRepeats.orgId, a.orgId), eq(invoiceRepeats.sourceId, id))).get(),
  ]);
  const src = d.sourceId ? await deps.db.select({ id: invoiceDocs.id, number: invoiceDocs.number, kind: invoiceDocs.kind }).from(invoiceDocs).where(eq(invoiceDocs.id, d.sourceId)).get() : null;
  const problems = d.status === "draft" ? problemsOf({ ...d, issueDate: d.issueDate ?? today(deps) }, s, lines, src?.number ?? null) : []; // no date yet means today at issue
  const viewUrl = d.viewToken ? `${deps.config.appUrl.replace(/\/$/, "")}/i/${d.viewToken}` : null;
  return { ...presentDoc(d, today(deps)), viewUrl, lines, payments, source: src, related: credits, repeat: repeat ?? null,
    problems: problems.map((p) => ({ code: p, text: ATO_PROBLEM_TEXT[p] })), canManage: isAdmin(a) };
}

// ---------- public view link ----------
export async function findByToken(deps: Deps, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const d = await deps.db.select().from(invoiceDocs).where(eq(invoiceDocs.viewToken, token)).get();
  if (!d || d.status === "draft") return null;
  const [lines, s] = await Promise.all([deps.db.select().from(invoiceLines).where(eq(invoiceLines.docId, d.id)).orderBy(asc(invoiceLines.position)).all(), getSettings(deps, d.orgId)]);
  const src = d.sourceId ? await deps.db.select({ number: invoiceDocs.number }).from(invoiceDocs).where(eq(invoiceDocs.id, d.sourceId)).get() : null;
  return { doc: presentDoc(d, today(deps)), raw: d, lines, settings: s, sourceNumber: src?.number ?? null };
}
export async function markViewed(deps: Deps, id: string) {
  await deps.db.update(invoiceDocs).set({ viewedAt: deps.now() }).where(and(eq(invoiceDocs.id, id), sql`${invoiceDocs.viewedAt} is null`));
}
export async function answerQuote(deps: Deps, token: string, answer: "accepted" | "declined") {
  const f = await findByToken(deps, token);
  if (!f || f.raw.kind !== "quote") throw notFound("Quote");
  if (f.raw.status !== "issued") throw new HttpError(409, "answered", "This quote has already been answered.");
  if (f.raw.dueDate && f.raw.dueDate < today(deps)) throw new HttpError(410, "expired", "This quote has expired. Ask for a new one.");
  await deps.db.update(invoiceDocs).set({ status: answer, answeredAt: deps.now(), updatedAt: deps.now() }).where(eq(invoiceDocs.id, f.raw.id));
  return { ok: true, status: answer, orgId: f.raw.orgId, docId: f.raw.id, number: f.raw.number, createdBy: f.raw.createdBy };
}

// ---------- repeating invoices ----------
export async function setRepeat(deps: Deps, a: Actor, id: string, r: { every: Repeat; startDate?: string; endDate?: string | null; autoSend?: boolean } | null) {
  assertAdmin(a);
  const d = await docRow(deps, a.orgId, id);
  if (d.kind !== "invoice") throw new HttpError(409, "not_invoice", "Only invoices repeat.");
  const cur = await deps.db.select().from(invoiceRepeats).where(and(eq(invoiceRepeats.orgId, a.orgId), eq(invoiceRepeats.sourceId, id))).get();
  if (!r) { if (cur) await deps.db.update(invoiceRepeats).set({ active: false }).where(eq(invoiceRepeats.id, cur.id)); return docDetail(deps, a, id); }
  const start = r.startDate ?? nextRun(d.issueDate ?? today(deps), r.every);
  if (start < today(deps)) throw new HttpError(422, "past_start", "The next invoice date must be today or later.");
  const vals = { every: r.every, anchorDay: +start.slice(8, 10), nextRun: start, endDate: r.endDate ?? null, autoSend: !!r.autoSend, active: true };
  if (cur) await deps.db.update(invoiceRepeats).set(vals).where(eq(invoiceRepeats.id, cur.id));
  else await deps.db.insert(invoiceRepeats).values({ id: sortableId("rep", deps.now().getTime()), orgId: a.orgId, sourceId: id, createdBy: a.userId, createdAt: deps.now(), ...vals });
  return docDetail(deps, a, id);
}

/** Cron: make the invoices whose repeat date has come (bounded per pass). Issued when settings allow, else left as drafts. */
export async function runRepeats(deps: Deps, max = 25): Promise<{ made: number; ids: string[] }> {
  const t = today(deps);
  // OPS1 security review N1: only workspaces with invoices on (a workspace override counts, either way).
  const fw = await passWorkspaces(deps, "invoicesEnabled");
  if (!fw) return { made: 0, ids: [] };
  const due = await deps.db.select().from(invoiceRepeats).where(and(eq(invoiceRepeats.active, true), sql`${invoiceRepeats.nextRun} <= ${t}`, flagOrgCond(invoiceRepeats.orgId, fw))).orderBy(asc(invoiceRepeats.nextRun)).limit(max).all();
  const ids: string[] = [];
  for (const r of due) {
    const src = await deps.db.select().from(invoiceDocs).where(eq(invoiceDocs.id, r.sourceId)).get();
    const following = nextRun(r.nextRun, r.every, r.anchorDay);
    const ended = !src || src.status === "void" || (r.endDate !== null && r.nextRun > r.endDate);
    // Move the date first so a crash never makes the same invoice twice.
    const moved = await deps.db.update(invoiceRepeats).set({ nextRun: following, active: !ended && !(r.endDate !== null && following > r.endDate) })
      .where(and(eq(invoiceRepeats.id, r.id), eq(invoiceRepeats.nextRun, r.nextRun))).returning({ id: invoiceRepeats.id });
    if (ended || !moved.length || !src) continue;
    const actor: Actor = { orgId: r.orgId, userId: r.createdBy, email: "", name: "Repeating invoice", role: "admin" };
    const s = await getSettings(deps, r.orgId);
    const doc = await createDoc(deps, actor, "invoice", { contactId: src.contactId, dealId: src.dealId, buyerName: src.buyerName, buyerEmail: src.buyerEmail, buyerAbn: src.buyerAbn,
      buyerAddress: src.buyerAddress, currency: src.currency, priceMode: src.priceMode, reference: src.reference, notes: src.notes, terms: src.terms,
      issueDate: r.nextRun, dueDate: addDays(r.nextRun, s.termsDays), lines: await linesOf(deps, src.id) });
    await deps.db.update(invoiceDocs).set({ repeatId: r.id }).where(eq(invoiceDocs.id, doc.id));
    if (!doc.problems.length) await issueDoc(deps, actor, doc.id);
    await deps.db.update(invoiceRepeats).set({ runs: sql`${invoiceRepeats.runs} + 1`, lastDocId: doc.id }).where(eq(invoiceRepeats.id, r.id));
    ids.push(doc.id);
  }
  return { made: ids.length, ids };
}

/** Cron: issued invoices to remind about (before due once, after due once per remind_after_days), bounded. */
export async function dueReminders(deps: Deps, max = 50) {
  const t = today(deps);
  // OPS1 security review N1: only workspaces with invoices on (a workspace override counts, either way).
  const fw = await passWorkspaces(deps, "invoicesEnabled");
  if (!fw) return [];
  const remindOrgs = flagOrgCond(sql`d.org_id`, fw) ?? sql`1 = 1`;
  const rows = await deps.db.all<{ id: string; org_id: string; due_date: string; reminder_count: number; last_reminder_at: number | null; buyer_email: string | null; before: number; after: number }>(sql`
    select d.id, d.org_id, d.due_date, d.reminder_count, d.last_reminder_at, d.buyer_email, coalesce(s.remind_before_days, 3) as before, coalesce(s.remind_after_days, 7) as after
    from invoice_docs d left join invoice_settings s on s.org_id = d.org_id
    where d.kind = 'invoice' and d.status = 'issued' and d.due_date is not null and d.due_date <= ${addDays(t, 14)} and ${remindOrgs}
      and d.paid_cents + d.credited_cents < d.total_cents and d.buyer_email is not null and d.reminder_count < 6
    order by d.due_date limit ${max * 4}`);
  const out: { id: string; orgId: string; when: "before" | "after" }[] = [];
  for (const r of rows) {
    const last = r.last_reminder_at ? new Date(r.last_reminder_at).toISOString().slice(0, 10) : null;
    if (r.before > 0 && r.due_date > t && addDays(r.due_date, -r.before) <= t && !last) out.push({ id: r.id, orgId: r.org_id, when: "before" });
    else if (r.after > 0 && r.due_date < t && (!last || addDays(last, r.after) <= t) && addDays(r.due_date, r.after) <= t) out.push({ id: r.id, orgId: r.org_id, when: "after" });
    if (out.length >= max) break;
  }
  return out;
}
export async function noteReminder(deps: Deps, id: string) {
  await deps.db.update(invoiceDocs).set({ lastReminderAt: deps.now(), reminderCount: sql`${invoiceDocs.reminderCount} + 1` }).where(eq(invoiceDocs.id, id));
}
export async function noteSent(deps: Deps, id: string) { await deps.db.update(invoiceDocs).set({ sentAt: deps.now() }).where(eq(invoiceDocs.id, id)); }

// ---------- reports ----------
export async function agedReceivables(deps: Deps, orgId: string) {
  const t = today(deps);
  const rows = await deps.db.select({ id: invoiceDocs.id, number: invoiceDocs.number, buyerName: invoiceDocs.buyerName, contactId: invoiceDocs.contactId, dueDate: invoiceDocs.dueDate,
    owing: sql<number>`${invoiceDocs.totalCents} - ${invoiceDocs.paidCents} - ${invoiceDocs.creditedCents}` }).from(invoiceDocs)
    .where(and(eq(invoiceDocs.orgId, orgId), eq(invoiceDocs.kind, "invoice"), eq(invoiceDocs.status, "issued"), sql`${invoiceDocs.paidCents} + ${invoiceDocs.creditedCents} < ${invoiceDocs.totalCents}`)).limit(2000).all();
  const byBuyer = new Map<string, { name: string; buckets: Record<AgeBucket, number>; totalCents: number }>();
  const totals: Record<AgeBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const r of rows) {
    const b = ageBucket(r.dueDate, t), key = r.contactId ?? r.buyerName ?? "none";
    const e = byBuyer.get(key) ?? { name: r.buyerName ?? "No customer", buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, totalCents: 0 };
    e.buckets[b] += r.owing; e.totalCents += r.owing; totals[b] += r.owing; byBuyer.set(key, e);
  }
  return { asOf: t, rows: [...byBuyer.values()].sort((x, y) => y.totalCents - x.totalCents), totals, totalCents: Object.values(totals).reduce((x, y) => x + y, 0) };
}

/** GST for BAS: G1 total sales, 1A GST on sales, 1B GST on purchases (bills). Accrual by issue date or cash by payment date. */
export async function gstReport(deps: Deps, orgId: string, from: string, to: string, basis: "accrual" | "cash") {
  let salesCents = 0, gstSales = 0, gstPurchases = 0, purchasesCents = 0;
  if (basis === "accrual") {
    const rows = await deps.db.all<{ kind: string; total: number; gst: number }>(sql`select kind, coalesce(sum(total_cents), 0) as total, coalesce(sum(gst_cents), 0) as gst from invoice_docs
      where org_id = ${orgId} and status in ('issued') and kind in ('invoice', 'credit_note', 'bill') and issue_date >= ${from} and issue_date <= ${to} group by kind`);
    for (const r of rows) {
      if (r.kind === "invoice") { salesCents += r.total; gstSales += r.gst; }
      if (r.kind === "credit_note") { salesCents -= r.total; gstSales -= r.gst; }
      if (r.kind === "bill") { purchasesCents += r.total; gstPurchases += r.gst; }
    }
  } else {
    const rows = await deps.db.all<{ kind: string; amount: number; total: number; gst: number }>(sql`select d.kind, p.amount_cents as amount, d.total_cents as total, d.gst_cents as gst
      from invoice_payments p join invoice_docs d on d.id = p.doc_id where p.org_id = ${orgId} and p.paid_on >= ${from} and p.paid_on <= ${to} and d.status <> 'void' limit 5000`);
    for (const r of rows) {
      const g = gstInPayment(r.amount, r.total, r.gst);
      if (r.kind === "invoice") { salesCents += r.amount; gstSales += g; } else if (r.kind === "bill") { purchasesCents += r.amount; gstPurchases += g; }
    }
  }
  return { from, to, basis, g1SalesCents: salesCents, gstOnSalesCents: gstSales, purchasesCents, gstOnPurchasesCents: gstPurchases, netGstCents: gstSales - gstPurchases };
}

export async function docsForContact(deps: Deps, orgId: string, contactId: string) {
  const t = today(deps);
  const rows = await deps.db.select().from(invoiceDocs).where(and(eq(invoiceDocs.orgId, orgId), eq(invoiceDocs.contactId, contactId), isNotNull(invoiceDocs.id))).orderBy(desc(invoiceDocs.createdAt)).limit(50).all();
  return rows.map((d) => presentDoc(d, t));
}
