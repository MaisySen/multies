/**
 * R106: expenses and receipts. Receipts come in by upload, the phone camera or a forward to the workspace receipts
 * address; their fields are read by the existing free text engine and the Tools rules (routes/tools-ai.ts), people
 * check them, submit, an approver decides, and an expense can be re billed onto an R105 invoice draft.
 * Members see their own; approvers (picked by admins), owners and admins see all. Money is integer cents.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { containsAny } from "../../lib/like-search";
import type { Deps } from "../../context";
import { expenseSettings, expenses, invoiceDocs, invoiceLines, members, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { randomToken } from "../../lib/crypto";
import { audit } from "../audit";
import { sortableId, type SuiteActor } from "../suite/common";
import { blobsFor } from "../suite/drive-r101";
import { isAskExcluded } from "../ask-r110";
import { updateDoc } from "../invoices/invoices";
import type { InvoiceRow } from "../tools/ai-docs";
import { abnValid, cleanAbn, divRound, formatAbn } from "@/shared/invoices";
import {
  EVERY, EXPENSE_CATEGORIES, EXPENSE_MAX_CENTS, RECEIPT_MAX_BYTES, RECEIPT_TYPES, RECEIPTS_LOCAL_RE, SPLIT_PROBLEM_TEXT, canClaimGst, expensesCsv, gstOfTotal, guessEvery,
  needsTaxInvoice, nextExpected, perYear, receiptsLocal, splitGst, splitProblems, type Every, type ExpenseSource, type Split,
} from "@/shared/expenses";
import { featureOn, featureVariesByWorkspace } from "../console/flags"; // OPS1 feature flags

export type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
type Row = typeof expenses.$inferSelect;
const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";
export const DAILY_RECEIPTS = 100; // per person per day, all sources
export const MAIL_RECEIPTS_MAX = 5; // attachments taken from one mail
const PAGE = 50;
const parseList = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };

// ---------------------------------------------------------------- access

/** People signed in to the workspace only: not API keys, agents or the system. */
export function assertPerson(a: Actor): string {
  if (a.agentId || a.apiKeyId || a.system || !a.userId) throw new HttpError(403, "people_only", "Expenses are for people signed in to the workspace.");
  return a.userId;
}

