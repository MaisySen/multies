/**
 * AI2 (flag AI_CONNECT_AI2): connecting the workspace's own AI without typing. Shared by the server and the web app:
 * the provider catalogue, provider detection from a pasted key, the short curated model lists used when a
 * provider's live list cannot be read, and the rule that picks the recommended model from a list.
 * Keys never pass through this file; the browser only ever sees model ids and names.
 */
export const AI2_PROVIDERS = ["openrouter", "anthropic", "openai", "gemini", "groq", "mistral", "deepseek", "custom"] as const;
export type Ai2ProviderId = (typeof AI2_PROVIDERS)[number];

export interface Ai2ProviderCard {
  id: Ai2ProviderId;
  name: string;
  /** One plain line under the name. */
  blurb: string;
  /** Where the customer creates a key (opens in a new tab). Empty for a custom server. */
  keysUrl: string;
  /** True when the one tap sign in is offered instead of a pasted key. */
  oneTap?: boolean;
}

export const AI2_PROVIDER_CARDS: Record<Ai2ProviderId, Ai2ProviderCard> = {
  openrouter: { id: "openrouter", name: "OpenRouter", blurb: "One account for every major model. Sign in and approve, no key to copy.", keysUrl: "https://openrouter.ai/keys", oneTap: true },
  anthropic: { id: "anthropic", name: "Anthropic", blurb: "Claude models, strong at writing and careful replies.", keysUrl: "https://console.anthropic.com/settings/keys" },
  openai: { id: "openai", name: "OpenAI", blurb: "GPT models, a solid all rounder.", keysUrl: "https://platform.openai.com/api-keys" },
  gemini: { id: "gemini", name: "Google Gemini", blurb: "Gemini models, fast with a free tier.", keysUrl: "https://aistudio.google.com/app/apikey" },
  groq: { id: "groq", name: "Groq", blurb: "Open models with very fast replies.", keysUrl: "https://console.groq.com/keys" },
  mistral: { id: "mistral", name: "Mistral", blurb: "Mistral models, hosted in Europe.", keysUrl: "https://console.mistral.ai/api-keys" },
  deepseek: { id: "deepseek", name: "DeepSeek", blurb: "Low cost chat and reasoning models.", keysUrl: "https://platform.deepseek.com/api_keys" },
  custom: { id: "custom", name: "Other (OpenAI compatible)", blurb: "Your own server or any service with an OpenAI compatible address.", keysUrl: "" },
};

export const isAi2ProviderId = (v: unknown): v is Ai2ProviderId => typeof v === "string" && (AI2_PROVIDERS as readonly string[]).includes(v);

/** Removes spaces and line breaks a copy and paste picks up (and wrapping quotes). */
export function cleanPastedKey(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
}

/**
 * The provider a key belongs to, from its format, or null when the format is not distinctive.
 * Order matters: Anthropic and OpenRouter keys also start with "sk-".
 */
export function detectProvider(raw: string): Ai2ProviderId | null {
  const k = cleanPastedKey(raw);
  if (k.length < 16) return null;
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("sk-proj-") || k.startsWith("sk-svcacct-") || k.startsWith("sk-admin-")) return "openai";
  // DeepSeek keys are "sk-" and 32 hex characters; OpenAI's legacy keys are "sk-" and 48 mixed characters.
  if (/^sk-[0-9a-f]{32}$/.test(k)) return "deepseek";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export interface Ai2Model { id: string; name: string }

/**
 * Short lists shown when the provider's live list cannot be read ("Could not load the live list, showing common
 * models"). Checked against the providers' public lists on Nov 2 2026; the first entry is the recommended one.
 */
export const AI2_CURATED_MODELS: Record<Ai2ProviderId, Ai2Model[]> = {
  openrouter: [
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
    { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "openai/gpt-6-luna", name: "GPT 6 Luna" },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "openai/gpt-6.1-sol", name: "GPT 6.1 Sol" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
  ],
  anthropic: [
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  ],
  openai: [
    { id: "gpt-6-luna", name: "GPT 6 Luna" },
    { id: "gpt-6.1-terra", name: "GPT 6.1 Terra" },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  ],
  gemini: [
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  groq: [
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" },
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
    { id: "openai/gpt-oss-20b", name: "GPT OSS 20B" },
  ],
  mistral: [
    { id: "mistral-small-latest", name: "Mistral Small" },
    { id: "mistral-medium-latest", name: "Mistral Medium" },
    { id: "mistral-large-latest", name: "Mistral Large" },
  ],
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
  ],
  custom: [],
};

