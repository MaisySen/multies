/**
 * Workspace membership on top of Better Auth's organization plugin. Better Auth owns
 * the records and the core rules (invitations, roles, membership); this module adds
 * Multies' stricter role policy, plan seats and per-mailbox access for members.
 */
import { cancelForDeletion } from "./billing";
import { and, count, desc, eq, max, ne, or, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import type { DB } from "../db";
import { accounts, invitations, mailboxAccess, mailboxAccessLog, mailboxDelegations, mailboxes, mailConnections, members, organizations, sessions, users } from "../db/schema";
import { newId, randomToken, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, planLimit } from "../lib/errors";
import { authFor } from "../auth";
import { addonHint, getPlan } from "./plans";
import { isHosted } from "./mail/delivery";
import { removeAgentMember } from "./people";
import { DEFAULT_TIMEZONE } from "@/shared/locale";
import { sendInviteEmail, takeInviteSend } from "./invite-email";
import { chunkIds, inIds } from "../lib/sql-chunks";
import { assertOpen, canOpen, scopeFor, whoCanOpen, type Need } from "./mail-access-priv1a";

/** MB-220: shown when someone in the demo tries to invite a person. */
export const DEMO_INVITES_OFF = "Invites are off in the demo. Sign up to invite your team.";

export type Role = "owner" | "admin" | "member";

/**
 * Mailboxes this user may open: `null` means every mailbox in the workspace; otherwise the exact list.
 * PRIV1a (MB-366): the one rule lives in mail-access-priv1a.ts. Owners and admins see every team and agent mailbox but
 * not someone else's personal mailbox; members see the team mailboxes they are granted; personal mailboxes open only
 * to their owner and the people the owner shared them with. `need` asks for more than reading (a reply, a send).
 */
export async function mailboxScope(db: DB, auth: Pick<AuthContext, "userId" | "orgId" | "role">, need: Need = "read"): Promise<string[] | null> {
  return scopeFor(db, auth, need);
}

/** People who can open a mailbox (notifications, push, realtime, mentions). PRIV1a: personal mailboxes only reach their owner and shares. */
export async function usersWhoCanOpen(db: DB, orgId: string, mailboxId: string): Promise<string[]> {
  return whoCanOpen(db, orgId, mailboxId);
}

/** True when this person may open the mailbox (at `need`). */
export async function canOpenMailbox(db: DB, auth: Pick<AuthContext, "userId" | "orgId" | "role">, mailboxId: string, need: Need = "read") {
  return canOpen(db, auth, mailboxId, need);
}

export async function assertMailboxAccess(db: DB, auth: Pick<AuthContext, "userId" | "orgId" | "role">, mailboxId: string, need: Need = "read") {
  return assertOpen(db, auth, mailboxId, need);
}

async function validMailboxIds(db: DB, orgId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: mailboxes.id, personal: mailboxes.personal }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inIds(mailboxes.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("One of those mailboxes doesn't exist in this workspace.");
  // PRIV1a: a personal mailbox is shared by its owner (Share in its settings), never granted by an admin.
  if (rows.some((r) => r.personal)) throw forbidden("A personal mailbox is private to the person who connected it. Ask them to share it.");
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
  // R40 (MB-199): one statement instead of two (each D1 query costs the Worker CPU to build and map).
  // AI agent members take no seat; a pending invite counts until it expires.
  const row = await db.select({
    members: sql<number>`(select count(*) from ${members} where ${members.organizationId} = ${orgId} and ${members.kind} = 'human')`,
    pending: sql<number>`(select count(*) from ${invitations} where ${invitations.organizationId} = ${orgId} and ${invitations.status} = 'pending' and ${invitations.expiresAt} > ${sql.param(now, invitations.expiresAt)})`,
  }).from(sql`(select 1)`).get();
  return { members: Number(row?.members ?? 0), pendingInvites: Number(row?.pending ?? 0) };
}

export async function listMembers(db: DB, orgId: string) {
  const rows = await db.select({
    memberId: members.id, userId: users.id, email: users.email, name: users.name, role: members.role, kind: members.kind, title: members.title, bio: members.bio, joinedAt: members.createdAt,
  }).from(members).innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId));
  const ids = rows.map((r) => r.userId);
  const access = await db.select().from(mailboxAccess).where(eq(mailboxAccess.orgId, orgId));
  const seen = ids.length
    ? await db.select({ userId: sessions.userId, at: max(sessions.updatedAt) }).from(sessions).where(inIds(sessions.userId, ids)).groupBy(sessions.userId)
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
    title: inv.title ?? null, bio: inv.bio ?? null,
    createdAt: inv.createdAt, expiresAt: inv.expiresAt, expired: inv.expiresAt <= now,
  }));
}