/** The client workspace stays out (same rule as Ask). */
export async function excludedOrg(deps: Deps, orgId: string): Promise<boolean> {
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${orgId} limit 1`);
  return !o || isAskExcluded(o);
}

export interface Settings { receiptsToken: string | null; approverIds: string[]; requireApproval: boolean }
export async function getSettings(deps: Deps, orgId: string): Promise<Settings> {
  const s = await deps.db.select().from(expenseSettings).where(eq(expenseSettings.orgId, orgId)).get();
  const ids = s ? parseList<unknown[]>(s.approverIds, []).filter((x): x is string => typeof x === "string") : [];
  return { receiptsToken: s?.receiptsToken ?? null, approverIds: ids, requireApproval: s?.requireApproval ?? true };
}

export const isApprover = (a: Actor, s: Settings) => isAdmin(a) || s.approverIds.includes(a.userId);

export function receiptsAddress(deps: Deps, token: string | null): string | null {
  const domain = deps.config.freeMail?.domain;
  return token && domain ? `${receiptsLocal(token)}@${domain}` : null;
}

async function upsertSettings(deps: Deps, orgId: string, patch: Partial<{ receiptsToken: string | null; approverIds: string }>) {
  await deps.db.insert(expenseSettings).values({ orgId, updatedAt: deps.now(), ...patch })
    .onConflictDoUpdate({ target: expenseSettings.orgId, set: { ...patch, updatedAt: deps.now() } });
}

const newToken = () => randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(12, "x");

/** The workspace's settings as the page shows them; makes the receipts token the first time an admin looks. */
export async function settingsView(deps: Deps, a: Actor) {
  assertPerson(a);
  let s = await getSettings(deps, a.orgId);
  if (isAdmin(a) && !s.receiptsToken) {
    await upsertSettings(deps, a.orgId, { receiptsToken: newToken() });
    s = await getSettings(deps, a.orgId);
  }
  const people = await deps.db.select({ id: users.id, name: users.name, email: users.email, role: members.role }).from(members)
    .innerJoin(users, eq(users.id, members.userId)).where(and(eq(members.organizationId, a.orgId), eq(members.kind, "human"))).limit(500).all();
  return {
    canManage: isAdmin(a), canApprove: isApprover(a, s), receiptsAddress: receiptsAddress(deps, s.receiptsToken), approverIds: s.approverIds,
    people: isAdmin(a) ? people.map((p) => ({ id: p.id, name: p.name || p.email, role: p.role })) : [], categories: EXPENSE_CATEGORIES,
  };
}

export async function saveSettings(deps: Deps, a: Actor, p: { approverIds?: string[]; resetAddress?: boolean }) {
  assertPerson(a);
  if (!isAdmin(a)) throw new HttpError(403, "admin_only", "Only owners and admins can change expense settings.");
  if (p.approverIds) {
    const ids = [...new Set(p.approverIds)].slice(0, 50);
    const found = ids.length ? await deps.db.select({ id: members.userId }).from(members).where(and(eq(members.organizationId, a.orgId), inArray(members.userId, ids.slice(0, 90)))).all() : [];
    if (found.length !== ids.length) throw new HttpError(422, "not_member", "Approvers must be people in this workspace.");
    await upsertSettings(deps, a.orgId, { approverIds: JSON.stringify(ids) });
  }
  if (p.resetAddress) await upsertSettings(deps, a.orgId, { receiptsToken: newToken() });
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "expenses.settings", metadata: { approvers: p.approverIds?.length ?? null, reset: !!p.resetAddress } });
  return settingsView(deps, a);
}

async function rowFor(deps: Deps, a: Actor, id: string, s?: Settings): Promise<{ row: Row; settings: Settings; approver: boolean }> {
  assertPerson(a);
  const row = await deps.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.orgId, a.orgId))).get();
  const settings = s ?? await getSettings(deps, a.orgId);
  const approver = isApprover(a, settings);
  // Someone else's expense reads as missing to a member, never as forbidden.
  if (!row || (row.userId !== a.userId && !approver)) throw notFound("Expense");
  return { row, settings, approver };
}

// ---------------------------------------------------------------- presenting


export function present(r: Row, a: Actor, approver: boolean) {
  const splits = parseList<Split[]>(r.splits, []);
  const own = r.userId === a.userId;
  const editable = own && (r.status === "draft" || r.status === "rejected");
  return {
    id: r.id, userId: r.userId, userName: r.userName, own, status: r.status, supplier: r.supplier, supplierAbn: r.supplierAbn ? formatAbn(r.supplierAbn) : null, spentOn: r.spentOn,
    totalCents: r.totalCents, gstCents: r.gstCents, currency: r.currency, category: r.category, gstClaimable: r.gstClaimable, reimbursable: r.reimbursable, note: r.note,
    source: r.source, hasFile: !!r.fileKey, fileName: r.fileName, fileType: r.fileType, fileSize: r.fileSize, readState: r.readState,
    readFields: parseList<string[]>(r.readFields, []), splits: splitGst(r.gstCents, r.totalCents, splits), every: r.every as Every | null,
    rebillDocId: r.rebillDocId, decidedByName: r.decidedByName, decidedAt: r.decidedAt?.toISOString() ?? null, rejectReason: r.rejectReason,
    submittedAt: r.submittedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    needsTaxInvoice: needsTaxInvoice(r.totalCents, r.supplierAbn),
    can: {
      edit: editable, submit: editable, delete: editable,
      decide: approver && r.status === "submitted",
      rebill: (own || approver) && !r.rebillDocId && r.totalCents > 0 && r.status !== "rejected",
    },
  };
}
export type PresentedExpense = ReturnType<typeof present>;

// ---------------------------------------------------------------- receipts in

export function receiptTypeOk(type: string, name: string): string | null {
  const t = type.split(";")[0].trim().toLowerCase();
  if ((RECEIPT_TYPES as readonly string[]).includes(t)) return t;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const byExt: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
  return ext && byExt[ext] ? byExt[ext] : null;
}

const cleanName = (n: string) => n.replace(/[\r\n"\\/]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "receipt";

async function userName(deps: Deps, userId: string, fallback: string) {
  const u = await deps.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).get();
  return (u?.name || u?.email || fallback).slice(0, 120);
}

async function checkDaily(deps: Deps, orgId: string, userId: string) {
  const since = new Date(deps.now().getTime() - 86_400_000);
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.orgId, orgId), eq(expenses.userId, userId), gte(expenses.createdAt, since))).get();
  if (Number(n?.n ?? 0) >= DAILY_RECEIPTS) throw new HttpError(429, "too_many_receipts", `You can add up to ${DAILY_RECEIPTS} receipts a day.`);
}

/** One new expense, with or without a receipt file. */
export async function addExpense(deps: Deps, a: Actor, body: { source: ExpenseSource; file?: { bytes: Uint8Array; name: string; type: string } | null; note?: string | null }) {
  assertPerson(a);
  await checkDaily(deps, a.orgId, a.userId);
  const now = deps.now();
  const id = sortableId("exp", now.getTime());
  let file: Partial<Row> = {};
  if (body.file) {
    const type = receiptTypeOk(body.file.type, body.file.name);
    if (!type) throw new HttpError(422, "receipt_type", "Add a photo or a PDF of the receipt.");
    if (!body.file.bytes.length) throw new HttpError(422, "receipt_empty", "That file is empty.");
    if (body.file.bytes.length > RECEIPT_MAX_BYTES) throw new HttpError(413, "receipt_too_large", `Receipts can be up to ${RECEIPT_MAX_BYTES / (1024 * 1024)} MB.`);
    const key = `expense/${a.orgId}/${id}`;
    const parts = await blobsFor(deps).put(key, body.file.bytes, type);
    file = { fileKey: key, fileParts: parts, fileSize: body.file.bytes.length, fileName: cleanName(body.file.name), fileType: type };
  }
  await deps.db.insert(expenses).values({
    id, orgId: a.orgId, userId: a.userId, userName: await userName(deps, a.userId, a.name || a.email || ""), source: body.source, note: body.note?.slice(0, 500) ?? null,
    createdAt: now, updatedAt: now, ...file,
  });
  return expenseDetail(deps, a, id);
}

export async function expenseDetail(deps: Deps, a: Actor, id: string) {
  const { row, approver } = await rowFor(deps, a, id);
  return present(row, a, approver);
}

/** The receipt's bytes for someone who can see the expense. */
export async function receiptFile(deps: Deps, a: Actor, id: string) {
  const { row } = await rowFor(deps, a, id);
  if (!row.fileKey) throw notFound("Receipt");
  return { stream: blobsFor(deps).read(row.fileKey, row.fileParts, row.fileSize), type: row.fileType ?? "application/octet-stream", name: row.fileName ?? "receipt", size: row.fileSize };
}

export async function receiptBytes(deps: Deps, row: Pick<Row, "fileKey" | "fileParts" | "fileSize">) {
  return row.fileKey ? blobsFor(deps).readAll(row.fileKey, row.fileParts, row.fileSize) : null;
}

// ---------------------------------------------------------------- reading fields

export interface ReadFields { supplier?: string; supplierAbn?: string; spentOn?: string; totalCents?: number; gstCents?: number; category?: string; currency?: string }

const toCents = (v: number | null) => (v === null || !Number.isFinite(v) || v <= 0 ? null : Math.round(v * 100));

/** The rules' row (Tools field rules) as expense fields. GST: the receipt's own GST line; else one eleventh when the receipt shows an ABN (a GST registered supplier). */
export function fieldsFromRow(r: InvoiceRow): ReadFields {
  const out: ReadFields = {};
  if (r.supplier) out.supplier = r.supplier.slice(0, 200);
  const abn = r.abn ? cleanAbn(r.abn) : "";
  if (abn && abnValid(abn)) out.supplierAbn = abn;
  if (r.date) out.spentOn = r.date;
  const total = toCents(r.total);
  if (total !== null && total <= EXPENSE_MAX_CENTS) out.totalCents = total;
  const gst = toCents(r.gst);
  if (gst !== null && (total === null || gst < total)) out.gstCents = gst;
  else if (total !== null && out.supplierAbn) out.gstCents = gstOfTotal(total);
  if (r.category && (EXPENSE_CATEGORIES as readonly string[]).includes(r.category)) out.category = r.category;
  if (r.currency) out.currency = r.currency;
  return out;
}

/** Puts read fields onto the expense, never over a field the person typed. Returns the names filled. */
export async function applyRead(deps: Deps, id: string, f: ReadFields): Promise<string[]> {
  const row = await deps.db.select().from(expenses).where(eq(expenses.id, id)).get();
  if (!row) return [];
  const edited = new Set(parseList<string[]>(row.editedFields, []));
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || edited.has(k)) continue;
    const cur = row[k as keyof Row];
    if (cur === null || cur === "" || cur === 0 || k === "category" || k === "currency") patch[k] = v;
  }
  const total = (patch.totalCents as number | undefined) ?? row.totalCents;
  const gst = (patch.gstCents as number | undefined) ?? row.gstCents;
  const abn = (patch.supplierAbn as string | undefined) ?? row.supplierAbn;
  if (!edited.has("gstClaimable")) patch.gstClaimable = canClaimGst(total, gst, abn);
  const filled = Object.keys(patch).filter((k) => k !== "gstClaimable");
  await deps.db.update(expenses).set({ ...patch, readState: "done", readToken: null, readFields: JSON.stringify(filled), updatedAt: deps.now() }).where(eq(expenses.id, id));
  return filled;
}

export async function setReadState(deps: Deps, id: string, state: Row["readState"], token: string | null = null) {
  await deps.db.update(expenses).set({ readState: state, readToken: token, updatedAt: deps.now() }).where(eq(expenses.id, id));
}

export async function rowForRead(deps: Deps, a: Actor, id: string) {
  const { row } = await rowFor(deps, a, id);
  if (row.userId !== a.userId) throw new HttpError(403, "own_only", "Only the person who added a receipt can read it again.");
  return row;
}

// ---------------------------------------------------------------- editing

export interface ExpensePatch {
  supplier?: string | null; supplierAbn?: string | null; spentOn?: string | null; totalCents?: number; gstCents?: number; currency?: string; category?: string | null;
  gstClaimable?: boolean; reimbursable?: boolean; note?: string | null; splits?: Split[]; every?: Every | null;
}

export async function updateExpense(deps: Deps, a: Actor, id: string, p: ExpensePatch) {
  const { row, approver } = await rowFor(deps, a, id);
  if (row.userId !== a.userId) throw new HttpError(403, "own_only", "Only the person who added an expense can change it.");
  if (row.status !== "draft" && row.status !== "rejected") throw new HttpError(409, "not_draft", row.status === "approved" ? "Approved expenses cannot be changed." : "This expense is waiting for approval. Withdraw it to make changes.");
  const next = { ...row };
  const set: Record<string, unknown> = {};
  if (p.supplier !== undefined) set.supplier = p.supplier?.trim().slice(0, 200) || null;
  if (p.supplierAbn !== undefined) {
    const abn = cleanAbn(p.supplierAbn);
    if (abn && !abnValid(abn)) throw new HttpError(422, "bad_abn", "That ABN does not look right. It has 11 digits.");
    set.supplierAbn = abn || null;
  }
  if (p.spentOn !== undefined) {
    if (p.spentOn && (!/^\d{4}-\d{2}-\d{2}$/.test(p.spentOn) || Number.isNaN(Date.parse(p.spentOn)))) throw new HttpError(422, "bad_date", "Choose a valid date.");
    set.spentOn = p.spentOn || null;
  }
  for (const k of ["totalCents", "gstCents"] as const) {
    const v = p[k];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v) || v < 0 || v > EXPENSE_MAX_CENTS) throw new HttpError(422, "bad_amount", "Enter an amount of zero or more.");
    set[k] = v;
  }
  if (p.currency !== undefined) set.currency = p.currency;
  if (p.category !== undefined) set.category = p.category?.trim().slice(0, 60) || null;
  if (p.reimbursable !== undefined) set.reimbursable = p.reimbursable;
  if (p.note !== undefined) set.note = p.note?.slice(0, 1000) || null;
  if (p.every !== undefined) {
    if (p.every !== null && !(EVERY as readonly string[]).includes(p.every)) throw new HttpError(422, "bad_every", "Choose how often it repeats.");
    set.every = p.every;
  }
  Object.assign(next, set);
  if (next.gstCents > next.totalCents) throw new HttpError(422, "gst_over_total", "GST cannot be more than the total.");
  if (p.splits !== undefined) {
    const splits = p.splits.map((s) => ({ category: s.category.trim().slice(0, 60), amountCents: s.amountCents, note: s.note?.slice(0, 200) || null }));
    const probs = splitProblems(next.totalCents, splits);
    if (probs.length) throw new HttpError(422, `split_${probs[0]}`, SPLIT_PROBLEM_TEXT[probs[0]]);
    set.splits = JSON.stringify(splits);
  } else if (p.totalCents !== undefined && p.totalCents !== row.totalCents && parseList<Split[]>(row.splits, []).length) {
    set.splits = "[]"; // a new total clears a split that no longer adds up
  }
  if (p.gstClaimable !== undefined) {
    if (p.gstClaimable && needsTaxInvoice(next.totalCents, next.supplierAbn)) throw new HttpError(422, "needs_abn", "Over $82.50 you need a tax invoice that shows the supplier ABN. Add the ABN to claim GST.");
    if (p.gstClaimable && next.gstCents <= 0) throw new HttpError(422, "no_gst", "There is no GST on this receipt to claim.");
    set.gstClaimable = p.gstClaimable;
  } else if (next.gstClaimable && !canClaimGst(next.totalCents, next.gstCents, next.supplierAbn)) {
    set.gstClaimable = false;
  }
  const edited = new Set(parseList<string[]>(row.editedFields, []));
  for (const k of Object.keys(p)) edited.add(k);
  await deps.db.update(expenses).set({ ...set, editedFields: JSON.stringify([...edited]), status: row.status === "rejected" ? "draft" : row.status, updatedAt: deps.now() })
    .where(eq(expenses.id, id));
  return expenseDetail(deps, a, id).then((e) => ({ ...e, can: { ...e.can, decide: approver && e.status === "submitted" } }));
}

export async function deleteExpense(deps: Deps, a: Actor, id: string) {
  const { row } = await rowFor(deps, a, id);
  if (row.userId !== a.userId) throw new HttpError(403, "own_only", "Only the person who added an expense can delete it.");
  if (row.status === "approved" || row.status === "submitted") throw new HttpError(409, "not_draft", "Only drafts and rejected expenses can be deleted.");
  if (row.fileKey) await blobsFor(deps).delete(row.fileKey, row.fileParts);
  await deps.db.delete(expenses).where(eq(expenses.id, id));
  return { ok: true };
}

// ---------------------------------------------------------------- approval

export async function submitExpense(deps: Deps, a: Actor, id: string) {
  const { row } = await rowFor(deps, a, id);
  if (row.userId !== a.userId) throw new HttpError(403, "own_only", "Only the person who added an expense can submit it.");
  if (row.status !== "draft" && row.status !== "rejected") throw new HttpError(409, "not_draft", "This expense was already submitted.");
  const missing = [!row.supplier && "supplier", !row.spentOn && "date", row.totalCents <= 0 && "total"].filter(Boolean);
  if (missing.length) throw new HttpError(422, "missing_fields", `Add the ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")} before you submit.`);
  const probs = splitProblems(row.totalCents, parseList<Split[]>(row.splits, []));
  if (probs.length) throw new HttpError(422, `split_${probs[0]}`, SPLIT_PROBLEM_TEXT[probs[0]]);
  await deps.db.update(expenses).set({ status: "submitted", submittedAt: deps.now(), rejectReason: null, decidedBy: null, decidedByName: null, decidedAt: null, updatedAt: deps.now() })
    .where(eq(expenses.id, id));
  return expenseDetail(deps, a, id);
}