/** Small, fast, low cost models first: what suits sorting, summaries and drafted replies in the inbox. */
const RECOMMEND: Record<Ai2ProviderId, RegExp[]> = {
  openrouter: [/^anthropic\/claude-haiku-[\d.]+$/, /^google\/gemini-[\d.]+-flash-lite$/, /^openai\/gpt-[\d.]+-(luna|mini)$/, /flash|mini|haiku/],
  anthropic: [/^claude-haiku-[\d-]+$/, /haiku/],
  openai: [/^gpt-[\d.]+-luna$/, /^gpt-[\d.]+-mini$/, /^gpt-[\d.]+-nano$/, /mini|luna/],
  gemini: [/^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash$/, /flash/],
  groq: [/^llama-3\.1-8b-instant$/, /instant/, /^openai\/gpt-oss-20b$/, /8b/],
  mistral: [/^mistral-small-latest$/, /^ministral-8b-latest$/, /small/],
  deepseek: [/^deepseek-chat$/, /flash/, /chat/],
  custom: [],
};

const unstable = (id: string) => /(preview|exp|beta|alpha|:)/i.test(id);
/** Numbers in an id ("gemini-3.5-flash-lite" is [3, 5]) so the newest of a family sorts first. */
const versionOf = (id: string) => (id.match(/\d+/g) ?? []).slice(0, 4).map(Number);
function newerFirst(a: string, b: string) {
  const va = versionOf(a); const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) { const d = (vb[i] ?? -1) - (va[i] ?? -1); if (d) return d; }
  return a.localeCompare(b);
}

/** The recommended model in a list: the newest stable match of the provider's first matching rule, else the first. */
export function pickRecommended(provider: Ai2ProviderId, models: Ai2Model[]): string | null {
  if (!models.length) return null;
  const ids = models.map((m) => m.id);
  const stable = ids.filter((id) => !unstable(id));
  for (const rule of RECOMMEND[provider]) {
    const hits = (stable.length ? stable : ids).filter((id) => rule.test(id));
    if (hits.length) return [...hits].sort(newerFirst)[0]!;
  }
  return (stable[0] ?? ids[0])!;
}

/** Plain outcomes of a connection test or a list call, worded for the person. */
export const AI2_RESULT_TEXT = {
  ok: "Connected.",
  key_refused: "That key was refused. Check it and paste it again.",
  no_credit: "Your provider account has no credit.",
  model_unavailable: "That model is not available on your key.",
  rate_limited: "Too many requests. Try again in a minute.",
  unreachable: "Could not reach the provider. Try again in a minute.",
  provider_error: "The provider had a problem. Try again in a minute.",
} as const;
export type Ai2ResultCode = keyof typeof AI2_RESULT_TEXT;

/**
 * QUAL1 (audit rows 12, 14): what is wrong with a saved key, as the provider last answered. It stays on the key until a
 * call on it works, a connection test passes, or the key or model is changed, so every screen shows the real state.
 */
export const AI_KEY_PROBLEMS = ["key_refused", "no_credit", "model_unavailable"] as const;
export type AiKeyProblem = (typeof AI_KEY_PROBLEMS)[number];
export const isAiKeyProblem = (v: unknown): v is AiKeyProblem => typeof v === "string" && (AI_KEY_PROBLEMS as readonly string[]).includes(v);
/** Where an admin fixes the key: Settings, AI. */
export const AI_KEY_FIX_PATH = "/app/settings#ai";
/** QUAL1 review: an API error code for a key problem (ai_key_refused, ai_no_credit, ai_model_unavailable), which gets the fix link. */
export const isAiKeyProblemCode = (code: unknown): boolean => typeof code === "string" && code.startsWith("ai_") && isAiKeyProblem(code.slice(3));

/** The one plain sentence for a key problem, wherever it shows (Settings, the mail assistant, Team AI, meeting notes, errors). */
export function aiKeyProblemText(problem: AiKeyProblem, providerName: string | null | undefined): string {
  const name = providerName || "Your AI provider";
  if (problem === "key_refused") return `${name} refused your workspace's AI key. An admin can paste a new key in Settings, AI.`;
  if (problem === "no_credit") return `Your ${providerName || "AI provider"} account has no credit left. Add credit there, then test the key in Settings, AI.`;
  return `The saved model is not offered on your ${providerName || "AI provider"} key any more. Pick another model in Settings, AI.`;
}

/** The note on an answer that built-in AI wrote because the workspace's own key did not work. */
export function aiFallbackText(problem: AiKeyProblem, providerName: string | null | undefined): string {
  const why = problem === "key_refused" ? `${providerName || "Your AI provider"} refused your workspace's AI key`
    : problem === "no_credit" ? `your ${providerName || "AI provider"} account has no credit left`
    : `the saved ${providerName || "AI"} model is not offered any more`;
  return `Built-in AI wrote this because ${why}. An admin can fix it in Settings, AI.`;
}
