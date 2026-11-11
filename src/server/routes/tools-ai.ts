/**
 * Tools P2 H3: AI document features (/api/tools/ai). Flags: ask, translate, extract, expenses, contracts.
 * Text comes from the engine (extract-text, segments); AI goes only through services/tools/ai-meter (own key,
 * then the free daily allocation behind the hard 9,000 unit stop). Engine jobs reuse the P1 job tokens, so
 * GET /api/tools/jobs/:token and its download link work for every job started here.
 *
 * Flow: start a reading job (POST /read or /read/upload) -> poll GET /api/tools/jobs/:token -> call the
 * feature with the token (ask, translate, invoices, contract). The engine keeps a job's output for 1 hour.
 */
import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError, notFound, planLimit } from "../lib/errors";
import { inIds } from "../lib/sql-chunks";
import { attachments, messages } from "../db/schema";
import { attachmentBytes } from "../services/mail/store";
import { mailboxScope } from "../services/team";
import { audit } from "../services/audit";
import { engineFetch, type EngineConfig } from "../services/tools/engine-client";
import { mintToken, readToken } from "../services/tools/tokens";
import { readToolState, toolLimits, toolsOnFor, type ToolState } from "../services/tools/usage";
import { requireToolFeature, toolFeatureOn } from "../services/tools/features";
import { aiUsage, askAi, isTranslateLanguage, TRANSLATE_LANGUAGES, type AiResult } from "../services/tools/ai-meter";
import {
  applyContractFill, applyInvoiceFill, bullets, chunkDoc, citedPages, cleanRow, contractFillPrompt, contractMissing, contractReminders,
  docChars, expenseTotals, extractContract, extractInvoice, INVOICE_HEADERS, invoiceCells, invoiceFillPrompt, missingFields,
  parseJsonObject, pickChunks, questionPrompt, readDocText, spreadChunks, summaryPrompt, type DocText, type InvoiceRow,
} from "../services/tools/ai-docs";
import { writeCsv, writeXlsx, type Cell } from "../services/tools/xlsx-writer";
import { createTask } from "../services/suite/tasks";
import type { ToolFeature } from "@/shared/tool-features";
import type { ToolJob, ToolOp } from "@/shared/tools";
import { containsAny } from "../lib/like-search";

export const AI_FEATURES: ToolFeature[] = ["ask", "translate", "extract", "expenses", "contracts"];
const READ_FEATURES = ["ask", "extract", "expenses", "contracts", "translate"] as const;
/** Page and size caps that keep one document inside the free AI allowance. */
export const AI_CAPS = { askChars: 9_000, translatePages: 20, translateChars: 60_000, translateBatch: 40, extractFiles: 20, reminderMax: 4, receiptsList: 50 } as const;
const OUTPUT_JSON_MAX = 6 * 1024 * 1024;
const MULTIPART_ALLOWANCE = 64 * 1024;
const UPLOAD_HEADER = "x-multies-upload";

const READABLE = /\.(pdf|docx|png|jpe?g|webp|tiff?)$/i;
const SEGMENTABLE = /\.(pdf|docx)$/i;

function setup(c: Context<AppEnv>) {
  const t = c.var.deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) throw notFound("Page");
  return { engine: t.engine as EngineConfig, tokenKey: t.tokenKey };
}

function requireAnyAi(c: Context<AppEnv>) {
  if (!AI_FEATURES.some((f) => toolFeatureOn(c, f))) throw notFound("Page");
}

