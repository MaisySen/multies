/**
 * Tools P2 (H5): small server side engine calls for share and sign (submit, status, output), on the same signed
 * job API as the Tools page. Used where a person is not waiting on a Tools page job: page previews for placing
 * signatures, and the sign op that finishes a document. The other P2 helpers' runToolJob can replace this.
 */
import type { Deps } from "../../context";
import { HttpError } from "../../lib/errors";
import { engineFetch } from "./engine-client";

/** `field` is the form field the engine reads the file from: "files" unless the op names an extra slot (sign: "images"). */
export interface EngineFile { name: string; type: string; bytes: Uint8Array; field?: string }
export interface EngineJobState { status: "queued" | "running" | "done" | "failed" | "expired"; result?: Record<string, unknown>; error?: string }

function engineOf(deps: Deps) {
  const t = deps.config.tools;
  if (!t.enabled || !t.engine) throw new HttpError(404, "not_found", "Page not found.");
  return t.engine;
}

const down = () => new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");

export async function submitEngineJob(deps: Deps, ws: string, user: string, op: string, files: EngineFile[], options: Record<string, string> = {}): Promise<string> {
  const engine = engineOf(deps);
  const fd = new FormData();
  for (const [k, v] of Object.entries(options)) fd.append(k, v);
  for (const f of files) fd.append(f.field ?? "files", new Blob([f.bytes as BlobPart], { type: f.type }), f.name.replace(/[\r\n"\\/]/g, "_").slice(0, 120));
  const req = new Request("http://tools.local/", { method: "POST", body: fd });
  const body = new Uint8Array(await req.arrayBuffer());
  let res: Response;
  try {
    res = await engineFetch(deps.fetch, engine, { method: "POST", path: `/internal/v1/jobs?op=${op}`, ws, user, maxBytes: body.byteLength + 1024, body: new Blob([body]).stream(), contentLength: body.byteLength, contentType: req.headers.get("content-type") ?? "" });
  } catch { throw down(); }
  if (res.status !== 202) {
    let message = "";
    try { message = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
    if (res.status === 400) throw new HttpError(422, "tool_input", message || "That file could not be used here.");
    if (res.status === 429) throw new HttpError(429, "tools_busy", "Tools are busy. Try again in a minute.");
    throw down();
  }
  return ((await res.json()) as { id: string }).id;
}

export async function engineJobState(deps: Deps, ws: string, user: string, id: string): Promise<EngineJobState> {
  const engine = engineOf(deps);
  let res: Response;
  try { res = await engineFetch(deps.fetch, engine, { method: "GET", path: `/internal/v1/jobs/${id}`, ws, user, maxBytes: 0 }); } catch { throw down(); }
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) throw down();
  const j = (await res.json()) as { status: EngineJobState["status"]; result?: Record<string, unknown>; error?: string };
  return { status: j.status, result: j.result, error: j.error };
}

export async function engineJobOutput(deps: Deps, ws: string, user: string, id: string): Promise<Uint8Array | null> {
  const engine = engineOf(deps);
  let res: Response;
  try { res = await engineFetch(deps.fetch, engine, { method: "GET", path: `/internal/v1/jobs/${id}/output`, ws, user, maxBytes: 0 }); } catch { throw down(); }
  if (res.status === 404) return null;
  if (!res.ok) throw down();
  return new Uint8Array(await res.arrayBuffer());
}
