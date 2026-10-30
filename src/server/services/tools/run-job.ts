/**
 * Tools P2: run engine jobs from server code (AI, index, share, sign and automation helpers call this),
 * plus the pieces the /api/tools routes share: plan checks, engine errors and the facts filter.
 *
 * runToolJob(deps, auth, op, files, options) starts one job on the document engine with the same plan
 * limits, workspace switch, feature flag and usage count as a person's run, waits for it, and hands back
 * the result facts and (by default) the output bytes. startToolJob / toolJobStatus / toolJobOutput are the
 * same steps one at a time, for cron passes that collect a job on their next run instead of waiting.
 */
import type { AuthContext, Deps } from "../../context";
import { HttpError, notFound, planLimit } from "../../lib/errors";
import { audit } from "../audit";
import { engineFetch, type EngineConfig } from "./engine-client";
import { readToolState, recordRun, toolLimits, toolsOnFor, type ToolState } from "./usage";
import { TOOL_FACT_KEYS, extForType, isToolOp, toolDef, toolOn, type ToolJobStatus, type ToolOp, type ToolResultFacts } from "@/shared/tools";

/** Multipart framing on top of the files themselves (boundaries and part headers). */
export const MULTIPART_ALLOWANCE = 64 * 1024;

export const engineDown = () => new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");

/** The engine settings, or null when Tools is off for this deployment. */
export function toolsEngine(deps: Pick<Deps, "config">): { engine: EngineConfig; tokenKey: string } | null {
  const t = deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) return null;
  return { engine: t.engine as EngineConfig, tokenKey: t.tokenKey };
}

