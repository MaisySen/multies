/**
 * R103: comments on docs.
 *   team thread    everyone in the workspace who can open the doc, and the doc's project guests; visible at once.
 *   public thread  people with a share link that has comments on; their posts wait for review (pending) and only
 *                  approved ones are shown on the link. The team answers there in public (moderators only).
 * Moderators: owners, admins and the person who made the doc. They approve, hide and remove; authors edit and remove
 * their own. A visitor's email is never shown. Reads are bounded (500 per doc) and use doc_comments_doc_idx.
 */
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { docComments, docs, members, shareLinks, users } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { sha256Hex } from "../../lib/crypto";
import { assertWritable, sortableId, type SuiteActor } from "../suite/common";
import { notify } from "../suite/notify";
import { isActive, readMeta, TOKEN_RE } from "../suite/share-links";
import { organizations } from "../../db/schema";
import { COMMENT_MAX, PUBLIC_NAME_MAX, mentionedIds, type CommentStatus, type CommentThread } from "@/shared/docs-plus";
import type { GuestContext } from "../suite/guests";

export const PER_DOC_LIMIT = 500;
export const PENDING_CAP = 100;
type Row = typeof docComments.$inferSelect;
type DocRow = { id: string; orgId: string; title: string; projectId: string | null; createdById: string | null };

const isAdmin = (a: Pick<SuiteActor, "role">) => a.role === "owner" || a.role === "admin";
const canModerate = (a: SuiteActor, d: DocRow) => isAdmin(a) || (!!d.createdById && d.createdById === a.userId);

async function docOf(deps: Deps, orgId: string, id: string): Promise<DocRow> {
  const d = await deps.db.select({ id: docs.id, orgId: docs.orgId, title: docs.title, projectId: docs.projectId, createdById: docs.createdById }).from(docs)
    .where(and(eq(docs.orgId, orgId), eq(docs.id, id), isNull(docs.deletedAt))).get();
  if (!d) throw notFound("Doc");
  return d;
}

function cleanBody(body: unknown): string {
  const b = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!b) throw new HttpError(422, "validation_failed", "Write a comment first.");
  if (b.length > COMMENT_MAX) throw new HttpError(422, "validation_failed", `Comments can be up to ${COMMENT_MAX} characters.`);
  return b;
}

export function presentComment(r: Row, viewer: { userId?: string; guestId?: string; moderator?: boolean }) {
  const mine = (r.authorType === "member" && !!viewer.userId && r.authorId === viewer.userId) || (r.authorType === "guest" && !!viewer.guestId && r.authorId === viewer.guestId);
  return {
    id: r.id, thread: r.thread as CommentThread, body: r.body, status: r.status as CommentStatus,
    author: { type: r.authorType, name: r.authorName || (r.authorType === "visitor" ? "Visitor" : "Someone"), ...(viewer.moderator && r.authorEmail ? { email: r.authorEmail } : {}) },
    createdAt: r.createdAt.toISOString(), editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    mine, canEdit: mine && r.authorType !== "visitor", canRemove: mine || !!viewer.moderator,
  };
}
export type CommentOut = ReturnType<typeof presentComment>;

async function rowsFor(deps: Deps, orgId: string, docId: string, threads: CommentThread[], statuses?: CommentStatus[]) {
  return deps.db.select().from(docComments).where(and(eq(docComments.orgId, orgId), eq(docComments.docId, docId), isNull(docComments.deletedAt),
    inArray(docComments.thread, threads), statuses ? inArray(docComments.status, statuses) : undefined)).orderBy(asc(docComments.createdAt)).limit(PER_DOC_LIMIT);
}

/** Any share link of this doc with comments on (so the panel can show the public tab). */
async function publicOn(deps: Deps, orgId: string, docId: string) {
  const rows = await deps.db.select({ comments: shareLinks.comments, revokedAt: shareLinks.revokedAt, expiresAt: shareLinks.expiresAt }).from(shareLinks)
    .where(and(eq(shareLinks.orgId, orgId), eq(shareLinks.kind, "doc"), eq(shareLinks.targetId, docId))).limit(50);
  return rows.some((r) => r.comments === "on" && isActive(r, deps.now()));
}

