import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError, notFound, planLimit } from "../lib/errors";
import { audit } from "../services/audit";
import { engineFetch, type EngineConfig } from "../services/tools/engine-client";
import { mintToken, readToken } from "../services/tools/tokens";
import { readToolState, recordRun, toolLimits, toolsOnFor, type ToolState } from "../services/tools/usage";
import { and, eq } from "drizzle-orm";
import { inIds } from "../lib/sql-chunks";
import { z } from "zod";
import { attachments, messages } from "../db/schema";
import { attachmentBytes } from "../services/mail/store";
import { mailboxScope } from "../services/team";
import { TOOLS, isToolOp, resultName, toolDef, toolTakes, type ToolJob, type ToolJobStatus, type ToolOp, type ToolResultFacts, type ToolsInfo } from "@/shared/tools";

/** The custom header the web app sends with an upload. A cross site form cannot set it (it needs a CORS preflight). */
export const TOOLS_UPLOAD_HEADER = "x-multies-upload";
/** Multipart framing on top of the files themselves (boundaries and part headers). */
const MULTIPART_ALLOWANCE = 64 * 1024;

const expired = () => new HttpError(404, "not_found", "This file has expired. Run the tool again.");
const engineDown = () => new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");

function setup(c: Context<AppEnv>) {
  const t = c.var.deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) throw notFound("Page");
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
  if (res.status === 400) throw new HttpError(422, "tool_input", message || "That file could not be used with this tool.");
  if (res.status === 413) throw new HttpError(413, "too_large", message || "That upload is larger than your plan allows.");
  if (res.status === 429) throw new HttpError(429, "tools_busy", message || "Tools are busy. Try again in a minute.");
  throw engineDown();
}

const FACT_KEYS = ["pages", "parts", "matches", "phrases", "verified", "pages_changed", "pages_with_text"] as const;
/** Only the known small facts pass through to the browser. */
function pickFacts(r: ToolResultFacts): ToolResultFacts {
  const out: Record<string, number | boolean> = {};
  for (const k of FACT_KEYS) {
    const v = (r as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out as ToolResultFacts;
}

const fromAttachmentsSchema = z.object({
  op: z.string().refine(isToolOp).transform((v) => v as ToolOp),
  attachmentIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  options: z.record(z.string(), z.string().max(2000)).optional(),
});

/** The plan and per tool limits for a run of `files` files and `len` bytes (0 when not known yet). */
function checkRun(op: ToolOp, files: number, len: number, s: ToolState) {
  const limits = toolLimits(s.plan);
  const def = toolDef(op);
  if (files < def.minFiles) throw new HttpError(400, "bad_request", `This tool needs ${def.minFiles} or more files.`);
  if (def.maxFiles === "plan" && files > limits.maxMergeFiles) throw planLimit(`You can merge up to ${limits.maxMergeFiles} files at once on your plan.`);
  if (def.maxFiles !== "plan" && files > def.maxFiles) throw new HttpError(400, "bad_request", `${def.label} takes up to ${def.maxFiles} ${def.maxFiles === 1 ? "file" : "files"}.`);
  if (def.maxBytes && len > def.maxBytes + MULTIPART_ALLOWANCE) throw new HttpError(413, "too_large", `${def.label} takes files up to ${Math.round(def.maxBytes / (1024 * 1024))} MB.`);
  if (s.month >= limits.runsMonthly) throw planLimit(`Your workspace has used all ${limits.runsMonthly} tool runs this month. They reset on the 1st.`);
  if (s.day >= limits.runsDaily) throw planLimit(`Your workspace has used all ${limits.runsDaily} tool runs for today. Try again tomorrow.`);
}

interface JobStart { op: ToolOp; files: number; len: number; maxBytes: number; body: ReadableStream<Uint8Array> | null; contentType: string; source: "upload" | "attachment"; firstName?: string }

/** Sends the files to the engine, counts the run (one usage upsert, one audit row without file names) and mints the status token. */
async function startJob(c: Context<AppEnv>, engine: EngineConfig, tokenKey: string, j: JobStart) {
  const { auth, deps } = c.var;
  const res = await callEngine(c, engine, {
    method: "POST", path: `/internal/v1/jobs?op=${j.op}`, ws: auth.orgId, user: auth.userId, maxBytes: j.maxBytes,
    body: j.body, contentLength: j.len, contentType: j.contentType,
  });
  if (res.status !== 202) await engineError(res);
  const job = (await res.json()) as { id: string; status: ToolJobStatus };
  const now = deps.now();
  await Promise.all([
    recordRun(deps.db, auth.orgId, now, j.len),
    audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.id, metadata: { op: j.op, source: j.source, files: j.files, bytes_in: j.len }, ip: c.var.ip }),
  ]);
  const name = resultName(j.op, j.firstName);
  const token = await mintToken(tokenKey, { k: "s", j: job.id, w: auth.orgId, u: auth.userId, o: j.op, n: name }, now.getTime());
  const out: ToolJob = { token, op: j.op, status: job.status, name };
  return c.json(out, 202);
}

