/**
 * TD8 Team AI: the one gate for the per workspace AI switch. True means the workspace allows AI; false means no provider
 * call anywhere in Team AI. Points at TD1's switch (ai-trust-td1.ts) once TD1 is on main; until then AI is allowed,
 * as on main today.
 */
import type { Deps } from "../context";

export async function teamAiSwitchOn(_deps: Deps, _orgId: string): Promise<boolean> {
  return true;
}