export async function withdrawExpense(deps: Deps, a: Actor, id: string) {
  const { row } = await rowFor(deps, a, id);
  if (row.userId !== a.userId || row.status !== "submitted") throw new HttpError(409, "not_submitted", "Only your own expenses waiting for approval can be withdrawn.");
  await deps.db.update(expenses).set({ status: "draft", submittedAt: null, updatedAt: deps.now() }).where(eq(expenses.id, id));
  return expenseDetail(deps, a, id);
}

/** Owners and admins, plus approvers picked by admins, other than the person themself. */
async function otherApprovers(deps: Deps, orgId: string, s: Settings, self: string): Promise<number> {
  const admins = await deps.db.select({ id: members.userId }).from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.role, ["owner", "admin"]), eq(members.kind, "human"))).limit(200).all();
  return new Set([...admins.map((x) => x.id), ...s.approverIds]).size - (new Set([...admins.map((x) => x.id), ...s.approverIds]).has(self) ? 1 : 0);
}

export async function decideExpense(deps: Deps, a: Actor, id: string, d: { approve: boolean; reason?: string | null }) {
  const { row, settings, approver } = await rowFor(deps, a, id);
  if (!approver) throw new HttpError(403, "approver_only", "Only approvers can approve expenses.");
  if (row.status !== "submitted") throw new HttpError(409, "not_submitted", "This expense is not waiting for approval.");
  if (row.userId === a.userId && (await otherApprovers(deps, a.orgId, settings, a.userId)) > 0) {
    throw new HttpError(403, "own_expense", "Someone else approves your own expenses.");
  }
  const reason = d.reason?.trim().slice(0, 500) || null;
  if (!d.approve && !reason) throw new HttpError(422, "reason_needed", "Say why, so they can fix it.");
  await deps.db.update(expenses).set({
    status: d.approve ? "approved" : "rejected", decidedBy: a.userId, decidedByName: await userName(deps, a.userId, a.email ?? ""), decidedAt: deps.now(),
    rejectReason: d.approve ? null : reason, updatedAt: deps.now(),
  }).where(eq(expenses.id, id));
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: d.approve ? "expenses.approved" : "expenses.rejected", targetType: "expense", targetId: id });
  return expenseDetail(deps, a, id);
}

