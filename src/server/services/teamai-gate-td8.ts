/**
 * TD8 Team AI: the one gate for the per workspace AI switch (TD1, ai-trust-td1.ts). True means the workspace allows AI;
 * false means no provider call anywhere in Team AI (the run is logged as skipped, the page shows the off state).
 */
import type { Deps } from "../context";
import { aiAllowed } from "./ai-trust-td1";

export async function teamAiSwitchOn(deps: Deps, orgId: string): Promise<boolean> {
  return aiAllowed(deps, orgId);
}
