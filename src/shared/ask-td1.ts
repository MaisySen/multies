/**
 * TD1 Ask v2 and AI trust controls: words and facts shared by the server and the web app (flag ASK_TD1).
 */

/** Where each AI provider runs, in plain words (shown in Settings > AI so people know where their data goes). */
export const AI_WHERE: Record<string, { name: string; region: string }> = {
  builtin: { name: "Built in AI (Cloudflare Workers AI)", region: "Runs in Cloudflare data centres, which may be outside Australia. Not used to train models." },
  openai: { name: "OpenAI", region: "Processed in the United States." },
  anthropic: { name: "Anthropic", region: "Processed in the United States." },
  openrouter: { name: "OpenRouter", region: "Passed on to the model's own provider, mostly in the United States." },
  groq: { name: "Groq", region: "Processed in the United States." },
  gemini: { name: "Google Gemini", region: "Processed in Google data centres, mostly in the United States." },
  google: { name: "Google Gemini", region: "Processed in Google data centres, mostly in the United States." },
  mistral: { name: "Mistral AI", region: "Processed in the European Union." },
  deepseek: { name: "DeepSeek", region: "Processed in China." },
  custom: { name: "Your own AI server", region: "Processed wherever that server runs." },
  other: { name: "Your own AI server", region: "Processed wherever that server runs." },
};
export const whereOf = (provider: string | null | undefined) => (provider && AI_WHERE[provider]) || AI_WHERE.other;

export const AI_OFF_MESSAGE = "AI is off in this workspace. An admin can turn it on in Settings, AI.";
export const AI_OFF_MEMBER = "AI is off in this workspace. Ask an admin to turn it on in Settings, AI.";

/** The items "Ask about this" can scope a question to. */
export const ABOUT_KINDS = ["tasks", "docs", "tables", "deals", "meetings", "contacts"] as const;
export type AboutKind = (typeof ABOUT_KINDS)[number];
export const isAboutKind = (x: unknown): x is AboutKind => typeof x === "string" && (ABOUT_KINDS as readonly string[]).includes(x);

/** What an answer read, so it can say plainly what it could not see. */
export interface AskCoverage { matched: number; read: number; trimmed: number; meaning: "words" | "widened" | "ranked"; about: boolean }

/** The plain line under an answer: what it read and what it could not see. */
export function coverageLine(c: AskCoverage | null | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.about) parts.push("Answered from this item first, then related items you can open.");
  if (c.read === 0) parts.push("Nothing you can open matched.");
  else parts.push(`Read ${c.read} of ${c.matched} ${c.matched === 1 ? "match" : "matches"} you can open.`);
  if (c.trimmed > 0) parts.push(`${c.trimmed} long ${c.trimmed === 1 ? "item was" : "items were"} cut to the first part.`);
  parts.push("Items you cannot open and file attachments were not read.");
  if (c.meaning === "ranked") parts.push("Matched by meaning with your own AI key.");
  else if (c.meaning === "widened") parts.push("Matched on your words and close words.");
  return parts.join(" ");
}

export const GONE_SOURCE = "A source that is gone or no longer open to you";