// ---------------------------------------------------------------- re bill onto an invoice draft

const ddmmyyyy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

export function rebillLine(r: Pick<Row, "supplier" | "spentOn" | "note" | "totalCents" | "gstCents" | "category">, priceMode: "exclusive" | "inclusive") {
  const what = [r.supplier || r.category || "Expense", ddmmyyyy(r.spentOn), r.note].filter(Boolean).join(", ");
  return {
    description: `Re billed: ${what}`.slice(0, 1000), quantityMilli: 1000,
    unitCents: priceMode === "exclusive" ? r.totalCents - r.gstCents : r.totalCents, gstFree: r.gstCents === 0,
  };
}

export async function rebillExpense(deps: Deps, a: Actor & { role: "owner" | "admin" | "member" }, id: string, docId: string) {
  const { row, approver } = await rowFor(deps, a, id);
  if (row.userId !== a.userId && !approver) throw notFound("Expense");
  if (row.rebillDocId) throw new HttpError(409, "already_rebilled", "This expense is already on an invoice.");
  if (row.totalCents <= 0) throw new HttpError(422, "missing_fields", "Add the total before you re bill it.");
  if (row.status === "rejected") throw new HttpError(409, "rejected", "Rejected expenses cannot be re billed.");
  const doc = await deps.db.select().from(invoiceDocs).where(and(eq(invoiceDocs.id, docId), eq(invoiceDocs.orgId, a.orgId))).get();
  if (!doc || doc.kind !== "invoice") throw notFound("Invoice");
  if (doc.status !== "draft") throw new HttpError(409, "not_draft", "Pick a draft invoice. Issued invoices cannot change.");
  const lines = await deps.db.select().from(invoiceLines).where(eq(invoiceLines.docId, docId)).orderBy(invoiceLines.position).all();
  const add = rebillLine(row, doc.priceMode);
  // Claim the expense first so two clicks never add two lines.
  const claimed = await deps.db.update(expenses).set({ rebillDocId: docId, rebillAt: deps.now(), updatedAt: deps.now() })
    .where(and(eq(expenses.id, id), sql`${expenses.rebillDocId} is null`)).returning({ id: expenses.id });
  if (!claimed.length) throw new HttpError(409, "already_rebilled", "This expense is already on an invoice.");
  try {
    await updateDoc(deps, a, docId, { lines: [...lines.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli, unitCents: l.unitCents, gstFree: l.gstFree, itemId: l.itemId })), add] });
  } catch (err) {
    await deps.db.update(expenses).set({ rebillDocId: null, rebillAt: null }).where(eq(expenses.id, id));
    throw err;
  }
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "expenses.rebilled", targetType: "expense", targetId: id, metadata: { docId } });
  return { expense: await expenseDetail(deps, a, id), docId };
}

