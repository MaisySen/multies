/**
 * The in-app workspace agent on the Node server. The Worker uses its Workers AI binding.
 * Node uses the same door: the public Workers AI HTTPS API when this server has an account id and
 * token. Without those credentials there is no built-in runner. Callers see unavailable, the same
 * as a Worker with no AI binding. It never calls a private address and never invents an answer.
 */
import type { AiRunner } from "../tools/p2-bindings";

export function nodeBuiltinAi(
  env: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): AiRunner | undefined {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !token) return undefined;
  return {
    async run(model, input) {
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${encodeURIComponent(model)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error("Built-in AI could not answer just now.");
      const body = await res.json() as { result?: unknown };
      const result = body.result ?? body;
      if (result && typeof result === "object") return result;
      return { response: typeof result === "string" ? result : "" };
    },
  };
}
