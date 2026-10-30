/**
 * Tools P2, H7: the interactive editors' API (/api/tools/editors): page editor (thumbnails, organize),
 * form filler (form-fields, form-fill) and compare. Same engine, signing, plan limits, workspace switch
 * and job tokens as /api/tools; each op answers 404 while its feature flag (TOOLS_FEATURES) is off.
 *
 * Previews (thumbnails, form-fields) do not count as tool runs and write nothing to D1; they are rate
 * limited per person instead. A save (organize, form-fill) counts one run. Compare counts one run for its
 * two engine jobs (the report PDF and the change list, from the same two files).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError, notFound, planLimit, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { inIds } from "../lib/sql-chunks";
import { audit } from "../services/audit";
import { engineFetch, type EngineConfig } from "../services/tools/engine-client";
import { requireToolFeature } from "../services/tools/features";
import { mintToken, readToken } from "../services/tools/tokens";
import { readToolState, recordRun, toolLimits, toolsOnFor, type ToolState } from "../services/tools/usage";
import { attachments, messages } from "../db/schema";
import { attachmentBytes } from "../services/mail/store";
import { mailboxScope } from "../services/team";
import type { ToolOp } from "@/shared/tools";
import {
  EDITOR_FACT_KEYS, EDITOR_FEATURE, EDITOR_OPTION_NAMES, EDITOR_OUTPUT, EDITOR_PREVIEW_OPS, isEditorOp, editorResultName,
  PLAN_MAX_LEN, VALUES_MAX_LEN, type CompareStart, type EditorFacts, type EditorJob, type EditorJobStatus, type EditorOp,
} from "@/shared/tools-editors";

/** The header the web app sends with an upload (same as /api/tools: a cross site form cannot set it). */
const UPLOAD_HEADER = "x-multies-upload";
const MULTIPART_ALLOWANCE = 64 * 1024;
const OPTION_MAX: Record<string, number> = { plan: PLAN_MAX_LEN, values: VALUES_MAX_LEN, flatten: 3 };
const FILES_FOR: Record<EditorOp, number> = { thumbnails: 1, organize: 1, "form-fields": 1, "form-fill": 1, compare: 2 };

const expired = () => new HttpError(404, "not_found", "This file has expired. Run the tool again.");
const engineDown = () => new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");
const isPdfName = (n: string) => /\.pdf$/i.test(n);

function setup(c: Context<AppEnv>, op?: EditorOp) {
  const t = c.var.deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) throw notFound("Page");
  if (op) requireToolFeature(c, EDITOR_FEATURE[op]);
  return { engine: t.engine as EngineConfig, tokenKey: t.tokenKey };
}

async function stateFor(c: Context<AppEnv>): Promise<ToolState> {
  const s = await readToolState(c.var.deps.db, c.var.auth.orgId, c.var.deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
  return s;
}

async function callEngine(c: Context<AppEnv>, engine: EngineConfig, init: Parameters<typeof engineFetch>[2]) {
  try {
    return await engineFetch(c.var.deps.fetch, engine, init);
  } catch (err) {
    c.var.log?.warn("tools.engine_unreachable", { error: String(err) });
    throw engineDown();
  }
}

async function engineError(res: Response): Promise<never> {
  let message = "";
  try { message = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
  if (res.status === 400) throw new HttpError(422, "tool_input", message.slice(0, 300) || "That file could not be used with this tool.");
  if (res.status === 413) throw new HttpError(413, "too_large", message.slice(0, 300) || "That file is larger than this tool takes.");
  if (res.status === 429) throw new HttpError(429, "tools_busy", "Tools are busy. Try again in a minute.");
  throw engineDown();
}

function pickFacts(r: Record<string, unknown>): EditorFacts {
  const out: Record<string, number> = {};
  for (const k of EDITOR_FACT_KEYS) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out as EditorFacts;
}

/** Plan limits for a run (a preview checks them too, so a workspace with no runs left hears it before editing). */
function checkRun(op: EditorOp, files: number, s: ToolState) {
  const limits = toolLimits(s.plan);
  const want = FILES_FOR[op];
  if (files !== want) throw new HttpError(400, "bad_request", want === 2 ? "Choose two PDFs to compare." : "Choose one PDF.");
  if (s.month >= limits.runsMonthly) throw planLimit(`Your workspace has used all ${limits.runsMonthly} tool runs this month. They reset on the 1st.`);
  if (s.day >= limits.runsDaily) throw planLimit(`Your workspace has used all ${limits.runsDaily} tool runs for today. Try again tomorrow.`);
}

/** The options a browser may set for an op, each within its length; JSON options must parse. */
function cleanOptions(op: EditorOp, raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of EDITOR_OPTION_NAMES[op]) {
    const v = raw?.[name];
    if (typeof v !== "string" || v.trim() === "") continue;
    if (v.length > (OPTION_MAX[name] ?? 2000)) throw new HttpError(400, "bad_request", "That is too much to save at once.");
    if (name === "plan" || name === "values") {
      try { JSON.parse(v); } catch { throw new HttpError(400, "bad_request", "That could not be read. Try again."); }
    }
    if (name === "flatten" && v !== "yes" && v !== "no") continue;
    out[name] = v;
  }
  if (op === "organize" && !out.plan) throw new HttpError(400, "bad_request", "Keep at least one page.");
  if (op === "form-fill" && !out.values) throw new HttpError(400, "bad_request", "Fill in at least one field.");
  return out;
}

interface Started { id: string; status: EditorJobStatus }

async function engineJob(c: Context<AppEnv>, engine: EngineConfig, op: EditorOp, body: ReadableStream<Uint8Array> | null, len: number, maxBytes: number, contentType: string): Promise<Started> {
  const { auth } = c.var;
  const res = await callEngine(c, engine, { method: "POST", path: `/internal/v1/jobs?op=${op}`, ws: auth.orgId, user: auth.userId, maxBytes, body, contentLength: len, contentType });
  if (res.status !== 202) await engineError(res);
  const j = (await res.json()) as { id: string; status: EditorJobStatus };
  if (typeof j.id !== "string" || !/^[a-f0-9]{16,64}$/.test(j.id)) throw engineDown();
  return j;
}

/** Counts a run (one usage upsert and one audit row without file names). Previews count nothing. */
async function countRun(c: Context<AppEnv>, op: EditorOp, jobId: string, source: "upload" | "attachment", files: number, len: number) {
  if (EDITOR_PREVIEW_OPS.includes(op)) return;
  const { auth, deps } = c.var;
  await Promise.all([
    recordRun(deps.db, auth.orgId, deps.now(), len),
    audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: jobId, metadata: { op, source, files, bytes_in: len }, ip: c.var.ip }),
  ]);
}