/** Invoice drafts to re bill onto (newest first). */
export async function rebillTargets(deps: Deps, a: Actor) {
  assertPerson(a);
  return deps.db.select({ id: invoiceDocs.id, buyerName: invoiceDocs.buyerName, totalCents: invoiceDocs.totalCents, createdAt: invoiceDocs.createdAt, reference: invoiceDocs.reference })
    .from(invoiceDocs).where(and(eq(invoiceDocs.orgId, a.orgId), eq(invoiceDocs.kind, "invoice"), eq(invoiceDocs.status, "draft"))).orderBy(desc(invoiceDocs.createdAt)).limit(30).all();
}

// ---------------------------------------------------------------- lists, export, subscriptions

export type View = "mine" | "approve" | "all";
export interface ListQuery { view: View; status?: string; q?: string; from?: string; to?: string; offset?: number }

function whereFor(a: Actor, approver: boolean, q: ListQuery) {
  const conds = [eq(expenses.orgId, a.orgId)];
  if (q.view === "mine" || !approver) conds.push(eq(expenses.userId, a.userId));
  if (q.view === "approve") conds.push(eq(expenses.status, "submitted"));
  else if (q.status && ["draft", "submitted", "approved", "rejected"].includes(q.status)) conds.push(eq(expenses.status, q.status as Row["status"]));
  if (q.from) conds.push(gte(expenses.spentOn, q.from));
  if (q.to) conds.push(lt(expenses.spentOn, `${q.to}~`));
  const text = q.q?.trim();
  if (text) conds.push(containsAny([expenses.supplier, expenses.note, expenses.category, expenses.userName], text));
  return and(...conds);
}

