/**
 * AI2 (flag AI_CONNECT_AI2): built-in AI for the inbox assistant, so AI works with no key.
 * It runs only through the AI meter (services/tools/ai-meter.ts), the same door the document helpers use:
 * before every call the estimated units are reserved in D1 against the account wide hard stop (80% of the free
 * daily allocation) and the workspace's daily share; the model is never called unless both reservations hold.
 * When today's budget is spent it pauses until the next UTC day. A workspace's own key always wins.
 */
import type { Deps } from "../../context";
import { HttpError } from "../../lib/errors";
import type { AiCompletion } from "./providers";
import { aiAllowed, assertAiAllowed } from "../ai-trust-td1";

export const BUILTIN_LIMIT_MESSAGE = "Built-in AI has reached today's free limit. It's back tomorrow, or add your own key in Advanced.";
export const BUILTIN_NAME = "Built-in AI";

/** One completion on built-in AI. Throws a plain HttpError when the meter says no; never falls through to anything billed. */
export async function askBuiltin(deps: Deps, orgId: string, req: AiCompletion, opts: { skipOwnKey?: boolean } = {}): Promise<{ text: string | null; provider: string }> {
  await assertAiAllowed(deps, orgId); // TD1 switch off: no reservation and no binding call
  const { askAi } = await import("../tools/ai-meter");
  // QUAL1: standing in for a refused own key, the meter must not try that key again (skipOwnKey).
  const r = await askAi(deps, orgId, { task: "chat", system: req.system, user: req.user, maxTokens: req.maxTokens }, opts);
  if (r.ok) return { text: r.text.trim() || null, provider: r.source === "own_key" ? "own_key" : "builtin" };
  if (r.reason === "limit" || r.reason === "workspace_limit") throw new HttpError(429, "builtin_ai_limit", BUILTIN_LIMIT_MESSAGE);
  if (r.reason === "too_big") throw new HttpError(413, "builtin_ai_too_big", "That is too long for built-in AI. Add your own key in Advanced for longer work.");
  if (r.reason === "unavailable") throw new HttpError(409, "ai_key_required", "Built-in AI is not available right now. Add your own key in Advanced.");
  throw new HttpError(502, "builtin_ai_error", "Built-in AI could not answer just now. Try again in a minute.");
}

/** What the settings screen shows: whether built-in AI is there, and today's use for this workspace. */
export async function builtinStatus(deps: Deps, orgId: string) {
  const { aiUsage } = await import("../tools/ai-meter");
  const usage = await aiUsage(deps, orgId);
  const available = !!deps.ai;
  const paused = usage.globalReached || usage.percent >= 100;
  const off = !(await aiAllowed(deps, orgId));
  return {
    available,
    /** TD1 switch: an admin turned AI off here, so no AI path calls any provider. */
    off,
    /** True when the assistant runs on built-in AI now (no own key saved). */
    active: available && !off && !usage.ownKey, // MB-330: never "in use" while the workspace switch is off
    paused,
    percent: usage.percent,
    calls: usage.calls,
    resetsAt: `${usage.day}T23:59:59Z`,
    message: paused ? BUILTIN_LIMIT_MESSAGE : null,
  };
}
