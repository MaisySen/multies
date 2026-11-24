/**
 * The in-app workspace agent on the Node server. The Worker uses its Workers AI binding.
 * Node uses the same door through the public Workers AI REST API, but only when the operator turns it on:
 * BUILTIN_AI=workers-ai with its own WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN (a token with the Workers AI
 * permission). The CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN that the D1 import uses never turn it on: that
 * token is for reading the hosted database, and workspace text must not go to another processor by accident.
 * Without the opt-in there is no built-in runner. Callers see unavailable, the same as a Worker with no AI binding.
 * It never calls a private address and never invents an answer.
 */
import type { AiRunner } from "../tools/p2-bindings";

export interface NodeBuiltinAiEnv {
  BUILTIN_AI?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
  [key: string]: string | undefined;
}

const FAILED = "Built-in AI could not answer just now.";

/**
 * The model path as Cloudflare documents it (`/accounts/{id}/ai/run/@cf/meta/llama-3.1-8b-instruct`): each segment
 * encoded on its own so the slashes stay, `@` kept. Anything that is not a plain model id is refused.
 */
export function workersAiModelPath(model: string): string | null {
  const parts = model.split("/");
  if (!parts.length || parts.some((p) => !/^@?[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p) || p === "." || p === "..")) return null;
  return parts.map((p) => encodeURIComponent(p).replace(/^%40/, "@")).join("/");
}

export function nodeBuiltinAi(env: NodeBuiltinAiEnv, fetchImpl: typeof fetch = globalThis.fetch): AiRunner | undefined {
  if ((env.BUILTIN_AI ?? "").trim().toLowerCase() !== "workers-ai") return undefined;
  const account = env.WORKERS_AI_ACCOUNT_ID?.trim();
  const token = env.WORKERS_AI_API_TOKEN?.trim();
  if (!account || !token) return undefined;
  return {
    async run(model, input) {
      const path = workersAiModelPath(model);
      if (!path) throw new Error(FAILED);
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(FAILED);
      // Cloudflare's envelope: { success, errors, messages, result }. success:false (or no result) is a failure.
      const body = await res.json().catch(() => null) as { success?: boolean; result?: unknown } | null;
      if (!body || body.success === false || body.result === undefined || body.result === null) throw new Error(FAILED);
      const result = body.result;
      if (typeof result === "object") return result;
      return { response: typeof result === "string" ? result : "" };
    },
  };
}
