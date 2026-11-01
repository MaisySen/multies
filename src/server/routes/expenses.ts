/**
 * R106: expenses and receipts API (signed in people; flags INVOICES_ENABLED and EXPENSES_R106; the client workspace is
 * out). Members see their own; approvers, owners and admins see all. Money is integer cents.
 *   GET /api/expenses?view=mine|approve|all&status&q&from&to&offset, GET /api/expenses/export.csv (same query)
 *   PUT /api/expenses/upload?source=upload|camera&name= (raw body, x-multies-upload: 1), POST /api/expenses (no receipt)
 *   GET|PUT /api/expenses/settings, GET /api/expenses/subscriptions, GET /api/expenses/rebill-targets
 *   GET|PATCH|DELETE /api/expenses/:id, GET /api/expenses/:id/receipt, POST /api/expenses/:id/read
 *   POST /api/expenses/:id/submit | withdraw | approve | reject | rebill
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import {
  addExpense, applyRead, decideExpense, deleteExpense, excludedOrg, expenseDetail, exportCsv, fieldsFromRow, listExpenses, rebillExpense, rebillTargets, receiptBytes,
  receiptFile, rowForRead, saveSettings, setReadState, settingsView, submitExpense, subscriptions, updateExpense, withdrawExpense, type View,
} from "../services/expenses/expenses";
import { extractInvoice } from "../services/tools/ai-docs";
import { toolFeatureOn } from "../services/tools/features";
import { docFor, fillInvoices, startEngineJob } from "./tools-ai";
import { CURRENCIES } from "@/shared/invoices";
import { EVERY, MAX_SPLITS, RECEIPT_MAX_BYTES } from "@/shared/expenses";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Split = z.object({ category: z.string().min(1).max(60), amountCents: z.number().int(), note: z.string().max(200).nullable().optional() });
const PatchBody = z.object({
  supplier: z.string().max(200).nullable().optional(), supplierAbn: z.string().max(20).nullable().optional(), spentOn: date.nullable().optional().or(z.literal("").transform(() => null)),
  totalCents: z.number().int().optional(), gstCents: z.number().int().optional(), currency: z.enum(CURRENCIES).optional(), category: z.string().max(60).nullable().optional(),
  gstClaimable: z.boolean().optional(), reimbursable: z.boolean().optional(), note: z.string().max(1000).nullable().optional(),
  splits: z.array(Split).max(MAX_SPLITS + 5).optional(), every: z.enum(EVERY).nullable().optional(),
}).strict();
const SettingsBody = z.object({ approverIds: z.array(z.string().min(1).max(80)).max(50).optional(), resetAddress: z.boolean().optional() }).strict();
const RejectBody = z.object({ reason: z.string().max(500) });
const RebillBody = z.object({ docId: z.string().min(1).max(80) });
const NewBody = z.object({ note: z.string().max(500).nullable().optional() }).strict();

const reads = new RateLimiter(120, 60_000);

function view(c: Context<AppEnv>) {
  const v = c.req.query("view") ?? "mine";
  if (v !== "mine" && v !== "approve" && v !== "all") throw new HttpError(422, "validation_failed", "Unknown view.");
  const d = (k: string) => { const s = c.req.query(k); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined; };
  return { view: v as View, status: c.req.query("status") || undefined, q: (c.req.query("q") ?? "").slice(0, 100) || undefined, from: d("from"), to: d("to"), offset: Number(c.req.query("offset") ?? "0") || 0 };
}

async function readBody(c: Context<AppEnv>): Promise<Uint8Array> {
  if (c.req.header("x-multies-upload") !== "1") throw new HttpError(400, "bad_request", "Upload from the Expenses page.");
  const tooBig = () => new HttpError(413, "receipt_too_large", `Receipts can be up to ${RECEIPT_MAX_BYTES / (1024 * 1024)} MB.`);
  if (Number(c.req.header("content-length") ?? "0") > RECEIPT_MAX_BYTES) throw tooBig();
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > RECEIPT_MAX_BYTES) { await reader.cancel(); throw tooBig(); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}

/** Test and local only: the receipt's own bytes are its text (no engine). Never in production. */
const fakeRead = (c: Context<AppEnv>) => c.var.deps.config.mode !== "production" && !!c.var.deps.config.expensesFakeRead;

