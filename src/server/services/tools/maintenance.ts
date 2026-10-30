import type { Deps } from "../../context";
import { pruneToolUsage } from "./usage";

/** Pings the engine's /healthz so a free host does not go to sleep, and (once an hour) prunes tool_usage. */
export async function toolsMaintenance(deps: Deps, prune: boolean): Promise<{ engine: boolean }> {
  const engine = deps.config.tools.engine;
  let ok = false;
  if (engine) {
    try {
      const res = await deps.fetch(`${engine.url}/healthz`, { method: "GET", signal: AbortSignal.timeout(8_000) });
      ok = res.ok;
      await res.body?.cancel();
    } catch { ok = false; }
    if (!ok) deps.log?.warn("tools.engine_health", { ok });
  }
  if (prune) await pruneToolUsage(deps.db, deps.now());
  return { engine: ok };
}