export function inviteLink(deps: Deps, id: string) {
  return `${deps.config.appUrl}/invite/${id}`;
}

export interface InviteInput { email: string; role: "admin" | "member"; mailboxIds: string[]; title?: string | null; bio?: string | null }

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** True for an API key or OAuth caller: there is no Better Auth session to act through. */
const viaKey = (auth: AuthContext) => auth.sessionId.startsWith("apikey:") || auth.sessionId.startsWith("oauth:");
const cleanText = (v: string | null | undefined, max: number) => (v === undefined ? undefined : (v ?? "").trim().slice(0, max) || null);

/**
 * Creates (or re-issues) an invitation. In the app it goes through Better Auth with the
 * person's session; with an API key (POST /api/v1/invites) there is no session, so the same
 * checks run here and the row and email are written directly, as the key's creator.
 * R25 (DF-4): an invitation can carry a title and bio, copied to the member row on accept.
 * The link is always returned to the inviter.
 */
export async function createInvite(deps: Deps, auth: AuthContext, headers: Headers, input: InviteInput) {
  const { db } = deps;
  const email = input.email.trim().toLowerCase();
  const key = viaKey(auth);
  // A workspace key acts with the admin role; inviting an admin needs the key's creator to be the owner.
  let inviterRole: Role = auth.role;
  if (key) {
    if (!auth.userId) throw forbidden("This key's creator is no longer in the workspace. Create a new key to invite people.");
    const creator = await db.select({ role: members.role }).from(members).where(and(eq(members.organizationId, auth.orgId), eq(members.userId, auth.userId))).get();
    if (!creator) throw forbidden("This key's creator is no longer in the workspace. Create a new key to invite people.");
    inviterRole = creator.role;
  }
  if (input.role === "admin" && inviterRole !== "owner") throw forbidden("Only the workspace owner can invite admins.");
  // R40 deploy 3 (MB-220): an anonymous demo workspace sends no real mail, so it cannot mail invitations to
  // any address from our domain.
  const inOrg = await db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, auth.orgId)).get();
  if (inOrg?.isDemo) throw new HttpError(403, "demo_invites_off", DEMO_INVITES_OFF);
  const existing = await db.select({ id: users.id }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, auth.orgId), eq(users.email, email))).get();
  if (existing) throw conflict(`${email} is already in this workspace.`);
  if (input.role === "member") await validMailboxIds(db, auth.orgId, input.mailboxIds);
  const plan = await getPlan(db, auth.orgId);
  const used = await seatsUsed(db, auth.orgId, deps.now());
  const reinvite = await db.select().from(invitations)
    .where(and(eq(invitations.organizationId, auth.orgId), eq(invitations.email, email), eq(invitations.status, "pending"))).get();
  if (used.members + used.pendingInvites - (reinvite ? 1 : 0) >= plan.limits.seats) {
    throw planLimit(`Your workspace includes ${plan.limits.seats} seats, and they're all taken or invited. ${addonHint("seats")}`);
  }
  const mailboxIds = JSON.stringify(input.role === "member" ? input.mailboxIds : []);
  const title = cleanText(input.title, 80);
  const bio = cleanText(input.bio, 500);
  let id: string;
  if (key) {
    id = await issueInviteDirect(deps, auth, { email, role: input.role, mailboxIds, title, bio }, reinvite);
  } else {
    const inv = await authFor(deps).api.createInvitation({
      headers,
      body: { email, role: input.role, organizationId: auth.orgId, resend: true, mailboxIds },
    });
    id = inv.id;
    // Better Auth keeps a re-issued invitation's old role and mailboxes and has no title or bio
    // field, so set what this call asked for (one write, and only when something differs).
    const want: Partial<typeof invitations.$inferInsert> = {};
    if (reinvite && (reinvite.role ?? "member") !== input.role) want.role = input.role;
    if (reinvite && (reinvite.mailboxIds ?? "[]") !== mailboxIds) want.mailboxIds = mailboxIds;
    if (title !== undefined && title !== (reinvite?.title ?? null)) want.title = title;
    if (bio !== undefined && bio !== (reinvite?.bio ?? null)) want.bio = bio;
    if (Object.keys(want).length) await db.update(invitations).set(want).where(eq(invitations.id, id));
  }
  // R41 (MB-228): emailed is what the send answered (a provider that holds or refuses mail to outside addresses
  // means emailed:false with the reason), not a guess from the deployment.
  const sent = takeInviteSend(id);
  const emailed = sent ? sent.delivered : deps.outbound.name !== "log" || (await isHosted(db, email));
  const emailDetail = emailed ? undefined : inviteNotSentReason(sent?.detail);
  return { id, link: inviteLink(deps, id), emailed, ...(emailDetail ? { emailDetail } : {}) };
}

