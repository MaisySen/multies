/**
 * Workspace membership on top of Better Auth's organization plugin. Better Auth owns
 * the records and the core rules (invitations, roles, membership); this module adds
 * Multies' stricter role policy, plan seats and per-mailbox access for members.
 */
import { cancelForDeletion } from "./billing";
import { and, count, desc, eq, inArray, max, ne } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import type { DB } from "../db";
import { accounts, invitations, mailboxAccess, mailboxes, members, organizations, sessions, users } from "../db/schema";
import { verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, planLimit } from "../lib/errors";
import { authFor } from "../auth";
import { addonHint, getPlan } from "./plans";
import { isHosted } from "./mail/delivery";
import { removeAgentMember } from "./people";

export type Role = "owner" | "admin" | "member";

/**
 * Mailboxes this user may open: `null` means every mailbox in the workspace
 * (owners and admins); members get the explicit list they were granted.
 */
export async function mailboxScope(db: DB, auth: Pick<AuthContext, "userId" | "orgId" | "role">): Promise<string[] | null> {
  if (auth.role !== "member") return null;
  const rows = await db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, auth.userId), eq(mailboxAccess.orgId, auth.orgId)));
  return rows.map((r) => r.id);
}

/** People who can open a mailbox: owners and admins, plus members granted it. */
export async function usersWhoCanOpen(db: DB, orgId: string, mailboxId: string): Promise<string[]> {
  const [leads, granted] = await Promise.all([
    db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), ne(members.role, "member"))),
    db.select({ userId: mailboxAccess.userId }).from(mailboxAccess).where(and(eq(mailboxAccess.orgId, orgId), eq(mailboxAccess.mailboxId, mailboxId))),
  ]);
  return [...new Set([...leads, ...granted].map((r) => r.userId))];
}

export async function assertMailboxAccess(db: DB, auth: Pick<AuthContext, "userId" | "orgId" | "role">, mailboxId: string) {
  const scope = await mailboxScope(db, auth);
  if (scope && !scope.includes(mailboxId)) throw notFound("Mailbox");
}

async function validMailboxIds(db: DB, orgId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inArray(mailboxes.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("One of those mailboxes doesn't exist in this workspace.");
  return rows.map((r) => r.id);
}

/** Re-checks the password for sensitive actions. People who only use social sign-in confirm with a fresh session instead. */
export async function confirmPassword(deps: Deps, auth: AuthContext, password: string | undefined) {
  const cred = await deps.db.select().from(accounts).where(and(eq(accounts.userId, auth.userId), eq(accounts.providerId, "credential"))).get();
  if (cred?.password) {
    if (!password || !(await verifyPassword(password, cred.password))) {
      throw new HttpError(422, "validation_failed", "That password is incorrect.", { fields: { password: "That password is incorrect." } });
    }
    return;
  }
  const s = await deps.db.select().from(sessions).where(eq(sessions.id, auth.sessionId)).get();
  if (!s || deps.now().getTime() - s.createdAt.getTime() > 15 * 60_000) {
    throw new HttpError(403, "reauth_required", "Sign in again to confirm it's you, then retry.");
  }
}

export async function seatsUsed(db: DB, orgId: string, now: Date) {
  const pending = await db.select({ expiresAt: invitations.expiresAt }).from(invitations)
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending")));
  // AI agent members take no seat.
  const m = await db.select({ n: count() }).from(members).where(and(eq(members.organizationId, orgId), eq(members.kind, "human"))).get();
  return { members: m?.n ?? 0, pendingInvites: pending.filter((p) => p.expiresAt > now).length };
}

export async function listMembers(db: DB, orgId: string) {
  const rows = await db.select({
    memberId: members.id, userId: users.id, email: users.email, name: users.name, role: members.role, kind: members.kind, title: members.title, bio: members.bio, joinedAt: members.createdAt,
  }).from(members).innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId));
  const ids = rows.map((r) => r.userId);
  const access = await db.select().from(mailboxAccess).where(eq(mailboxAccess.orgId, orgId));
  const seen = ids.length
    ? await db.select({ userId: sessions.userId, at: max(sessions.updatedAt) }).from(sessions).where(inArray(sessions.userId, ids)).groupBy(sessions.userId)
    : [];
  const order: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  return rows
    .map((r) => ({
      ...r,
      // An agent member's address is internal and never shown.
      email: r.kind === "agent" ? null : r.email,
      mailboxIds: r.role === "member" ? access.filter((a) => a.userId === r.userId).map((a) => a.mailboxId) : null,
      lastActiveAt: seen.find((s) => s.userId === r.userId)?.at ?? null,
    }))
    .sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent") || order[a.role] - order[b.role] || a.joinedAt.getTime() - b.joinedAt.getTime());
}

export async function listInvites(db: DB, orgId: string, now: Date) {
  const rows = await db.select({ inv: invitations, inviter: users.name }).from(invitations)
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending")))
    .orderBy(desc(invitations.createdAt));
  return rows.map(({ inv, inviter }) => ({
    id: inv.id, email: inv.email, role: (inv.role ?? "member") as "admin" | "member",
    mailboxIds: JSON.parse(inv.mailboxIds ?? "[]") as string[], invitedByName: inviter,
    createdAt: inv.createdAt, expiresAt: inv.expiresAt, expired: inv.expiresAt <= now,
  }));
}