async function jobFor(c: Context<AppEnv>, tokenKey: string, op: EditorOp, j: Started, name: string): Promise<EditorJob> {
  const { auth, deps } = c.var;
  // The token's op field is typed for the P1 catalogue; editor ops ride it as their own names.
  const token = await mintToken(tokenKey, { k: "s", j: j.id, w: auth.orgId, u: auth.userId, o: op as unknown as ToolOp, n: name }, deps.now().getTime());
  return { token, op, status: j.status, name };
}

/** Two form bodies for compare: the same two files, one asking for the report PDF and one for the change list. */
async function compareBodies(files: { blob: Blob; name: string }[]) {
  const make = async (output: "pdf" | "json") => {
    const fd = new FormData();
    fd.append("output", output);
    for (const f of files) fd.append("files", f.blob, f.name);
    const req = new Request("http://tools.local/", { method: "POST", body: fd });
    return { ctype: req.headers.get("content-type") ?? "", bytes: new Uint8Array(await req.arrayBuffer()) };
  };
  return Promise.all([make("pdf"), make("json")]);
}

async function startCompare(c: Context<AppEnv>, engine: EngineConfig, tokenKey: string, files: { blob: Blob; name: string }[], maxBytes: number, source: "upload" | "attachment") {
  const [pdf, json] = await compareBodies(files);
  const len = pdf.bytes.byteLength;
  if (len > maxBytes) throw new HttpError(413, "too_large", `The two files can add up to ${Math.round((maxBytes - MULTIPART_ALLOWANCE) / (1024 * 1024))} MB on your plan.`);
  const [a, b] = await Promise.all([
    engineJob(c, engine, "compare", new Blob([pdf.bytes as BlobPart]).stream(), len, maxBytes, pdf.ctype),
    engineJob(c, engine, "compare", new Blob([json.bytes as BlobPart]).stream(), json.bytes.byteLength, maxBytes, json.ctype),
  ]);
  await countRun(c, "compare", a.id, source, 2, len);
  const out: CompareStart = {
    report: await jobFor(c, tokenKey, "compare", a, editorResultName("compare", files[1]?.name ?? files[0]?.name)),
    changes: await jobFor(c, tokenKey, "compare", b, editorResultName("compare", files[1]?.name ?? files[0]?.name, "json")),
  };
  return c.json(out, 202);
}

const fromAttachmentsSchema = z.object({
  op: z.string().refine(isEditorOp).transform((v) => v as EditorOp),
  attachmentIds: z.array(z.string().min(1).max(64)).min(1).max(2),
  options: z.record(z.string(), z.string().max(VALUES_MAX_LEN)).optional(),
});

