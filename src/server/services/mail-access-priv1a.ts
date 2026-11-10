/**
 * PRIV1a (MB-366): the one rule for who may open a mailbox. Every list, count, search, open, export, send, push and
 * realtime path asks here (through mailboxScope, canOpenMailbox, assertMailboxAccess or usersWhoCanOpen in team.ts).
 *
 * Model (like Google Workspace and Microsoft 365): admins manage people, they don't read their mail.
 * - A team mailbox (personal = 0) and an agent inbox: owners and admins open it, members open the ones they are granted.
 * - A personal mailbox (a connected Gmail or IMAP inbox, or a claimed free address): only its owner, plus the people
 *   the owner shared it with (read, reply, send as). Owners and admins of the workspace can't open it. If its owner
 *   is unknown or has left, only the workspace's owners see it until it is given to someone.
 */
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DB } from "../db";
import { mailboxAccess, mailboxDelegations, mailboxes, members } from "../db/schema";
import { notFound, HttpError } from "../lib/errors";

export type Role = "owner" | "admin" | "member";
export type Need = "read" | "reply" | "send";
export type ShareLevel = "read" | "reply" | "send_as";
type Who = { userId: string; orgId: string; role?: Role | null };

const RANK: Record<ShareLevel | "own", number> = { read: 1, reply: 2, send_as: 3, own: 9 };
const NEED_RANK: Record<Need, number> = { read: 1, reply: 2, send: 3 };

interface Personal { owner: string | null; ownerIsMember: boolean }
interface Picture {
  /** Every personal mailbox in the workspace with its owner. */
  personal: Map<string, Personal>;
  /** This person's shares: mailbox id to level. */
  shares: Map<string, ShareLevel>;
}


async function loadPicture(db: DB, who: Who): Promise<Picture> {
  const [rows, shares] = await Promise.all([
    db.select({ id: mailboxes.id, owner: mailboxes.ownerUserId, member: members.userId }).from(mailboxes)
      .leftJoin(members, and(eq(members.userId, mailboxes.ownerUserId), eq(members.organizationId, mailboxes.orgId)))
      .where(and(eq(mailboxes.orgId, who.orgId), eq(mailboxes.personal, true))),
    who.userId
      ? db.select({ id: mailboxDelegations.mailboxId, level: mailboxDelegations.level }).from(mailboxDelegations)
        .where(and(eq(mailboxDelegations.orgId, who.orgId), eq(mailboxDelegations.userId, who.userId)))
      : Promise.resolve([] as { id: string; level: ShareLevel }[]),
  ]);
  return {
    personal: new Map(rows.map((r) => [r.id, { owner: r.owner, ownerIsMember: !!r.member }])),
    shares: new Map(shares.map((s) => [s.id, s.level])),
  };
}

// Read fresh every time (two small indexed reads): a share taken back closes the mailbox on the very next request.
// The auth object can outlive a request (the session cache), so nothing is cached on it.
function picture(db: DB, who: Who): Promise<Picture> {
  return loadPicture(db, who);
}

/** How far this person may go in one personal mailbox: "own", a share level, or null. */
function personalLevel(p: Personal, mailboxId: string, who: Who, pic: Picture): ShareLevel | "own" | null {
  if (who.userId && p.owner === who.userId && p.ownerIsMember) return "own";
  // Unresolved (no owner, or the owner left): the workspace's owners keep it so nobody is locked out of mail.
  if ((!p.owner || !p.ownerIsMember) && who.role === "owner") return "own";
  return pic.shares.get(mailboxId) ?? null;
}

/**
 * Mailboxes this person may open (at `need`): `null` means every mailbox in the workspace (an owner or admin in a
 * workspace with no personal mailbox closed to them), otherwise the exact list.
 */
export async function scopeFor(db: DB, who: Who, need: Need = "read"): Promise<string[] | null> {
  const pic = await picture(db, who);
  const closed: string[] = [];
  const open: string[] = [];
  for (const [id, p] of pic.personal) {
    const lvl = personalLevel(p, id, who, pic);
    if (lvl && RANK[lvl] >= NEED_RANK[need]) open.push(id); else closed.push(id);
  }
  if (who.role === "owner" || who.role === "admin") {
    if (!closed.length) return null;
    const all = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.orgId, who.orgId));
    const shut = new Set(closed);
    return all.map((r) => r.id).filter((id) => !shut.has(id));
  }
  // Members: team mailboxes they are granted (a grant on a personal mailbox counts for nothing), plus their own and shared ones.
  const granted = who.userId
    ? await db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.userId, who.userId), eq(mailboxAccess.orgId, who.orgId)))
    : [];
  return [...new Set([...granted.map((r) => r.id).filter((id) => !pic.personal.has(id)), ...open])];
}

/**
 * The same rule as scopeFor, as one SQL condition on a mailbox id column (no reads of its own), for hot single
 * statement routes such as the badge counts. People only; agents and system actors use scopeFor.
 */
