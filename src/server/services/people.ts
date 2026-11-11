/**
 * People: the humans in a workspace and its AI agent members, with a title and a short bio.
 *
 * An agent member is a row in `members` with kind "agent" and a user row that has no password,
 * no sign-in method and an internal address that can't receive mail. It takes no seat and no
 * inbox. It acts only through its own API keys, which resolve to the agent member (role member),
 * so its chat posts, task comments and activity carry its own name. Mail agents (the `agents`
 * table, each with its own inbox) are listed beside them.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { agents, apiKeys, mailboxes, members, users } from "../db/schema";
import { newId } from "../lib/crypto";
import { forbidden, HttpError, notFound, planLimit } from "../lib/errors";
import { audit } from "./audit";
import { createApiKey, presentApiKey } from "./developer/api-keys";
import { getPlan } from "./plans";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role"> & { agentId?: string | null; apiKeyId?: string };

/** Agent member user rows use this reserved domain (RFC 2606), so nothing can sign in or receive mail as them. */
export const AGENT_EMAIL_DOMAIN = "agents.multies.invalid";
export const isAgentEmail = (email: string) => email.toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);

const clean = (s: string | null | undefined, max: number) => {
  if (s === undefined) return undefined;
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};

export interface Person {
  id: string;
  type: "member" | "mail_agent";
  kind: "human" | "agent";
  userId: string | null;
  agentId: string | null;
  name: string;
  email: string | null;
  /** AIS1 (audit row 41): a person member whose address is an AI agent's inbox: an AI, whatever its kind says. */
  agentInbox?: boolean;
  role: "owner" | "admin" | "member" | null;
  title: string | null;
  bio: string | null;
  inbox: string | null;
  joinedAt: string;
}

/** Everyone in the workspace: people first, then agent members, then mail agents. Reads only. */
export async function listPeople(deps: Deps, orgId: string): Promise<Person[]> {
  const [rows, mailAgents] = await Promise.all([
    deps.db.select({ userId: users.id, email: users.email, name: users.name, role: members.role, kind: members.kind, title: members.title, bio: members.bio, at: members.createdAt, agentInboxId: mailboxes.id })
      .from(members).innerJoin(users, eq(users.id, members.userId))
      .leftJoin(mailboxes, and(eq(mailboxes.address, users.email), eq(mailboxes.kind, "agent")))
      .where(eq(members.organizationId, orgId)),
    deps.db.select({ id: agents.id, name: agents.name, description: agents.description, address: mailboxes.address, at: agents.createdAt })
      .from(agents).innerJoin(mailboxes, eq(mailboxes.id, agents.mailboxId)).where(eq(agents.orgId, orgId)),
  ]);
  const order = { owner: 0, admin: 1, member: 2 } as const;
  const people: Person[] = rows
    .sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent") || order[a.role] - order[b.role] || a.at.getTime() - b.at.getTime())
    .map((r) => ({
      id: r.userId, type: "member", kind: r.kind, userId: r.userId, agentId: null, name: r.name,
      email: r.kind === "agent" ? null : r.email, ...(r.agentInboxId ? { agentInbox: true } : {}), role: r.role, title: r.title, bio: r.bio, inbox: null, joinedAt: r.at.toISOString(),
    }));
  for (const a of mailAgents.sort((x, y) => x.at.getTime() - y.at.getTime())) {
    people.push({ id: a.id, type: "mail_agent", kind: "agent", userId: null, agentId: a.id, name: a.name, email: null, role: null, title: "Mail agent", bio: a.description ?? null, inbox: a.address, joinedAt: a.at.toISOString() });
  }
  return people;
}

export async function getPerson(deps: Deps, orgId: string, userId: string) {
  const r = await deps.db.select({ userId: users.id, email: users.email, name: users.name, role: members.role, kind: members.kind, title: members.title, bio: members.bio, at: members.createdAt })
    .from(members).innerJoin(users, eq(users.id, members.userId)).where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  if (!r) throw notFound("Member");
  return {
    id: r.userId, type: "member" as const, kind: r.kind, userId: r.userId, agentId: null, name: r.name,
    email: r.kind === "agent" ? null : r.email, role: r.role, title: r.title, bio: r.bio, inbox: null, joinedAt: r.at.toISOString(),
  } satisfies Person;
}

/** Title and bio (and an agent member's name). Anyone edits their own; admins edit anyone's but the owner's, and agents'. */
export async function updateProfile(deps: Deps, actor: Actor, userId: string, input: { title?: string | null; bio?: string | null; name?: string }) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't edit people.");
  const target = await getPerson(deps, actor.orgId, userId);
  const self = userId === actor.userId;
  if (!self) {
    if (actor.role === "member") throw forbidden("You can edit your own title and bio. Ask an admin to change someone else's.");
    if (actor.role === "admin" && target.role === "owner") throw forbidden("Only the owner can edit the owner's profile.");
  }
  const patch: { title?: string | null; bio?: string | null } = {};
  const title = clean(input.title, 80);
  const bio = clean(input.bio, 500);
  if (title !== undefined && title !== target.title) patch.title = title;
  if (bio !== undefined && bio !== target.bio) patch.bio = bio;
  const name = input.name === undefined ? undefined : clean(input.name, 80);
  if (name !== undefined && target.kind !== "agent") throw forbidden("People change their own name in Settings, Account.");
  if (name === null) throw new HttpError(422, "validation_failed", "Give the agent a name.");
  // Nothing changed: no write.
  if (!Object.keys(patch).length && (name === undefined || name === target.name)) return target;
  if (Object.keys(patch).length) await deps.db.update(members).set(patch).where(and(eq(members.organizationId, actor.orgId), eq(members.userId, userId)));
  if (name && name !== target.name) await deps.db.update(users).set({ name }).where(eq(users.id, userId));
  return { ...target, ...patch, ...(name ? { name } : {}) };
}