export async function listExpenses(deps: Deps, a: Actor, q: ListQuery) {
  assertPerson(a);
  const s = await getSettings(deps, a.orgId);
  const approver = isApprover(a, s);
  if ((q.view === "approve" || q.view === "all") && !approver) throw new HttpError(403, "approver_only", "Only approvers can see everyone's expenses.");
  const offset = Math.max(0, Math.min(10_000, q.offset ?? 0));
  const rows = await deps.db.select().from(expenses).where(whereFor(a, approver, q)).orderBy(desc(expenses.createdAt)).limit(PAGE + 1).offset(offset).all();
  const waiting = approver
    ? Number((await deps.db.select({ n: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.orgId, a.orgId), eq(expenses.status, "submitted"))).get())?.n ?? 0)
    : 0;
  return { expenses: rows.slice(0, PAGE).map((r) => present(r, a, approver)), next: rows.length > PAGE ? offset + PAGE : null, waiting, canApprove: approver, canManage: isAdmin(a) };
}

export async function exportCsv(deps: Deps, a: Actor, q: ListQuery): Promise<{ csv: string; count: number }> {
  assertPerson(a);
  const s = await getSettings(deps, a.orgId);
  const approver = isApprover(a, s);
  if (q.view !== "mine" && !approver) throw new HttpError(403, "approver_only", "Only approvers can export everyone's expenses.");
  const rows = await deps.db.select().from(expenses).where(whereFor(a, approver, q)).orderBy(expenses.spentOn).limit(5000).all();
  const csv = expensesCsv(rows.map((r) => ({
    spentOn: r.spentOn, supplier: r.supplier, supplierAbn: r.supplierAbn ? formatAbn(r.supplierAbn) : null, category: r.category, totalCents: r.totalCents, gstCents: r.gstCents,
    gstClaimable: r.gstClaimable, status: r.status, userName: r.userName, note: r.note, currency: r.currency, reimbursable: r.reimbursable, splits: parseList<Split[]>(r.splits, []), rebilled: !!r.rebillDocId,
  })));
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "expenses.exported", metadata: { rows: rows.length, view: q.view } });
  return { csv, count: rows.length };
}