export function scopeCond(who: Who, col: SQLWrapper): SQL {
  const me = who.userId || "-";
  const member = sql`exists (select 1 from members x where x.user_id = m.owner_user_id and x.organization_id = m.org_id)`;
  const owned = sql`(m.owner_user_id = ${me} and ${member})`;
  const orphan = sql`(m.owner_user_id is null or not ${member})`;
  const shared = sql`m.id in (select d.mailbox_id from mailbox_delegations d where d.org_id = ${who.orgId} and d.user_id = ${me})`;
  const open = who.role === "owner" ? sql`(${owned} or ${orphan} or ${shared})` : sql`(${owned} or ${shared})`;
  if (who.role === "owner" || who.role === "admin") {
    return sql`${col} not in (select m.id from mailboxes m where m.org_id = ${who.orgId} and m.personal = 1 and not ${open})`;
  }
  return sql`(${col} in (select a.mailbox_id from mailbox_access a join mailboxes m on m.id = a.mailbox_id where a.org_id = ${who.orgId} and a.user_id = ${me} and m.personal = 0) or ${col} in (select m.id from mailboxes m where m.org_id = ${who.orgId} and m.personal = 1 and ${open}))`;
}

/** True when this person may open the mailbox (at `need`). False for another workspace's mailbox. */
export async function canOpen(db: DB, who: Who, mailboxId: string, need: Need = "read"): Promise<boolean> {
  const scope = await scopeFor(db, who, need);
  if (scope) return scope.includes(mailboxId);
  const row = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, who.orgId))).get();
  return !!row;
}

/** 404 when the person can't see the mailbox at all; 403 when they can see it but not do this (a read only share). */
export async function assertOpen(db: DB, who: Who, mailboxId: string, need: Need = "read") {
  if (await canOpen(db, who, mailboxId, need)) return;
  if (need !== "read" && await canOpen(db, who, mailboxId, "read")) {
    throw new HttpError(403, "share_level", need === "send" ? "This mailbox was shared with you without Send as. Ask its owner." : "This mailbox was shared with you to read only. Ask its owner.");
  }
  throw notFound("Mailbox");
}

/** Personal mailbox facts for one mailbox (null for a team or agent mailbox, or another workspace's). */
export async function personalInfo(db: DB, orgId: string, mailboxId: string) {
  const r = await db.select({ personal: mailboxes.personal, owner: mailboxes.ownerUserId }).from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId))).get();
  return r?.personal ? { owner: r.owner } : null;
}

/** Everyone who can open the mailbox: for notifications, mentions, push and realtime. */
export async function whoCanOpen(db: DB, orgId: string, mailboxId: string): Promise<string[]> {
  const p = await personalInfo(db, orgId, mailboxId);
  if (p) {
    const [owner, shares] = await Promise.all([
      p.owner ? db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, p.owner))).get() : Promise.resolve(undefined),
      db.select({ userId: mailboxDelegations.userId }).from(mailboxDelegations).where(and(eq(mailboxDelegations.orgId, orgId), eq(mailboxDelegations.mailboxId, mailboxId))),
    ]);
    const ids = shares.map((s) => s.userId);
    if (owner) ids.push(owner.userId);
    else {
      const owners = await db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.role, "owner")));
      ids.push(...owners.map((o) => o.userId));
    }
    // Only people still in the workspace.
    if (!ids.length) return [];
    const still = await db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, orgId), inArray(members.userId, [...new Set(ids)].slice(0, 90))));
    return [...new Set(still.map((r) => r.userId))];
  }
  const [leads, granted] = await Promise.all([
    db.select({ userId: members.userId, role: members.role }).from(members).where(eq(members.organizationId, orgId)),
    db.select({ userId: mailboxAccess.userId }).from(mailboxAccess).where(and(eq(mailboxAccess.orgId, orgId), eq(mailboxAccess.mailboxId, mailboxId))),
  ]);
  return [...new Set([...leads.filter((r) => r.role !== "member"), ...granted].map((r) => r.userId))];
}

/** Of these people, the ones who can open at least one of the mailboxes (thread mentions, assignment, followers). */
export async function whoCanOpenAny(db: DB, orgId: string, mailboxIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of [...new Set(mailboxIds)]) for (const u of await whoCanOpen(db, orgId, id)) out.add(u);
  return out;
}

/**
 * An AI agent's mailboxes, minus personal mailboxes its maker doesn't own: an admin can't route someone's private inbox
 * through an agent. Team and agent mailboxes pass as before.
 * PRIV1b (P4): only the maker's OWN personal mailbox, while the maker is still a member. A share the maker holds no
 * longer counts: an agent key has no share level, so a read share became trash and delete forever through it.
 */
export async function keepOpenableBy(db: DB, orgId: string, userId: string | null | undefined, ids: string[]): Promise<string[]> {
  if (!ids.length) return ids;
  const pic = await loadPicture(db, { orgId, userId: "", role: "member" }); // shares not needed: one read
  return ids.filter((id) => {
    const p = pic.personal.get(id);
    if (!p) return true;
    return !!userId && p.owner === userId && p.ownerIsMember;
  });
}

/**
 * The owner of a personal mailbox as this request sees it: undefined for a team or agent mailbox (or another
 * workspace's), null when unresolved, else the owner's user id. Uses the request's one read.
 */
export async function ownerOfPersonal(db: DB, who: Who, mailboxId: string): Promise<string | null | undefined> {
  const p = (await picture(db, who)).personal.get(mailboxId);
  return p ? p.owner : undefined;
}

/** Kept for callers: nothing is cached, so there is nothing to forget. */
export function forgetPicture(_who: object) { /* no cache */ }