export function inviteLink(deps: Deps, id: string) {
  return `${deps.config.appUrl}/invite/${id}`;
}

/** Creates (or re-issues) an invitation through Better Auth. The link is always returned to the inviter. */
export async function createInvite(deps: Deps, auth: AuthContext, headers: Headers, input: { email: string; role: "admin" | "member"; mailboxIds: string[] }) {
  const { db } = deps;
  const email = input.email.trim().toLowerCase();
  if (input.role === "admin" && auth.role !== "owner") throw forbidden("Only the workspace owner can invite admins.");
  const existing = await db.select({ id: users.id }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, auth.orgId), eq(users.email, email))).get();
  if (existing) throw conflict(`${email} is already in this workspace.`);
  if (input.role === "member") await validMailboxIds(db, auth.orgId, input.mailboxIds);
  const plan = await getPlan(db, auth.orgId);
  const used = await seatsUsed(db, auth.orgId, deps.now());
  const reinvite = await db.select({ id: invitations.id }).from(invitations)
    .where(and(eq(invitations.organizationId, auth.orgId), eq(invitations.email, email), eq(invitations.status, "pending"))).get();
  if (used.members + used.pendingInvites - (reinvite ? 1 : 0) >= plan.limits.seats) {
    throw planLimit(`Your workspace includes ${plan.limits.seats} seats, and they're all taken or invited. ${addonHint("seats")}`);
  }
  const inv = await authFor(deps).api.createInvitation({
    headers,
    body: { email, role: input.role, organizationId: auth.orgId, resend: true, mailboxIds: JSON.stringify(input.role === "member" ? input.mailboxIds : []) },
  });
  const emailed = deps.outbound.name !== "log" || (await isHosted(db, email));
  return { id: inv.id, link: inviteLink(deps, inv.id), emailed, emailDetail: emailed ? undefined : "Email delivery isn't connected on this deployment." };
}

export async function getInvite(db: DB, orgId: string, id: string) {
  const inv = await db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.organizationId, orgId), eq(invitations.status, "pending"))).get();
  if (!inv) throw notFound("Invitation");
  return inv;
}

export async function revokeInvite(deps: Deps, auth: AuthContext, headers: Headers, id: string) {
  const inv = await getInvite(deps.db, auth.orgId, id);
  await authFor(deps).api.cancelInvitation({ headers, body: { invitationId: id } });
  return inv;
}

/** Public view of an invite link, so the accept page can explain itself before sign-in. */
export async function describeInvite(db: DB, id: string, now: Date) {
  const row = await db.select({ inv: invitations, org: organizations, inviter: users.name }).from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(eq(invitations.id, id)).get();
  if (!row) throw notFound("Invitation");
  const s = row.inv.status;
  const state = s === "canceled" || s === "rejected" ? "revoked" : s === "accepted" ? "accepted" : row.inv.expiresAt <= now ? "expired" : "pending";
  const hasAccount = !!(await db.select({ id: users.id }).from(users).where(eq(users.email, row.inv.email)).get());
  return {
    email: row.inv.email, role: row.inv.role ?? "member", state, hasAccount,
    organization: { name: row.org.name }, invitedBy: row.inviter, expiresAt: row.inv.expiresAt,
  };
}

/** Accepts an invite for the signed-in user and opens the workspace in their session. */
export async function acceptInvite(deps: Deps, auth: AuthContext, headers: Headers, id: string) {
  const { db } = deps;
  const inv = await db.select().from(invitations).where(eq(invitations.id, id)).get();
  if (!inv || inv.status === "canceled" || inv.status === "rejected") throw notFound("Invitation");
  if (inv.status === "accepted") throw new HttpError(410, "invite_used", "This invitation has already been used.");
  if (inv.expiresAt <= deps.now()) throw new HttpError(410, "invite_expired", "This invitation has expired. Ask for a new one.");
  if (inv.email !== auth.email.toLowerCase()) throw forbidden(`This invitation is for ${inv.email}. Sign in with that address to accept it.`);
  await authFor(deps).api.acceptInvitation({ headers, body: { invitationId: id } });
  await db.update(sessions).set({ activeOrganizationId: inv.organizationId, updatedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
  const org = (await db.select().from(organizations).where(eq(organizations.id, inv.organizationId)).get())!;
  return { orgId: org.id, orgName: org.name, role: inv.role ?? "member" };
}

async function getMember(db: DB, orgId: string, userId: string) {
  const m = await db.select({ id: members.id, role: members.role, kind: members.kind, email: users.email, name: users.name }).from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  if (!m) throw notFound("Member");
  return m;
}

/** Role and mailbox-access changes. Owners manage everyone; admins manage members only. */
export async function updateMember(deps: Deps, auth: AuthContext, headers: Headers, userId: string, input: { role?: "admin" | "member"; mailboxIds?: string[] }) {
  const { db } = deps;
  const target = await getMember(db, auth.orgId, userId);
  if (target.kind === "agent") throw forbidden("Agent members keep the member role. Change what they can do with their API key instead.");
  if (target.role === "owner") throw forbidden("The owner's role can't be changed. Transfer ownership instead.");
  if (userId === auth.userId) throw forbidden("You can't change your own role.");
  if (auth.role === "admin" && (target.role === "admin" || input.role === "admin")) throw forbidden("Only the owner can manage admins.");
  const role = input.role ?? target.role;
  if (input.role && input.role !== target.role) {
    await authFor(deps).api.updateMemberRole({ headers, body: { memberId: target.id, role: input.role, organizationId: auth.orgId } });
  }
  if (role === "admin") {
    await db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, userId)));
  } else if (input.mailboxIds) {
    const ids = await validMailboxIds(db, auth.orgId, input.mailboxIds);
    await db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, userId)));
    for (const id of ids) await db.insert(mailboxAccess).values({ orgId: auth.orgId, userId, mailboxId: id });
  }
  return { ...target, role, previousRole: target.role };
}

