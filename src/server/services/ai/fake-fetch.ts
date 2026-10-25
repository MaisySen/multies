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

const AI_HOSTS = new Set(["api.openai.com", "api.groq.com", "api.anthropic.com", "openrouter.ai"]);

export function fakeAiAllowed(env: { AI_FAKE?: string; APP_URL?: string }) {
  if (env.AI_FAKE !== "1") return false;
  try { return ["localhost", "127.0.0.1"].includes(new URL(env.APP_URL ?? "").hostname); } catch { return false; }
}

export function fakeAiFetch(real: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!AI_HOSTS.has(url.hostname)) return real(input, init);
    if (url.pathname.endsWith("/audio/transcriptions")) return Response.json({ text: FAKE_TRANSCRIPT });
    const content = JSON.stringify(FAKE_SUMMARY);
    if (url.hostname === "api.anthropic.com") return Response.json({ content: [{ type: "text", text: content }] });
    return Response.json({ choices: [{ message: { content } }] });
  }) as typeof fetch;
}
