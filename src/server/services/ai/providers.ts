/**
 * "Bring your own AI": the model providers a workspace can plug its own API key into.
 * Multies never pays for model calls. OpenAI, OpenRouter and Groq share the OpenAI chat
 * completions format; Anthropic uses its Messages API.
 */
import type { Ai2ResultCode, AiKeyProblem } from "../../../shared/ai-connect-ai2";

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
  // QUAL1 (audit row 14): was claude-3-5-haiku-latest, an alias of the older Claude Haiku 3.5 that the curated list no longer offers;
  // now the current Haiku, the same id the AI2 curated list recommends (shared/ai-connect-ai2.ts).
  anthropic: { id: "anthropic", name: "Anthropic", defaultModel: "claude-haiku-5-5", keysUrl: "https://console.anthropic.com/settings/keys" },
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

/**
 * Words a provider uses when it refuses the request's own text (moderation, guardrails, its length), never the key:
 * OpenRouter's 403 "requires moderation ... your input was flagged", an OpenAI style 400 context_length_exceeded.
 */
const CONTENT_REFUSAL = /moderat|flagged|guardrail|content[ _-]?(policy|filter|management)|context[ _-]?length|maximum context|too many tokens|max_tokens|prompt is too long|input is too long|reduce the length/;
/**
 * An account out of credit, in the codes and phrases providers use: OpenAI insufficient_quota, Anthropic "credit
 * balance is too low", OpenRouter "insufficient credits", DeepSeek "insufficient balance". Never a bare "credit"
 * ("No credits were charged") or a billing link (Groq's rate limit answer links its settings/billing page).
 */
const NO_CREDIT = /insufficient[ _](quota|balance|credits?|funds)|credit balance|out of credits?|no credits? (left|remaining)|exceeded your current quota|billing[ _]hard[ _]limit|payment[ _]required|key limit exceeded/;
/**
 * QUAL1 second review: a 429 is a rate limit unless it names the account's credit itself. Gemini's per minute limit
 * (429 RESOURCE_EXHAUSTED) also says "exceeded your current quota", so that phrase alone is not enough on a 429;
 * OpenAI's out of credit 429 carries insufficient_quota.
 */
const NO_CREDIT_429 = /insufficient[ _](quota|balance|credits?|funds)|credit balance|out of credits?|no credits? (left|remaining)|billing[ _]hard[ _]limit/;
/**
 * A 403 about the key itself: it names the key, signing in or permission. Not a bare "forbidden" or "access denied":
 * that is what a firewall in front of a custom server answers when it blocks a request for its content.
 */
const KEY_WORDS = /api[ _-]?key|x-api-key|authenticat|unauthori[sz]|permission|invalid (key|token|credentials)|revoked/;
/** A model that is not offered: "model" with a not found or retired phrase on the same line, or the codes for it. */
const MODEL_GONE = /model_not_found|model_decommissioned|\bmodels?\b[^\n]{0,160}?(not found|does not exist|not exist|is not available|not available|not supported|decommissioned|deprecated|no longer|do not have access|does not have access|no access)|(unknown|invalid|unsupported) model\b|not a valid model/;

/**
 * The plain result for a failed provider call, for the connection test and the model list (their request text is
 * fixed, so any 403 there is about the key). The body is only searched for a few words and is never returned or logged.
 */
export function mapFailure(status: number | null, body = ""): Ai2ResultCode {
  const b = body.toLowerCase();
  if (status === null) return "unreachable";
  if (status === 401) return "key_refused";
  if (status === 403) return NO_CREDIT.test(b) ? "no_credit" : "key_refused";
  if (status === 429) return NO_CREDIT_429.test(b) ? "no_credit" : "rate_limited"; // second review: Gemini's per minute limit
  if (status === 402 || NO_CREDIT.test(b)) return "no_credit";
  if (status === 404) return "model_unavailable";
  if ((status === 400 || status === 422) && MODEL_GONE.test(b)) return "model_unavailable";
  if (status === 400 && /api key|api_key|apikey|authentication|unauthor/.test(b)) return "key_refused";
  return "provider_error";
}

/**
 * QUAL1 (audit rows 12, 14): the lasting problem a failed call names on the saved key or its model, or null for a
 * passing one. Stricter than mapFailure, because a call's text can come from outside (a mail, a form answer): only a
 * failure about the key, the account's credit or the model counts. A provider refusing the request's own content
 * (moderation, a guardrail, too long) is never the key's problem, so outside text can neither mark a working key nor
 * send itself to built-in AI. Rate limits, outages and timeouts are passing too.
 */
export function keyProblemOf(err: unknown): AiKeyProblem | null {
  if (!(err instanceof AiProviderError) || err.status === null) return null;
  const s = err.status, b = err.message.toLowerCase();
  if (s === 401) return "key_refused";
  // QUAL1 second review: 402 Payment Required is never about the text. OpenRouter's out of credit answer is a 402 that
  // says "requires more credits, or fewer max_tokens", which the content check below would otherwise take.
  if (s === 402) return "no_credit";
  // A 429 is a rate limit (passing) unless it names the credit itself (OpenAI insufficient_quota).
  if (s === 429) return NO_CREDIT_429.test(b) ? "no_credit" : null;
  if (CONTENT_REFUSAL.test(b)) return null;
  if (NO_CREDIT.test(b)) return "no_credit";
  if (s === 403) return KEY_WORDS.test(b) ? "key_refused" : null;
  if (s === 404) return "model_unavailable";
  if ((s === 400 || s === 422) && MODEL_GONE.test(b)) return "model_unavailable";
  if (s === 400 && /api[ _-]?key|authenticat|unauthori[sz]/.test(b)) return "key_refused"; // Gemini: 400 API_KEY_INVALID
  return null;
}