export interface SubscriptionRow { supplier: string; every: Every; amountCents: number; lastOn: string; nextOn: string; perYearCents: number; count: number; suggested: boolean; expenseId: string }

/** Repeating costs: expenses marked as repeating, plus suppliers that look like they repeat (2 or more about one period apart, amounts within 10 percent). */
export async function subscriptions(deps: Deps, a: Actor) {
  assertPerson(a);
  const s = await getSettings(deps, a.orgId);
  const approver = isApprover(a, s);
  const since = new Date(deps.now().getTime() - 400 * 86_400_000).toISOString().slice(0, 10);
  const conds = [eq(expenses.orgId, a.orgId), gte(expenses.spentOn, since), sql`${expenses.status} <> 'rejected'`, sql`${expenses.supplier} is not null`];
  if (!approver) conds.push(eq(expenses.userId, a.userId));
  const rows = await deps.db.select({ id: expenses.id, supplier: expenses.supplier, spentOn: expenses.spentOn, totalCents: expenses.totalCents, every: expenses.every })
    .from(expenses).where(and(...conds)).orderBy(expenses.spentOn).limit(3000).all();
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = (r.supplier ?? "").trim().toLowerCase();
    if (!k || !r.spentOn) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: SubscriptionRow[] = [];
  for (const g of groups.values()) {
    const last = g[g.length - 1];
    const marked = [...g].reverse().find((r) => r.every && (EVERY as readonly string[]).includes(r.every));
    let every = (marked?.every as Every | undefined) ?? null;
    let suggested = false;
    if (!every) {
      const amounts = g.map((r) => r.totalCents);
      const similar = Math.max(...amounts) <= Math.min(...amounts) * 1.1;
      every = similar ? guessEvery(g.map((r) => r.spentOn as string)) : null;
      suggested = !!every;
    }
    if (!every) continue;
    out.push({ supplier: last.supplier as string, every, amountCents: last.totalCents, lastOn: last.spentOn as string, nextOn: nextExpected(last.spentOn as string, every),
      perYearCents: perYear(last.totalCents, every), count: g.length, suggested, expenseId: last.id });
  }
  out.sort((x, y) => x.nextOn.localeCompare(y.nextOn));
  return { subscriptions: out, perYearCents: out.reduce((n, r) => n + r.perYearCents, 0) };
}