export async function listForMember(deps: Deps, actor: SuiteActor, docId: string) {
  const d = await docOf(deps, actor.orgId, docId);
  const mod = canModerate(actor, d);
  const rows = await rowsFor(deps, actor.orgId, docId, ["team", "public"]);
  const v = { userId: actor.userId, moderator: mod };
  const team = rows.filter((r) => r.thread === "team" && (r.status === "visible" || mod)).map((r) => presentComment(r, v));
  const pub = rows.filter((r) => r.thread === "public" && (r.status === "visible" || mod)).map((r) => presentComment(r, v));
  return { team, public: pub, pending: rows.filter((r) => r.thread === "public" && r.status === "pending").length, canModerate: mod, publicOn: await publicOn(deps, actor.orgId, docId) };
}

async function memberPeople(deps: Deps, orgId: string) {
  return deps.db.select({ id: users.id, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.kind, "human"))).limit(500);
}

async function tellPeople(deps: Deps, d: DocRow, from: { id: string; name: string }, body: string, extra: string[] = []) {
  const people = await memberPeople(deps, d.orgId);
  const mentioned = mentionedIds(body, people).filter((id) => id !== from.id);
  for (const id of mentioned) await notify(deps, d.orgId, id, { type: "doc.mentioned", entityType: "doc", entityId: d.id, title: `${from.name} mentioned you on ${d.title}`, actorName: from.name });
  const others = new Set([...(d.createdById ? [d.createdById] : []), ...extra].filter((id) => id !== from.id && !mentioned.includes(id)));
  for (const id of others) await notify(deps, d.orgId, id, { type: "doc.commented", entityType: "doc", entityId: d.id, title: `${from.name} commented on ${d.title}`, actorName: from.name });
  return mentioned;
}

export async function addMemberComment(deps: Deps, actor: SuiteActor, docId: string, input: { body: string; thread?: CommentThread }) {
  assertWritable(actor);
  const d = await docOf(deps, actor.orgId, docId);
  const thread = input.thread ?? "team";
  if (thread === "public" && !canModerate(actor, d)) throw forbidden("Only owners, admins and the person who made this doc answer on the shared link.");
  const body = cleanBody(input.body);
  const now = deps.now();
  const id = sortableId("dcm", now.getTime());
  const name = actor.name || actor.email || "Someone";
  await deps.db.insert(docComments).values({ id, orgId: actor.orgId, docId, thread, authorType: "member", authorId: actor.userId, authorName: name.slice(0, 120), body, status: "visible", createdAt: now });
  const mentions = thread === "team" ? await tellPeople(deps, d, { id: actor.userId, name }, body) : [];
  if (mentions.length) await deps.db.update(docComments).set({ mentions: JSON.stringify(mentions) }).where(eq(docComments.id, id));
  const r = await deps.db.select().from(docComments).where(eq(docComments.id, id)).get();
  return presentComment(r!, { userId: actor.userId, moderator: canModerate(actor, d) });
}

async function commentRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(docComments).where(and(eq(docComments.orgId, orgId), eq(docComments.id, id), isNull(docComments.deletedAt))).get();
  if (!r) throw notFound("Comment");
  return r;
}

export async function changeComment(deps: Deps, actor: SuiteActor, id: string, patch: { body?: string; status?: CommentStatus }) {
  assertWritable(actor);
  const r = await commentRow(deps, actor.orgId, id);
  const d = await docOf(deps, actor.orgId, r.docId);
  const mod = canModerate(actor, d);
  const now = deps.now();
  if (patch.body !== undefined) {
    if (!(r.authorType === "member" && r.authorId === actor.userId)) throw forbidden("Only the author can edit a comment.");
    await deps.db.update(docComments).set({ body: cleanBody(patch.body), editedAt: now }).where(eq(docComments.id, id));
  }
  if (patch.status !== undefined) {
    if (!mod) throw forbidden("Only owners, admins and the person who made this doc review comments.");
    if (patch.status === "pending") throw new HttpError(422, "validation_failed", "A comment can be shown or hidden.");
    await deps.db.update(docComments).set({ status: patch.status, moderatedBy: actor.userId, moderatedAt: now }).where(eq(docComments.id, id));
  }
  return presentComment((await commentRow(deps, actor.orgId, id)), { userId: actor.userId, moderator: mod });
}

export async function removeComment(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const r = await commentRow(deps, actor.orgId, id);
  const d = await docOf(deps, actor.orgId, r.docId);
  const mine = r.authorType === "member" && r.authorId === actor.userId;
  if (!mine && !canModerate(actor, d)) throw forbidden("Only the author, an owner, an admin or the person who made this doc can remove a comment.");
  await deps.db.update(docComments).set({ deletedAt: deps.now(), moderatedBy: mine ? null : actor.userId }).where(eq(docComments.id, id));
  return { ok: true };
}

