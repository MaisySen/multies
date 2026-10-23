/**
 * The workspace's own AI key, encrypted at rest with APP_SECRET (AES-GCM). The key is
 * never returned by the API: only the provider, the model and its last 4 characters.
 */
import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { aiKeys } from "../../db/schema";
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
}

export async function aiKeyStatus(deps: Deps, orgId: string): Promise<AiKeyStatus> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return { connected: false, provider: null, providerName: null, model: null, keyHint: null };
  return { connected: true, provider: row.provider, providerName: AI_PROVIDER_INFO[row.provider].name, model: row.model, keyHint: row.keyHint };
}

export async function saveAiKey(deps: Deps, auth: AuthContext, input: { provider: AiProviderId; apiKey: string; model?: string }) {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 16 || /\s/.test(apiKey)) throw badRequest("That doesn't look like an API key.");
  const model = input.model?.trim() || AI_PROVIDER_INFO[input.provider].defaultModel;
  const values = {
    provider: input.provider, model, keyEnc: await encryptSecret(deps.config.appSecret, apiKey), keyHint: apiKey.slice(-4),
    updatedByUserId: auth.userId || null, updatedAt: deps.now(),
  };
  await deps.db.insert(aiKeys).values({ orgId: auth.orgId, ...values }).onConflictDoUpdate({ target: aiKeys.orgId, set: values });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.saved", targetType: "ai_key", targetId: input.provider, metadata: { provider: input.provider, model } });
  return aiKeyStatus(deps, auth.orgId);
}

export async function deleteAiKey(deps: Deps, auth: AuthContext) {
  await deps.db.delete(aiKeys).where(eq(aiKeys.orgId, auth.orgId));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "ai_key.removed", targetType: "ai_key", targetId: auth.orgId });
  return aiKeyStatus(deps, auth.orgId);
}

/** The workspace's provider, or null when it has not added a key. */
export async function providerFor(deps: Deps, orgId: string): Promise<AiProvider | null> {
  const row = await deps.db.select().from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row) return null;
  return byoProvider(row.provider, await decryptSecret(deps.config.appSecret, row.keyEnc), row.model, deps.fetch);
}