/** Tools: document tools on the private engine (/api/tools). Off (404) unless the deployment turns them on. */
export function toolsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      setup(c);
      const s = await stateFor(c);
      const body: ToolsInfo = { enabled: true, tools: TOOLS, usage: { month: s.month, day: s.day }, limits: toolLimits(s.plan) };
      return c.json(body);
    })
    .post("/jobs", async (c) => {
      const { engine, tokenKey } = setup(c);
      if (c.req.header(TOOLS_UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      const op = c.req.query("op");
      if (!isToolOp(op)) throw new HttpError(400, "bad_request", "That tool is not available.");
      const lenHeader = c.req.header("content-length");
      if (!lenHeader || !/^\d+$/.test(lenHeader)) throw new HttpError(411, "length_required", "The upload needs a size. Try again from the Tools page.");
      const len = Number(lenHeader);
      const ctype = c.req.header("content-type") ?? "";
      if (!/^multipart\/form-data;\s*boundary=/i.test(ctype)) throw new HttpError(400, "bad_request", "Send the files as a form upload.");
      const s = await stateFor(c);
      const limits = toolLimits(s.plan);
      const maxBytes = limits.maxBytes + MULTIPART_ALLOWANCE;
      if (len > maxBytes) throw new HttpError(413, "too_large", `Uploads can be up to ${Math.round(limits.maxBytes / (1024 * 1024))} MB on your plan.`);
      const files = Math.max(1, Math.min(1000, Number(c.req.query("files") ?? "1") || 1));
      checkRun(op, files, len, s);
      return startJob(c, engine, tokenKey, { op, files, len, maxBytes, body: c.req.raw.body, contentType: ctype, source: "upload", firstName: c.req.query("name") });
    })
    // Run a tool straight on mail attachments: the Worker reads them from the workspace's own mail and
    // sends them on; nothing is uploaded again and nothing new is stored.
    .post("/jobs/from-attachments", async (c) => {
      const { engine, tokenKey } = setup(c);
      const input = fromAttachmentsSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw new HttpError(400, "bad_request", "Choose a tool and at least one attachment.");
      const { op, attachmentIds, options } = input.data;
      const { auth, deps } = c.var;
      const s = await stateFor(c);
      const ids = [...new Set(attachmentIds)];
      checkRun(op, ids.length, 0, s);
      const scope = await mailboxScope(deps.db, auth);
      const rows = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(inIds(attachments.id, ids), eq(messages.orgId, auth.orgId))).all();
      const byId = new Map(rows.filter((r) => !scope || scope.includes(r.mailboxId)).map((r) => [r.a.id, r.a]));
      const def = toolDef(op);
      const fd = new FormData();
      for (const [k, v] of Object.entries(options ?? {})) if (def.options.some((o) => o.name === k) && v.trim() !== "") fd.append(k, v);
      let first: string | undefined;
      for (const id of ids) {
        const a = byId.get(id);
        if (!a) throw notFound("Attachment");
        if (!toolTakes(def, a.filename)) throw new HttpError(422, "tool_input", `${def.label} does not take ${a.filename.replace(/[\r\n]/g, " ").slice(0, 80)}.`);
        const bytes = await attachmentBytes(a, deps.bodyStore);
        if (!bytes) throw new HttpError(422, "tool_input", "That attachment is not stored, so it cannot be used here.");
        first ??= a.filename;
        fd.append("files", new Blob([bytes as BlobPart], { type: a.contentType || "application/octet-stream" }), a.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 120));
      }
      const req = new Request("http://tools.local/", { method: "POST", body: fd });
      const ctype = req.headers.get("content-type") ?? "";
      const body = new Uint8Array(await req.arrayBuffer());
      const limits = toolLimits(s.plan);
      const maxBytes = limits.maxBytes + MULTIPART_ALLOWANCE;
      if (body.byteLength > maxBytes) throw new HttpError(413, "too_large", `Attachments can add up to ${Math.round(limits.maxBytes / (1024 * 1024))} MB on your plan.`);
      checkRun(op, ids.length, body.byteLength, s);
      return startJob(c, engine, tokenKey, { op, files: ids.length, len: body.byteLength, maxBytes, body: new Blob([body]).stream(), contentType: ctype, source: "attachment", firstName: first });
    })
    .get("/jobs/:token", async (c) => {
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, c.req.param("token"), "s", deps.now().getTime());
      if (!t || t.w !== auth.orgId) throw notFound("Job");
      // Polling reads no D1: the token carries the workspace and the engine checks it again.
      const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      if (res.status === 404) return c.json({ token: c.req.param("token"), op: t.o, status: "expired", name: t.n } satisfies ToolJob);
      if (!res.ok) await engineError(res);
      const j = (await res.json()) as { status: ToolJobStatus; error?: string; output?: { bytes: number }; progress?: { done: number; total: number }; result?: ToolResultFacts };
      const out: ToolJob = { token: c.req.param("token"), op: t.o, status: j.status, name: t.n };
      if (j.progress && Number.isFinite(j.progress.done) && Number.isFinite(j.progress.total)) out.progress = { done: j.progress.done, total: j.progress.total };
      if (j.status === "done" && j.result) out.result = pickFacts(j.result);
      if (j.status === "failed") out.error = j.error || "The file could not be processed.";
      if (j.status === "done") {
        out.bytes = j.output?.bytes;
        const d = await mintToken(tokenKey, { k: "d", j: t.j, w: t.w, u: auth.userId, o: t.o, n: t.n }, deps.now().getTime());
        out.downloadUrl = `/api/tools/jobs/${d}/download`;
      }
      return c.json(out);
    })
    .get("/jobs/:token/download", async (c) => {
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, c.req.param("token"), "d", deps.now().getTime());
      if (!t || t.w !== auth.orgId) throw expired();
      const res = await callEngine(c, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      if (res.status === 404) throw expired();
      if (!res.ok || !res.body) await engineError(res);
      const ascii = t.n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      const headers = new Headers({
        "content-type": isToolOp(t.o) ? toolDef(t.o).contentType : "application/octet-stream",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(t.n)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      const size = res.headers.get("content-length");
      if (size) headers.set("content-length", size);
      return new Response(res.body, { status: 200, headers });
    });
}