/** The API key path of createInvite: what Better Auth's createInvitation does, written directly. */
async function issueInviteDirect(deps: Deps, auth: AuthContext, v: { email: string; role: "admin" | "member"; mailboxIds: string; title?: string | null; bio?: string | null }, reinvite: typeof invitations.$inferSelect | undefined) {
  const { db } = deps;
  const expiresAt = new Date(deps.now().getTime() + INVITE_TTL_MS);
  let id: string;
  if (reinvite) {
    id = reinvite.id;
    await db.update(invitations).set({
      expiresAt, role: v.role, mailboxIds: v.mailboxIds,
      ...(v.title !== undefined ? { title: v.title } : {}), ...(v.bio !== undefined ? { bio: v.bio } : {}),
    }).where(eq(invitations.id, id));
  } else {
    id = randomToken(24);
    await db.insert(invitations).values({
      id, organizationId: auth.orgId, email: v.email, role: v.role, status: "pending", expiresAt, inviterId: auth.userId,
      mailboxIds: v.mailboxIds, title: v.title ?? null, bio: v.bio ?? null, createdAt: deps.now(),
    });
  }
  const [org, inviter] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, auth.orgId)).get(),
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, auth.userId)).get(),
  ]);
  await sendInviteEmail(deps, { id, email: v.email, role: v.role, organization: org!, inviter: inviter ?? { name: org!.name, email: auth.email } });
  return id;
}

export async function getInvite(db: DB, orgId: string, id: string) {
  const inv = await db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.organizationId, orgId), eq(invitations.status, "pending"))).get();
  if (!inv) throw notFound("Invitation");
  return inv;
}

export async function revokeInvite(deps: Deps, auth: AuthContext, headers: Headers, id: string) {
  const inv = await getInvite(deps.db, auth.orgId, id);
  // An API key has no session for Better Auth: cancel the row the same way it would.
  if (viaKey(auth)) await deps.db.update(invitations).set({ status: "canceled" }).where(and(eq(invitations.id, id), eq(invitations.organizationId, auth.orgId)));
  else await authFor(deps).api.cancelInvitation({ headers, body: { invitationId: id } });
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
  // R39 security hotfix: the invite id alone is not proof. The account must own the invited address,
  // so an account made with someone else's address but never confirmed can't take their seat or role.
  const me = await db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, auth.userId)).get();
  if (!me || me.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden(`This invitation is for ${inv.email}. Sign in with that address to accept it.`);
  if (!me.emailVerified) throw new HttpError(403, "email_not_verified", `Confirm your email address ${inv.email} first (look for the confirmation email in that inbox), then open the invite link again.`);
  await authFor(deps).api.acceptInvitation({ headers, body: { invitationId: id } });
  // R25 (DF-4): the title and bio the invitation carried start the new member's profile.
  if (inv.title || inv.bio) {
    await db.update(members).set({ title: inv.title, bio: inv.bio }).where(and(eq(members.organizationId, inv.organizationId), eq(members.userId, auth.userId)));
  }
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
  await endPersonalMail(deps, auth.orgId, userId, { userId: auth.userId || null, email: auth.email ?? null });
  return target;
}

