/**
 * R105: invoices and quotes API (signed in, flag INVOICES_ENABLED). Members view and draft; owners and admins issue,
 * void, take payments and change settings. Money is integer cents; quantities thousandths.
 *   GET|PUT /api/invoices/settings
 *   GET|POST /api/invoices/items, PATCH /api/invoices/items/:id
 *   GET|POST /api/invoices/suppliers
 *   GET /api/invoices/reports/aged, GET /api/invoices/reports/gst?from&to&basis
 *   GET|POST /api/invoices/docs, GET|PATCH|DELETE /api/invoices/docs/:id
 *   POST /api/invoices/docs/:id/issue | void | convert | payments | send, DELETE /api/invoices/docs/:id/payments/:pid
 *   PUT /api/invoices/docs/:id/repeat, GET /api/invoices/docs/:id/pdf
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import {
  agedReceivables, convertQuote, createDoc, createItem, createSupplier, deleteDraft, deletePayment, docDetail, getSettings, gstReport, issueDoc, listDocs, listItems,
  listSuppliers, presentSettings, recordPayment, saveSettings, setRepeat, updateDoc, updateItem, voidDoc, answerQuote, findByToken, markViewed,
} from "../services/invoices/invoices";
import { pdfForDoc, pdfForToken, publicView, sendDoc } from "../services/invoices/deliver";
import { basQuarter, CURRENCIES, PAYMENT_METHODS } from "@/shared/invoices";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const str = (n: number) => z.string().max(n);
const cents = z.number().int();
const Line = z.object({ description: str(1000), quantityMilli: z.number().int().min(0), unitCents: cents, gstFree: z.boolean().optional(), itemId: z.string().max(64).nullable().optional() });
const DocBody = z.object({
  contactId: z.string().max(64).nullable().optional(), supplierId: z.string().max(64).nullable().optional(), dealId: z.string().max(64).nullable().optional(),
  buyerName: str(200).nullable().optional(), buyerEmail: z.string().email().max(254).nullable().optional().or(z.literal("").transform(() => null)),
  buyerAbn: str(20).nullable().optional(), buyerAddress: str(500).nullable().optional(), issueDate: date.nullable().optional(), dueDate: date.nullable().optional(),
  currency: z.enum(CURRENCIES).optional(), priceMode: z.enum(["exclusive", "inclusive"]).optional(), reference: str(100).nullable().optional(),
  notes: str(2000).nullable().optional(), terms: str(2000).nullable().optional(), lines: z.array(Line).max(200).optional(),
});
const CreateBody = DocBody.extend({ kind: z.enum(["quote", "invoice", "credit_note", "bill"]), sourceId: z.string().max(64).nullable().optional() });
const SettingsBody = z.object({
  businessName: str(200).optional(), abn: str(20).nullable().optional(), gstRegistered: z.boolean().optional(), priceMode: z.enum(["exclusive", "inclusive"]).optional(),
  currency: z.enum(CURRENCIES).optional(), termsDays: z.number().int().min(0).max(365).optional(), address: str(500).nullable().optional(),
  email: z.string().email().max(254).nullable().optional().or(z.literal("").transform(() => null)), phone: str(40).nullable().optional(), bankName: str(100).nullable().optional(),
  bsb: str(10).nullable().optional(), accountNumber: str(12).nullable().optional(), accountName: str(100).nullable().optional(), payNote: str(500).nullable().optional(),
  footer: str(500).nullable().optional(), prefixInvoice: z.string().regex(/^[A-Za-z0-9]{0,8}$/).nullable().optional(), prefixQuote: z.string().regex(/^[A-Za-z0-9]{0,8}$/).nullable().optional(),
  prefixCredit: z.string().regex(/^[A-Za-z0-9]{0,8}$/).nullable().optional(), remindBeforeDays: z.number().int().min(0).max(30).optional(), remindAfterDays: z.number().int().min(0).max(60).optional(),
});
const ItemBody = z.object({ name: str(200).min(1), description: str(1000).optional(), unitCents: cents, gstFree: z.boolean().optional() });
const SupplierBody = z.object({ name: str(200).min(1), abn: str(20).nullable().optional(), email: z.string().email().max(254).nullable().optional(), phone: str(40).nullable().optional(), notes: str(1000).optional() });
const PaymentBody = z.object({ amountCents: cents, paidOn: date.optional(), method: z.enum(PAYMENT_METHODS).optional(), reference: str(100).nullable().optional() });
const RepeatBody = z.object({ every: z.enum(["week", "fortnight", "month", "quarter", "year"]), startDate: date.optional(), endDate: date.nullable().optional(), autoSend: z.boolean().optional() }).nullable();

export function invoiceRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { if (!c.var.deps.config.invoicesEnabled) throw new HttpError(404, "not_found", "Not found."); await next(); })
    .get("/settings", async (c) => c.json({ settings: presentSettings(await getSettings(c.var.deps, c.var.auth.orgId)), canManage: c.var.auth.role === "owner" || c.var.auth.role === "admin" }))
    .put("/settings", async (c) => c.json({ settings: await saveSettings(c.var.deps, c.var.auth, await parseBody(c, SettingsBody)) }))
    .get("/items", async (c) => c.json({ items: await listItems(c.var.deps, c.var.auth.orgId, c.req.query("q") || undefined) }))
    .post("/items", async (c) => c.json({ item: await createItem(c.var.deps, c.var.auth, await parseBody(c, ItemBody)) }, 201))
    .patch("/items/:id", async (c) => c.json({ item: await updateItem(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ItemBody.partial().extend({ archived: z.boolean().optional() }))) }))
    .get("/suppliers", async (c) => c.json({ suppliers: await listSuppliers(c.var.deps, c.var.auth.orgId) }))
    .post("/suppliers", async (c) => c.json({ supplier: await createSupplier(c.var.deps, c.var.auth, await parseBody(c, SupplierBody)) }, 201))
    .get("/reports/aged", async (c) => c.json(await agedReceivables(c.var.deps, c.var.auth.orgId)))
    .get("/reports/gst", async (c) => {
      const q = basQuarter(c.var.deps.now().toISOString().slice(0, 10));
      const from = date.safeParse(c.req.query("from")).data ?? q.from, to = date.safeParse(c.req.query("to")).data ?? q.to;
      return c.json({ ...(await gstReport(c.var.deps, c.var.auth.orgId, from, to, c.req.query("basis") === "cash" ? "cash" : "accrual")), quarter: q });
    })
    .get("/docs", async (c) => {
      const kind = z.enum(["quote", "invoice", "credit_note", "bill"]).catch("invoice").parse(c.req.query("kind"));
      return c.json(await listDocs(c.var.deps, c.var.auth.orgId, { kind, state: c.req.query("state") || undefined, q: c.req.query("q") || undefined,
        contactId: c.req.query("contactId") || undefined, limit: Number(c.req.query("limit")) || undefined, offset: Number(c.req.query("offset")) || undefined }));
    })
    .post("/docs", async (c) => { const { kind, ...b } = await parseBody(c, CreateBody); return c.json({ doc: await createDoc(c.var.deps, c.var.auth, kind, b) }, 201); })
    .get("/docs/:id", async (c) => c.json({ doc: await docDetail(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/docs/:id", async (c) => c.json({ doc: await updateDoc(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DocBody)) }))
    .delete("/docs/:id", async (c) => c.json(await deleteDraft(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/docs/:id/issue", async (c) => c.json({ doc: await issueDoc(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/docs/:id/void", async (c) => c.json({ doc: await voidDoc(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ reason: str(300).optional() }))).reason ?? "") }))
    .post("/docs/:id/convert", async (c) => c.json({ doc: await convertQuote(c.var.deps, c.var.auth, c.req.param("id")) }, 201))
    .post("/docs/:id/payments", async (c) => c.json({ doc: await recordPayment(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PaymentBody)) }))
    .delete("/docs/:id/payments/:pid", async (c) => c.json({ doc: await deletePayment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid")) }))
    .put("/docs/:id/repeat", async (c) => c.json({ doc: await setRepeat(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, RepeatBody)) }))
    .post("/docs/:id/send", async (c) => c.json(await sendDoc(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SendBody))))
    .get("/docs/:id/pdf", async (c) => pdfResponse(await pdfForDoc(c.var.deps, c.var.auth, c.req.param("id")), c.req.query("download") === "1"));
}

const SendBody = z.object({ to: z.string().email().max(254).nullable().optional(), message: str(2000).nullable().optional() });

function pdfResponse(p: { bytes: Uint8Array; name: string }, download: boolean) {
  return new Response(p.bytes as unknown as BodyInit, { headers: { "content-type": "application/pdf", "cache-control": "private, no-store", "x-robots-tag": "noindex",
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${p.name}"` } });
}

/**
 * Logged out view link for one issued document (the buyer's copy): GET /api/invoice-view/:token, GET .../pdf, POST .../answer
 * (quotes only: accept or decline). Shows that one document only; drafts, bills and unknown tokens are 404.
 */
export function invoicePublicRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!c.var.deps.config.invoicesEnabled) throw new HttpError(404, "not_found", "Not found."); await next(); c.header("x-robots-tag", "noindex"); c.header("cache-control", "private, no-store"); })
    .get("/:token", async (c) => {
      const f = await findByToken(c.var.deps, c.req.param("token"));
      if (!f || f.raw.kind === "bill") throw new HttpError(404, "not_found", "This link is not valid. Ask the sender for a new one.");
      if (!f.raw.viewedAt) await markViewed(c.var.deps, f.raw.id);
      return c.json({ doc: publicView(f) });
    })
    .get("/:token/pdf", async (c) => {
      const p = await pdfForToken(c.var.deps, c.req.param("token"));
      if (!p) throw new HttpError(404, "not_found", "This link is not valid. Ask the sender for a new one.");
      return pdfResponse(p, c.req.query("download") === "1");
    })
    .post("/:token/answer", async (c) => {
      const { answer } = await parseBody(c, z.object({ answer: z.enum(["accepted", "declined"]) }));
      const r = await answerQuote(c.var.deps, c.req.param("token"), answer);
      return c.json({ ok: true, status: r.status });
    });
}
