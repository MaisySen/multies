/**
 * "Bring your own AI": the model providers a workspace can plug its own API key into.
 * Multies never pays for model calls. OpenAI, OpenRouter and Groq share the OpenAI chat
 * completions format; Anthropic uses its Messages API.
 */
export const AI_PROVIDERS = ["openai", "anthropic", "openrouter", "groq"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  /** A small, cheap model that suits triage, summaries and drafts. */
  defaultModel: string;
  /** Where the customer creates a key. */
  keysUrl: string;
}

export const AI_PROVIDER_INFO: Record<AiProviderId, AiProviderInfo> = {
  openai: { id: "openai", name: "OpenAI", defaultModel: "gpt-4o-mini", keysUrl: "https://platform.openai.com/api-keys" },
  anthropic: { id: "anthropic", name: "Anthropic", defaultModel: "claude-3-5-haiku-latest", keysUrl: "https://console.anthropic.com/settings/keys" },
  openrouter: { id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-4o-mini", keysUrl: "https://openrouter.ai/keys" },
  groq: { id: "groq", name: "Groq", defaultModel: "llama-3.1-8b-instant", keysUrl: "https://console.groq.com/keys" },
};

export const isAiProviderId = (v: unknown): v is AiProviderId => typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);

const OPENAI_COMPATIBLE: Record<Exclude<AiProviderId, "anthropic">, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

export interface AiCompletion { system: string; user: string; maxTokens?: number }

export interface AiProvider {
  /** The provider id, shown to the user ("openai", "anthropic", ...). */
  name: string;
  complete(req: AiCompletion): Promise<string | null>;
}

/** The provider refused or failed. `status` is its HTTP status, when it answered. */
export class AiProviderError extends Error {
  constructor(public provider: AiProviderId, public status: number | null, message: string) { super(message); }
}

/** A provider that calls the customer's chosen API with the customer's own key. */
export function byoProvider(provider: AiProviderId, apiKey: string, model: string, fetchImpl: typeof fetch): AiProvider {
  return {
    name: provider,
    async complete(req) {
      const maxTokens = req.maxTokens ?? 400;
      let res: Response;
      try {
        res = provider === "anthropic"
          ? await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, system: req.system, messages: [{ role: "user", content: req.user }] }),
          })
          : await fetchImpl(OPENAI_COMPATIBLE[provider], {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
          });
      } catch (err) {
        throw new AiProviderError(provider, null, err instanceof Error ? err.message : String(err));
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AiProviderError(provider, res.status, body.slice(0, 300));
      }
      const out = (await res.json()) as { content?: { type?: string; text?: string }[]; choices?: { message?: { content?: string } }[] };
      const text = provider === "anthropic"
        ? (out.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
        : out.choices?.[0]?.message?.content ?? "";
      return text.trim() || null;
    },
  };
}