async function stateFor(c: Context<AppEnv>): Promise<ToolState> {
  const s = await readToolState(c.var.deps.db, c.var.auth.orgId, c.var.deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
  return s;
}

function checkRuns(s: ToolState, runs: number) {
  const l = toolLimits(s.plan);
  if (s.month + runs > l.runsMonthly) throw planLimit(`Your workspace has used all ${l.runsMonthly} tool runs this month. They reset on the 1st.`);
  if (s.day + runs > l.runsDaily) throw planLimit(`Your workspace has used all ${l.runsDaily} tool runs for today. Try again tomorrow.`);
}

async function callEngine(c: Context<AppEnv>, engine: EngineConfig, init: Parameters<typeof engineFetch>[2]) {
  try {
    return await engineFetch(c.var.deps.fetch, engine, init);
  } catch (err) {
    c.var.log?.warn("tools.engine_unreachable", { error: String(err) });
    throw new HttpError(503, "engine_unavailable", "Tools are busy right now. Try again in a minute.");
  }
}

async function engineFail(res: Response): Promise<never> {
  const b = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (res.status === 413) throw new HttpError(413, "too_large", b?.message || "That file is too big for this tool.");
  if (res.status >= 400 && res.status < 500) throw new HttpError(422, "tool_input", b?.message || "That file could not be read.");
  throw new HttpError(503, "engine_unavailable", "Tools are busy right now. Try again in a minute.");
}

const safeName = (s: string) => s.replace(/[\r\n"\\/]/g, "_").slice(0, 120);
const base = (s: string) => s.replace(/\.[a-z0-9]{2,5}$/i, "") || "document";

/** Posts one engine job and returns a P1 style status token. Counts one tool run and writes one audit row. */
export async function startEngineJob(c: Context<AppEnv>, op: string, fd: FormData, name: string, source: string) {
  const { engine, tokenKey } = setup(c);
  const { auth, deps } = c.var;
  const req = new Request("http://tools.local/", { method: "POST", body: fd });
  const body = new Uint8Array(await req.arrayBuffer());
  const s = await stateFor(c);
  const limits = toolLimits(s.plan);
  if (body.byteLength > limits.maxBytes + MULTIPART_ALLOWANCE) throw new HttpError(413, "too_large", `Files can add up to ${Math.round(limits.maxBytes / (1024 * 1024))} MB on your plan.`);
  checkRuns(s, 1);
  const res = await callEngine(c, engine, {
    method: "POST", path: `/internal/v1/jobs?op=${op}`, ws: auth.orgId, user: auth.userId, maxBytes: limits.maxBytes + MULTIPART_ALLOWANCE,
    body: new Blob([body]).stream(), contentLength: body.byteLength, contentType: req.headers.get("content-type") ?? "",
  });
  if (res.status !== 202) await engineFail(res);
  const job = (await res.json()) as { id: string; status: ToolJob["status"] };
  const now = deps.now();
  // R66 (MB-256): counted by the status read that sees it finished (GET /api/tools/jobs/:token), not here.
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.id, metadata: { op, source, files: 1, bytes_in: body.byteLength }, ip: c.var.ip });
  const token = await mintToken(tokenKey, { k: "s", j: job.id, w: auth.orgId, u: auth.userId, o: op as ToolOp, n: name, b: body.byteLength }, now.getTime());
  return { token, op: op as ToolOp, status: job.status, name } satisfies ToolJob;
}

/** The workspace's own attachments (respecting mailbox access), in the order asked. */
async function ownAttachments(c: Context<AppEnv>, ids: string[]) {
  const { auth, deps } = c.var;
  const scope = await mailboxScope(deps.db, auth);
  const rows = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId, threadId: messages.threadId }).from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(inIds(attachments.id, ids), eq(messages.orgId, auth.orgId))).all();
  const byId = new Map(rows.filter((r) => !scope || scope.includes(r.mailboxId)).map((r) => [r.a.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw notFound("Attachment");
    return r;
  });
}

async function attachmentBlob(c: Context<AppEnv>, a: typeof attachments.$inferSelect): Promise<Blob> {
  const bytes = await attachmentBytes(a, c.var.deps.bodyStore);
  if (!bytes) throw new HttpError(422, "tool_input", "That attachment is not stored, so it cannot be used here.");
  return new Blob([bytes as BlobPart], { type: a.contentType || "application/octet-stream" });
}

/** Reads a finished job's JSON output (extract-text or segments). 409 while it is still running. */
async function jobJson(c: Context<AppEnv>, token: string): Promise<{ data: unknown; name: string }> {
  const { engine, tokenKey } = setup(c);
  const { auth, deps } = c.var;
  const t = await readToken(tokenKey, token, "s", deps.now().getTime());
  if (!t || t.w !== auth.orgId) throw notFound("Job");
  const st = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
  if (st.status === 404) throw new HttpError(410, "expired", "This file has expired. Open it again.");
  if (!st.ok) await engineFail(st);
  const j = (await st.json()) as { status: string; error?: string };
  if (j.status === "failed") throw new HttpError(422, "tool_input", j.error || "The file could not be read.");
  if (j.status !== "done") throw new HttpError(409, "not_ready", "Still reading the file.");
  const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
  if (res.status === 404) throw new HttpError(410, "expired", "This file has expired. Open it again.");
  if (!res.ok) await engineFail(res);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > OUTPUT_JSON_MAX) throw new HttpError(413, "too_large", "That document has too much text for this feature.");
  const text = await res.text();
  if (text.length > OUTPUT_JSON_MAX) throw new HttpError(413, "too_large", "That document has too much text for this feature.");
  try { return { data: JSON.parse(text) as unknown, name: t.n }; } catch { throw new HttpError(422, "tool_input", "The file could not be read."); }
}

