import { and, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { apiKeys, members, organizations } from "../../db/schema";
import { newId, randomToken, sha256Hex } from "../../lib/crypto";
import { conflict, notFound } from "../../lib/errors";

export const MAX_API_KEYS = 25;
export type ApiKeyScope = "full" | "read";

export function presentApiKey(k: typeof apiKeys.$inferSelect) {
  return { id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, createdByUserId: k.createdByUserId };
}

export async function listApiKeys(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(desc(apiKeys.createdAt));
  return rows.map(presentApiKey);
}

/** Creates a key. The full key is returned once; only its hash is kept. */
export async function createApiKey(deps: Deps, auth: AuthContext, input: { name: string; scope: ApiKeyScope }) {
  const count = (await deps.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.orgId, auth.orgId))).length;
  if (count >= MAX_API_KEYS) throw conflict(`A workspace can have up to ${MAX_API_KEYS} API keys. Delete one you no longer use.`);
  const secret = `mm_live_${randomToken(30)}`;
  const id = newId("key");
  await deps.db.insert(apiKeys).values({
    id, orgId: auth.orgId, createdByUserId: auth.userId, name: input.name, scope: input.scope,
    prefix: secret.slice(0, 12), keyHash: await sha256Hex(secret),
  });
  const row = await deps.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  return { apiKey: presentApiKey(row!), secret };
}

export async function deleteApiKey(deps: Deps, orgId: string, id: string) {
  const k = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId))).get();
  if (!k) throw notFound("API key");
  await deps.db.delete(apiKeys).where(eq(apiKeys.id, k.id));
  return presentApiKey(k);
}

/**
 * Resolves `Authorization: Bearer mm_live_...` to a workspace context. The key acts as
 * a workspace admin; `read` keys are limited to GET by the API layer.
 */
export async function resolveApiKey(deps: Deps, header: string | undefined): Promise<(AuthContext & { apiKeyId: string; scope: ApiKeyScope; orgSuspended: boolean }) | null> {
  const token = header?.match(/^Bearer\s+(mm_live_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) return null;
  // One round trip: the key, whether its creator is still a member, and the workspace's state.
  const row = await deps.db.select({ k: apiKeys, memberId: members.id, suspendedAt: organizations.suspendedAt })
    .from(apiKeys)
    .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
    .leftJoin(members, and(eq(members.userId, apiKeys.createdByUserId), eq(members.organizationId, apiKeys.orgId)))
    .where(eq(apiKeys.keyHash, await sha256Hex(token))).get();
  if (!row) return null;
  const { k } = row;
  const now = deps.now();
  // Write at most once a minute per key.
  if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > 60_000) {
    await deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, k.id));
  }
  // A key outlives its creator's membership only as a plain workspace key.
  const userId = k.createdByUserId && row.memberId ? k.createdByUserId : "";
  return {
    userId, email: `api-key:${k.prefix}`, name: `API key "${k.name}"`, orgId: k.orgId, role: "admin",
    sessionId: `apikey:${k.id}`, apiKeyId: k.id, scope: k.scope, orgSuspended: !!row.suspendedAt,
  };
}
