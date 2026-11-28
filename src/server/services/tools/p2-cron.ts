/**
 * Tools P2: the cron passes, called from the scheduled handler (src/entry/worker.ts). Each pass runs on its own,
 * inside its own try/catch, and only when Tools is on and its feature is listed, so production (Tools on, no P2
 * features yet) makes no extra query. Every pass is bounded (see each function for its reads and writes).
 */
import type { Deps } from "../../context";
import { pruneAiUsage } from "./ai-meter";
import { runSignPass } from "./esign";
import { runMergePass } from "./automation";
import { runIndexPass } from "./attachment-index";
import { pruneStaleUploads } from "./file-requests";
import { runDocPass } from "../suite/doc-inbox";
import type { CronStep } from "../cron-steps";

const AI_FEATURES = ["ask", "translate", "extract", "expenses", "contracts"];

/**
 * MPLAT-96: the passes due on this run, each already guarded, NOT started yet. The scheduled handler runs them one
 * after another (services/cron-steps.ts) so the database never sees them all in the same second.
 */
export function toolsCronSteps(deps: Deps): CronStep[] {
  const t = deps.config.tools;
  if (!t.enabled) return [];
  const features: readonly string[] = t.features;
  const on = (...ids: string[]) => ids.some((id) => features.includes(id));
  const guard = (where: string, run: () => Promise<unknown>): CronStep => ({
    name: `tools.${where}`,
    run: () => run().catch((err: unknown) => {
      deps.log?.warn(`tools.${where}_failed`, { error: err instanceof Error ? err.message : String(err) });
      deps.reportError?.(err, { where: `tools.${where}` });
    }),
  });
  const out: CronStep[] = [];
  if (on(...AI_FEATURES)) out.push(guard("ai_prune", () => pruneAiUsage(deps, deps.now())));
  if (on("esign", "share")) out.push(guard("sign_pass", () => runSignPass(deps)));
  // R88: file request uploads left unfinished for a day give their room back (100 a run).
  if (on("file_requests")) out.push(guard("request_prune", () => pruneStaleUploads(deps)));
  if (on("merge_mail")) out.push(guard("merge_pass", () => runMergePass(deps)));
  // A no op without INDEX_DB or with indexing off (the pass checks its own stops: the D1 read guard, caps, switches).
  if (on("index", "folders")) out.push(guard("index_pass", () => runIndexPass(deps)));
  // R102: Files > Documents reading (DOC_INBOX_R102 with Files plus); its own caps, the vv8k exclusion and the D1 guard.
  if (deps.config.docInbox && deps.config.filesPlus) out.push(guard("doc_inbox_pass", () => runDocPass(deps)));
  return out;
}

/** The same passes started at once (each guarded); kept for callers that want every promise. */
export function toolsCronPasses(deps: Deps): Promise<unknown>[] {
  return toolsCronSteps(deps).map((s) => s.run());
}
