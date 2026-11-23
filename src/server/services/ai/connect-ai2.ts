/**
 * AI2 (flag AI_CONNECT_AI2): connect the workspace's own AI without typing model names.
 * Everything here runs on the server with the workspace's own key: the live model list (cached 10 minutes),
 * the connection test, connecting with a pasted key, and the one tap OpenRouter sign in (OAuth PKCE, S256).
 * The browser only ever receives model ids and names and plain result words: never a key, never a provider's
 * error body (bodies are read only to choose the plain words, and are not logged).
 */
import { and, eq, lt } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { aiKeys, aiModelCache, aiOauthStates } from "../../db/schema";
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256Hex, toB64 } from "../../lib/crypto";
import { HttpError, badRequest } from "../../lib/errors";
import { audit } from "../audit";
import {
  AI2_CURATED_MODELS, AI2_RESULT_TEXT, cleanPastedKey, detectProvider, pickRecommended,
  type Ai2Model, type Ai2ProviderId, type Ai2ResultCode,
} from "../../../shared/ai-connect-ai2";
import { recordKeyProblem, saveAiKey, savedKey } from "./keys";
import { assertAiAllowed } from "../ai-trust-td1"; // TD1 switch: AI off means no provider call on any AI2 path
import { AiProviderError, OPENAI_COMPATIBLE_BASE, byoProvider, mapFailure, type AiProviderId } from "./providers";

export const MODEL_CACHE_MS = 10 * 60_000;
export const OAUTH_STATE_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 20_000;
const MAX_MODELS = 1000;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,120}$/;

/** A provider call that did not work, as one plain result code (the status is kept for the audit, the body is not). */
export class Ai2Failure extends Error {
  constructor(public code: Ai2ResultCode, public status: number | null) { super(AI2_RESULT_TEXT[code]); }
}

// QUAL1: mapFailure moved to ./providers (the key problem record in ./keys needs it without loading this file).
export { mapFailure };

// ---------- SSRF guard for a custom server's base address ----------

function ipv4Parts(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** True for addresses a server must never be pointed at: private, loopback, link local, carrier NAT, multicast, reserved. */
export function isBlockedIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!host.includes(":")) return false;
  // IPv6: loopback, unspecified, unique local (fc00::/7), link local (fe80::/10), multicast, and IPv4 mapped or translated forms.
  if (host === "::1" || host === "::" || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(host)) return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) return true;
  const mapped = host.match(/(?:^|:)(?:ffff:(?:0:)?)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIp(mapped[1]!);
  if (/^::ffff:/.test(host) || /^64:ff9b:/.test(host) || /^2002:/.test(host) || /^100::/.test(host)) return true;
  return false;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|home|lan|corp|localdomain|home\.arpa)$/i;

type Resolver = (host: string) => Promise<string[]>;

/** Resolves a host name through DNS over HTTPS (A and AAAA). No redirects; a failed lookup resolves to nothing. */
export function dohResolver(fetchImpl: typeof fetch): Resolver {
  return async (host) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"]) {
      try {
        const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, redirect: "error", signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const j = (await res.json()) as { Answer?: { type: number; data: string }[] };
        for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
      } catch { /* treated as no answer */ }
    }
    return out;
  };
}

/**
 * Checks and normalises a custom base address: https only, no user or password in it, no private, loopback or
 * link local host (by name, by literal address, and by every address the name resolves to). Throws a plain 400.
 */