export async function agentMemberCount(deps: Deps, orgId: string) {
  const r = await deps.db.select({ n: count() }).from(members).where(and(eq(members.organizationId, orgId), eq(members.kind, "agent"))).get();
  return r?.n ?? 0;
}

function assertAdminActor(actor: Actor) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't manage agent members.");
  if (actor.role === "member") throw forbidden("Only workspace admins can manage agent members.");
}

export interface CreateAgentMemberInput { name: string; title?: string | null; bio?: string | null; scope?: "full" | "read" }

/**
 * Adds an AI agent member with its first API key (shown once). Counts against the plan's
 * agent member limit, never against seats or inboxes. Writes: user, member, key, audit.
 */
export async function createAgentMember(deps: Deps, actor: Actor, input: CreateAgentMemberInput) {
  assertAdminActor(actor);
  const name = clean(input.name, 80);
  if (!name) throw new HttpError(422, "validation_failed", "Give the agent a name.");
  const [plan, used] = await Promise.all([getPlan(deps.db, actor.orgId), agentMemberCount(deps, actor.orgId)]);
  if (used >= plan.limits.agentMembers) throw planLimit(`Your workspace includes ${plan.limits.agentMembers} agent members. Remove one you no longer use, or move to a bigger plan in Billing.`);
  const userId = newId("usr");
  const email = `${userId.toLowerCase()}@${AGENT_EMAIL_DOMAIN}`;
  const now = deps.now();
  await deps.db.insert(users).values({ id: userId, email, name, emailVerified: false, createdAt: now, updatedAt: now });
  await deps.db.insert(members).values({ id: newId("mem"), organizationId: actor.orgId, userId, role: "member", kind: "agent", title: clean(input.title, 80) ?? null, bio: clean(input.bio, 500) ?? null, createdAt: now });
  let key: Awaited<ReturnType<typeof createApiKey>>;
  try {
    key = await createApiKey(deps, { orgId: actor.orgId, userId }, { name: `${name} key`, scope: input.scope ?? "full" });
  } catch (e) {
    await deps.db.delete(users).where(eq(users.id, userId));
    throw e;
  }
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, action: "agent_member.created", targetType: "user", targetId: userId, metadata: { name, scope: input.scope ?? "full", via: actor.apiKeyId ? "api" : "app" } });
  return { member: await getPerson(deps, actor.orgId, userId), apiKey: key.apiKey, secret: key.secret };
}

async function agentRow(deps: Deps, orgId: string, userId: string) {
  const p = await getPerson(deps, orgId, userId);
  if (p.kind !== "agent") throw notFound("Agent member");
  return p;
}

export async function listAgentMemberKeys(deps: Deps, actor: Actor, userId: string) {
  assertAdminActor(actor);
  await agentRow(deps, actor.orgId, userId);
  const rows = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.orgId, actor.orgId), eq(apiKeys.createdByUserId, userId)));
  return rows.map(presentApiKey);
}

export async function createAgentMemberKey(deps: Deps, actor: Actor, userId: string, input: { name?: string; scope?: "full" | "read" } = {}) {
  assertAdminActor(actor);
  const p = await agentRow(deps, actor.orgId, userId);
  const k = await createApiKey(deps, { orgId: actor.orgId, userId }, { name: clean(input.name, 80) ?? `${p.name} key`, scope: input.scope ?? "full" });
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, action: "agent_member.key_created", targetType: "api_key", targetId: k.apiKey.id, metadata: { member: userId } });
  return k;
}

export async function revokeAgentMemberKey(deps: Deps, actor: Actor, userId: string, keyId: string) {
  assertAdminActor(actor);
  await agentRow(deps, actor.orgId, userId);
  const k = await deps.db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, actor.orgId), eq(apiKeys.createdByUserId, userId))).get();
  if (!k) throw notFound("API key");
  await deps.db.delete(apiKeys).where(eq(apiKeys.id, k.id));
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, action: "agent_member.key_revoked", targetType: "api_key", targetId: k.id, metadata: { member: userId } });
}

/** Removes an agent member and its keys. What it wrote stays, under the name it had. */
export async function removeAgentMember(deps: Deps, actor: Actor, userId: string) {
  assertAdminActor(actor);
  const p = await agentRow(deps, actor.orgId, userId);
  await deps.db.delete(apiKeys).where(and(eq(apiKeys.orgId, actor.orgId), eq(apiKeys.createdByUserId, userId)));
  // The user row exists only for this member: deleting it removes the membership too.
  const other = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.userId, userId), inArray(members.kind, ["human"]))).get();
  if (other) await deps.db.delete(members).where(and(eq(members.organizationId, actor.orgId), eq(members.userId, userId)));
  else await deps.db.delete(users).where(eq(users.id, userId));
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, action: "agent_member.removed", targetType: "user", targetId: userId, metadata: { name: p.name } });
  return p;
}
