/**
 * R26 (DF-3): AI agent members as workspace members, the parts People did not have yet: pause and
 * resume (a paused agent's keys are refused), an avatar colour with initials, and an optional link
 * to an existing agent inbox (mailbox stays optional). Creating, keys and removal live in
 * services/people.ts; this file only adds to them. See docs/adr/0008-agents-as-members.md.
 *
 * D1 writes: an update is 1 members row (no indexed column changes), plus 1 users row when the
 * name changes, plus 1 audit row (3 with its two indexes). Nothing is written when nothing changes.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { agents, apiKeys, mailboxes, members, users } from "../../db/schema";
import { forbidden, HttpError, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { createAgentMember, type CreateAgentMemberInput } from "../people";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role"> & { agentId?: string | null; apiKeyId?: string; scope?: "full" | "read" };

/** The palette the app offers; any #rrggbb is accepted from the API. */
export const AGENT_COLORS = ["#0071E3", "#5E5CE6", "#BF5AF2", "#FF375F", "#FF9F0A", "#30B158", "#00A3A3", "#8E8E93"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

/** A stable default colour per agent so the list looks right before anyone picks one. */
export function defaultColor(userId: string) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

export interface AgentMember {
  userId: string; name: string; title: string | null; bio: string | null;
  avatar: { color: string; initials: string };
  disabled: boolean; disabledAt: string | null;
  inbox: { agentId: string; address: string } | null;
  keys: number; joinedAt: string;
}

function assertAdmin(actor: Actor) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't manage agent members.");
  if (actor.role === "member") throw forbidden("Only workspace admins can manage agent members.");
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This key is read only.");
}

/** Agent members with avatar, paused state and linked inbox. Reads only; anyone in the workspace can list them. */
export async function listAgentMembers(deps: Deps, orgId: string): Promise<AgentMember[]> {
  const [rows, keys] = await Promise.all([
    deps.db.select({ userId: users.id, name: users.name, title: members.title, bio: members.bio, color: members.avatarColor, disabledAt: members.disabledAt, at: members.createdAt, agentId: members.linkedAgentId, address: mailboxes.address })
      .from(members).innerJoin(users, eq(users.id, members.userId))
      .leftJoin(agents, and(eq(agents.id, members.linkedAgentId), eq(agents.orgId, orgId)))
      .leftJoin(mailboxes, eq(mailboxes.id, agents.mailboxId))
      .where(and(eq(members.organizationId, orgId), eq(members.kind, "agent"))),
    deps.db.select({ userId: apiKeys.createdByUserId }).from(apiKeys).innerJoin(members, and(eq(members.userId, apiKeys.createdByUserId), eq(members.organizationId, orgId)))
      .where(and(eq(apiKeys.orgId, orgId), eq(members.kind, "agent"))),
  ]);
  const n = new Map<string, number>();
  for (const k of keys) if (k.userId) n.set(k.userId, (n.get(k.userId) ?? 0) + 1);
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => ({
    userId: r.userId, name: r.name, title: r.title, bio: r.bio,
    avatar: { color: r.color ?? defaultColor(r.userId), initials: initialsOf(r.name) },
    disabled: !!r.disabledAt, disabledAt: r.disabledAt ? r.disabledAt.toISOString() : null,
    inbox: r.agentId && r.address ? { agentId: r.agentId, address: r.address } : null,
    keys: n.get(r.userId) ?? 0, joinedAt: r.at.toISOString(),
  }));
}

export async function getAgentMember(deps: Deps, orgId: string, userId: string) {
  const m = (await listAgentMembers(deps, orgId)).find((x) => x.userId === userId);
  if (!m) throw notFound("Agent member");
  return m;
}

export interface AgentMemberPatch {
  name?: string; title?: string | null; bio?: string | null;
  avatarColor?: string | null; disabled?: boolean; inboxAgentId?: string | null;
}