/** Starts reading the receipt, or checks a read in progress and fills the fields when it is done. */
async function readReceipt(c: Context<AppEnv>, id: string) {
  const { deps, auth } = c.var;
  const row = await rowForRead(deps, auth, id);
  if (!row.fileKey) throw new HttpError(422, "no_receipt", "Add a receipt first.");
  if (!reads.take(auth.userId)) throw new HttpError(429, "slow_down", "Slow down a little.");
  if (fakeRead(c)) {
    const bytes = await receiptBytes(deps, row);
    const text = new TextDecoder().decode(bytes ?? new Uint8Array());
    await applyRead(deps, id, fieldsFromRow(extractInvoice({ pages: [{ page: 1, text }] }, row.fileName ?? "receipt")));
    return { expense: await expenseDetail(deps, auth, id), note: null };
  }
  if (row.readState === "reading" && row.readToken) {
    try {
      const { rows, note } = await fillInvoices(c, "expenses", [{ token: row.readToken }], toolFeatureOn(c, "expenses"));
      await applyRead(deps, id, fieldsFromRow(rows[0]));
      return { expense: await expenseDetail(deps, auth, id), note };
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return { expense: await expenseDetail(deps, auth, id), note: null };
      await setReadState(deps, id, "failed");
      const msg = err instanceof HttpError && err.status < 500 ? err.message : "The receipt could not be read. Fill in the details yourself.";
      return { expense: await expenseDetail(deps, auth, id), note: msg };
    }
  }
  try {
    const bytes = await receiptBytes(deps, row);
    if (!bytes) throw new HttpError(410, "expired", "The receipt file is missing.");
    const fd = new FormData();
    fd.append("ocr", "auto");
    fd.append("language", "eng");
    fd.append("files", new Blob([bytes as BlobPart], { type: row.fileType ?? "application/octet-stream" }), row.fileName ?? "receipt");
    const job = await startEngineJob(c, "extract-text", fd, row.fileName ?? "receipt", "expense");
    await setReadState(deps, id, "reading", job.token);
    return { expense: await expenseDetail(deps, auth, id), note: null };
  } catch (err) {
    // Tools off for the workspace, its monthly runs used, or the engine busy: the person fills the fields in.
    await setReadState(deps, id, "unavailable");
    const msg = err instanceof HttpError && (err.status === 429 || err.status === 413) ? err.message : "Reading receipts is not available right now. Fill in the details yourself.";
    return { expense: await expenseDetail(deps, auth, id), note: msg };
  }
}
void docFor;

export function expenseRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      const cfg = c.var.deps.config;
      if (!cfg.invoicesEnabled || !cfg.expensesR106 || (await excludedOrg(c.var.deps, c.var.auth.orgId))) throw notFound("Page");
      await next();
    })
    .get("/", async (c) => c.json(await listExpenses(c.var.deps, c.var.auth, view(c))))
    .get("/export.csv", async (c) => {
      const q = view(c);
      const { csv } = await exportCsv(c.var.deps, c.var.auth, q);
      const day = c.var.deps.now().toISOString().slice(0, 10);
      return new Response(`\ufeff${csv}`, { status: 200, headers: {
        "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="expenses-${day}.csv"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      } });
    })
    .get("/settings", async (c) => c.json(await settingsView(c.var.deps, c.var.auth)))
    .put("/settings", async (c) => c.json(await saveSettings(c.var.deps, c.var.auth, await parseBody(c, SettingsBody))))
    .get("/subscriptions", async (c) => c.json(await subscriptions(c.var.deps, c.var.auth)))
    .get("/rebill-targets", async (c) => c.json({ invoices: (await rebillTargets(c.var.deps, c.var.auth)).map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })) }))
    .post("/", async (c) => c.json({ expense: await addExpense(c.var.deps, c.var.auth, { source: "upload", note: (await parseBody(c, NewBody)).note ?? null }) }, 201))
    .put("/upload", async (c) => {
      const source = c.req.query("source") === "camera" ? "camera" : "upload";
      const bytes = await readBody(c);
      const name = (c.req.query("name") ?? "receipt").slice(0, 200);
      return c.json({ expense: await addExpense(c.var.deps, c.var.auth, { source, file: { bytes, name, type: c.req.header("content-type") ?? "" } }) }, 201);
    })
    .get("/:id", async (c) => c.json({ expense: await expenseDetail(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ expense: await updateExpense(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PatchBody)) }))
    .delete("/:id", async (c) => c.json(await deleteExpense(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/receipt", async (c) => {
      const f = await receiptFile(c.var.deps, c.var.auth, c.req.param("id"));
      const inline = c.req.query("inline") === "1" && /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type);
      return new Response(f.stream, { status: 200, headers: {
        "content-type": inline ? f.type : "application/octet-stream", "content-length": String(f.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff", "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      } });
    })
    .post("/:id/read", async (c) => c.json(await readReceipt(c, c.req.param("id"))))
    .post("/:id/submit", async (c) => c.json({ expense: await submitExpense(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/withdraw", async (c) => c.json({ expense: await withdrawExpense(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/approve", async (c) => c.json({ expense: await decideExpense(c.var.deps, c.var.auth, c.req.param("id"), { approve: true }) }))
    .post("/:id/reject", async (c) => c.json({ expense: await decideExpense(c.var.deps, c.var.auth, c.req.param("id"), { approve: false, reason: (await parseBody(c, RejectBody)).reason }) }))
    .post("/:id/rebill", async (c) => c.json(await rebillExpense(c.var.deps, c.var.auth as typeof c.var.auth & { role: "owner" | "admin" | "member" }, c.req.param("id"), (await parseBody(c, RebillBody)).docId)));
}
