/**
 * C1: a webhook delivery from the signature check to the database. Split from the route so the mock "customer"
 * in E2E goes through exactly the same path as Meta.
 */
import type { Deps } from "../../context";
import { ingestBatches } from "./ingest";
import { MOCK_APP_SECRET, parseWebhook, verifySignature } from "./webhook";

export async function handleWebhookPost(deps: Deps, raw: string, signature: string | undefined): Promise<{ status: 200 | 401; work: Promise<unknown> | null }> {
  const { meta, mock } = deps.config.channels;
  const secrets = [meta?.appSecret ?? "", mock ? MOCK_APP_SECRET : ""].filter(Boolean);
  if (!secrets.length || !(await verifySignature(raw, signature, secrets))) return { status: 401, work: null };
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { status: 200, work: null }; }
  const batches = parseWebhook(body, deps.now());
  if (!batches.length) return { status: 200, work: null };
  const work = ingestBatches(deps, batches)
    .then((r) => { if (r.unknownEndpoint || r.overCap) deps.log?.info?.("channels.ingest", { ...r }); return r; })
    .catch((err) => { deps.log?.warn?.("channels.ingest_failed", { error: String((err as Error)?.message ?? err) }); deps.reportError?.(err, { where: "channels.ingest" }); });
  return { status: 200, work };
}
