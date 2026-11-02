/**
 * Round 23: a stand in for the AI providers' APIs, for local end to end tests only. The node entry
 * uses it when AI_FAKE=1 AND APP_URL points at localhost or 127.0.0.1; it is never wired into the
 * Workers entry, and any other request goes to the real fetch. It answers speech to text (OpenAI and
 * Groq) with a fixed line and chat completions with a fixed call summary, so the recording flow can
 * be exercised with no key bills and no network.
 */
export const FAKE_TRANSCRIPT = "Maria: Let's ship the pricing page on Friday. Sam: I will write the launch email by Thursday.";
export const FAKE_SUMMARY = {
  summary: "The team agreed to ship the new pricing page this week.",
  decisions: ["Ship the pricing page on Friday"],
  actionItems: [{ text: "Write the launch email", assignee: "Sam", due: "Thursday" }],
};

const AI_HOSTS = new Set(["api.openai.com", "api.groq.com", "api.anthropic.com", "openrouter.ai", "generativelanguage.googleapis.com", "api.mistral.ai", "api.deepseek.com"]);

/**
 * AI2: model lists for the connect screen, and failures on demand. A key containing FAKEBAD is refused (401),
 * FAKENOCREDIT has no credit (402), FAKERATE is rate limited (429), FAKELISTFAIL cannot list models (500);
 * the model "missing-model" answers 404. The one tap OpenRouter sign in exchanges "mock-code" for a key.
 */
export const FAKE_MODEL_LISTS: Record<string, unknown> = {
  "api.anthropic.com": { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }, { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] },
  "api.openai.com": { data: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6.1-terra" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }] },
  "openrouter.ai": { data: [{ id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" }, { id: "google/gemini-3.5-flash-lite", name: "Google: Gemini 3.5 Flash Lite" }, { id: "openai/gpt-6-luna", name: "OpenAI: GPT 6 Luna" }] },
  "api.groq.com": { data: [{ id: "llama-3.1-8b-instant", active: true }, { id: "llama-3.3-70b-versatile", active: true }, { id: "whisper-large-v3", active: true }] },
  "generativelanguage.googleapis.com": { models: [{ name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", supportedGenerationMethods: ["generateContent"] }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }] },
  "api.mistral.ai": { data: [{ id: "mistral-small-latest", capabilities: { completion_chat: true } }, { id: "mistral-embed", capabilities: { completion_chat: false } }] },
  "api.deepseek.com": { data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] },
};

function headerOf(init: RequestInit | undefined, name: string): string {
  const h = init?.headers;
  if (!h) return "";
  if (h instanceof Headers) return h.get(name) ?? "";
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
  return (h as Record<string, string>)[name] ?? "";
}
const failure = (status: number, message: string) => Response.json({ error: { message } }, { status });

export function fakeAiAllowed(env: { AI_FAKE?: string; APP_URL?: string }) {
  if (env.AI_FAKE !== "1") return false;
  try { return ["localhost", "127.0.0.1"].includes(new URL(env.APP_URL ?? "").hostname); } catch { return false; }
}

export function fakeAiFetch(real: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!AI_HOSTS.has(url.hostname)) return real(input, init);
    if (url.pathname.endsWith("/audio/transcriptions")) return Response.json({ text: FAKE_TRANSCRIPT });
    if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/auth/keys") {
      const b = JSON.parse(String(init?.body ?? "{}")) as { code?: string; code_verifier?: string; code_challenge_method?: string };
      return b.code === "mock-code" && b.code_verifier && b.code_challenge_method === "S256" ? Response.json({ key: `sk-or-v1-${"fa4e".repeat(16)}` }) : failure(403, "invalid code");
    }
    const key = `${headerOf(init, "authorization")}${headerOf(init, "x-api-key")}${headerOf(init, "x-goog-api-key")}`;
    if (key.includes("FAKEBAD")) return failure(401, "invalid api key");
    if (key.includes("FAKENOCREDIT")) return failure(402, "insufficient credit");
    if (key.includes("FAKERATE")) return failure(429, "rate limited");
    if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/models")) {
      if (key.includes("FAKELISTFAIL")) return failure(500, "list failed");
      return Response.json(FAKE_MODEL_LISTS[url.hostname] ?? { data: [] });
    }
    if (String(init?.body ?? "").includes('"model":"missing-model"')) return failure(404, "model not found");
    const content = JSON.stringify(FAKE_SUMMARY);
    if (url.hostname === "api.anthropic.com") return Response.json({ content: [{ type: "text", text: content }] });
    return Response.json({ choices: [{ message: { content } }] });
  }) as typeof fetch;
}