// ---------------------------------------------------------------- receipts by mail

export interface MailReceipt { rcpt: string; fromAddress: string; subject: string | null; dmarcFail: boolean; attachments: { filename: string; contentType: string; content: Uint8Array }[] }
export type MailOutcome = { handled: false } | { handled: true; accepted: boolean; reason: string; created: string[] };

/** A forward to receipts.<token>@<shared domain>: drafts for the member who sent it. Returns handled false for any other address. */
export async function receiveReceiptMail(deps: Deps, m: MailReceipt): Promise<MailOutcome> {
  const domain = deps.config.freeMail?.domain?.toLowerCase();
  const [local, host] = m.rcpt.toLowerCase().split("@");
  const tok = local?.match(RECEIPTS_LOCAL_RE)?.[1];
  if (!domain || host !== domain || !tok) return { handled: false };
  const no = (reason: string): MailOutcome => ({ handled: true, accepted: false, reason, created: [] });
  // OPS1 feature flags: both on for the receiving workspace. With no operator override that is the env value, read
  // before any query as before; when some workspace differs, the receiving workspace is looked up first.
  const on = (org?: string) => featureOn(deps, "expensesR106", org) && featureOn(deps, "invoicesEnabled", org);
  const varies = featureVariesByWorkspace(deps, "expensesR106") || featureVariesByWorkspace(deps, "invoicesEnabled");
  if (!varies && !on()) return no("No mailbox here.");
  const s = await deps.db.select({ orgId: expenseSettings.orgId }).from(expenseSettings).where(eq(expenseSettings.receiptsToken, tok)).get();
  if (!s || !on(s.orgId) || (await excludedOrg(deps, s.orgId))) return no("No mailbox here.");
  if (m.dmarcFail) return no("This mail did not pass sender checks.");
  const from = m.fromAddress.trim().toLowerCase();
  const who = await deps.db.select({ id: users.id, email: users.email, name: users.name, role: members.role }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, s.orgId), eq(members.kind, "human"), sql`lower(${users.email}) = ${from}`)).get();
  if (!who) return no("This address takes receipts only from people in the workspace, sent from their sign in address.");
  const files = m.attachments.filter((f) => receiptTypeOk(f.contentType, f.filename) && f.content.length > 0 && f.content.length <= RECEIPT_MAX_BYTES).slice(0, MAIL_RECEIPTS_MAX);
  if (!files.length) return no("Attach a photo or a PDF of the receipt.");
  const actor: Actor = { orgId: s.orgId, userId: who.id, email: who.email, name: who.name, role: who.role };
  const created: string[] = [];
  for (const f of files) {
    try {
      const e = await addExpense(deps, actor, { source: "email", file: { bytes: f.content, name: f.filename, type: f.contentType }, note: m.subject?.replace(/^(fwd?|fw):\s*/i, "").slice(0, 200) || null });
      created.push(e.id);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) break;
      throw err;
    }
  }
  await audit(deps.db, { orgId: s.orgId, actorUserId: who.id, actorEmail: who.email, action: "expenses.mail_in", metadata: { created: created.length } });
  return created.length ? { handled: true, accepted: true, reason: "Receipts added.", created } : no("You have added the most receipts for today.");
}

/** Rounds kept in one place for tests: GST on a re billed inclusive line equals one eleventh. */
export const _internals = { divRound };
