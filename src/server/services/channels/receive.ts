/**
 * C1: a webhook delivery from the signature check to the database. Split from the route so the mock "customer"
 * in E2E goes through exactly the same path as Meta.
 *
 * Meta has no way to fetch a missed webhook, so messages and statuses are stored before the answer: a database
 * failure answers 500 and Meta retries (for up to 7 days; the duplicate check makes retries free). Only the file
 * downloads run after the 200, in `work` (waitUntil on Workers).
 */
import type { Deps } from "../../context";
import { ingestBatches } from "./ingest";
import { and, eq } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import { msgChannels } from "../../db/schema";
import { MOCK_APP_SECRET, parseAccountUpdates, parseWebhook, verifySignature } from "./webhook";

export async function handleWebhookPost(deps: Deps, raw: string, signature: string | undefined): Promise<{ status: 200 | 401 | 500; work: Promise<unknown> | null }> {
  const { meta, mock } = deps.config.channels;
  const secrets = [meta?.appSecret ?? "", mock ? MOCK_APP_SECRET : ""].filter(Boolean);
  if (!secrets.length || !(await verifySignature(raw, signature, secrets))) return { status: 401, work: null };
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { status: 200, work: null }; }
  const batches = parseWebhook(body, deps.now());
  if (!batches.length) {
    // A business that removes Multies from its WhatsApp account: its channel shows "Connect again" (rare, one write).
    const gone = parseAccountUpdates(body).filter((u) => u.event === "PARTNER_APP_UNINSTALLED").map((u) => u.accountId);
    if (gone.length) {
      try {
        await deps.db.update(msgChannels).set({ status: "error", lastError: "This WhatsApp account removed Multies. Connect it again to keep receiving messages." })
          .where(and(inIds(msgChannels.externalAccountId, gone.slice(0, 50)), eq(msgChannels.provider, "whatsapp"), eq(msgChannels.status, "active")));
      } catch { return { status: 500, work: null }; }
    }
    return { status: 200, work: null };
  }
  let r: Awaited<ReturnType<typeof ingestBatches>>;
  try {
    r = await ingestBatches(deps, batches);
  } catch (err) {
    deps.log?.warn?.("channels.ingest_failed", { error: String((err as Error)?.message ?? err) });
    deps.reportError?.(err, { where: "channels.ingest" });
    return { status: 500, work: null };
  }
  if (r.unknownEndpoint || r.overCap) deps.log?.info?.("channels.ingest", { stored: r.stored, duplicates: r.duplicates, statuses: r.statuses, unknownEndpoint: r.unknownEndpoint, overCap: r.overCap });
  const work = r.mediaJobs.length ? Promise.all(r.mediaJobs.map((job) => job())) : null;
  return { status: 200, work };
}
