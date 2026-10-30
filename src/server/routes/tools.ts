import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { audit } from "../services/audit";
import { engineFetch, type EngineConfig } from "../services/tools/engine-client";
import { mintToken, readToken } from "../services/tools/tokens";
import { activeToolFeatures } from "../services/tools/features"; // Tools P2 (17): "index" only with INDEX_DB
import { chargeJob, toolLimits, type ToolState } from "../services/tools/usage";
import { MULTIPART_ALLOWANCE, assertToolOn, checkRun, engineDown, engineError, pickFacts, toolStateFor } from "../services/tools/run-job";
import { and, eq, sql } from "drizzle-orm";
import { inIds } from "../lib/sql-chunks";
import { z } from "zod";
import { attachments, messages } from "../db/schema";
import { attachmentBytes } from "../services/mail/store";
import { mailboxScope } from "../services/team";
import { EXT_TYPES, catalogueFor, emptyResult, extForType, isToolOp, resultName, toolDef, toolTakes, withExt, type ToolExt, type ToolJob, type ToolJobStatus, type ToolOp, type ToolResultFacts, type ToolsInfo } from "@/shared/tools";

/** The custom header the web app sends with an upload. A cross site form cannot set it (it needs a CORS preflight). */
export const TOOLS_UPLOAD_HEADER = "x-multies-upload";
const expired = () => new HttpError(404, "not_found", "This file has expired. Run the tool again.");

function setup(c: Context<AppEnv>) {
  const t = c.var.deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) throw notFound("Page");
  return { engine: t.engine as EngineConfig, tokenKey: t.tokenKey };
}

async function stateFor(c: Context<AppEnv>): Promise<ToolState> {
  return toolStateFor(c.var.deps, c.var.auth.orgId);
}

async function callEngine(c: Context<AppEnv>, engine: EngineConfig, init: Parameters<typeof engineFetch>[2]) {
  try {
    return await engineFetch(c.var.deps.fetch, engine, init);
  } catch (err) {
    c.var.log?.warn("tools.engine_unreachable", { error: String(err) });
    throw engineDown();
  }
}

const fromAttachmentsSchema = z.object({
  op: z.string().refine(isToolOp).transform((v) => v as ToolOp),
  attachmentIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  options: z.record(z.string(), z.string().max(2000)).optional(),
});

interface JobStart { op: ToolOp; files: number; len: number; maxBytes: number; body: ReadableStream<Uint8Array> | null; contentType: string; source: "upload" | "attachment"; firstName?: string; options?: Record<string, string> }

/**
 * Sends the files to the engine, writes one audit row without file names and mints the status token. R66 (MB-256):
 * the run is counted later, by the status read that first sees it finished with a result (chargeJob), so a run
 * that fails, is cancelled or finds nothing to do costs nothing.
 */
async function startJob(c: Context<AppEnv>, engine: EngineConfig, tokenKey: string, j: JobStart) {
  const { auth, deps } = c.var;
  const res = await callEngine(c, engine, {
    method: "POST", path: `/internal/v1/jobs?op=${j.op}`, ws: auth.orgId, user: auth.userId, maxBytes: j.maxBytes,
    body: j.body, contentLength: j.len, contentType: j.contentType,
  });
  if (res.status !== 202) await engineError(res);
  const job = (await res.json()) as { id: string; status: ToolJobStatus };
  const now = deps.now();
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.id, metadata: { op: j.op, source: j.source, files: j.files, bytes_in: j.len }, ip: c.var.ip });
  const name = resultName(j.op, j.firstName, j.options);
  const token = await mintToken(tokenKey, { k: "s", j: job.id, w: auth.orgId, u: auth.userId, o: j.op, n: name, b: j.len }, now.getTime());
  const out: ToolJob = { token, op: j.op, status: job.status, name };
  return c.json(out, 202);
}

/** The download's type from the result name's extension (set from what the engine made), else the tool's own type. */
function downloadType(op: string, name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() as ToolExt | undefined;
  if (ext && EXT_TYPES[ext]) return EXT_TYPES[ext];
  return isToolOp(op) ? toolDef(op).contentType : "application/octet-stream";
}

/** Tools UX: when the engine was last asked to wake (per server instance). */
const warm = { at: 0, ok: false };