export async function checkBaseUrl(raw: string, resolve: Resolver): Promise<string> {
  const bad = (msg = "Use a public https address, like https://api.example.com/v1.") => badRequest(msg);
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw bad(); }
  if (u.protocol !== "https:") throw bad("The address must start with https://.");
  if (u.username || u.password) throw bad("Leave the user name and password out of the address.");
  if (u.search || u.hash) throw bad("Leave the ? and # parts out of the address.");
  if (u.port && u.port !== "443") throw bad("Use the standard https port.");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_NAMES.test(host) || !host.includes(".") && !host.includes(":")) throw bad();
  const literal = ipv4Parts(host) || host.startsWith("[") || host.includes(":");
  if (literal) { if (isBlockedIp(host)) throw bad(); }
  else {
    const ips = await resolve(host);
    if (!ips.length) throw bad("That address could not be found.");
    if (ips.some(isBlockedIp)) throw bad();
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// ---------- live model lists ----------

/** Parses one provider's model list answer into ids and names (chat models only). Exported for the fixtures in the unit tests. */
export function parseModels(provider: Ai2ProviderId, json: unknown): Ai2Model[] {
  const j = (json ?? {}) as Record<string, unknown>;
  const arr = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []) as Record<string, unknown>[];
  const out: Ai2Model[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, name?: unknown) => {
    if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : id });
  };
  for (const m of arr) {
    switch (provider) {
      case "anthropic":
        add(m.id, m.display_name);
        break;
      case "gemini": {
        const methods = m.supportedGenerationMethods as string[] | undefined;
        if (!Array.isArray(methods) || !methods.includes("generateContent")) break;
        const id = typeof m.name === "string" ? m.name.replace(/^models\//, "") : null;
        if (id && /(embedding|aqa|imagen|veo|tts|image|audio|live|robotics)/i.test(id)) break;
        add(id, m.displayName);
        break;
      }
      case "openai": {
        const id = String(m.id ?? "");
        if (!/^(gpt-|o\d|chatgpt-)/.test(id)) break;
        if (/(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct|dall-e|whisper|codex|computer-use|deep-research)/.test(id)) break;
        add(id);
        break;
      }
      case "groq": {
        const id = String(m.id ?? "");
        if (m.active === false || /(whisper|tts|guard|playai|orpheus)/i.test(id)) break;
        add(id);
        break;
      }
      case "mistral": {
        const caps = m.capabilities as { completion_chat?: boolean } | undefined;
        const id = String(m.id ?? "");
        if (caps && caps.completion_chat === false) break;
        if (/(embed|ocr|moderation|transcribe)/i.test(id)) break;
        add(id, m.name && m.name !== id ? m.name : undefined);
        break;
      }
      case "openrouter": {
        const arch = m.architecture as { output_modalities?: string[] } | undefined;
        if (arch?.output_modalities && !arch.output_modalities.includes("text")) break;
        add(m.id, m.name);
        break;
      }
      default:
        add(m.id);
    }
    if (out.length >= MAX_MODELS) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listRequest(provider: Ai2ProviderId, apiKey: string, baseUrl: string | null): { url: string; init: RequestInit } {
  const init: RequestInit = { method: "GET", redirect: "manual", signal: AbortSignal.timeout(LIST_TIMEOUT_MS) };
  if (provider === "anthropic") return { url: "https://api.anthropic.com/v1/models?limit=1000", init: { ...init, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } } };
  // The key goes in a header, never in the address (addresses end up in logs).
  if (provider === "gemini") return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", init: { ...init, headers: { "x-goog-api-key": apiKey } } };
  const base = provider === "custom" ? baseUrl : OPENAI_COMPATIBLE_BASE[provider];
  if (!base) throw new Ai2Failure("provider_error", null);
  return { url: `${base.replace(/\/+$/, "")}/models`, init: { ...init, headers: { authorization: `Bearer ${apiKey}` } } };
}

/** Reads the provider's live model list with this key. Throws Ai2Failure with a plain code. */
export async function listModels(fetchImpl: typeof fetch, provider: Ai2ProviderId, apiKey: string, baseUrl: string | null): Promise<Ai2Model[]> {
  const { url, init } = listRequest(provider, apiKey, baseUrl);
  let res: Response;
  try { res = await fetchImpl(url, init); } catch { throw new Ai2Failure("unreachable", null); }
  if (!res.ok) {
    const body = res.status >= 300 && res.status < 400 ? "" : await res.text().catch(() => "");
    throw new Ai2Failure(res.status >= 300 && res.status < 400 ? "provider_error" : mapFailure(res.status, body), res.status);
  }
  let json: unknown;
  try { json = await res.json(); } catch { throw new Ai2Failure("provider_error", res.status); }
  return parseModels(provider, json);
}

const fingerprintOf = (k: { provider: string; baseUrl: string | null; keyHint: string; model?: string }) => sha256Hex(`${k.provider}|${k.baseUrl ?? ""}|${k.keyHint}`);

export interface ModelListView {
  provider: Ai2ProviderId;
  models: Ai2Model[];
  recommended: string | null;
  /** False when the live list could not be read and the short curated list is shown. */
  live: boolean;
  current: string;
  note: string | null;
  /** QUAL1: set when the list did not load because the provider refused the key. */
  problem?: "key_refused" | "no_credit";
}

/** The saved key's model list: the cache when fresh (10 minutes), else a live read, else the curated list. */
export async function modelsForWorkspace(deps: Deps, orgId: string, opts: { refresh?: boolean } = {}): Promise<ModelListView> {
  await assertAiAllowed(deps, orgId);
  const k = await savedKey(deps, orgId);
  if (!k) throw new HttpError(409, "ai_key_required", "Connect a provider first.");
  const provider = k.provider as Ai2ProviderId;
  const fp = await fingerprintOf(k);
  const now = deps.now();
  let models: Ai2Model[] | null = null;
  let live = true;
  if (!opts.refresh) {
    const c = await deps.db.select().from(aiModelCache).where(eq(aiModelCache.orgId, orgId)).get();
    if (c && c.fingerprint === fp && now.getTime() - c.fetchedAt.getTime() < MODEL_CACHE_MS) {
      try { models = JSON.parse(c.modelsJson) as Ai2Model[]; live = c.live; } catch { models = null; }
    }
  }
  let refused: keyof typeof MODELS_REFUSED_NOTE | null = null;
  if (!models) {
    try { models = await listModels(deps.fetch, provider, k.apiKey, k.baseUrl); live = true; }
    catch (err) {
      deps.log?.warn("ai2.models_failed", { provider, status: err instanceof Ai2Failure ? err.status : null });
      models = AI2_CURATED_MODELS[provider]; live = false;
      // QUAL1 (audit row 14): a list refused for the key is the key's problem: note it on the key, say so, and keep no
      // cached copy, so the list loads as soon as the key is fixed.
      if (err instanceof Ai2Failure && (err.code === "key_refused" || err.code === "no_credit")) {
        refused = err.code;
        if (k.problem !== err.code) await recordKeyProblem(deps, orgId, k.updatedAt, err.code);
      }
    }
    if (refused) await deps.db.delete(aiModelCache).where(eq(aiModelCache.orgId, orgId));
    else {
      const values = { fingerprint: fp, modelsJson: JSON.stringify(models), live, fetchedAt: now };
      await deps.db.insert(aiModelCache).values({ orgId, ...values }).onConflictDoUpdate({ target: aiModelCache.orgId, set: values });
    }
  }
  return {
    provider, models, recommended: pickRecommended(provider, models), live, current: k.model,
    note: live ? null : refused ? `${MODELS_REFUSED_NOTE[refused]} Showing common models.` : "Could not load the live list, showing common models.",
    ...(refused ? { problem: refused } : {}),
  };
}

/** QUAL1: why the live list did not load, when the key itself is the reason. */
const MODELS_REFUSED_NOTE = {
  key_refused: "Your provider refused this key, so the live list could not load. Paste a new key above.",
  no_credit: "Your provider account has no credit, so the live list could not load.",
} as const;

export function assertModelId(model: string) {
  if (!MODEL_ID.test(model)) throw badRequest("That model name has characters a model id never uses.");
}

/** Saves the chosen model on the existing key. */
export async function setModel(deps: Deps, auth: AuthContext, model: string) {
  const m = model.trim();
  assertModelId(m);
  const k = await savedKey(deps, auth.orgId);
  if (!k) throw new HttpError(409, "ai_key_required", "Connect a provider first.");
  // QUAL1: a new model ends "the saved model is not offered"; a refused key stays refused until it works or is replaced.
  await deps.db.update(aiKeys).set({ model: m, updatedByUserId: auth.userId || null, updatedAt: deps.now(), ...(k.problem === "model_unavailable" ? { problem: null, problemAt: null } : {}) }).where(eq(aiKeys.orgId, auth.orgId));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.model_changed", targetType: "ai_key", targetId: k.provider, metadata: { provider: k.provider, from: k.model, to: m } });
  return { model: m };
}

export interface TestResult { ok: boolean; code: Ai2ResultCode; message: string; ms: number | null; model: string }

/** One tiny call on the chosen model. The result is plain words; the key and the provider's body never leave. */
export async function testConnection(deps: Deps, auth: AuthContext, model?: string): Promise<TestResult> {
  await assertAiAllowed(deps, auth.orgId);
  const k = await savedKey(deps, auth.orgId);
  if (!k) throw new HttpError(409, "ai_key_required", "Connect a provider first.");
  const m = model?.trim() || k.model;
  assertModelId(m);
  const started = Date.now();
  let code: Ai2ResultCode = "ok";
  let status: number | null = null;
  try {
    const timed: typeof fetch = (input, init) => deps.fetch(input, { ...init, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    await byoProvider(k.provider, k.apiKey, m, timed, k.baseUrl).complete({ system: "Reply with the single word OK.", user: "Connection test.", maxTokens: 16 });
  } catch (err) {
    if (err instanceof AiProviderError) { status = err.status; code = mapFailure(err.status, err.message); }
    else code = "unreachable";
  }
  const ms = Date.now() - started;
  // QUAL1 (audit row 14): a passed test clears the key's recorded problem; a refusal is noted on the key. A model
  // other than the saved one that is not offered says nothing about the saved setup, so it is not noted.
  const problem = code === "key_refused" || code === "no_credit" || (code === "model_unavailable" && m === k.model) ? code : null;
  const clears = code === "ok" && k.problem !== null && (k.problem !== "model_unavailable" || m === k.model);
  if (clears || (problem !== null && problem !== k.problem)) await recordKeyProblem(deps, auth.orgId, k.updatedAt, clears ? null : problem);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.tested", targetType: "ai_key", targetId: k.provider, metadata: { provider: k.provider, model: m, result: code, ...(status ? { status } : {}) } });
  const ok = code === "ok";
  return { ok, code, ms: ok ? ms : null, model: m, message: ok ? `Connected. Replies in ${ms < 100 ? "under 0.1" : (ms / 1000).toFixed(1)} s` : AI2_RESULT_TEXT[code] };
}

/**
 * True only when the list address refuses a caller with no key. Some lists are public (OpenRouter's, and many
 * compatible servers), so reading them with a key proves nothing about the key (MB-321).
 */
async function listNeedsKey(fetchImpl: typeof fetch, provider: Ai2ProviderId, baseUrl: string | null): Promise<boolean> {
  const { url, init } = listRequest(provider, "", baseUrl);
  try {
    const res = await fetchImpl(url, { ...init, headers: {} });
    return res.status === 401 || res.status === 403;
  } catch { return false; }
}

const refusal = (code: Ai2ResultCode) =>
  code === "key_refused" || code === "no_credit" ? new HttpError(400, `ai_${code}`, AI2_RESULT_TEXT[code]) : new HttpError(502, "ai_check_failed", AI2_RESULT_TEXT[code]);

/**
 * Proves the key with a question only a valid key can answer, before anything is saved. Any check that would pass
 * with no key does not count: OpenRouter's key endpoint, else the model list when it refuses a keyless caller, else
 * one tiny call on the chosen model. Throws a plain HttpError; never returns or logs the provider's body.
 */
export async function proveKey(fetchImpl: typeof fetch, provider: Ai2ProviderId, apiKey: string, baseUrl: string | null, model: string, listRead: boolean): Promise<void> {
  // A live list plus OpenRouter's key endpoint is enough. A typed model, used because the list could not be read, is proved with a real call.
  if (provider === "openrouter" && listRead) {
    let res: Response;
    try { res = await fetchImpl("https://openrouter.ai/api/v1/key", { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }); }
    catch { throw refusal("unreachable"); }
    if (res.ok) return;
    const body = res.status >= 300 && res.status < 400 ? "" : await res.text().catch(() => "");
    throw refusal(res.status >= 300 && res.status < 400 ? "provider_error" : mapFailure(res.status, body));
  }
  if (listRead && (await listNeedsKey(fetchImpl, provider, baseUrl))) return;
  try {
    const timed: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    await byoProvider(provider as AiProviderId, apiKey, model, timed, baseUrl).complete({ system: "Reply with the single word OK.", user: "Connection test.", maxTokens: 16 });
  } catch (err) {
    throw refusal(err instanceof AiProviderError ? mapFailure(err.status, err.message) : "unreachable");
  }
}

/**
 * Connects with a pasted key: cleans it, takes the provider the person picked (or the one the key's format names),
 * reads the live model list, proves the key on an endpoint that needs it (proveKey), and only then saves it with the
 * recommended model. A refused or unproven key is never saved, and built-in AI stays in use.
 */
export async function connectWithKey(deps: Deps, auth: AuthContext, input: { apiKey: string; provider?: Ai2ProviderId; baseUrl?: string; model?: string }) {
  await assertAiAllowed(deps, auth.orgId);
  const apiKey = cleanPastedKey(input.apiKey);
  const provider = input.provider ?? detectProvider(apiKey);
  if (!provider) throw badRequest("Pick your provider: the key's format doesn't say which one it is.");
  if (apiKey.length < 16 || apiKey.length > 400) throw badRequest("That doesn't look like an API key.");
  let baseUrl: string | null = null;
  if (provider === "custom") {
    if (!input.baseUrl) throw badRequest("Add the server's https address.");
    baseUrl = await checkBaseUrl(input.baseUrl, dohResolver(deps.fetch));
  }
  let models: Ai2Model[];
  let live = true;
  try { models = await listModels(deps.fetch, provider, apiKey, baseUrl); }
  catch (err) {
    const code = err instanceof Ai2Failure ? err.code : "unreachable";
    deps.log?.warn("ai2.connect_check_failed", { provider, code });
    if (code === "key_refused" || code === "no_credit") throw new HttpError(400, `ai_${code}`, AI2_RESULT_TEXT[code]);
    // A guessed model is not saved. The person types the model id, and that id is what gets proved.
    if (!input.model?.trim()) throw badRequest("This provider's model list could not be read. Type a model id, then connect.");
    models = []; live = false;
  }
  if (input.model) assertModelId(input.model);
  const model = input.model?.trim() || pickRecommended(provider, models);
  if (!model) throw badRequest("This server lists no models. Type a model id under Advanced.");
  try { await proveKey(deps.fetch, provider, apiKey, baseUrl, model, live); }
  catch (err) {
    deps.log?.warn("ai2.connect_proof_failed", { provider, code: err instanceof HttpError ? err.code : "unknown" });
    throw err;
  }
  const status = await saveAiKey(deps, auth, { provider: provider as AiProviderId, apiKey, model, baseUrl, via: "paste" });
  await cacheModels(deps, auth.orgId, { provider, baseUrl, keyHint: apiKey.slice(-4) }, models, live);
  return { ...status, live };
}

async function cacheModels(deps: Deps, orgId: string, k: { provider: string; baseUrl: string | null; keyHint: string }, models: Ai2Model[], live: boolean) {
  const values = { fingerprint: await fingerprintOf(k), modelsJson: JSON.stringify(models), live, fetchedAt: deps.now() };
  await deps.db.insert(aiModelCache).values({ orgId, ...values }).onConflictDoUpdate({ target: aiModelCache.orgId, set: values });
}

// ---------- one tap OpenRouter sign in (OAuth PKCE, S256) ----------

const b64url = (bytes: ArrayBuffer) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function s256(verifier: string) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export const openRouterCallback = (deps: Deps) => `${deps.config.appUrl.replace(/\/+$/, "")}/api/ai/oauth/openrouter/callback`;
const authUrl = (deps: Deps) => deps.config.openRouterAuthUrl || "https://openrouter.ai/auth";
const isLocal = (deps: Deps) => { try { return ["localhost", "127.0.0.1"].includes(new URL(deps.config.appUrl).hostname); } catch { return false; } };

/** Starts the sign in: a one use state bound to this person, workspace and browser (nonce), with the verifier kept here. */
export async function openRouterStart(deps: Deps, auth: AuthContext, nonce: string): Promise<string> {
  await assertAiAllowed(deps, auth.orgId);
  const now = deps.now();
  // Old unfinished starts go (10 minutes), so the table stays tiny.
  await deps.db.delete(aiOauthStates).where(lt(aiOauthStates.createdAt, new Date(now.getTime() - OAUTH_STATE_MS)));
  const verifier = randomToken(48);
  const state = randomToken(32);
  await deps.db.insert(aiOauthStates).values({
    stateHash: await sha256Hex(state), orgId: auth.orgId, userId: auth.userId, nonceHash: await sha256Hex(nonce),
    verifierEnc: await encryptSecret(deps.config.appSecret, verifier), createdAt: now,
  });
  const q = new URLSearchParams({ callback_url: openRouterCallback(deps), code_challenge: await s256(verifier), code_challenge_method: "S256", state, key_label: "Multies" });
  // Local end to end runs only: the stand in skips the consent page and comes straight back with a code.
  if (isLocal(deps) && new URL(authUrl(deps)).hostname === "openrouter.mock") return `${openRouterCallback(deps)}?${new URLSearchParams({ code: "mock-code", state })}`;
  return `${authUrl(deps)}?${q}`;
}

/** Finishes the sign in: one use state, same person, workspace and browser, within 10 minutes; then code for key. */
export async function openRouterFinish(deps: Deps, auth: AuthContext, code: string, state: string, nonce: string | null) {
  await assertAiAllowed(deps, auth.orgId);
  const fail = (msg = "That sign in expired or was started somewhere else. Start again from Settings, AI.") => new HttpError(400, "oauth_state", msg);
  if (!state || state.length > 200 || !code || code.length > 500) throw fail();
  const hash = await sha256Hex(state);
  const row = await deps.db.select().from(aiOauthStates).where(eq(aiOauthStates.stateHash, hash)).get();
  if (!row) throw fail();
  await deps.db.delete(aiOauthStates).where(and(eq(aiOauthStates.stateHash, hash)));
  if (row.orgId !== auth.orgId || row.userId !== auth.userId) throw fail();
  if (deps.now().getTime() - row.createdAt.getTime() > OAUTH_STATE_MS) throw fail();
  if (!nonce || !safeEqual(row.nonceHash, await sha256Hex(nonce))) throw fail("That sign in was started in another browser. Start again from Settings, AI.");
  const verifier = await decryptSecret(deps.config.appSecret, row.verifierEnc);
  let res: Response;
  try {
    res = await deps.fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
  } catch { throw new HttpError(502, "oauth_exchange", "OpenRouter could not be reached. Try again in a minute."); }
  if (!res.ok) {
    deps.log?.warn("ai2.oauth_exchange_failed", { status: res.status });
    throw new HttpError(400, "oauth_exchange", "OpenRouter did not finish the sign in. Start again from Settings, AI.");
  }
  const key = ((await res.json().catch(() => ({}))) as { key?: unknown }).key;
  if (typeof key !== "string" || key.length < 16 || key.length > 400 || /\s/.test(key)) throw new HttpError(502, "oauth_exchange", "OpenRouter did not send a key. Start again from Settings, AI.");
  let models: Ai2Model[] = AI2_CURATED_MODELS.openrouter;
  let live = false;
  try { models = await listModels(deps.fetch, "openrouter", key, null); live = true; } catch { /* curated list */ }
  const model = pickRecommended("openrouter", models) ?? AI2_CURATED_MODELS.openrouter[0]!.id;
  await saveAiKey(deps, auth, { provider: "openrouter", apiKey: key, model, via: "oauth" });
  await cacheModels(deps, auth.orgId, { provider: "openrouter", baseUrl: null, keyHint: key.slice(-4) }, models, live);
}
