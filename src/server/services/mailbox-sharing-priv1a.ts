/**
 * PRIV1a (MB-366): sharing a personal mailbox (Gmail style delegation) and its "Who opened my mailbox" log.
 * Only the mailbox's owner shares or stops sharing; an admin can't, and can't see the mail. No message content is logged.
 */
import { and, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { mailboxAccessLog, mailboxDelegations, mailboxes, members, users } from "../db/schema";
import { newId } from "../lib/crypto";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { personalInfo, type ShareLevel } from "./mail-access-priv1a";

export const SHARE_LEVELS: ShareLevel[] = ["read", "reply", "send_as"];
export const ACCESS_LOG_PAGE = 50;
/** One "opened" row per person and thread (or mailbox) in this window. */
export const OPEN_LOG_WINDOW_MS = 15 * 60_000;

type Who = Pick<AuthContext, "userId" | "orgId" | "role" | "email"> & { sessionId?: string };

/** web, phone or api, from the request (never stored beyond the word). */
export function deviceOf(headers: Headers | undefined, who: Who): "web" | "phone" | "api" {
  if (who.email?.startsWith("api-key:") || (who.sessionId === "" && !headers?.get("cookie"))) return "api";
  const ua = headers?.get("user-agent") ?? "";
  return /okhttp|CFNetwork|Expo|Darwin|Android|iPhone|iPad|Mobile/i.test(ua) ? "phone" : "web";
}

// Isolate memory: skip the database for a repeat open in the window (the database check still holds across isolates).
const recent = new Map<string, number>();

/**
 * Logs an open by anyone but the owner of a personal mailbox. Never throws into the read. Callers log only what the
 * person could open (PRIV1b, P17): the shared readers call it after their scope check.
 */
export async function logMailboxOpen(deps: Deps, who: Who, mailboxId: string, action: "opened_mailbox" | "opened_thread", targetId: string | null, headers?: Headers) {
  try {
    const key = `${mailboxId}:${who.userId}:${action}:${targetId ?? ""}`;
    const now = deps.now().getTime();
    if ((recent.get(key) ?? 0) > now - OPEN_LOG_WINDOW_MS) return;
    // PRIV1b (P29): one indexed read on the mailbox, not the workspace's whole picture.
    const p = await personalInfo(deps.db, who.orgId, mailboxId);
    if (!p || (p.owner && p.owner === who.userId)) return;
    if (recent.size > 2000) recent.clear();
    recent.set(key, now);
    const last = await deps.db.select({ at: mailboxAccessLog.createdAt, actor: mailboxAccessLog.actorUserId, action: mailboxAccessLog.action, target: mailboxAccessLog.targetId }).from(mailboxAccessLog)
      .where(eq(mailboxAccessLog.mailboxId, mailboxId)).orderBy(desc(mailboxAccessLog.createdAt)).limit(5);
    if (last.some((r) => r.actor === (who.userId || null) && r.action === action && r.target === targetId && new Date(r.at).getTime() > now - OPEN_LOG_WINDOW_MS)) return;
    await deps.db.insert(mailboxAccessLog).values({ id: newId("mal"), orgId: who.orgId, mailboxId, actorUserId: who.userId || null, actorEmail: who.email ?? null, action, targetId, device: deviceOf(headers, who) });
  } catch (err) {
    deps.log?.warn("priv1a.access_log_failed", { error: (err as Error).message });
  }
}

async function ownMailbox(deps: Deps, who: Who, mailboxId: string) {
  const mb = await deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName, personal: mailboxes.personal, owner: mailboxes.ownerUserId })
    .from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, who.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  return mb;
}

async function requireOwner(deps: Deps, who: Who, mailboxId: string) {
  const mb = await ownMailbox(deps, who, mailboxId);
  if (!mb.personal) throw badRequest("This is a team mailbox. Admins choose who opens it in Team.");
  if (!who.userId || mb.owner !== who.userId) throw forbidden("Only the person this mailbox belongs to can share it.");
  return mb;
}

/** The owner's view: who it is shared with, who could be added, and the access log. Delegates see only their own share. */
export async function sharingView(deps: Deps, who: Who, mailboxId: string) {
  const mb = await ownMailbox(deps, who, mailboxId);
  if (!mb.personal) return { personal: false as const, isOwner: false, shares: [], people: [], log: [] };
  const isOwner = !!who.userId && mb.owner === who.userId;
  const shares = await deps.db.select({ userId: mailboxDelegations.userId, level: mailboxDelegations.level, createdAt: mailboxDelegations.createdAt, name: users.name, email: users.email })
    .from(mailboxDelegations).innerJoin(users, eq(users.id, mailboxDelegations.userId))
    .where(and(eq(mailboxDelegations.orgId, who.orgId), eq(mailboxDelegations.mailboxId, mailboxId)));
  if (!isOwner) {
    const mine = shares.find((s) => s.userId === who.userId);
    if (!mine) throw notFound("Mailbox");
    return { personal: true as const, isOwner: false, address: mb.address, shares: [present(mine)], people: [], log: [] };
  }
  const [people, log] = await Promise.all([
    deps.db.select({ id: users.id, name: users.name, email: users.email, kind: members.kind }).from(members).innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, who.orgId)).limit(500),
    deps.db.select().from(mailboxAccessLog).where(eq(mailboxAccessLog.mailboxId, mailboxId)).orderBy(desc(mailboxAccessLog.createdAt)).limit(ACCESS_LOG_PAGE),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  return {
    personal: true as const, isOwner: true, address: mb.address,
    shares: shares.map(present),
    people: people.filter((p) => p.id !== who.userId && p.kind !== "agent" && !shares.some((s) => s.userId === p.id)).map((p) => ({ id: p.id, name: p.name, email: p.email })),
    log: log.map((r) => ({ id: r.id, action: r.action, who: (r.actorUserId && names.get(r.actorUserId)) || r.actorEmail || "Someone", targetId: r.targetId, device: r.device, at: new Date(r.createdAt).toISOString() })),
  };
}
function present(s: { userId: string; level: ShareLevel; createdAt: Date; name: string; email: string }) {
  return { userId: s.userId, name: s.name, email: s.email, level: s.level, since: new Date(s.createdAt).toISOString() };
}