/** Tools P2 editors (/api/tools/editors). */
export function toolsEditorsRoutes() {
  // Previews write nothing, so they are limited per person: 60 in 10 minutes is far more than editing needs.
  const previewLimiter = new RateLimiter(60, 10 * 60_000);
  const takePreview = (c: Context<AppEnv>, op: EditorOp) => {
    if (EDITOR_PREVIEW_OPS.includes(op) && !previewLimiter.take(c.var.auth.userId)) throw tooMany("You're opening files very fast. Wait a moment.");
  };
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // Upload: one PDF for thumbnails, organize, form-fields and form-fill, streamed to the engine unread.
    .post("/jobs", async (c) => {
      const op = c.req.query("op");
      if (!isEditorOp(op) || op === "compare") throw new HttpError(400, "bad_request", "That tool is not available.");
      const { engine, tokenKey } = setup(c, op);
      if (c.req.header(UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      const lenHeader = c.req.header("content-length");
      if (!lenHeader || !/^\d+$/.test(lenHeader)) throw new HttpError(411, "length_required", "The upload needs a size. Try again from the Tools page.");
      const len = Number(lenHeader);
      const ctype = c.req.header("content-type") ?? "";
      if (!/^multipart\/form-data;\s*boundary=/i.test(ctype)) throw new HttpError(400, "bad_request", "Send the file as a form upload.");
      const s = await stateFor(c);
      const maxBytes = toolLimits(s.plan).maxBytes + MULTIPART_ALLOWANCE;
      if (len > maxBytes) throw new HttpError(413, "too_large", `Uploads can be up to ${Math.round(toolLimits(s.plan).maxBytes / (1024 * 1024))} MB on your plan.`);
      checkRun(op, 1, s);
      takePreview(c, op);
      const j = await engineJob(c, engine, op, c.req.raw.body, len, maxBytes, ctype);
      await countRun(c, op, j.id, "upload", 1, len);
      return c.json(await jobFor(c, tokenKey, op, j, editorResultName(op, c.req.query("name"))), 202);
    })
    // Compare upload: two PDFs, older first. Read once in the Worker, sent to the engine twice (report and change list).
    .post("/compare", async (c) => {
      const { engine, tokenKey } = setup(c, "compare");
      if (c.req.header(UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      const lenHeader = c.req.header("content-length");
      if (!lenHeader || !/^\d+$/.test(lenHeader)) throw new HttpError(411, "length_required", "The upload needs a size. Try again from the Tools page.");
      const s = await stateFor(c);
      const maxBytes = toolLimits(s.plan).maxBytes + MULTIPART_ALLOWANCE;
      if (Number(lenHeader) > maxBytes) throw new HttpError(413, "too_large", `Uploads can be up to ${Math.round(toolLimits(s.plan).maxBytes / (1024 * 1024))} MB on your plan.`);
      let form: FormData;
      try { form = await c.req.raw.formData(); } catch { throw new HttpError(400, "bad_request", "Send the files as a form upload."); }
      const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
      checkRun("compare", files.length, s);
      if (!files.every((f) => isPdfName(f.name))) throw new HttpError(422, "tool_input", "Compare takes PDF files.");
      return startCompare(c, engine, tokenKey, files.map((f) => ({ blob: f, name: f.name.replace(/[\r\n"\\/]/g, "_").slice(0, 120) })), maxBytes, "upload");
    })
    // Straight from mail attachments: nothing is uploaded again and nothing new is stored.
    .post("/jobs/from-attachments", async (c) => {
      const input = fromAttachmentsSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw new HttpError(400, "bad_request", "Choose a tool and an attachment.");
      const { op, attachmentIds, options } = input.data;
      const { engine, tokenKey } = setup(c, op);
      const { auth, deps } = c.var;
      const s = await stateFor(c);
      checkRun(op, attachmentIds.length, s);
      const opts = cleanOptions(op, options);
      takePreview(c, op);
      const scope = await mailboxScope(deps.db, auth);
      const rows = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(inIds(attachments.id, attachmentIds), eq(messages.orgId, auth.orgId))).all();
      const byId = new Map(rows.filter((r) => !scope || scope.includes(r.mailboxId)).map((r) => [r.a.id, r.a]));
      const files: { blob: Blob; name: string }[] = [];
      for (const id of attachmentIds) {
        const a = byId.get(id);
        if (!a) throw notFound("Attachment");
        if (!isPdfName(a.filename)) throw new HttpError(422, "tool_input", `This tool takes PDF files, not ${a.filename.replace(/[\r\n]/g, " ").slice(0, 80)}.`);
        const bytes = await attachmentBytes(a, deps.bodyStore);
        if (!bytes) throw new HttpError(422, "tool_input", "That attachment is not stored, so it cannot be used here.");
        files.push({ blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), name: a.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 120) });
      }
      const maxBytes = toolLimits(s.plan).maxBytes + MULTIPART_ALLOWANCE;
      if (op === "compare") return startCompare(c, engine, tokenKey, files, maxBytes, "attachment");
      const fd = new FormData();
      for (const [k, v] of Object.entries(opts)) fd.append(k, v);
      fd.append("files", files[0].blob, files[0].name);
      const req = new Request("http://tools.local/", { method: "POST", body: fd });
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.byteLength > maxBytes) throw new HttpError(413, "too_large", `Attachments can add up to ${Math.round(toolLimits(s.plan).maxBytes / (1024 * 1024))} MB on your plan.`);
      const j = await engineJob(c, engine, op, new Blob([body as BlobPart]).stream(), body.byteLength, maxBytes, req.headers.get("content-type") ?? "");
      await countRun(c, op, j.id, "attachment", 1, body.byteLength);
      return c.json(await jobFor(c, tokenKey, op, j, editorResultName(op, files[0].name)), 202);
    })
    // The other PDFs in an attachment's thread, newest first: what compare offers as the second version.
    .get("/attachments/:id/pdfs", async (c) => {
      setup(c, "compare");
      await stateFor(c);
      const { auth, deps } = c.var;
      const scope = await mailboxScope(deps.db, auth);
      const own = await deps.db.select({ threadId: messages.threadId, mailboxId: messages.mailboxId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(eq(attachments.id, c.req.param("id")), eq(messages.orgId, auth.orgId))).get();
      if (!own || (scope && !scope.includes(own.mailboxId))) throw notFound("Attachment");
      const rows = await deps.db.select({ id: attachments.id, filename: attachments.filename, sizeBytes: attachments.sizeBytes, date: messages.date, mailboxId: messages.mailboxId, stored: attachments.contentB64, key: attachments.storageKey })
        .from(attachments).innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(eq(messages.threadId, own.threadId), eq(messages.orgId, auth.orgId))).all();
      const pdfs = rows.filter((r) => isPdfName(r.filename) && (!scope || scope.includes(r.mailboxId)) && (r.stored !== null || r.key !== null))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30)
        .map((r) => ({ id: r.id, filename: r.filename, sizeBytes: r.sizeBytes, date: r.date }));
      return c.json({ attachments: pdfs });
    })
    .get("/jobs/:token", async (c) => {
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, c.req.param("token"), "s", deps.now().getTime());
      const op = t?.o as unknown;
      if (!t || t.w !== auth.orgId || !isEditorOp(op)) throw notFound("Job");
      requireToolFeature(c, EDITOR_FEATURE[op]);
      const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      if (res.status === 404) return c.json({ token: c.req.param("token"), op, status: "expired", name: t.n } satisfies EditorJob);
      if (!res.ok) await engineError(res);
      const j = (await res.json()) as { status: EditorJobStatus; error?: string; output?: { bytes: number }; progress?: { done: number; total: number }; result?: Record<string, unknown> };
      const out: EditorJob = { token: c.req.param("token"), op, status: j.status, name: t.n };
      if (j.progress && Number.isFinite(j.progress.done) && Number.isFinite(j.progress.total)) out.progress = { done: j.progress.done, total: j.progress.total };
      if (j.status === "done" && j.result && typeof j.result === "object") out.result = pickFacts(j.result);
      if (j.status === "failed") out.error = (typeof j.error === "string" && j.error.slice(0, 300)) || "The file could not be processed.";
      if (j.status === "done") {
        out.bytes = j.output?.bytes;
        const d = await mintToken(tokenKey, { k: "d", j: t.j, w: t.w, u: auth.userId, o: t.o, n: t.n }, deps.now().getTime());
        out.downloadUrl = `/api/tools/editors/jobs/${d}/download`;
      }
      return c.json(out);
    })
    .get("/jobs/:token/download", async (c) => {
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, c.req.param("token"), "d", deps.now().getTime());
      const op = t?.o as unknown;
      if (!t || t.w !== auth.orgId || !isEditorOp(op)) throw expired();
      requireToolFeature(c, EDITOR_FEATURE[op]);
      const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      if (res.status === 404) throw expired();
      if (!res.ok || !res.body) await engineError(res);
      const json = /\.json$/.test(t.n);
      const ascii = t.n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      const headers = new Headers({
        "content-type": json ? "application/json" : EDITOR_OUTPUT[op].contentType,
        "content-disposition": `${c.req.query("inline") === "1" && !json ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(t.n)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      const size = res.headers.get("content-length");
      if (size) headers.set("content-length", size);
      return new Response(res.body, { status: 200, headers });
    });
}
