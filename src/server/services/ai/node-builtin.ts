/**
 * The in-app workspace agent on the Node server. The Worker uses its Workers AI binding.
 * Node uses the same door: the public Workers AI HTTPS API when this server has an account id and
 * token, and otherwise a short answer from the request itself. It never calls a private address.
 */
import type { AiRunner } from "../tools/p2-bindings";

export function nodeBuiltinAi(env: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }, fetchImpl: typeof fetch = globalThis.fetch): AiRunner {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  return {
    async run(model, input) {
      if (account && token) {
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
      }
      return localAnswer(input);
    },
  };
}

/** A bounded answer from the request, used when this Node server has no Workers AI token. */
function localAnswer(input: unknown): unknown {
  const o = (input && typeof input === "object" ? input : {}) as { messages?: { role?: string; content?: string }[]; text?: string };
  if (typeof o.text === "string") return { translated_text: o.text, usage: { prompt_tokens: 8, completion_tokens: Math.max(1, Math.ceil(o.text.length / 4)) } };
  const user = o.messages?.find((m) => m.role === "user")?.content ?? "";
  const text = user.replace(/\s+/g, " ").trim().slice(0, 500);
  const response = text ? (text.length > 280 ? `${text.slice(0, 277).trimEnd()}...` : text) : "Nothing to add.";
  return { response, usage: { prompt_tokens: Math.max(1, Math.ceil((user.length || 1) / 4)), completion_tokens: Math.max(1, Math.ceil(response.length / 4)) } };
}
