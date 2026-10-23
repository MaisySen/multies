import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import type { DB } from "../db";
import { invitations, mailboxAccess, mailboxes, memberships, organizations, sessions, users } from "../db/schema";
import { newId, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, planLimit } from "../lib/errors";
import { getPlan } from "./plans";
import { sendSystemEmail } from "./system-mail";

export type Role = "owner" | "admin" | "member";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export async function seatsUsed(db: DB, orgId: string, now: Date) {
  const [m, i] = await Promise.all([
    db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId)).get(),
    db.select({ n: count() }).from(invitations)
      .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now))).get(),
  ]);
  return { members: m?.n ?? 0, pendingInvites: i?.n ?? 0 };
}

export async function listMembers(db: DB, orgId: string) {
  const rows = await db.select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.orgId, orgId));
  const access = await db.select().from(mailboxAccess).where(eq(mailboxAccess.orgId, orgId));
  const lastSeen = await db.select({ userId: sessions.userId, at: sessions.lastSeenAt }).from(sessions).where(eq(sessions.orgId, orgId));
  const order: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  return rows
    .map((r) => ({
      ...r,
      mailboxIds: r.role === "member" ? access.filter((a) => a.userId === r.userId).map((a) => a.mailboxId) : null,
      lastActiveAt: lastSeen.filter((s) => s.userId === r.userId).reduce<Date | null>((acc, s) => (!acc || s.at > acc ? s.at : acc), null),
    }))
    .sort((a, b) => order[a.role] - order[b.role] || a.joinedAt.getTime() - b.joinedAt.getTime());
}

