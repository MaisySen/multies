/**
 * "Bring your own AI": the model providers a workspace can plug its own API key into.
 * Multies never pays for model calls. OpenAI, OpenRouter and Groq share the OpenAI chat
 * completions format; Anthropic uses its Messages API.
 */
export const AI_PROVIDERS = ["openai", "anthropic", "openrouter", "groq", "gemini", "mistral", "deepseek", "custom"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
/** The providers offered while AI2 (AI_CONNECT_AI2) is off: today's screen, unchanged. */
export const LEGACY_AI_PROVIDERS = ["openai", "anthropic", "openrouter", "groq"] as const satisfies readonly AiProviderId[];

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
  // AI2: offered only while AI_CONNECT_AI2 is on. The saved model comes from the live list (curated fallback).
  gemini: { id: "gemini", name: "Google Gemini", defaultModel: "gemini-3.5-flash-lite", keysUrl: "https://aistudio.google.com/app/apikey" },
  mistral: { id: "mistral", name: "Mistral", defaultModel: "mistral-small-latest", keysUrl: "https://console.mistral.ai/api-keys" },
  deepseek: { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat", keysUrl: "https://platform.deepseek.com/api_keys" },
  custom: { id: "custom", name: "Other (OpenAI compatible)", defaultModel: "", keysUrl: "" },
};

export const isAiProviderId = (v: unknown): v is AiProviderId => typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);

/** Where each provider's OpenAI style API lives (chat completions and the model list hang off it). */
export const OPENAI_COMPATIBLE_BASE: Record<Exclude<AiProviderId, "anthropic" | "custom">, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
};

/** The chat completions address for a provider; a custom server's comes from its saved base address. */
export function chatUrl(provider: Exclude<AiProviderId, "anthropic">, baseUrl?: string | null): string {
  if (provider === "custom") {
    if (!baseUrl) throw new AiProviderError(provider, null, "no base address");
    return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }
  return `${OPENAI_COMPATIBLE_BASE[provider]}/chat/completions`;
}

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
export function byoProvider(provider: AiProviderId, apiKey: string, model: string, fetchImpl: typeof fetch, baseUrl?: string | null): AiProvider {
  return {
    name: provider,
    async complete(req) {
      const maxTokens = req.maxTokens ?? 400;
      let res: Response;
      const openAiBody = (legacy: boolean) => JSON.stringify({
        model,
        // Newer reasoning models refuse max_tokens and any temperature but the default; the retry below drops both.
        ...(legacy ? { max_tokens: maxTokens, temperature: 0.3 } : { max_completion_tokens: maxTokens }),
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      });
      const callOpenAi = (legacy: boolean) => fetchImpl(chatUrl(provider as Exclude<AiProviderId, "anthropic">, baseUrl), {
        method: "POST",
        // AI2: a custom server never gets to send the call somewhere else.
        ...(provider === "custom" ? { redirect: "manual" as const } : {}),
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: openAiBody(legacy),
      });
      try {
        res = provider === "anthropic"
          ? await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, system: req.system, messages: [{ role: "user", content: req.user }] }),
          })
          : await callOpenAi(true);
        if (provider !== "anthropic" && res.status === 400) {
          const why = await res.clone().text().catch(() => "");
          if (/max_tokens|max_completion_tokens|temperature/i.test(why)) res = await callOpenAi(false);
        }
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
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