export async function docFor(c: Context<AppEnv>, token: string): Promise<{ doc: DocText; name: string }> {
  const { data, name } = await jobJson(c, token);
  const doc = readDocText(data);
  if (docChars(doc) < 3) throw new HttpError(422, "no_text", "No text was found in this file. If it is a scan, try again with text recognition on.");
  return { doc, name };
}

const aiFail = (r: AiResult): never => {
  if (r.ok) throw new Error("unreachable");
  throw new HttpError(r.reason === "limit" || r.reason === "workspace_limit" ? 429 : r.reason === "too_big" ? 413 : 503, `ai_${r.reason}`, r.message);
};

const readSchema = z.object({
  attachmentIds: z.array(z.string().min(1).max(80)).min(1).max(AI_CAPS.extractFiles),
  feature: z.enum(READ_FEATURES),
  ocr: z.enum(["auto", "no", "yes"]).optional(),
  language: z.string().regex(/^[a-z_+]{3,20}$/).optional(),
});
const askSchema = z.object({ token: z.string().min(10).max(1200), question: z.string().max(500).optional() });
const translateSchema = z.object({ token: z.string().min(10).max(1200), target: z.string(), offset: z.number().int().min(0).max(5000).default(0), count: z.number().int().min(1).max(AI_CAPS.translateBatch).default(AI_CAPS.translateBatch) });
const applySchema = z.object({ attachmentId: z.string().min(1).max(80), target: z.string(), translations: z.record(z.string(), z.string().max(4000)) });
const invoicesSchema = z.object({ feature: z.enum(["extract", "expenses"]), files: z.array(z.object({ token: z.string().min(10).max(1200), attachmentId: z.string().max(80).optional() })).min(1).max(AI_CAPS.extractFiles), ai: z.boolean().default(true) });
const sheetSchema = z.object({ feature: z.enum(["extract", "expenses"]), format: z.enum(["xlsx", "csv"]), rows: z.array(z.unknown()).min(1).max(200), title: z.string().max(80).optional() });
const reportSchema = z.object({ rows: z.array(z.unknown()).min(1).max(200), title: z.string().max(80).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional() });
const packSchema = z.object({ summaryToken: z.string().min(10).max(1200), attachmentIds: z.array(z.string().min(1).max(80)).max(30), title: z.string().max(80).optional() });
const contractSchema = z.object({ token: z.string().min(10).max(1200) });
const remindersSchema = z.object({ attachmentId: z.string().max(80).optional(), name: z.string().max(200), reminders: z.array(z.object({ title: z.string().min(1).max(200), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).min(1).max(AI_CAPS.reminderMax) });

async function parse<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw new HttpError(400, "bad_request", "Something in the request is missing or not valid.");
  return r.data;
}

const esc = (s: string) => s.replace(/[&<>"'{}]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "{": "&#123;", "}": "&#125;" })[ch]!);
const fmt = (n: number | null) => (n === null ? "" : n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** The expense summary page, fully built and escaped here (render gets no data, so nothing is filled in later). */
export function expenseSummaryHtml(rows: InvoiceRow[], title: string, workspace: string, period: string): string {
  const t = expenseTotals(rows);
  const cat = t.byCategory.map((r) => `<tr><td>${esc(r.category)}</td><td class="n">${r.count}</td><td class="n">${fmt(r.gst)}</td><td class="n">${fmt(r.total)}</td></tr>`).join("");
  const list = rows.map((r) => `<tr><td>${esc(r.date ?? "")}</td><td>${esc(r.supplier ?? r.file)}</td><td>${esc(r.category ?? "Other")}</td><td class="n">${fmt(r.gst)}</td><td class="n">${fmt(r.total)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#111;margin:28px}h1{font-size:20px;margin:0 0 4px}p.m{color:#555;margin:0 0 18px}
table{border-collapse:collapse;width:100%;margin:0 0 18px}th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left}th{background:#f3f4f6}.n{text-align:right}
tfoot td{font-weight:bold;border-top:2px solid #111}</style></head><body>
<h1>${esc(title)}</h1><p class="m">${esc(workspace)}${period ? ` · ${esc(period)}` : ""} · ${t.count} receipts</p>
<table><thead><tr><th>Category</th><th class="n">Receipts</th><th class="n">GST</th><th class="n">Total</th></tr></thead><tbody>${cat}</tbody>
<tfoot><tr><td>Total</td><td class="n">${t.count}</td><td class="n">${fmt(t.gst)}</td><td class="n">${fmt(t.total)}</td></tr></tfoot></table>
<table><thead><tr><th>Date</th><th>Supplier</th><th>Category</th><th class="n">GST</th><th class="n">Total</th></tr></thead><tbody>${list}</tbody></table>
</body></html>`;
}

function sheetFile(name: string, format: "xlsx" | "csv", sheets: { name: string; rows: Cell[][] }[]) {
  const body = format === "xlsx" ? writeXlsx(sheets) : new TextEncoder().encode(writeCsv(sheets[0].rows));
  const file = `${name}.${format}`;
  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    },
  });
}

export async function fillInvoices(c: Context<AppEnv>, feature: "extract" | "expenses", files: { token: string; attachmentId?: string }[], useAi: boolean) {
  const rows: InvoiceRow[] = [];
  let note: string | null = null;
  for (const f of files) {
    const { doc, name } = await docFor(c, f.token);
    let row: InvoiceRow = { ...extractInvoice(doc, name), attachmentId: f.attachmentId ?? null };
    const missing = missingFields(row).filter((m) => feature === "expenses" || m !== "category").filter((m) => m !== "due_date" && m !== "subtotal");
    if (useAi && missing.length && !note) {
      const p = invoiceFillPrompt(doc, missing);
      const r = await askAi(c.var.deps, c.var.auth.orgId, { task: "chat", system: p.system, user: p.user, maxTokens: 160 });
      if (r.ok) { row = applyInvoiceFill(row, parseJsonObject(r.text)); if (r.fallback) note = r.fallback.message; } // QUAL1: built-in AI stood in
      else note = r.message;
    }
    rows.push(row);
  }
  return { rows, note };
}

/** Tools P2 H3 routes, mounted at /api/tools/ai. */
export function toolsAiRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // Today's AI use for the workspace (Settings) and what is switched on. One read.
    .get("/usage", async (c) => {
      setup(c);
      requireAnyAi(c);
      const u = await aiUsage(c.var.deps, c.var.auth.orgId);
      return c.json({ ...u, features: AI_FEATURES.filter((f) => toolFeatureOn(c, f)), languages: TRANSLATE_LANGUAGES, caps: AI_CAPS });
    })
    // Start reading mail attachments: one extract-text (or segments, for translation) job per file.
    .post("/read", async (c) => {
      const input = await parse(c, readSchema);
      requireToolFeature(c, input.feature);
      const ids = [...new Set(input.attachmentIds)];
      const rows = await ownAttachments(c, ids);
      const op = input.feature === "translate" ? "segments" : "extract-text";
      const jobs: (ToolJob & { attachmentId: string; threadId: string | null })[] = [];
      for (const r of rows) {
        const ok = op === "segments" ? SEGMENTABLE.test(r.a.filename) : READABLE.test(r.a.filename);
        if (!ok) throw new HttpError(422, "tool_input", op === "segments" ? "Translation takes PDF and Word files." : "This works on PDF, Word and image files.");
        const fd = new FormData();
        if (op === "extract-text") { fd.append("ocr", input.ocr ?? "auto"); fd.append("language", input.language ?? "eng"); }
        fd.append("files", await attachmentBlob(c, r.a), safeName(r.a.filename));
        const job = await startEngineJob(c, op, fd, r.a.filename, "attachment");
        jobs.push({ ...job, attachmentId: r.a.id, threadId: r.threadId });
      }
      return c.json({ jobs }, 202);
    })
    // The same from an upload (one file a request). The web app sends the custom header; a cross site form cannot.
    .post("/read/upload", async (c) => {
      const feature = c.req.query("feature") ?? "";
      if (!(READ_FEATURES as readonly string[]).includes(feature)) throw new HttpError(400, "bad_request", "Choose a feature.");
      requireToolFeature(c, feature as ToolFeature);
      if (c.req.header(UPLOAD_HEADER) !== "1") throw new HttpError(400, "bad_request", "Upload from the Tools page.");
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "bad_request", "Choose a file.");
      const op = feature === "translate" ? "segments" : "extract-text";
      if (!(op === "segments" ? SEGMENTABLE : READABLE).test(file.name)) throw new HttpError(422, "tool_input", op === "segments" ? "Translation takes PDF and Word files." : "This works on PDF, Word and image files.");
      const fd = new FormData();
      if (op === "extract-text") { fd.append("ocr", String(form?.get("ocr") ?? "auto").replace(/[^a-z]/g, "") || "auto"); fd.append("language", "eng"); }
      fd.append("files", file, safeName(file.name));
      return c.json(await startEngineJob(c, op, fd, file.name, "upload"), 202);
    })
    // 6 Ask a document: a short bullet summary (no question) or an answer with page numbers.
    .post("/ask", async (c) => {
      requireToolFeature(c, "ask");
      const input = await parse(c, askSchema);
      const { doc, name } = await docFor(c, input.token);
      const chunks = chunkDoc(doc);
      const q = input.question?.trim();
      const shown = q ? pickChunks(chunks, q, AI_CAPS.askChars) : spreadChunks(chunks, AI_CAPS.askChars);
      const p = q ? questionPrompt(shown, q) : summaryPrompt(shown);
      const r = await askAi(c.var.deps, c.var.auth.orgId, { task: "chat", system: p.system, user: p.user, maxTokens: q ? 350 : 400 });
      if (!r.ok) aiFail(r);
      const text = r.ok ? r.text : "";
      return c.json({
        name, question: q ?? null, answer: q ? text : null, bullets: q ? null : bullets(text), pages: citedPages(text, shown),
        partial: shown.length < chunks.length, pagesRead: doc.pages.length, source: r.ok ? r.source : null,
        ...(r.ok && r.fallback ? { fallback: r.fallback } : {}), // QUAL1: built-in AI answered because the workspace's key was refused
      });
    })
    // 11 Translate: one batch of segments a call (the page shows progress), metered as one reservation.
    .post("/translate", async (c) => {
      requireToolFeature(c, "translate");
      const input = await parse(c, translateSchema);
      if (!isTranslateLanguage(input.target)) throw new HttpError(400, "bad_request", "Choose a language.");
      const { data } = await jobJson(c, input.token);
      const segs = (Array.isArray((data as { segments?: unknown })?.segments) ? (data as { segments: unknown[] }).segments : [])
        .filter((s): s is { id: string | number; text: string; page?: number } => !!s && typeof (s as { text?: unknown }).text === "string" && ((s as { id?: unknown }).id !== undefined));
      if (segs.length === 0) throw new HttpError(422, "no_text", "No text was found to translate. If it is a scan, make it searchable first.");
      if (segs.some((s) => (s.page ?? 1) > AI_CAPS.translatePages)) throw new HttpError(413, "too_large", `Translation takes documents up to ${AI_CAPS.translatePages} pages.`);
      if (segs.reduce((n, s) => n + s.text.length, 0) > AI_CAPS.translateChars) throw new HttpError(413, "too_large", "That document has too much text to translate in one go. Split it first.");
      // At most 20 lines a call so one reservation stays well under the per call ceiling; the page follows `next`.
      const batch = segs.slice(input.offset, input.offset + Math.min(input.count, 20));
      const r = await askAi(c.var.deps, c.var.auth.orgId, { task: "translate", texts: batch.map((s) => s.text), target: input.target });
      if (!r.ok) aiFail(r);
      const translations: Record<string, string> = {};
      if (r.ok) batch.forEach((s, i) => { if (r.texts[i]) translations[String(s.id)] = r.texts[i]; });
      const next = input.offset + batch.length;
      return c.json({ translations, total: segs.length, done: Math.min(next, segs.length), next: next < segs.length ? next : null, ...(r.ok && r.fallback ? { fallback: r.fallback } : {}) });
    })
    // 11 Put the translations back into the file, keeping its layout. Attachment (JSON) or upload (multipart).
    .post("/translate/apply", async (c) => {
      requireToolFeature(c, "translate");
      let file: Blob, fname: string, target: string, translations: Record<string, string>, source: string;
      if ((c.req.header("content-type") ?? "").startsWith("multipart/")) {
        if (c.req.header(UPLOAD_HEADER) !== "1") throw new HttpError(400, "bad_request", "Upload from the Tools page.");
        const form = await c.req.formData().catch(() => null);
        const f = form?.get("file");
        if (!(f instanceof File)) throw new HttpError(400, "bad_request", "Choose a file.");
        const parsed = applySchema.omit({ attachmentId: true }).safeParse({ target: form?.get("target"), translations: JSON.parse(String(form?.get("translations") ?? "{}")) as unknown });
        if (!parsed.success) throw new HttpError(400, "bad_request", "Something in the request is missing or not valid.");
        file = f; fname = f.name; target = parsed.data.target; translations = parsed.data.translations; source = "upload";
      } else {
        const input = await parse(c, applySchema);
        const [r] = await ownAttachments(c, [input.attachmentId]);
        file = await attachmentBlob(c, r.a); fname = r.a.filename; target = input.target; translations = input.translations; source = "attachment";
      }
      if (!isTranslateLanguage(target)) throw new HttpError(400, "bad_request", "Choose a language.");
      if (!SEGMENTABLE.test(fname)) throw new HttpError(422, "tool_input", "Translation takes PDF and Word files.");
      if (Object.keys(translations).length > 2000) throw new HttpError(413, "too_large", "Too many parts to translate.");
      const fd = new FormData();
      fd.append("translations", JSON.stringify(translations));
      fd.append("files", file, safeName(fname));
      const ext = fname.match(/\.(pdf|docx)$/i)?.[1]?.toLowerCase() ?? "pdf";
      return c.json(await startEngineJob(c, "translate-apply", fd, `${base(fname)} (${TRANSLATE_LANGUAGES[target]}).${ext}`, source), 202);
    })
    // 2 and 24: read invoices or receipts into rows (rules first, AI fills gaps as strict JSON).
    .post("/invoices", async (c) => {
      const input = await parse(c, invoicesSchema);
      requireToolFeature(c, input.feature);
      return c.json(await fillInvoices(c, input.feature, input.files, input.ai));
    })
    // 2 and 24: the reviewed rows as XLSX or CSV (written here, no engine round trip).
    .post("/sheet", async (c) => {
      const input = await parse(c, sheetSchema);
      requireToolFeature(c, input.feature);
      const rows = input.rows.map(cleanRow).filter((r): r is InvoiceRow => !!r);
      const main: Cell[][] = [INVOICE_HEADERS, ...rows.map(invoiceCells)];
      const sheets = [{ name: input.feature === "expenses" ? "Receipts" : "Invoices", rows: main }];
      if (input.feature === "expenses") {
        const t = expenseTotals(rows);
        sheets.push({ name: "Totals", rows: [["Category", "Receipts", "GST", "Total"], ...t.byCategory.map((r) => [r.category, r.count, r.gst, r.total]), ["Total", t.count, t.gst, t.total]] });
      }
      return sheetFile((input.title || (input.feature === "expenses" ? "Expense report" : "Invoices")).replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "Invoices", input.format, sheets);
    })
    // 24: receipts to choose from: PDF and image attachments in a date range, optionally matching a word.
    .get("/receipts", async (c) => {
      requireToolFeature(c, "expenses");
      const { auth, deps } = c.var;
      const from = c.req.query("from"), to = c.req.query("to"), q = (c.req.query("q") ?? "").trim().slice(0, 60);
      const d0 = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00Z`) : new Date(deps.now().getTime() - 31 * 86_400_000);
      const d1 = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59Z`) : deps.now();
      const scope = await mailboxScope(deps.db, auth);
      const term = q ? q.trim() : "";
      const rows = await deps.db.select({ id: attachments.id, filename: attachments.filename, size: attachments.sizeBytes, date: messages.date, subject: messages.subject, mailboxId: messages.mailboxId, threadId: messages.threadId })
        .from(messages).innerJoin(attachments, eq(attachments.messageId, messages.id))
        // Uses messages_org_folder_date_idx (org, folder, date) and attachments_message_idx; capped.
        .where(and(eq(messages.orgId, auth.orgId), inArray(messages.folder, ["inbox", "archive"]), gte(messages.date, d0), lte(messages.date, d1),
          sql`(lower(${attachments.filename}) like '%.pdf' or lower(${attachments.filename}) like '%.jpg' or lower(${attachments.filename}) like '%.jpeg' or lower(${attachments.filename}) like '%.png')`,
          term ? containsAny([attachments.filename, messages.subject], term) : undefined))
        .orderBy(desc(messages.date)).limit(AI_CAPS.receiptsList).all();
      return c.json({ receipts: rows.filter((r) => !scope || scope.includes(r.mailboxId)).map(({ mailboxId: _m, ...r }) => r) });
    })
    // 24: the PDF summary (engine render of HTML built and escaped here).
    .post("/expenses/report", async (c) => {
      requireToolFeature(c, "expenses");
      const input = await parse(c, reportSchema);
      const rows = input.rows.map(cleanRow).filter((r): r is InvoiceRow => !!r);
      const org = await c.var.deps.db.get<{ name: string }>(sql`select name from organizations where id = ${c.var.auth.orgId}`);
      const title = input.title?.trim() || "Expense report";
      const period = input.from && input.to ? `${input.from} to ${input.to}` : "";
      const fd = new FormData();
      fd.append("data", "{}");
      fd.append("files", new Blob([expenseSummaryHtml(rows, title, org?.name ?? "", period)], { type: "text/html" }), "summary.html");
      return c.json(await startEngineJob(c, "render", fd, `${title}.pdf`, "upload"), 202);
    })
    // 24: the summary with the chosen receipts appended (engine merge). PDF receipts are appended; images are listed only.
    .post("/expenses/pack", async (c) => {
      requireToolFeature(c, "expenses");
      const input = await parse(c, packSchema);
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, input.summaryToken, "s", deps.now().getTime());
      if (!t || t.w !== auth.orgId) throw notFound("Job");
      const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      if (res.status === 404) throw new HttpError(410, "expired", "The summary has expired. Make it again.");
      if (!res.ok) await engineFail(res);
      const fd = new FormData();
      fd.append("files", new Blob([await res.arrayBuffer()], { type: "application/pdf" }), "summary.pdf");
      const ids = [...new Set(input.attachmentIds)];
      let appended = 0;
      for (const r of ids.length ? await ownAttachments(c, ids) : []) {
        if (!/\.pdf$/i.test(r.a.filename)) continue;
        fd.append("files", await attachmentBlob(c, r.a), safeName(r.a.filename));
        appended++;
      }
      const title = input.title?.trim() || "Expense report";
      const job = await startEngineJob(c, "merge", fd, `${title} with receipts.pdf`, "attachment");
      return c.json({ ...job, appended, skipped: ids.length - appended }, 202);
    })
    // 23 Contract helper: key facts by rules, AI fills the gaps, reminder dates proposed.
    .post("/contract", async (c) => {
      requireToolFeature(c, "contracts");
      const input = await parse(c, contractSchema);
      const { doc, name } = await docFor(c, input.token);
      let facts = extractContract(doc);
      let note: string | null = null;
      const missing = contractMissing(facts);
      if (missing.length) {
        const p = contractFillPrompt(doc, missing);
        const r = await askAi(c.var.deps, c.var.auth.orgId, { task: "chat", system: p.system, user: p.user, maxTokens: 200 });
        if (r.ok) { facts = applyContractFill(facts, parseJsonObject(r.text)); if (r.fallback) note = r.fallback.message; } // QUAL1
        else note = r.message;
      }
      const today = c.var.deps.now().toISOString().slice(0, 10);
      return c.json({ name, facts, reminders: contractReminders(facts, name, today), note });
    })
    // 23 "Add reminders": My Work tasks with due dates, assigned to the person, linked to the attachment's thread.
    .post("/contract/reminders", async (c) => {
      requireToolFeature(c, "contracts");
      const input = await parse(c, remindersSchema);
      const { auth, deps } = c.var;
      let source: { messageId: string } | null = null;
      if (input.attachmentId) { const [r] = await ownAttachments(c, [input.attachmentId]); source = { messageId: r.a.messageId }; }
      const notes = `From the contract ${input.name.replace(/[\r\n]/g, " ").slice(0, 200)}. Dates were read from the document; check them against the contract.`;
      const created: { id: string; title: string; due: string }[] = [];
      for (const r of input.reminders) {
        const t = await createTask(deps, auth, { title: r.title, notes, due: r.due, assignee: { type: "member", id: auth.userId }, source });
        created.push({ id: (t as { id: string }).id, title: r.title, due: r.due });
      }
      return c.json({ created }, 201);
    });
}