/** Removes someone from the workspace, or lets a non-owner leave. */
export async function removeMember(deps: Deps, auth: AuthContext, headers: Headers, userId: string) {
  const { db } = deps;
  const target = await getMember(db, auth.orgId, userId);
  if (target.kind === "agent") {
    if (auth.role === "member") throw forbidden("Only workspace admins can do that.");
    await removeAgentMember(deps, auth, userId);
    return target;
  }
  const self = userId === auth.userId;
  if (target.role === "owner") throw forbidden(self ? "Transfer ownership before leaving the workspace." : "The owner can't be removed.");
  if (!self) {
    if (auth.role === "member") throw forbidden("Only workspace admins can do that.");
    if (auth.role === "admin" && target.role === "admin") throw forbidden("Only the owner can remove admins.");
  }
  const api = authFor(deps).api;
  if (self) await api.leaveOrganization({ headers, body: { organizationId: auth.orgId } });
  else await api.removeMember({ headers, body: { memberIdOrEmail: target.id, organizationId: auth.orgId } });
  await db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, userId)));
  return target;
}

export async function transferOwnership(deps: Deps, auth: AuthContext, headers: Headers, toUserId: string, password: string | undefined) {
  if (auth.role !== "owner") throw forbidden("Only the owner can transfer ownership.");
  if (toUserId === auth.userId) throw badRequest("You already own this workspace.");
  await confirmPassword(deps, auth, password);
  const target = await getMember(deps.db, auth.orgId, toUserId);
  if (target.kind === "agent") throw forbidden("An agent member can't own the workspace.");
  const me = await getMember(deps.db, auth.orgId, auth.userId);
  const api = authFor(deps).api;
  await api.updateMemberRole({ headers, body: { memberId: target.id, role: "owner", organizationId: auth.orgId } });
  await api.updateMemberRole({ headers, body: { memberId: me.id, role: "admin", organizationId: auth.orgId } });
  await deps.db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, toUserId)));
  return target;
}

/** Workspaces the user belongs to, for the switcher. */
export async function listWorkspaces(db: DB, userId: string) {
  return db.select({ id: organizations.id, name: organizations.name, plan: organizations.plan, role: members.role, isDemo: organizations.isDemo })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, userId));
}

export async function switchWorkspace(deps: Deps, auth: AuthContext, headers: Headers, orgId: string) {
  const m = await deps.db.select().from(members).where(and(eq(members.userId, auth.userId), eq(members.organizationId, orgId))).get();
  if (!m) throw notFound("Workspace");
  await authFor(deps).api.setActiveOrganization({ headers, body: { organizationId: orgId } });
}

export async function createWorkspace(deps: Deps, auth: AuthContext, headers: Headers, name: string) {
  const owned = await deps.db.select({ n: count() }).from(members).where(and(eq(members.userId, auth.userId), eq(members.role, "owner"))).get();
  if ((owned?.n ?? 0) >= 10) throw planLimit("You can own up to 10 workspaces.");
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace"}-${crypto.randomUUID().slice(0, 8)}`;
  const org = await authFor(deps).api.createOrganization({ headers, body: { name, slug } });
  if (!org) throw new HttpError(500, "internal", "The workspace could not be created.");
  await deps.db.update(sessions).set({ activeOrganizationId: org.id, updatedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
  return org.id;
}

/** Deletes a workspace and everything in it. Owner only, password confirmed. */
export async function deleteWorkspace(deps: Deps, auth: AuthContext, headers: Headers, password: string | undefined) {
  if (auth.role !== "owner") throw forbidden("Only the workspace owner can delete it.");
  await confirmPassword(deps, auth, password);
  const org = await deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
  if (org) await cancelForDeletion(deps, org);
  await authFor(deps).api.deleteOrganization({ headers, body: { organizationId: auth.orgId } });
  // Better Auth removes the organization row; make sure the cascade ran on every runtime.
  await deps.db.delete(organizations).where(eq(organizations.id, auth.orgId));
  const left = await deps.db.select().from(members).where(and(eq(members.userId, auth.userId), ne(members.organizationId, auth.orgId))).get();
  return { remaining: !!left };
}