/**
 * PRIV1b (P9): someone left the workspace (removed, left, or deleting their account). The shares they hold and the
 * ones on their personal mailboxes end (each logged as share_revoked), their personal connections stop syncing, and
 * app passwords on those mailboxes that their owner no longer stands behind go. Nothing comes back on a re-invite.
 * A mail server failure doesn't undo the rest: the maintenance sweep takes what is left.
 */
export async function endPersonalMail(deps: Deps, orgId: string, userId: string, actor: { userId: string | null; email: string | null }) {
  const { db } = deps;
  const own = (await db.select({ id: mailboxes.id }).from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.personal, true), eq(mailboxes.ownerUserId, userId)))).map((r) => r.id);
  const gone = await db.delete(mailboxDelegations)
    .where(and(eq(mailboxDelegations.orgId, orgId), or(eq(mailboxDelegations.userId, userId), own.length ? inIds(mailboxDelegations.mailboxId, own) : undefined)))
    .returning({ mailboxId: mailboxDelegations.mailboxId, userId: mailboxDelegations.userId });
  for (const part of chunkIds(gone, 10)) { // 9 columns a row: under D1's 100 bound variables
    await db.insert(mailboxAccessLog).values(part.map((g) => ({ id: newId("mal"), orgId, mailboxId: g.mailboxId, actorUserId: actor.userId, actorEmail: actor.email, action: "share_revoked", targetId: g.userId, device: null })));
  }
  if (own.length) await db.update(mailConnections).set({ status: "paused" }).where(and(eq(mailConnections.orgId, orgId), inIds(mailConnections.mailboxId, own)));
  const { destroyForeignAppPasswords } = await import("./mailserver");
  for (const mb of new Set([...own, ...gone.map((g) => g.mailboxId)])) {
    await destroyForeignAppPasswords(deps, orgId, mb).catch((err: unknown) => deps.reportError?.(err, { where: "member_left.app_passwords" }));
  }
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

/**
 * Moves this session to another workspace the person belongs to. Multiws (27 Oct 2026): one direct write on the
 * session row (the same write joining or creating a workspace makes), which also bumps updatedAt, so the next
 * sign in on any device opens the workspace switched to last. Answers the workspace so the caller can confirm it.
 */
export async function switchWorkspace(deps: Deps, auth: AuthContext, _headers: Headers, orgId: string) {
  const m = await deps.db.select({ name: organizations.name, role: members.role }).from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.userId, auth.userId), eq(members.organizationId, orgId))).get();
  if (!m) throw notFound("Workspace");
  await deps.db.update(sessions).set({ activeOrganizationId: orgId, updatedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
  return { id: orgId, name: m.name, role: m.role };
}

export async function createWorkspace(deps: Deps, auth: AuthContext, headers: Headers, name: string) {
  const owned = await deps.db.select({ n: count() }).from(members).where(and(eq(members.userId, auth.userId), eq(members.role, "owner"))).get();
  if ((owned?.n ?? 0) >= 10) throw planLimit("You can own up to 10 workspaces.");
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace"}-${crypto.randomUUID().slice(0, 8)}`;
  const org = await authFor(deps).api.createOrganization({ headers, body: { name, slug } });
  if (!org) throw new HttpError(500, "internal", "The workspace could not be created.");
  // A new workspace starts in its creator's own zone and the country of the workspace they came from, never a fixed default.
  const [me, from] = await Promise.all([
    deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, auth.userId)).get(),
    deps.db.select({ country: organizations.country, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, auth.orgId)).get(),
  ]);
  await deps.db.update(organizations).set({ timezone: me?.tz ?? from?.tz ?? DEFAULT_TIMEZONE, ...(from?.country ? { country: from.country } : {}) }).where(eq(organizations.id, org.id));
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

/** R41 (MB-228): a plain reason an invite was not emailed, for the dialog and the API answer. */
export function inviteNotSentReason(detail: string | undefined) {
  if (!detail) return "Email delivery isn't connected on this deployment.";
  if (/^Delayed/i.test(detail)) return "The email provider is unavailable right now. We'll keep trying, but share the link to be sure.";
  if (/^Held/i.test(detail)) return "This deployment can't email addresses outside Multies yet.";
  if (/demo/i.test(detail)) return "Demo workspaces send no email.";
  if (/isn't connected/i.test(detail)) return "Email delivery isn't connected on this deployment.";
  return "The email provider didn't accept this invite.";
}
