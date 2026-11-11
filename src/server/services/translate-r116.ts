/**
 * R116 Translate (TRANSLATE_R116): translates the text of a mail, a doc or a chat message for the reader. It reuses
 * the built in AI exactly as the Tools translation does: the one door askAi (the existing binding, the workspace's own
 * key when it has one, the single shared daily meter with its hard caps, never billed) and the workspace AI switch
 * (off = no provider call). Loaded on first use (app.ts imports the route lazily), so Worker startup does not grow.
 *
 * On top: a per person limit (R116_LIMITS.perMinute a minute, counted in the shared rate limit table), a size cap per
 * call, and a small in memory cache per isolate keyed by the exact text, so the same message or doc version translated
 * again costs nothing. Nothing is stored.
 */
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import { DbRateLimitStore } from "../lib/rate-limit";
import { aiAllowed } from "./ai-trust-td1";
import { aiRefusalError, askAi, type AiOk, type AiRequest } from "./tools/ai-meter";
import { AI_OFF_MESSAGE } from "@/shared/ask-td1";
import { detectLanguage, isR116Language, R116_LIMITS, type R116Language } from "@/shared/translate-r116";

export type TranslateInput = { texts: string[]; target: string; source?: string | null };
/** fallback (QUAL1 review): built-in AI translated because the provider refused the workspace's own key; `message` says so. */
export type TranslateOutput = { texts: string[]; source: R116Language | null; target: R116Language; cached: boolean; same: boolean; fallback?: AiOk["fallback"] };

const CACHE_MAX = 300, CACHE_TTL_MS = 60 * 60_000;
/** A cached answer keeps its fallback note, so the same text read again still says who translated it. */
const cache = new Map<string, { until: number; texts: string[]; fallback?: AiOk["fallback"] }>();
/** For tests: empties this isolate's cache. */
export const clearTranslateCache = () => cache.clear();

async function keyOf(orgId: string, source: string, target: string, texts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([orgId, source, target, texts]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Checks the input and its size before anything else runs. */
export function checkInput(input: TranslateInput): { texts: string[]; target: R116Language; source: R116Language | null } {
  if (!isR116Language(input.target)) throw new HttpError(400, "bad_request", "Choose a language.");
  if (!Array.isArray(input.texts) || input.texts.length === 0 || input.texts.some((t) => typeof t !== "string")) throw new HttpError(400, "bad_request", "Nothing to translate.");
  if (input.texts.length > R116_LIMITS.callTexts || input.texts.reduce((n, t) => n + t.length, 0) > R116_LIMITS.callChars) {
    throw new HttpError(413, "too_large", "That is too much text to translate at once. Try a shorter part.");
  }
  const texts = input.texts.map((t) => t.trim());
  if (texts.every((t) => !t)) throw new HttpError(400, "bad_request", "Nothing to translate.");
  const source = isR116Language(input.source) ? input.source : detectLanguage(texts.join("\n"));
  return { texts, target: input.target, source };
}

/** One translate call for the signed in person. Throws plain messages the app shows with a Retry. */
export async function translateTexts(deps: Deps, actor: { orgId: string; userId: string }, input: TranslateInput): Promise<TranslateOutput> {
  const { texts, target, source } = checkInput(input);
  // The AI switch first: when it is off nothing is translated, cached or not, and no provider is called.
  if (!(await aiAllowed(deps, actor.orgId))) throw new HttpError(409, "ai_off", AI_OFF_MESSAGE);
  if (source === target) return { texts, source, target, cached: false, same: true };

  const key = await keyOf(actor.orgId, source ?? "", target, texts);
  const hit = cache.get(key);
  if (hit && hit.until > deps.now().getTime()) return { texts: hit.texts, source, target, cached: true, same: false, ...(hit.fallback ? { fallback: hit.fallback } : {}) };

  const store = new DbRateLimitStore(() => deps.db, () => deps.now().getTime());
  store.prefix = "rl:tr116:";
  store.init({ windowMs: 60_000 });
  const { totalHits } = await store.increment(actor.userId);
  if (totalHits > R116_LIMITS.perMinute) throw new HttpError(429, "rate_limited", "That is a lot of translating in one minute. Wait a moment and try again.");

  // End to end tests only: node.ts sets deps.askAi on a localhost server with ASK_AI_FAKE=1 (as Ask does).
  const d: Deps = deps.askAi ? { ...deps, ai: deps.askAi } : deps;
  const req: AiRequest = { task: "translate", texts, target, ...(source ? { source } : {}) };
  const r = await askAi(d, actor.orgId, req);
  if (!r.ok) {
    // QUAL1 review: a refused workspace key answers 409 ai_key_refused with the fix link, never "try again".
    const keyProblem = aiRefusalError(r);
    if (keyProblem) throw keyProblem;
    if (r.reason === "limit" || r.reason === "workspace_limit") throw new HttpError(429, "ai_limit", r.message);
    if (r.reason === "too_big") throw new HttpError(413, "too_large", r.message);
    if (r.reason === "unavailable") throw new HttpError(r.message === AI_OFF_MESSAGE ? 409 : 503, r.message === AI_OFF_MESSAGE ? "ai_off" : "ai_unavailable", r.message);
    throw new HttpError(502, "ai_failed", "The translation failed. Try again in a moment.");
  }
  // A string the model left empty keeps its original words.
  const out = texts.map((t, i) => (r.texts[i]?.trim() ? r.texts[i].trim() : t));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { until: deps.now().getTime() + CACHE_TTL_MS, texts: out, ...(r.fallback ? { fallback: r.fallback } : {}) });
  return { texts: out, source, target, cached: false, same: false, ...(r.fallback ? { fallback: r.fallback } : {}) };
}
