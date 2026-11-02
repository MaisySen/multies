/**
 * The workspace's own AI key, encrypted at rest with APP_SECRET (AES-GCM). The key is
 * never returned by the API: only the provider, the model and its last 4 characters.
 */
import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { aiKeys, aiModelCache } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { badRequest } from "../../lib/errors";
import { audit } from "../audit";
import { AI_PROVIDER_INFO, byoProvider, type AiProvider, type AiProviderId } from "./providers";

export interface AiKeyStatus {
  connected: boolean;
  provider: AiProviderId | null;
  providerName: string | null;
  model: string | null;
  keyHint: string | null;
  /** AI2: the host of a custom server's base address (never the key). */
  baseHost?: string | null;
}

const hostOf = (u: string | null | undefined) => { try { return u ? new URL(u).host : null; } catch { return null; } };

export async function aiKeyStatus(deps: Deps, orgId: string): Promise<AiKeyStatus> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return { connected: false, provider: null, providerName: null, model: null, keyHint: null };
  return { connected: true, provider: row.provider, providerName: AI_PROVIDER_INFO[row.provider].name, model: row.model, keyHint: row.keyHint, ...(row.baseUrl ? { baseHost: hostOf(row.baseUrl) } : {}) };
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
  return { provider: row.provider, model: row.model, keyHint: row.keyHint, baseUrl: row.baseUrl ?? null, apiKey: await decryptSecret(deps.config.appSecret, row.keyEnc) };
}

/** The workspace's provider, or null when it has not added a key. */
export async function providerFor(deps: Deps, orgId: string): Promise<AiProvider | null> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return null;
  return byoProvider(row.provider, await decryptSecret(deps.config.appSecret, row.keyEnc), row.model, deps.fetch, row.baseUrl);
}