export async function shareMailbox(deps: Deps, who: Who, mailboxId: string, userId: string, level: ShareLevel) {
  if (!SHARE_LEVELS.includes(level)) throw badRequest("Pick Read, Read and reply, or Send as.");
  await requireOwner(deps, who, mailboxId);
  if (userId === who.userId) throw badRequest("It's already yours.");
  const m = await deps.db.select({ kind: members.kind }).from(members).where(and(eq(members.organizationId, who.orgId), eq(members.userId, userId))).get();
  if (!m) throw badRequest("That person isn't in this workspace.");
  if (m.kind === "agent") throw badRequest("Share with people. Agents get mailboxes in Agents.");
  const before = await deps.db.select({ level: mailboxDelegations.level }).from(mailboxDelegations).where(and(eq(mailboxDelegations.mailboxId, mailboxId), eq(mailboxDelegations.userId, userId))).get();
  if (before?.level === level) return sharingView(deps, who, mailboxId);
  if (before) await deps.db.update(mailboxDelegations).set({ level }).where(and(eq(mailboxDelegations.mailboxId, mailboxId), eq(mailboxDelegations.userId, userId)));
  else await deps.db.insert(mailboxDelegations).values({ orgId: who.orgId, mailboxId, userId, level, grantedByUserId: who.userId });
  await deps.db.insert(mailboxAccessLog).values({ id: newId("mal"), orgId: who.orgId, mailboxId, actorUserId: who.userId, actorEmail: who.email ?? null, action: before ? "share_changed" : "share_granted", targetId: `${userId}:${level}`, device: null });
  return sharingView(deps, who, mailboxId);
}

/** The owner stops sharing, or the person it was shared with leaves it. Takes effect on the next request. */
export async function unshareMailbox(deps: Deps, who: Who, mailboxId: string, userId: string) {
  const mb = await ownMailbox(deps, who, mailboxId);
  if (!mb.personal) throw badRequest("This is a team mailbox. Admins choose who opens it in Team.");
  const self = userId === who.userId;
  if (!self && mb.owner !== who.userId) throw forbidden("Only the person this mailbox belongs to can stop sharing it.");
  const gone = await deps.db.delete(mailboxDelegations).where(and(eq(mailboxDelegations.orgId, who.orgId), eq(mailboxDelegations.mailboxId, mailboxId), eq(mailboxDelegations.userId, userId))).returning({ userId: mailboxDelegations.userId });
  if (!gone.length) throw notFound("Share");
  // PRIV1b (P6): a mail app password made under the share would outlive it. A mail server failure doesn't undo the
  // unshare: the maintenance sweep takes what is left.
  await (await import("./mailserver")).destroyForeignAppPasswords(deps, who.orgId, mailboxId).catch((err: unknown) => deps.reportError?.(err, { where: "unshare.app_passwords" }));
  await deps.db.insert(mailboxAccessLog).values({ id: newId("mal"), orgId: who.orgId, mailboxId, actorUserId: who.userId, actorEmail: who.email ?? null, action: "share_revoked", targetId: userId, device: null });
  return self ? { ok: true } : sharingView(deps, who, mailboxId);
}

/** My personal mailboxes and the ones shared with me, for Settings. */
export async function myMailboxPrivacy(deps: Deps, who: Who) {
  const [own, shared] = await Promise.all([
    who.userId ? deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName }).from(mailboxes)
      .where(and(eq(mailboxes.orgId, who.orgId), eq(mailboxes.personal, true), eq(mailboxes.ownerUserId, who.userId))) : Promise.resolve([]),
    who.userId ? deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName, level: mailboxDelegations.level, ownerUserId: mailboxes.ownerUserId }).from(mailboxDelegations)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxDelegations.mailboxId))
      .where(and(eq(mailboxDelegations.orgId, who.orgId), eq(mailboxDelegations.userId, who.userId))) : Promise.resolve([]),
  ]);
  // The one time notice for owners and admins: personal inboxes in this workspace they no longer open.
  let hiddenFromMe = 0;
  // Wave 1 review V12 (P37): team mailboxes at a member's sign in address, for admins to decide on.
  let loginAddressTeam: { id: string; address: string; member: string }[] = [];
  if (who.role === "owner" || who.role === "admin") {
    const all = await deps.db.select({ id: mailboxes.id, owner: mailboxes.ownerUserId }).from(mailboxes).where(and(eq(mailboxes.orgId, who.orgId), eq(mailboxes.personal, true)));
    hiddenFromMe = all.filter((m) => m.owner && m.owner !== who.userId && !shared.some((s) => s.id === m.id)).length;
    loginAddressTeam = (await (await import("./addresses")).loginAddressTeamMailboxes(deps, who.orgId)).map(({ id, address, member }) => ({ id, address, member }));
  }
  return { own, shared, hiddenFromMe, loginAddressTeam };
}
