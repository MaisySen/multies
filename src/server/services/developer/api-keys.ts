import { and, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { agents, apiKeys, members, organizations, users } from "../../db/schema";
import { newId, randomToken, sha256Hex } from "../../lib/crypto";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { deferrableWrite } from "../write-priority";
import { grantedScopes, scopeChips, splitToolList, withToolList } from "../../lib/api-scopes";

/** How often a key's last used time is written (D1 daily write budget). */
export const LAST_USED_EVERY_MS = 15 * 60_000;

export const MAX_API_KEYS = 25;
/** "full", "read", or (R36) a space separated list of per area scopes (src/server/lib/api-scopes.ts). */
export type ApiKeyScope = "full" | "read" | (string & {});

export function presentApiKey(k: typeof apiKeys.$inferSelect) {
  const { scope, scopedList } = splitToolList(k.scope); // R37: the tool list option rides in the scope column
  return { id: k.id, name: k.name, prefix: k.prefix, scope, showOnlyUsableTools: scopedList, scopes: [...grantedScopes(scope)], scopeChips: scopeChips(scope), agentId: k.agentId ?? null, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt ?? null, createdAt: k.createdAt, createdByUserId: k.createdByUserId };
}

export async function listApiKeys(deps: Deps, orgId: string, agentId?: string) {
  const rows = await deps.db.select({ k: apiKeys, memberId: members.id }).from(apiKeys)
    .leftJoin(members, and(eq(members.userId, apiKeys.createdByUserId), eq(members.organizationId, apiKeys.orgId)))
    .where(and(eq(apiKeys.orgId, orgId), agentId ? eq(apiKeys.agentId, agentId) : undefined)).orderBy(desc(apiKeys.createdAt));
  // Wave 1 review V6: a workspace key whose maker is no longer a member acts as a member; the list says so.
  return rows.map((r) => ({ ...presentApiKey(r.k), makerLeft: !r.k.agentId && !r.memberId }));
}

/** Creates a key. The full key is returned once; only its hash is kept. */
/** Round 2: the longest expiry a key can be given, in days (about ten years). */
export const MAX_KEY_EXPIRY_DAYS = 3650;

export async function createApiKey(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, input: { name: string; scope: ApiKeyScope; agentId?: string; showOnlyUsableTools?: boolean; expiresInDays?: number | null; mintedByUserId?: string | null }) {
  const count = (await deps.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.orgId, auth.orgId))).length;
  if (count >= MAX_API_KEYS) throw conflict(`A workspace can have up to ${MAX_API_KEYS} API keys. Delete one you no longer use.`);
  const secret = `mm_live_${randomToken(30)}`;
  const id = newId("key");
  await deps.db.insert(apiKeys).values({
    id, orgId: auth.orgId, createdByUserId: auth.userId || null, name: input.name, scope: withToolList(input.scope, !!input.showOnlyUsableTools), agentId: input.agentId ?? null,
    prefix: secret.slice(0, 12), keyHash: await sha256Hex(secret),
    expiresAt: input.expiresInDays ? new Date(deps.now().getTime() + input.expiresInDays * 86_400_000) : null,
    mintedByUserId: input.mintedByUserId || null,
  });
  const row = await deps.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  return { apiKey: presentApiKey(row!), secret };
}

/** R36: change a key's scopes (the value is already normalised by the route). Essential write: one row, on a person's click. */
export async function updateApiKeyScope(deps: Deps, orgId: string, id: string, scope: string | undefined, showOnlyUsableTools?: boolean) {
  const k = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId))).get();
  if (!k) throw notFound("API key");
  // R37: either part can change alone; the other keeps its stored value.
  const was = splitToolList(k.scope);
  const stored = withToolList(scope ?? was.scope, showOnlyUsableTools ?? was.scopedList);
  await deps.db.update(apiKeys).set({ scope: stored }).where(eq(apiKeys.id, k.id));
  return presentApiKey({ ...k, scope: stored });
}

export async function deleteApiKey(deps: Deps, orgId: string, id: string) {
  const k = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId))).get();
  if (!k) throw notFound("API key");
  await deps.db.delete(apiKeys).where(eq(apiKeys.id, k.id));
  return presentApiKey(k);
}

/**
 * Resolves `Authorization: Bearer mm_live_...` to a workspace context. Round 2: a workspace key acts with its maker's
 * current role, at most admin (an owner's key is an admin, a maker demoted to member makes it a member's key); a key
 * whose maker left stays a plain workspace key as before. `read` keys are limited to GET by the API layer. An agent
 * key (agentId set) acts only as that agent, enforced by the agent routes. `keyKind` says which kind it is
 * (lib/actor-kind.ts), since the role alone no longer tells a workspace key from an agent member's key.
 */