// ---------------------------------------------------------------- project guests

async function guestDocRow(deps: Deps, g: GuestContext, docId: string) {
  const d = await docOf(deps, g.guest.orgId, docId);
  if (d.projectId !== g.guest.projectId) throw notFound("Doc");
  return d;
}

export async function listForGuest(deps: Deps, g: GuestContext, docId: string) {
  await guestDocRow(deps, g, docId);
  const rows = await rowsFor(deps, g.guest.orgId, docId, ["team"], ["visible"]);
  return { team: rows.map((r) => presentComment(r, { guestId: g.guest.id })) };
}

export async function addGuestComment(deps: Deps, g: GuestContext, docId: string, body: string) {
  const d = await guestDocRow(deps, g, docId);
  const b = cleanBody(body);
  const now = deps.now();
  const id = sortableId("dcm", now.getTime());
  const name = g.guest.name || g.guest.email;
  await deps.db.insert(docComments).values({ id, orgId: d.orgId, docId, thread: "team", authorType: "guest", authorId: g.guest.id, authorName: `${name}`.slice(0, 120), body: b, status: "visible", createdAt: now });
  await tellPeople(deps, d, { id: `guest:${g.guest.id}`, name: `${name} (guest)` }, b);
  return presentComment((await commentRow(deps, d.orgId, id)), { guestId: g.guest.id });
}

// ---------------------------------------------------------------- share link visitors

export interface PublicThread { linkId: string; docId: string; orgId: string; tokenHash: string; comments: { name: string; body: string; createdAt: string; team: boolean }[] }

/** The public thread for a share link token, or null when the link is not active, not a doc or has comments off. */
export async function publicThread(deps: Deps, token: string): Promise<PublicThread | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await deps.db.select().from(shareLinks).where(eq(shareLinks.tokenHash, tokenHash)).get();
  if (!row || row.kind !== "doc" || row.comments !== "on" || !isActive(row, deps.now())) return null;
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, row.orgId)).get();
  if (!org || readMeta(org.metadata).shareLinks === false) return null;
  const rows = await rowsFor(deps, row.orgId, row.targetId, ["public"], ["visible"]);
  return { linkId: row.id, docId: row.targetId, orgId: row.orgId, tokenHash, comments: rows.map((r) => ({ name: r.authorName || "Visitor", body: r.body, createdAt: r.createdAt.toISOString(), team: r.authorType === "member" })) };
}

export async function addPublicComment(deps: Deps, t: PublicThread, input: { name: string; email?: string; body: string }) {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, PUBLIC_NAME_MAX);
  if (!name) throw new HttpError(422, "validation_failed", "Add your name.");
  const email = String(input.email ?? "").trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, "validation_failed", "That email does not look right.");
  const body = cleanBody(input.body);
  const d = await docOf(deps, t.orgId, t.docId);
  const waiting = await deps.db.select({ n: count() }).from(docComments).where(and(eq(docComments.orgId, t.orgId), eq(docComments.docId, t.docId), eq(docComments.status, "pending"), isNull(docComments.deletedAt))).get();
  if ((waiting?.n ?? 0) >= PENDING_CAP) throw new HttpError(429, "too_many", "Comments on this page are waiting for review. Try again later.");
  const now = deps.now();
  await deps.db.insert(docComments).values({ id: sortableId("dcm", now.getTime()), orgId: t.orgId, docId: t.docId, thread: "public", shareLinkId: t.linkId, authorType: "visitor", authorName: name, authorEmail: email || null, body, status: "pending", createdAt: now });
  if (d.createdById) await notify(deps, d.orgId, d.createdById, { type: "doc.commented", entityType: "doc", entityId: d.id, title: `A comment on ${d.title} is waiting for review`, actorName: name });
  return { ok: true };
}

/** Turns comments on or off for one share link (the person who made the link, an owner or an admin). */
export async function setLinkComments(deps: Deps, actor: SuiteActor, linkId: string, on: boolean) {
  assertWritable(actor);
  const row = await deps.db.select().from(shareLinks).where(and(eq(shareLinks.orgId, actor.orgId), eq(shareLinks.id, linkId))).get();
  if (!row || row.kind !== "doc") throw notFound("Share link");
  if (row.createdBy !== actor.userId && !isAdmin(actor)) throw forbidden("Only the person who made this link, an owner or an admin can change it.");
  await deps.db.update(shareLinks).set({ comments: on ? "on" : "off" }).where(eq(shareLinks.id, linkId));
  return { id: linkId, comments: on ? "on" : "off" };
}