export async function listInvites(db: DB, orgId: string, now: Date) {
  const rows = await db.select().from(invitations)
    .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  return rows
    .map(({ tokenHash: _t, ...r }) => ({ ...r, mailboxIds: JSON.parse(r.mailboxIds) as string[], expired: r.expiresAt <= now }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function inviteLink(deps: Deps, token: string) {
  return `${deps.config.appUrl}/invite/${token}`;
}

/** Creates (or re-issues) an invitation and tries to email it. The link is always returned to the inviter. */
export async function createInvite(deps: Deps, auth: AuthContext, input: { email: string; role: "admin" | "member"; mailboxIds: string[] }) {
  const { db } = deps;
  const now = deps.now();
  const email = input.email.trim().toLowerCase();
  if (input.role === "admin" && auth.role !== "owner") throw forbidden("Only the workspace owner can invite admins.");
  const existing = await db.select({ id: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, auth.orgId), eq(users.email, email))).get();
  if (existing) throw conflict(`${email} is already in this workspace.`);

  // Re-inviting the same address replaces the earlier pending invite.
  await db.update(invitations).set({ revokedAt: now })
    .where(and(eq(invitations.orgId, auth.orgId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));

  const plan = await getPlan(db, auth.orgId);
  const used = await seatsUsed(db, auth.orgId, now);
  if (used.members + used.pendingInvites >= plan.limits.seats) {
    throw planLimit(`Your ${plan.name} plan includes ${plan.limits.seats} seats, and they're all taken or invited. Upgrade to add more people.`);
  }
  const mailboxIds = input.role === "member" ? await validMailboxIds(db, auth.orgId, input.mailboxIds) : [];
  const token = randomToken(32);
  const id = newId("inv");
  await db.insert(invitations).values({
    id, orgId: auth.orgId, email, role: input.role, mailboxIds: JSON.stringify(mailboxIds),
    tokenHash: await sha256Hex(token), invitedByUserId: auth.userId, invitedByName: auth.name,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });
  const org = (await db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get())!;
  const link = inviteLink(deps, token);
  const mail = await sendSystemEmail(deps, {
    to: email, orgId: auth.orgId,
    subject: `${auth.name} invited you to ${org.name} on ${deps.config.appName}`,
    text: `${auth.name} (${auth.email}) invited you to join the ${org.name} workspace on ${deps.config.appName} as ${input.role === "admin" ? "an admin" : "a member"}.\n\nThis invitation expires in 7 days.`,
    action: { label: "Accept invitation", url: link },
  });
  return { id, link, emailed: mail.delivered, emailDetail: mail.detail };
}

async function findInvite(db: DB, token: string) {
  const row = await db.select({ inv: invitations, org: organizations }).from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, await sha256Hex(token))).get();
  return row ?? null;
}

/** Public view of an invite link, so the accept page can explain itself before sign-in. */
export async function describeInvite(db: DB, token: string, now: Date) {
  const row = await findInvite(db, token);
  if (!row) throw notFound("Invitation");
  const state = row.inv.revokedAt ? "revoked" : row.inv.acceptedAt ? "accepted" : row.inv.expiresAt <= now ? "expired" : "pending";
  const hasAccount = !!(await db.select({ id: users.id }).from(users).where(eq(users.email, row.inv.email)).get());
  return {
    email: row.inv.email, role: row.inv.role, state, hasAccount,
    organization: { name: row.org.name }, invitedBy: row.inv.invitedByName,
    expiresAt: row.inv.expiresAt,
  };
}

/** Accepts an invite for the signed-in user and switches their session into the workspace. */
export async function acceptInvite(deps: Deps, auth: Pick<AuthContext, "userId" | "email" | "sessionId">, token: string) {
  const { db } = deps;
  const now = deps.now();
  const row = await findInvite(db, token);
  if (!row || row.inv.revokedAt) throw notFound("Invitation");
  if (row.inv.acceptedAt) throw new HttpError(410, "invite_used", "This invitation has already been used.");
  if (row.inv.expiresAt <= now) throw new HttpError(410, "invite_expired", "This invitation has expired. Ask for a new one.");
  if (row.inv.email !== auth.email.toLowerCase()) {
    throw forbidden(`This invitation is for ${row.inv.email}. Sign in with that address to accept it.`);
  }
  const already = await db.select().from(memberships).where(and(eq(memberships.orgId, row.inv.orgId), eq(memberships.userId, auth.userId))).get();
  if (!already) {
    await db.insert(memberships).values({ orgId: row.inv.orgId, userId: auth.userId, role: row.inv.role });
    const ids = (JSON.parse(row.inv.mailboxIds) as string[]);
    const live = ids.length ? await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, row.inv.orgId), inArray(mailboxes.id, ids))) : [];
    for (const m of live) await db.insert(mailboxAccess).values({ orgId: row.inv.orgId, userId: auth.userId, mailboxId: m.id }).onConflictDoNothing();
  }
  await db.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, row.inv.id));
  await db.update(sessions).set({ orgId: row.inv.orgId }).where(eq(sessions.id, auth.sessionId));
  return { orgId: row.inv.orgId, orgName: row.org.name, role: row.inv.role };
}

export async function revokeInvite(db: DB, orgId: string, id: string, now: Date) {
  const inv = await db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.orgId, orgId))).get();
  if (!inv || inv.acceptedAt || inv.revokedAt) throw notFound("Invitation");
  await db.update(invitations).set({ revokedAt: now }).where(eq(invitations.id, id));
  return inv;
}

async function getMember(db: DB, orgId: string, userId: string) {
  const m = await db.select({ role: memberships.role, email: users.email, name: users.name }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))).get();
  if (!m) throw notFound("Member");
  return m;
}

/** Role and mailbox-access changes. Owners manage everyone; admins manage members only. */
export async function updateMember(db: DB, auth: AuthContext, userId: string, input: { role?: "admin" | "member"; mailboxIds?: string[] }) {
  const target = await getMember(db, auth.orgId, userId);
  if (target.role === "owner") throw forbidden("The owner's role can't be changed. Transfer ownership instead.");
  if (userId === auth.userId) throw forbidden("You can't change your own role.");
  if (auth.role === "admin" && (target.role === "admin" || input.role === "admin")) throw forbidden("Only the owner can manage admins.");
  const role = input.role ?? target.role;
  if (input.role && input.role !== target.role) {
    await db.update(memberships).set({ role }).where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, userId)));
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