const clean = (s: string | null | undefined, max: number) => {
  if (s === undefined) return undefined;
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};

async function checkInbox(deps: Deps, orgId: string, agentId: string) {
  const a = await deps.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, orgId))).get();
  if (!a) throw notFound("Agent inbox");
}

/** Edits an agent member: name, title, bio, colour, paused, linked inbox. Admins only. */
export async function updateAgentMember(deps: Deps, actor: Actor, userId: string, input: AgentMemberPatch) {
  assertAdmin(actor);
  const cur = await getAgentMember(deps, actor.orgId, userId);
  const patch: Partial<typeof members.$inferInsert> = {};
  const changed: string[] = [];
  const title = clean(input.title, 80);
  if (title !== undefined && title !== cur.title) { patch.title = title; changed.push("title"); }
  const bio = clean(input.bio, 500);
  if (bio !== undefined && bio !== cur.bio) { patch.bio = bio; changed.push("bio"); }
  if (input.avatarColor !== undefined) {
    if (input.avatarColor !== null && !HEX.test(input.avatarColor)) throw new HttpError(422, "validation_failed", "Pick a colour as #rrggbb.");
    const c = input.avatarColor ? input.avatarColor.toUpperCase() : null;
    if ((c ?? defaultColor(userId)) !== cur.avatar.color) { patch.avatarColor = c; changed.push("avatarColor"); }
  }
  if (input.disabled !== undefined && input.disabled !== cur.disabled) { patch.disabledAt = input.disabled ? deps.now() : null; changed.push(input.disabled ? "paused" : "resumed"); }
  if (input.inboxAgentId !== undefined && input.inboxAgentId !== (cur.inbox?.agentId ?? null)) {
    if (input.inboxAgentId) await checkInbox(deps, actor.orgId, input.inboxAgentId);
    patch.linkedAgentId = input.inboxAgentId; changed.push("inbox");
  }
  const name = input.name === undefined ? undefined : clean(input.name, 80);
  if (name === null) throw new HttpError(422, "validation_failed", "Give the agent a name.");
  if (name !== undefined && name !== cur.name) changed.push("name");
  if (!changed.length) return cur;
  if (Object.keys(patch).length) await deps.db.update(members).set(patch).where(and(eq(members.organizationId, actor.orgId), eq(members.userId, userId)));
  if (name !== undefined && name !== cur.name) await deps.db.update(users).set({ name }).where(eq(users.id, userId));
  const action = changed.includes("paused") ? "agent_member.paused" : changed.includes("resumed") ? "agent_member.resumed" : "agent_member.updated";
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, action, targetType: "user", targetId: userId, metadata: { name: name ?? cur.name, changed, via: actor.apiKeyId ? "api" : "app" } });
  return getAgentMember(deps, actor.orgId, userId);
}

/** Creates an agent member (people.ts) and applies the colour and inbox link in the same call. */
export async function createAgentMemberR26(deps: Deps, actor: Actor, input: CreateAgentMemberInput & { avatarColor?: string | null; inboxAgentId?: string | null }) {
  assertAdmin(actor);
  if (input.avatarColor && !HEX.test(input.avatarColor)) throw new HttpError(422, "validation_failed", "Pick a colour as #rrggbb.");
  if (input.inboxAgentId) await checkInbox(deps, actor.orgId, input.inboxAgentId);
  const made = await createAgentMember(deps, actor, input);
  const userId = made.member.userId as string;
  if (input.avatarColor || input.inboxAgentId) {
    await deps.db.update(members).set({ avatarColor: input.avatarColor ? input.avatarColor.toUpperCase() : null, linkedAgentId: input.inboxAgentId ?? null })
      .where(and(eq(members.organizationId, actor.orgId), eq(members.userId, userId)));
  }
  return { member: { ...made.member, ...(await getAgentMember(deps, actor.orgId, userId)) }, apiKey: made.apiKey, secret: made.secret };
}
