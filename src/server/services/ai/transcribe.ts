/**
 * Round 23 (R23.2): speech to text with the workspace's own AI key. OpenAI and Groq answer the
 * same multipart request (POST .../audio/transcriptions); Anthropic and OpenRouter have no speech
 * to text, so a workspace on those keys gets the setup message instead. Multies never pays: the
 * customer's provider bills the customer's key. The key is decrypted here, server side only, and
 * never appears in an error or an answer.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { aiKeys } from "../../db/schema";
import { decryptSecret } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { AiProviderError, type AiProviderId } from "./providers";

export type TranscribeProviderId = "openai" | "groq";
export const TRANSCRIBE_URL: Record<TranscribeProviderId, string> = {
  openai: "https://api.openai.com/v1/audio/transcriptions",
  groq: "https://api.groq.com/openai/v1/audio/transcriptions",
};
export const TRANSCRIBE_MODEL: Record<TranscribeProviderId, string> = { openai: "gpt-4o-mini-transcribe", groq: "whisper-large-v3-turbo" };
/** Both providers take up to 25 MB a file; a chunk over this is refused before it leaves. */
export const MAX_CHUNK_BYTES = 24 * 1024 * 1024;

export const canTranscribe = (p: AiProviderId | null | undefined): p is TranscribeProviderId => p === "openai" || p === "groq";

export const RECORDING_SETUP_MESSAGE = "Add your OpenAI or Groq key in Settings > AI to record and transcribe. Multies doesn't charge for this; your provider bills your key.";
/** The codes the app recognises to open the setup prompt. */
export const SETUP_CODES = { noKey: "recording_needs_ai_key", wrongProvider: "recording_needs_transcribe_key", aiOff: "recording_needs_ai_on" } as const;
/** PAR1: the workspace switched AI off (TD1), so no audio goes to any provider and no transcript is made. */
export const RECORDING_AI_OFF_MESSAGE = "AI is off for this workspace, so calls are not transcribed. An admin can turn it on in Settings > AI.";

export function setupError(provider: AiProviderId | null) {
  if (!provider) return new HttpError(409, SETUP_CODES.noKey, RECORDING_SETUP_MESSAGE);
  const name = provider === "anthropic" ? "Anthropic" : "OpenRouter";
  return new HttpError(409, SETUP_CODES.wrongProvider, `${name} keys can't transcribe audio. ${RECORDING_SETUP_MESSAGE}`);
}

/** The workspace's key for transcribing, or the setup error. */
export async function transcribeKeyFor(deps: Deps, orgId: string): Promise<{ provider: TranscribeProviderId; apiKey: string }> {
  const row = await deps.db.select({ provider: aiKeys.provider, keyEnc: aiKeys.keyEnc }).from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row || !canTranscribe(row.provider)) throw setupError(row?.provider ?? null);
  return { provider: row.provider, apiKey: await decryptSecret(deps.config.appSecret, row.keyEnc) };
}

const scrub = (text: string, apiKey: string) => (apiKey ? text.split(apiKey).join("[key]") : text).replace(/(sk|gsk)[-_][A-Za-z0-9_-]{8,}/g, "[key]");

/** Sends one audio file and returns its text. Throws AiProviderError (with the key scrubbed) on a refusal. */
export async function transcribe(provider: TranscribeProviderId, apiKey: string, audio: Uint8Array, mime: string, fetchImpl: typeof fetch): Promise<string> {
  if (audio.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, "chunk_too_large", "That audio chunk is over 24 MB. Upload it in smaller pieces.");
  const type = (mime || "audio/webm").split(";")[0].trim() || "audio/webm";
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") || type.includes("m4a") ? "m4a" : type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type }), `chunk.${ext}`);
  form.append("model", TRANSCRIBE_MODEL[provider]);
  form.append("response_format", "json");
  let res: Response;
  try {
    res = await fetchImpl(TRANSCRIBE_URL[provider], { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form });
  } catch (err) {
    throw new AiProviderError(provider, null, scrub(err instanceof Error ? err.message : String(err), apiKey));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiProviderError(provider, res.status, scrub(body.slice(0, 300), apiKey));
  }
  const out = (await res.json().catch(() => ({}))) as { text?: string };
  return (out.text ?? "").trim();
}