/** Removes someone from the workspace (or lets a non-owner leave). Their sessions there end. */
export async function removeMember(db: DB, auth: AuthContext, userId: string) {
  const target = await getMember(db, auth.orgId, userId);
  const self = userId === auth.userId;
  if (target.role === "owner") throw forbidden(self ? "Transfer ownership before leaving the workspace." : "The owner can't be removed.");
  if (!self) {
    if (auth.role === "member") throw forbidden("Only workspace admins can do that.");
    if (auth.role === "admin" && target.role === "admin") throw forbidden("Only the owner can remove admins.");
  }
  await db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, userId)));
  await db.delete(memberships).where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, userId)));
  // Sessions pointed at this workspace move to another workspace the person belongs to, or end.
  const other = await db.select().from(memberships).where(eq(memberships.userId, userId)).get();
  if (other) await db.update(sessions).set({ orgId: other.orgId }).where(and(eq(sessions.userId, userId), eq(sessions.orgId, auth.orgId)));
  else await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.orgId, auth.orgId)));
  return target;
}

export async function transferOwnership(db: DB, auth: AuthContext, toUserId: string, password: string) {
  if (auth.role !== "owner") throw forbidden("Only the owner can transfer ownership.");
  if (toUserId === auth.userId) throw badRequest("You already own this workspace.");
  const me = await db.select().from(users).where(eq(users.id, auth.userId)).get();
  if (!me || !(await verifyPassword(password, me.passwordHash))) {
    throw new HttpError(422, "validation_failed", "That password is incorrect.", { fields: { password: "That password is incorrect." } });
  }
  const target = await getMember(db, auth.orgId, toUserId);
  await db.update(memberships).set({ role: "owner" }).where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, toUserId)));
  await db.update(memberships).set({ role: "admin" }).where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, auth.userId)));
  await db.delete(mailboxAccess).where(and(eq(mailboxAccess.orgId, auth.orgId), eq(mailboxAccess.userId, toUserId)));
  return target;
}

/** Workspaces the user belongs to, for the switcher. */
export async function listWorkspaces(db: DB, userId: string) {
  return db.select({ id: organizations.id, name: organizations.name, plan: organizations.plan, role: memberships.role, isDemo: organizations.isDemo })
    .from(memberships).innerJoin(organizations, eq(organizations.id, memberships.orgId)).where(eq(memberships.userId, userId));
}

export async function switchWorkspace(db: DB, auth: AuthContext, orgId: string) {
  const m = await db.select().from(memberships).where(and(eq(memberships.userId, auth.userId), eq(memberships.orgId, orgId))).get();
  if (!m) throw notFound("Workspace");
  await db.update(sessions).set({ orgId }).where(eq(sessions.id, auth.sessionId));
}

export async function createWorkspace(db: DB, auth: AuthContext, name: string) {
  const owned = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.userId, auth.userId), eq(memberships.role, "owner"))).get();
  if ((owned?.n ?? 0) >= 10) throw planLimit("You can own up to 10 workspaces.");
  const id = newId("org");
  await db.insert(organizations).values({ id, name });
  await db.insert(memberships).values({ orgId: id, userId: auth.userId, role: "owner" });
  await db.update(sessions).set({ orgId: id }).where(eq(sessions.id, auth.sessionId));
  return id;
}

/** Deletes a workspace and everything in it. Owner only, password confirmed. */
export async function deleteWorkspace(db: DB, auth: AuthContext, password: string) {
  if (auth.role !== "owner") throw forbidden("Only the owner can delete the workspace.");
  const me = await db.select().from(users).where(eq(users.id, auth.userId)).get();
  if (!me || !(await verifyPassword(password, me.passwordHash))) {
    throw new HttpError(422, "validation_failed", "That password is incorrect.", { fields: { password: "That password is incorrect." } });
  }
  const others = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, auth.orgId), ne(memberships.userId, auth.userId)));
  // Move sessions that point at this workspace somewhere else first; the delete cascades.
  for (const uid of [auth.userId, ...others.map((o) => o.userId)]) {
    const next = await db.select().from(memberships).where(and(eq(memberships.userId, uid), ne(memberships.orgId, auth.orgId))).get();
    if (next) await db.update(sessions).set({ orgId: next.orgId }).where(and(eq(sessions.userId, uid), eq(sessions.orgId, auth.orgId)));
  }
  await db.delete(organizations).where(eq(organizations.id, auth.orgId));
}