/** Turns an engine refusal into the plain error people see. */
export async function engineError(res: Response): Promise<never> {
  let message = "";
  try { message = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
  if (res.status === 400) throw new HttpError(422, "tool_input", message || "That file could not be used with this tool.");
  if (res.status === 413) throw new HttpError(413, "too_large", message || "That upload is larger than your plan allows.");
  if (res.status === 429) throw new HttpError(429, "tools_busy", message || "Tools are busy. Try again in a minute.");
  throw engineDown();
}

/** Only the known small facts pass through to the browser. */
export function pickFacts(r: ToolResultFacts): ToolResultFacts {
  const out: Record<string, number | boolean> = {};
  for (const k of TOOL_FACT_KEYS) {
    const v = (r as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out as ToolResultFacts;
}

/** A P2 tool whose flag is off answers like a tool that does not exist. */
export function assertToolOn(deps: Pick<Deps, "config">, op: ToolOp): void {
  const def = toolDef(op);
  if (!toolOn(def, deps.config.tools.features)) throw new HttpError(400, "bad_request", "That tool is not available.");
}

/** The plan and per tool limits for a run of `files` files and `len` bytes (0 when not known yet). */
export function checkRun(op: ToolOp, files: number, len: number, s: ToolState, extraFiles = 0) {
  const limits = toolLimits(s.plan);
  const def = toolDef(op);
  if (files < def.minFiles) throw new HttpError(400, "bad_request", `This tool needs ${def.minFiles} or more files.`);
  if (def.maxFiles === "plan" && files > limits.maxMergeFiles) throw planLimit(`You can merge up to ${limits.maxMergeFiles} files at once on your plan.`);
  if (def.maxFiles !== "plan" && files > def.maxFiles) throw new HttpError(400, "bad_request", `${def.label} takes up to ${def.maxFiles} ${def.maxFiles === 1 ? "file" : "files"}.`);
  if (def.extra && (extraFiles < def.extra.min || extraFiles > def.extra.max)) throw new HttpError(400, "bad_request", `${def.extra.label}: add ${def.extra.min === def.extra.max ? def.extra.min : `${def.extra.min} to ${def.extra.max}`}.`);
  if (def.maxBytes && len > def.maxBytes + MULTIPART_ALLOWANCE) throw new HttpError(413, "too_large", `${def.label} takes files up to ${Math.round(def.maxBytes / (1024 * 1024))} MB.`);
  if (s.month >= limits.runsMonthly) throw planLimit(`Your workspace has used all ${limits.runsMonthly} tool runs this month. They reset on the 1st.`);
  if (s.day >= limits.runsDaily) throw planLimit(`Your workspace has used all ${limits.runsDaily} tool runs for today. Try again tomorrow.`);
}

/** Plan, switch and counts for the workspace; 404 when Tools is switched off there. */
export async function toolStateFor(deps: Pick<Deps, "db" | "now">, orgId: string): Promise<ToolState> {
  const s = await readToolState(deps.db, orgId, deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
  return s;
}

export interface ToolFileInput { name: string; bytes: Uint8Array | ArrayBuffer; type?: string }
type RunAuth = Pick<AuthContext, "orgId" | "userId"> & Partial<Pick<AuthContext, "email">>;

export interface StartToolJobOptions {
  /** Files for the op's second slot (ToolDef.extra), sent under its own field name. */
  extra?: ToolFileInput[];
  /** Count the run against the plan and write the audit row (default true). Cron passes that meter themselves pass false. */
  count?: boolean;
  /** Recorded on the audit row as the source ("upload", "attachment", or the helper's own word such as "index"). */
  source?: string;
  ip?: string;
}

/** Starts one engine job. Throws the same plain HttpErrors the /api/tools routes answer with. */
export async function startToolJob(deps: Deps, auth: RunAuth, op: ToolOp, files: ToolFileInput[], options: Record<string, string> = {}, o: StartToolJobOptions = {}): Promise<{ jobId: string; status: ToolJobStatus; bytesIn: number }> {
  const cfg = toolsEngine(deps);
  if (!cfg) throw notFound("Page");
  if (!isToolOp(op) && !isEngineOnlyOp(op)) throw new HttpError(400, "bad_request", "That tool is not available.");
  if (isToolOp(op)) assertToolOn(deps, op);
  const s = await toolStateFor(deps, auth.orgId);
  const fd = new FormData();
  for (const [k, v] of Object.entries(options)) if (typeof v === "string" && v.trim() !== "") fd.append(k, v);
  for (const f of files) fd.append("files", new Blob([f.bytes as BlobPart], { type: f.type || "application/octet-stream" }), safeName(f.name));
  const extraField = isToolOp(op) ? toolDef(op).extra?.field ?? "extra" : "extra";
  for (const f of o.extra ?? []) fd.append(extraField, new Blob([f.bytes as BlobPart], { type: f.type || "application/octet-stream" }), safeName(f.name));
  const req = new Request("http://tools.local/", { method: "POST", body: fd });
  const ctype = req.headers.get("content-type") ?? "";
  const body = new Uint8Array(await req.arrayBuffer());
  const limits = toolLimits(s.plan);
  const maxBytes = limits.maxBytes + MULTIPART_ALLOWANCE;
  if (body.byteLength > maxBytes) throw new HttpError(413, "too_large", `Files can add up to ${Math.round(limits.maxBytes / (1024 * 1024))} MB on your plan.`);
  if (isToolOp(op)) checkRun(op, files.length, body.byteLength, s, o.extra?.length ?? 0);
  else if (s.month >= limits.runsMonthly || s.day >= limits.runsDaily) throw planLimit("Your workspace has used all its tool runs for now.");
  let res: Response;
  try {
    res = await engineFetch(deps.fetch, cfg.engine, { method: "POST", path: `/internal/v1/jobs?op=${op}`, ws: auth.orgId, user: auth.userId, maxBytes, body: new Blob([body]).stream(), contentLength: body.byteLength, contentType: ctype });
  } catch { throw engineDown(); }
  if (res.status !== 202) await engineError(res);
  const job = (await res.json()) as { id: string; status: ToolJobStatus };
  if (o.count !== false) {
    const now = deps.now();
    await Promise.all([
      recordRun(deps.db, auth.orgId, now, body.byteLength),
      audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email ?? "", action: "tools.run", targetType: "tool_job", targetId: job.id, metadata: { op, source: o.source ?? "server", files: files.length, bytes_in: body.byteLength }, ip: o.ip }),
    ]);
  }
  return { jobId: job.id, status: job.status, bytesIn: body.byteLength };
}

export interface ToolJobState { status: ToolJobStatus; error?: string; progress?: { done: number; total: number }; result?: ToolResultFacts; output?: { name?: string; bytes?: number; contentType?: string } }

/** One status read (no D1). "expired" when the engine no longer has the job. */
export async function toolJobStatus(deps: Deps, auth: RunAuth, jobId: string): Promise<ToolJobState> {
  const cfg = toolsEngine(deps);
  if (!cfg) throw notFound("Page");
  let res: Response;
  try { res = await engineFetch(deps.fetch, cfg.engine, { method: "GET", path: `/internal/v1/jobs/${jobId}`, ws: auth.orgId, user: auth.userId, maxBytes: 0 }); } catch { throw engineDown(); }
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) await engineError(res);
  const j = (await res.json()) as { status: ToolJobStatus; error?: string; output?: { name?: string; bytes?: number; content_type?: string }; progress?: { done: number; total: number }; result?: ToolResultFacts };
  const out: ToolJobState = { status: j.status };
  if (j.progress && Number.isFinite(j.progress.done) && Number.isFinite(j.progress.total)) out.progress = { done: j.progress.done, total: j.progress.total };
  if (j.status === "done") {
    if (j.result) out.result = pickFacts(j.result);
    out.output = { name: j.output?.name, bytes: j.output?.bytes, contentType: j.output?.content_type };
  }
  if (j.status === "failed") out.error = j.error || "The file could not be processed.";
  return out;
}

/** The finished output's bytes and type, or null when it has expired. Capped at maxBytes (default 25 MB). */
export async function toolJobOutput(deps: Deps, auth: RunAuth, jobId: string, maxBytes = 25 * 1024 * 1024): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const cfg = toolsEngine(deps);
  if (!cfg) throw notFound("Page");
  let res: Response;
  try { res = await engineFetch(deps.fetch, cfg.engine, { method: "GET", path: `/internal/v1/jobs/${jobId}/output`, ws: auth.orgId, user: auth.userId, maxBytes: 0 }); } catch { throw engineDown(); }
  if (res.status === 404) return null;
  if (!res.ok) await engineError(res);
  const size = Number(res.headers.get("content-length") ?? "0");
  if (size > maxBytes) throw new HttpError(413, "too_large", "That result is too large to use here.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new HttpError(413, "too_large", "That result is too large to use here.");
  return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

export interface RunToolJobResult {
  jobId: string;
  status: "done" | "failed" | "expired" | "timeout";
  error?: string;
  result?: ToolResultFacts;
  /** Present when status is done and fetchOutput was not false. ext is the type the engine made (null when unknown). */
  output?: { bytes: Uint8Array; contentType: string; ext: string | null };
}

export interface RunToolJobOptions extends StartToolJobOptions {
  /** How long to wait for the engine (default 120 s). */
  timeoutMs?: number;
  /** Time between status reads (default 1.5 s). */
  pollMs?: number;
  /** Download the output when done (default true). */
  fetchOutput?: boolean;
  /** Waits between polls; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs one engine op and waits for it: start, poll, then download the output. Same limits, switch,
 * flag and usage count as a person's run. Errors before the engine accepts the job throw HttpError;
 * a job that fails or runs past the timeout comes back with that status (nothing is thrown).
 */
export async function runToolJob(deps: Deps, auth: RunAuth, op: ToolOp, files: ToolFileInput[], options: Record<string, string> = {}, o: RunToolJobOptions = {}): Promise<RunToolJobResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { jobId } = await startToolJob(deps, auth, op, files, options, o);
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  for (;;) {
    const st = await toolJobStatus(deps, auth, jobId);
    if (st.status === "done") {
      const out: RunToolJobResult = { jobId, status: "done", result: st.result };
      if (o.fetchOutput !== false) {
        const got = await toolJobOutput(deps, auth, jobId);
        if (!got) return { jobId, status: "expired" };
        out.output = { ...got, ext: extForType(st.output?.contentType ?? got.contentType) };
      }
      return out;
    }
    if (st.status === "failed" || st.status === "expired") return { jobId, status: st.status, error: st.error };
    if (Date.now() >= deadline) return { jobId, status: "timeout", error: "The document engine took too long." };
    await sleep(o.pollMs ?? 1500);
  }
}

/** Engine ops with no card in the catalogue, run only by server code (contract E1 and E2). */
const ENGINE_ONLY_OPS = ["thumbnails", "organize", "form-fields", "form-fill", "compare", "sign", "extract-text", "segments", "translate-apply", "render", "render-batch", "chain"] as const;
export const isEngineOnlyOp = (op: string): boolean => (ENGINE_ONLY_OPS as readonly string[]).includes(op);

const safeName = (n: string) => (n || "file").replace(/[\r\n"\\/]/g, "_").slice(0, 120);
