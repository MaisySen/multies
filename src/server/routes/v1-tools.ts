/**
 * Tools P2 (developer API, flag api): Tools on the public API with workspace API keys. Scope "tools:read"
 * lists tools and reads job status; "tools:run" starts jobs and runs saved workflows (lib/api-scopes).
 * The /api/v1 rate limit applies (app.ts); each run also counts against the plan's Tools runs.
 *
 *   GET  /tools                          the tools, their options, and the workspace's saved workflows
 *   POST /tools/jobs?op=compress         multipart files (+ option fields), or JSON {op, attachmentIds, options}
 *   GET  /tools/jobs/{token}             status; when done, downloadUrl
 *   GET  /tools/jobs/{token}/download    the result file
 *   POST /tools/workflows/{id}/run       multipart files (+ password), or JSON {attachmentIds, password}
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { audit } from "../services/audit";
import { requireToolFeature } from "../services/tools/features";
import { mintToken, readToken } from "../services/tools/tokens";
import { engineFetch } from "../services/tools/engine-client";
import {
  checkRunAllowance, engineJobStatus, getWorkflow, listWorkflows, loadAttachmentFiles, runWorkflow, startTokenJob, toolStateOrOff, toolsSetup, type EngineFile,
} from "../services/tools/automation";
import { TOOLS, emptyResult, isToolOp, resultName, toolDef, toolTakes, type ToolOp, type ToolResultFacts } from "@/shared/tools";
import { chargeJob } from "../services/tools/usage";
import { WORKFLOW_STARTERS, type WorkflowStep } from "@/shared/tools-automation";

const FACT_KEYS = ["pages", "parts", "matches", "phrases", "verified", "pages_changed", "pages_with_text", "steps", "files"];

function gate(c: Context<AppEnv>) {
  requireToolFeature(c, "api");
  return toolsSetup(c.var.deps);
}

async function readMultipart(c: Context<AppEnv>) {
  const s = await toolStateOrOff(c.var.deps, c.var.auth.orgId);
  checkRunAllowance(s, Math.max(0, Number(c.req.header("content-length") ?? "0") - 64 * 1024));
  const fd = await c.req.formData().catch(() => null);
  if (!fd) throw badRequest("Send the files as multipart/form-data with one or more \"files\" parts.");
  const files: EngineFile[] = [];
  const fields: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") { if (k !== "files") fields[k] = v.slice(0, 2000); continue; }
    if (k === "files") files.push({ name: v.name.replace(/[\r\n"\\/]/g, "_").slice(0, 120) || "file", type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  return { files, fields };
}

const isJson = (c: Context<AppEnv>) => /^application\/json/i.test(c.req.header("content-type") ?? "");
const jobJson = z.object({ op: z.string().optional(), attachmentIds: z.array(z.string().min(1).max(64)).min(1).max(50), options: z.record(z.string(), z.string().max(2000)).optional(), password: z.string().max(128).optional() });

function publicTool(d: (typeof TOOLS)[number]) {
  return { op: d.op, label: d.label, group: d.group, description: d.blurb, accepts: d.acceptLabel, minFiles: d.minFiles, maxFiles: d.maxFiles, output: d.ext, options: d.options };
}

export function registerToolsV1Routes(api: OpenAPIHono<AppEnv>) {
  api.get("/tools", async (c) => {
    gate(c);
    const { deps, auth } = c.var;
    await toolStateOrOff(deps, auth.orgId);
    const on = new Set<string>(deps.config.tools.features);
    const tools = TOOLS.filter((d) => { const f = (d as { feature?: string }).feature; return !f || on.has(f); }).map(publicTool);
    const workflows = on.has("workflows") ? [...WORKFLOW_STARTERS.map((w) => ({ id: w.id, name: w.name, steps: w.steps.map((s) => s.op), builtIn: true })), ...(await listWorkflows(deps, auth.orgId)).map((w) => ({ id: w.id, name: w.name, steps: w.steps.map((s) => s.op), builtIn: false }))] : [];
    return c.json({ tools, workflows });
  });

  api.post("/tools/jobs", async (c) => {
    gate(c);
    const { deps, auth } = c.var;
    let op: string | undefined = c.req.query("op");
    let files: EngineFile[];
    let options: Record<string, string>;
    if (isJson(c)) {
      const input = jobJson.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw badRequest("Send {\"op\", \"attachmentIds\": [...], \"options\": {...}} or a multipart upload.");
      op = input.data.op ?? op;
      await toolStateOrOff(deps, auth.orgId);
      files = await loadAttachmentFiles(deps, auth, input.data.attachmentIds);
      options = input.data.options ?? {};
    } else {
      const m = await readMultipart(c);
      files = m.files; options = m.fields;
      op = op ?? m.fields.op;
    }
    if (!isToolOp(op)) throw new HttpError(400, "bad_request", "Unknown tool. GET /api/v1/tools lists the ops.");
    const def = toolDef(op as ToolOp);
    const f = (def as { feature?: string }).feature;
    if (f && !deps.config.tools.features.includes(f as never)) throw new HttpError(400, "bad_request", "That tool is not on for this workspace.");
    if (files.length < def.minFiles) throw badRequest(`${def.label} needs ${def.minFiles} or more files.`);
    if (def.maxFiles !== "plan" && files.length > def.maxFiles) throw badRequest(`${def.label} takes up to ${def.maxFiles} files.`);
    for (const file of files) if (!toolTakes(def, file.name)) throw new HttpError(422, "tool_input", `${def.label} does not take ${file.name}.`);
    const known = Object.fromEntries(Object.entries(options).filter(([k, v]) => def.options.some((o) => o.name === k) && v.trim() !== ""));
    const job = await startTokenJob(deps, auth, op, files, known, resultName(op as ToolOp, files[0]?.name));
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.jobId, metadata: { op, source: "api", files: files.length }, ip: c.var.ip });
    return c.json({ token: job.token, op, status: job.status, name: job.name, statusUrl: `/api/v1/tools/jobs/${job.token}` }, 202);
  });

  api.get("/tools/jobs/:token", async (c) => {
    const { tokenKey } = gate(c);
    const { deps, auth } = c.var;
    const t = await readToken(tokenKey, c.req.param("token"), "s", deps.now().getTime());
    if (!t || t.w !== auth.orgId) throw notFound("Job");
    const { engine } = toolsSetup(deps);
    const j = await engineJobStatus(deps, engine, { orgId: auth.orgId, userId: auth.userId }, t.j);
    const out: Record<string, unknown> = { token: c.req.param("token"), op: t.o, status: j.status, name: t.n };
    if (j.status === "failed") out.error = j.error || "The file could not be processed.";
    if (j.status === "done") {
      const facts: Record<string, unknown> = {};
      for (const k of FACT_KEYS) { const v = j.result?.[k]; if (typeof v === "number" || typeof v === "boolean") facts[k] = v; }
      out.result = facts;
      const d = await mintToken(tokenKey, { k: "d", j: t.j, w: t.w, u: auth.userId, o: t.o, n: t.n }, deps.now().getTime());
      out.downloadUrl = `/api/v1/tools/jobs/${d}/download`;
      // R66 (MB-256): counted once, when it finished with a result.
      if (t.b !== undefined && !emptyResult(t.o, facts as ToolResultFacts)) await chargeJob(deps.db, auth.orgId, t.j, deps.now(), t.b);
    }
    return c.json(out);
  });

  api.get("/tools/jobs/:token/download", async (c) => {
    const { tokenKey, engine } = gate(c);
    const { deps, auth } = c.var;
    const t = await readToken(tokenKey, c.req.param("token"), "d", deps.now().getTime());
    if (!t || t.w !== auth.orgId) throw new HttpError(404, "not_found", "This file has expired. Run the tool again.");
    let res: Response;
    try { res = await engineFetch(deps.fetch, engine, { method: "GET", path: `/internal/v1/jobs/${t.j}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 }); } catch { throw new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds."); }
    if (!res.ok || !res.body) throw new HttpError(404, "not_found", "This file has expired. Run the tool again.");
    const ascii = t.n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(res.body, { status: 200, headers: {
      "content-type": isToolOp(t.o) ? toolDef(t.o).contentType : "application/octet-stream",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(t.n)}`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    } });
  });

  api.post("/tools/workflows/:id/run", async (c) => {
    gate(c);
    requireToolFeature(c, "workflows");
    const { deps, auth } = c.var;
    const id = c.req.param("id");
    const starter = WORKFLOW_STARTERS.find((w) => w.id === id);
    const steps: WorkflowStep[] = starter ? starter.steps : (await getWorkflow(deps, auth.orgId, id)).steps;
    let files: EngineFile[];
    let password: string | undefined;
    if (isJson(c)) {
      const input = jobJson.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw badRequest("Send {\"attachmentIds\": [...], \"password\"?} or a multipart upload.");
      await toolStateOrOff(deps, auth.orgId);
      files = await loadAttachmentFiles(deps, auth, input.data.attachmentIds);
      password = input.data.password;
    } else {
      const m = await readMultipart(c);
      files = m.files; password = m.fields.password;
    }
    const job = await runWorkflow(deps, auth, steps, files, password);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.jobId, metadata: { op: "chain", steps: steps.map((s) => s.op), source: "api", files: files.length }, ip: c.var.ip });
    return c.json({ token: job.token, op: "chain", status: job.status, name: job.name, statusUrl: `/api/v1/tools/jobs/${job.token}` }, 202);
  });
}
