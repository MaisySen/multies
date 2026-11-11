/**
 * The workspace's own AI key, encrypted at rest with APP_SECRET (AES-GCM). The key is
 * never returned by the API: only the provider, the model and its last 4 characters.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { aiKeys, aiModelCache } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { badRequest } from "../../lib/errors";
import { audit } from "../audit";
import { AI_PROVIDER_INFO, byoProvider, keyProblemOf, type AiProvider, type AiProviderId } from "./providers";
import { aiKeyProblemText, type AiKeyProblem } from "../../../shared/ai-connect-ai2";

export interface AiKeyStatus {
  connected: boolean;
  provider: AiProviderId | null;
  providerName: string | null;
  model: string | null;
  keyHint: string | null;
  /** AI2: the host of a custom server's base address (never the key). */
  baseHost?: string | null;
  /**
   * QUAL1 (audit rows 12, 14): present only while the provider refuses the saved key or its model: what it said
   * (key_refused, no_credit, model_unavailable), since when, and the plain sentence every screen shows.
   */
  problem?: AiKeyProblem;
  problemAt?: string;
  problemMessage?: string;
}

const hostOf = (u: string | null | undefined) => { try { return u ? new URL(u).host : null; } catch { return null; } };

export async function aiKeyStatus(deps: Deps, orgId: string): Promise<AiKeyStatus> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return { connected: false, provider: null, providerName: null, model: null, keyHint: null };
  const providerName = AI_PROVIDER_INFO[row.provider].name;
  return {
    connected: true, provider: row.provider, providerName, model: row.model, keyHint: row.keyHint, ...(row.baseUrl ? { baseHost: hostOf(row.baseUrl) } : {}),
    ...(row.problem ? { problem: row.problem, problemAt: (row.problemAt ?? row.updatedAt).toISOString(), problemMessage: aiKeyProblemText(row.problem, providerName) } : {}),
  };
}

export async function saveAiKey(deps: Deps, auth: AuthContext, input: { provider: AiProviderId; apiKey: string; model?: string; baseUrl?: string | null; via?: "paste" | "oauth" }) {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 16 || /\s/.test(apiKey)) throw badRequest("That doesn't look like an API key.");
  const model = input.model?.trim() || AI_PROVIDER_INFO[input.provider].defaultModel;
  if (!model) throw badRequest("Pick a model.");
  const before = await deps.db.select({ provider: aiKeys.provider }).from(aiKeys).where(eq(aiKeys.orgId, auth.orgId)).get();
  const values = {
    provider: input.provider, model, keyEnc: await encryptSecret(deps.config.appSecret, apiKey), keyHint: apiKey.slice(-4),
    // Only a custom server keeps a base address; a named provider clears any earlier one.
    ...(input.baseUrl !== undefined || input.provider !== "custom" ? { baseUrl: input.provider === "custom" ? input.baseUrl ?? null : null } : {}),
    updatedByUserId: auth.userId || null, updatedAt: deps.now(),
    // QUAL1: a new key starts with a clean record.
    problem: null, problemAt: null,
  };
  await deps.db.insert(aiKeys).values({ orgId: auth.orgId, ...values }).onConflictDoUpdate({ target: aiKeys.orgId, set: values });
  // A new key may see different models: the cached list goes with the old key.
  await deps.db.delete(aiModelCache).where(eq(aiModelCache.orgId, auth.orgId));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.saved", targetType: "ai_key", targetId: input.provider, metadata: { provider: input.provider, model, ...(input.via ? { via: input.via } : {}) } });
  if (before && before.provider !== input.provider) {
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.provider_changed", targetType: "ai_key", targetId: input.provider, metadata: { from: before.provider, to: input.provider } });
  }
  return aiKeyStatus(deps, auth.orgId);
}

export async function deleteAiKey(deps: Deps, auth: AuthContext) {
  await deps.db.delete(aiKeys).where(eq(aiKeys.orgId, auth.orgId));
  await deps.db.delete(aiModelCache).where(eq(aiModelCache.orgId, auth.orgId));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.removed", targetType: "ai_key", targetId: auth.orgId });
  return aiKeyStatus(deps, auth.orgId);
}

/** AI2: the saved key, decrypted, for the server side model list and test only. Never returned to a caller of the API. */
export async function savedKey(deps: Deps, orgId: string) {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return null;
  return {
    provider: row.provider, model: row.model, keyHint: row.keyHint, baseUrl: row.baseUrl ?? null, apiKey: await decryptSecret(deps.config.appSecret, row.keyEnc),
    problem: row.problem ?? null, updatedAt: row.updatedAt,
  };
}

/**
 * QUAL1 (audit rows 12, 14): records (or clears, with null) what the provider said about the saved key. Only the key
 * that was used is marked: `version` is its updatedAt, which a new key or a new model changes, so a late refusal of an
 * old key never marks a new one. One small write, and only when the state changes. Never throws.
 */
export async function recordKeyProblem(deps: Deps, orgId: string, version: Date, problem: AiKeyProblem | null): Promise<void> {
  try {
    await deps.db.update(aiKeys).set({ problem, problemAt: problem ? deps.now() : null }).where(and(eq(aiKeys.orgId, orgId), eq(aiKeys.updatedAt, version)));
    if (problem) deps.log?.warn("ai.key_problem", { problem });
  } catch { /* a failed note must not hide the answer or the real error */ }
}

/** The workspace's provider and its key's recorded problem, or null when it has not added a key. */
export async function keyFor(deps: Deps, orgId: string): Promise<{ provider: AiProvider; providerId: AiProviderId; problem: AiKeyProblem | null } | null> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return null;
  const inner = byoProvider(row.provider, await decryptSecret(deps.config.appSecret, row.keyEnc), row.model, deps.fetch, row.baseUrl);
  let known: AiKeyProblem | null = row.problem ?? null;
  // QUAL1: every call on the saved key goes through here, so a refusal is noted the moment it happens on any AI path
  // (mail assistant, Tools, Team AI, meeting notes, catch up, forms), and the first call that works clears it.
  const provider: AiProvider = {
    name: inner.name,
    async complete(req) {
      try {
        const out = await inner.complete(req);
        if (known) { known = null; await recordKeyProblem(deps, orgId, row.updatedAt, null); }
        return out;
      } catch (err) {
        const problem = keyProblemOf(err);
        if (problem && problem !== known) { known = problem; await recordKeyProblem(deps, orgId, row.updatedAt, problem); }
        throw err;
      }
    },
  };
  return { provider, providerId: row.provider, problem: row.problem ?? null };
}

/** The workspace's provider, or null when it has not added a key. */
export async function providerFor(deps: Deps, orgId: string): Promise<AiProvider | null> {
  return (await keyFor(deps, orgId))?.provider ?? null;
}