/** Tools: document tools on the private engine (/api/tools). Off (404) unless the deployment turns them on. */
export function toolsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // R63: the workspace switch (organizations.tools_mode, migration 0092). Admins turn Tools off or back on in
    // Settings, General. One small read or write, only when the settings page asks.
    .get("/settings", async (c) => {
      setup(c);
      const r = await c.var.deps.db.get<{ mode: string | null }>(sql`select tools_mode as mode from organizations where id = ${c.var.auth.orgId}`);
      return c.json({ on: r?.mode !== "off" });
    })
    .put("/settings", requireAdmin, async (c) => {
      setup(c);
      const { on } = await parseBody(c, z.object({ on: z.boolean() }));
      const { auth, deps } = c.var;
      await deps.db.run(sql`update organizations set tools_mode = ${on ? "on" : "off"} where id = ${auth.orgId}`);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: on ? "tools.turned_on" : "tools.turned_off", ip: c.var.ip });
      return c.json({ on });
    })
    // Tools UX: the Tools page asks once when it opens, so a sleeping engine (free host) starts waking before the
    // first run. One health GET to the engine at most every 30 seconds per server; no database read.
    .get("/warm", async (c) => {
      const { engine } = setup(c);
      const now = Date.now();
      if (now - warm.at < 30_000) return c.json({ ok: warm.ok, ms: 0 });
      warm.at = now;
      try {
        const res = await c.var.deps.fetch(`${engine.url}/healthz`, { method: "GET", signal: AbortSignal.timeout(4_000) });
        warm.ok = res.ok;
        await res.body?.cancel();
      } catch { warm.ok = false; }
      return c.json({ ok: warm.ok, ms: Date.now() - now });
    })
    .get("/", async (c) => {
      setup(c);
      const s = await stateFor(c);
      // Tools P2: only the tools on for this deployment (and English only OCR until ocr_langs is on); "index" only with INDEX_DB.
      const features = activeToolFeatures(c.var.deps);
      const body: ToolsInfo = { enabled: true, tools: catalogueFor(features), usage: { month: s.month, day: s.day }, limits: toolLimits(s.plan), features };
      return c.json(body);
    })
    .post("/jobs", async (c) => {
      const { engine, tokenKey } = setup(c);
      if (c.req.header(TOOLS_UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      const op = c.req.query("op");
      if (!isToolOp(op)) throw new HttpError(400, "bad_request", "That tool is not available.");
      assertToolOn(c.var.deps, op);
      const def = toolDef(op);
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
      // Tools P2: the second slot's count (signature images) and the option the result type follows (PDF to)
      // come in the query, since the upload streams through unread; the engine checks the form itself.
      const extra = Math.max(0, Math.min(100, Number(c.req.query("extra") ?? "0") || 0));
      checkRun(op, files, len, s, extra);
      const typeOpt = def.extBy ? { [def.extBy.option]: c.req.query(def.extBy.option) ?? "" } : undefined;
      return startJob(c, engine, tokenKey, { op, files, len, maxBytes, body: c.req.raw.body, contentType: ctype, source: "upload", firstName: c.req.query("name"), options: typeOpt });
    })
    // Run a tool straight on mail attachments: the Worker reads them from the workspace's own mail and
    // sends them on; nothing is uploaded again and nothing new is stored.
    .post("/jobs/from-attachments", async (c) => {
      const { engine, tokenKey } = setup(c);
      const input = fromAttachmentsSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw new HttpError(400, "bad_request", "Choose a tool and at least one attachment.");
      const { op, attachmentIds, options } = input.data;
      const { auth, deps } = c.var;
      assertToolOn(deps, op);
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
      return startJob(c, engine, tokenKey, { op, files: ids.length, len: body.byteLength, maxBytes, body: new Blob([body]).stream(), contentType: ctype, source: "attachment", firstName: first, options });
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
      const j = (await res.json()) as { status: ToolJobStatus; error?: string; output?: { bytes: number; content_type?: string }; progress?: { done: number; total: number }; result?: ToolResultFacts };
      // Tools P2: when the engine made another type than the name says (PDF to picks its type from an option), the name follows it.
      const name = j.status === "done" ? withExt(t.n, extForType(j.output?.content_type)) : t.n;
      const out: ToolJob = { token: c.req.param("token"), op: t.o, status: j.status, name };
      if (j.progress && Number.isFinite(j.progress.done) && Number.isFinite(j.progress.total)) out.progress = { done: j.progress.done, total: j.progress.total };
      if (j.status === "done" && j.result) out.result = pickFacts(j.result);
      if (j.status === "failed") out.error = j.error || "The file could not be processed.";
      if (j.status === "done") {
        out.bytes = j.output?.bytes;
        const d = await mintToken(tokenKey, { k: "d", j: t.j, w: t.w, u: auth.userId, o: t.o, n: name }, deps.now().getTime());
        out.downloadUrl = `/api/tools/jobs/${d}/download`;
        // R66 (MB-256): counted once, here, when it finished with a result (polling before this read no D1).
        // A token without bytes was minted before R66, when the run was counted at the start.
        if (emptyResult(t.o, out.result)) out.notCounted = true;
        else if (t.b !== undefined) await chargeJob(deps.db, auth.orgId, t.j, deps.now(), t.b);
      }
      return c.json(out);
    })
    // R66 (MB-257): Cancel stops the job on the engine and frees its place (a workspace runs two at a time).
    // A cancelled job is never counted. A job that already finished is left alone (its result was counted).
    .delete("/jobs/:token", async (c) => {
      const { engine, tokenKey } = setup(c);
      const { auth, deps } = c.var;
      const t = await readToken(tokenKey, c.req.param("token"), "s", deps.now().getTime());
      if (!t || t.w !== auth.orgId) throw notFound("Job");
      const res = await callEngine(c, engine, { method: "DELETE", path: `/internal/v1/jobs/${t.j}`, ws: auth.orgId, user: auth.userId, maxBytes: 0 });
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) await engineError(res);
      return c.json({ token: c.req.param("token"), op: t.o, status: "cancelled", name: t.n } satisfies ToolJob);
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
        "content-type": downloadType(t.o, t.n),
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(t.n)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      const size = res.headers.get("content-length");
      if (size) headers.set("content-length", size);
      return new Response(res.body, { status: 200, headers });
    });
}