export type ApiKeyAuth = AuthContext & { apiKeyId: string; scope: ApiKeyScope; orgSuspended: boolean; agentId: string | null; title?: string | null; toolList?: "scoped";
  /** Unset on a connected AI app's token (developer/oauth.ts), which acts as the person. */
  keyKind?: "workspace" | "agent" | "agent_member";
  /** AIS1: the key's name and prefix, so the audit log and task history can say which key acted (lib/request-caller.ts). */
  keyName?: string; keyPrefix?: string };

export async function resolveApiKey(deps: Deps, header: string | undefined): Promise<ApiKeyAuth | null> {
  const token = header?.match(/^Bearer\s+(mm_live_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) return null;
  // One round trip: the key, whether its creator is still a member, and the workspace's state.
  const row = await deps.db.select({ k: apiKeys, memberId: members.id, memberKind: members.kind, memberRole: members.role, memberTitle: members.title, memberDisabledAt: members.disabledAt, creatorName: users.name, creatorBanned: users.banned, creatorBanExpires: users.banExpires, suspendedAt: organizations.suspendedAt, orgName: organizations.name, agentName: agents.name })
    .from(apiKeys)
    .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
    .leftJoin(members, and(eq(members.userId, apiKeys.createdByUserId), eq(members.organizationId, apiKeys.orgId)))
    .leftJoin(agents, and(eq(agents.id, apiKeys.agentId), eq(agents.orgId, apiKeys.orgId)))
    .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
    .where(eq(apiKeys.keyHash, await sha256Hex(token))).get();
  if (!row) return null;
  const { k } = row;
  const now = deps.now();
  // Round 2: an expired key is refused with its own code, so a script's owner knows to make a new one.
  if (k.expiresAt && k.expiresAt.getTime() <= now.getTime()) {
    throw new HttpError(401, "api_key_expired", `This API key (${k.prefix}) expired on ${k.expiresAt.toISOString().slice(0, 10)}. Make a new one in Settings, Developers.`);
  }
  // A key outlives its creator's membership only as a plain workspace key.
  const userId = k.createdByUserId && row.memberId ? k.createdByUserId : "";
  // An AI agent member's key acts as that member, under its name, with the member role.
  const agentMember = !!userId && row.memberKind === "agent";
  // R26 (DF-3): a paused agent member's keys are refused until an admin resumes it.
  if (agentMember && row.memberDisabledAt) return null;
  // PRIV1b (P48): the keys of a person under a platform ban stop working (same rule as the OAuth resolver).
  if (row.creatorBanned && (!row.creatorBanExpires || row.creatorBanExpires.getTime() > now.getTime())) return null;
  // Write at most once every 15 minutes per key: an agent polling once a minute would otherwise
  // cost 1,440 row writes a day per key against the shared D1 daily budget.
  if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await deferrableWrite(deps, "last_used", `key:${k.id}`, () => deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, k.id))); // R32: deferrable
  }
  // Who a post or a change reads as: the agent member by name, an agent inbox by its name,
  // otherwise the workspace itself (a script acting for the whole workspace).
  const name = agentMember ? row.creatorName ?? k.name : row.agentName ?? row.orgName;
  const keyKind = agentMember ? "agent_member" : k.agentId ? "agent" : "workspace";
  // Round 2: a workspace key acts with its maker's current role, never more than admin. An agent key acts as its agent.
  // Wave 1 review V6: a key whose maker left, was removed or deleted their account has no person behind it, so it keeps
  // working with the least role ("member"), never as a full admin; Settings, Developers flags it (makerLeft).
  const role = agentMember ? "member" : keyKind === "workspace" ? (userId && row.memberRole !== "member" ? "admin" : "member") : "admin";
  return {
    userId, email: `api-key:${k.prefix}`, name, title: agentMember ? row.memberTitle ?? null : null, orgId: k.orgId, role,
    sessionId: `apikey:${k.id}`, apiKeyId: k.id, ...keyScope(k.scope), orgSuspended: !!row.suspendedAt, agentId: k.agentId ?? null, keyName: k.name, keyPrefix: k.prefix, keyKind,
  };
}

/** R37: the plain scope every check reads, plus the key's tool list option for the MCP tools/list answer. */
function keyScope(stored: string): { scope: ApiKeyScope; toolList?: "scoped" } {
  const { scope, scopedList } = splitToolList(stored);
  return scopedList ? { scope, toolList: "scoped" } : { scope };
}
