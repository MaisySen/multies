/**
 * R111: mail archive and retention (flag MAIL_ARCHIVE_R111). Safety rules, in order:
 *   1. Nothing is deleted for a workspace until one of ITS owners or admins turns a policy on, after a dry run count
 *      (the save must echo the count it was shown), and a 7 day grace has passed.
 *   2. A legal hold always wins: held mailboxes and held people's mail are never deleted, by the pass or by a person.
 *   3. Drafts and connected mailboxes (synced copies of mail that lives on the provider) are never touched.
 *   4. Every pass that deletes anything, every hold, search and case export is written to the audit log.
 */
import { Zip, ZipDeflate } from "fflate";
import { and, asc, desc, eq, isNotNull, isNull, lt, lte, ne, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { attachments, mailCases, mailConnections, mailLegalHolds, mailRetentionPolicies, mailboxAccess, mailboxes, members, messages, organizations, users } from "../../db/schema";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { inIds, notInIds } from "../../lib/sql-chunks";
import { audit } from "../audit";
import { scopeFor } from "../mail-access-priv1a";
import { toMboxEntry } from "../data-move/formats";
import {
  ARCHIVE_PAGE, CASE_EXPORT_MAX, MAX_ACTIVE_HOLDS, RETENTION_BATCH, RETENTION_INTERVAL_MS, cleanFilters, describeFilters, graceEnd, isStricter,
  retentionCutoff, safeZone, zoneMidnight,
  type ArchiveFilters, type ArchiveHit, type LegalHoldView, type MailCaseView, type RetentionPreview, type RetentionView,
} from "@/shared/mail-archive";
import { containsText } from "../../lib/like-search";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role">;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
export function requireArchiveAdmin(a: Pick<AuthContext, "role">) {
  if (!isAdmin(a)) throw forbidden("Only workspace owners and admins can manage mail archive and retention.");
}

async function orgZone(deps: Deps, orgId: string) {
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return safeZone(o?.tz);
}
async function policyRow(deps: Deps, orgId: string) {
  return deps.db.select().from(mailRetentionPolicies).where(eq(mailRetentionPolicies.orgId, orgId)).get();
}

/** What a hold protects: whole mailboxes, and people (every mailbox they can open plus mail they sent). */
export interface HeldScope { mailboxIds: string[]; userIds: string[]; active: number }
export async function heldScope(deps: Deps, orgId: string): Promise<HeldScope> {
  const holds = await deps.db.select({ kind: mailLegalHolds.kind, targetId: mailLegalHolds.targetId }).from(mailLegalHolds)
    .where(and(eq(mailLegalHolds.orgId, orgId), isNull(mailLegalHolds.releasedAt)));
  const userIds = [...new Set(holds.filter((h) => h.kind === "person").map((h) => h.targetId))];
  const boxes = new Set(holds.filter((h) => h.kind === "mailbox").map((h) => h.targetId));
  if (userIds.length) {
    const [access, own, roles] = await Promise.all([
      deps.db.select({ mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess)
        .where(and(eq(mailboxAccess.orgId, orgId), inIds(mailboxAccess.userId, userIds))),
      // PRIV1a: a person's own personal mailboxes (connected inboxes, free addresses) are theirs to hold too, also
      // after they left the workspace.
      deps.db.select({ id: mailboxes.id }).from(mailboxes)
        .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.personal, true), inIds(mailboxes.ownerUserId, userIds))),
      deps.db.select({ userId: members.userId, role: members.role }).from(members)
        .where(and(eq(members.organizationId, orgId), inIds(members.userId, userIds))),
    ]);
    for (const a of access) boxes.add(a.mailboxId);
    for (const o of own) boxes.add(o.id);
    // PRIV1b (P44): every mailbox the held person can open by the one rule (grants, role, shares), so a hold on a
    // delegate or an admin keeps the mail they can open. A person who left holds what they owned (above).
    const role = new Map(roles.map((r) => [r.userId, r.role as "owner" | "admin" | "member"]));
    for (const u of userIds) {
      if (!role.has(u)) continue;
      const scope = await scopeFor(deps.db, { orgId, userId: u, role: role.get(u) });
      if (scope) { for (const id of scope) boxes.add(id); continue; }
      const all = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.orgId, orgId));
      for (const r of all) boxes.add(r.id);
      break; // every mailbox is held: nothing more to add
    }
  }
  return { mailboxIds: [...boxes], userIds, active: holds.length };
}
const notHeldCond = (s: HeldScope): SQL | undefined => {
  const parts = [notInIds(messages.mailboxId, s.mailboxIds), s.userIds.length ? or(isNull(messages.sentByUserId), notInIds(messages.sentByUserId, s.userIds)) : undefined].filter(Boolean) as SQL[];
  return parts.length ? and(...parts) : undefined;
};
// PRIV1b (P58): team mailboxes only. Personal ones are skipped by the pass and left out of every preview count below.
async function connectedBoxes(deps: Deps, orgId: string) {
  return (await deps.db.select({ id: mailConnections.mailboxId }).from(mailConnections).innerJoin(mailboxes, eq(mailboxes.id, mailConnections.mailboxId))
    .where(and(eq(mailConnections.orgId, orgId), eq(mailboxes.personal, false)))).map((r) => r.id);
}

/**
 * Past the cutoff, not a draft, not in a personal mailbox: what a policy is about.
 * PRIV1b (P58): the Date header is the sender's word, so the stored receive time must be past the cutoff too.
 * Personal mailboxes are their owner's (the admin can't open them), so a workspace policy never deletes from them and
 * the preview never counts them (a hold plus a preview was a per mailbox count).
 */
const pastCond = (orgId: string, cutoff: Date) => and(eq(messages.orgId, orgId), lt(messages.date, cutoff), lt(messages.createdAt, cutoff), ne(messages.folder, "drafts"),
  sql`${messages.mailboxId} not in (select p.id from mailboxes p where p.org_id = ${orgId} and p.personal = 1)`);
async function countWhere(deps: Deps, where: SQL | undefined) {
  const r = await deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(where).get();
  return Number(r?.n ?? 0);
}

export async function retentionView(deps: Deps, auth: Actor): Promise<RetentionView> {
  const [row, timeZone] = await Promise.all([policyRow(deps, auth.orgId), orgZone(deps, auth.orgId)]);
  const enabled = !!row?.enabled && row.keepYears != null;
  const view: RetentionView = {
    enabled, keepYears: enabled ? row!.keepYears : null, startsAt: enabled ? iso(row!.startsAt) : null,
    lastRunAt: iso(row?.lastRunAt), lastRunDeleted: row?.lastRunDeleted ?? 0, totalDeleted: row?.totalDeleted ?? 0, timeZone, canManage: isAdmin(auth),
  };
  if (isAdmin(auth)) view.activeHolds = (await heldScope(deps, auth.orgId)).active;
  return view;
}

/** The dry run: how many messages a policy of keepYears would delete today, and how many it would leave. */
export async function previewRetention(deps: Deps, auth: Actor, keepYears: number | null): Promise<RetentionPreview> {
  requireArchiveAdmin(auth);
  const now = deps.now();
  const cutoff = retentionCutoff(now, keepYears, await orgZone(deps, auth.orgId));
  const row = await policyRow(deps, auth.orgId);
  const prev = { enabled: !!row?.enabled, keepYears: row?.keepYears ?? null };
  const startsAt = keepYears == null ? null : isStricter(prev, { enabled: true, keepYears }) ? graceEnd(now) : (row?.startsAt ?? graceEnd(now));
  if (!cutoff) return { keepYears: null, cutoff: null, eligible: 0, heldBack: 0, connectedSkipped: 0, startsAt: null };
  const [scope, connected] = await Promise.all([heldScope(deps, auth.orgId), connectedBoxes(deps, auth.orgId)]);
  const past = pastCond(auth.orgId, cutoff);
  const [eligible, notConnected, connectedSkipped] = await Promise.all([
    countWhere(deps, and(past, notInIds(messages.mailboxId, connected), notHeldCond(scope))),
    countWhere(deps, and(past, notInIds(messages.mailboxId, connected))),
    connected.length ? countWhere(deps, and(past, inIds(messages.mailboxId, connected))) : Promise.resolve(0),
  ]);
  return { keepYears, cutoff: cutoff.toISOString(), eligible, heldBack: notConnected - eligible, connectedSkipped, startsAt: iso(startsAt) };
}

export interface PolicyInput { enabled: boolean; keepYears: number | null; confirmEligible?: number }
/**
 * Saves the policy. Turning it on (or making it stricter) needs the dry run count the admin was shown: when the mail
 * changed since, 409 with the new count, and nothing is saved.
 */
export async function savePolicy(deps: Deps, auth: Actor, input: PolicyInput): Promise<RetentionView> {
  requireArchiveAdmin(auth);
  const now = deps.now();
  const row = await policyRow(deps, auth.orgId);
  const prev = { enabled: !!row?.enabled && row?.keepYears != null, keepYears: row?.keepYears ?? null };
  const on = input.enabled && input.keepYears != null;
  const next = { enabled: on, keepYears: on ? input.keepYears : null };
  let startsAt: Date | null = row?.startsAt ?? null;
  if (on) {
    const preview = await previewRetention(deps, auth, next.keepYears);
    if (input.confirmEligible === undefined || input.confirmEligible !== preview.eligible) {
      throw new HttpError(409, "count_changed", "The number of messages this would delete has changed. Check the new count and confirm again.", { preview });
    }
    if (isStricter(prev, next) || !startsAt) startsAt = graceEnd(now);
  } else startsAt = null;
  const values = { enabled: on, keepYears: next.keepYears, startsAt, enabledAt: on ? (prev.enabled ? (row?.enabledAt ?? now) : now) : null, updatedBy: auth.userId || null, updatedAt: now, backlog: false };
  await deps.db.insert(mailRetentionPolicies).values({ orgId: auth.orgId, ...values })
    .onConflictDoUpdate({ target: mailRetentionPolicies.orgId, set: values });
  await audit(deps.db, {
    orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null,
    action: on ? (prev.enabled ? "mail.retention.changed" : "mail.retention.enabled") : "mail.retention.disabled",
    targetType: "retention_policy", targetId: auth.orgId,
    metadata: { keepYears: next.keepYears, previousKeepYears: prev.keepYears, startsAt: iso(startsAt), dryRunCount: on ? input.confirmEligible : undefined },
  });
  return retentionView(deps, auth);
}

/** One retention pass for one workspace: up to RETENTION_BATCH messages, never held, never drafts, never synced copies. */
export async function runRetentionForOrg(deps: Deps, orgId: string): Promise<{ deleted: number; skipped?: string }> {
  const now = deps.now();
  const row = await policyRow(deps, orgId);
  // Rule 1: only an explicit policy, switched on by that workspace, past its grace.
  if (!deps.config.mailArchive) return { deleted: 0, skipped: "flag_off" };
  if (!row || !row.enabled || row.keepYears == null) return { deleted: 0, skipped: "no_policy" };
  if (!row.startsAt || row.startsAt > now) return { deleted: 0, skipped: "grace" };
  const cutoff = retentionCutoff(now, row.keepYears, await orgZone(deps, orgId));
  if (!cutoff) return { deleted: 0, skipped: "no_policy" };
  const [scope, connected] = await Promise.all([heldScope(deps, orgId), connectedBoxes(deps, orgId)]);
  const rows = await deps.db.select({ id: messages.id, mailboxId: messages.mailboxId, sizeBytes: messages.sizeBytes }).from(messages)
    .where(and(pastCond(orgId, cutoff), notInIds(messages.mailboxId, connected), notHeldCond(scope)))
    .orderBy(asc(messages.date)).limit(RETENTION_BATCH);
  const perBox: Record<string, { n: number; bytes: number }> = {};
  for (let i = 0; i < rows.length; i += 50) {
    const part = rows.slice(i, i + 50);
    const ids = part.map((r) => r.id);
    // PRIV1b (P58): large attachments live in the body store; read their keys before the rows (and the attachment
    // rows, by foreign key) go, then delete the blobs. A failed blob delete never stops the pass.
    const blobs = deps.bodyStore ? await deps.db.select({ key: attachments.storageKey }).from(attachments).where(and(inIds(attachments.messageId, ids), isNotNull(attachments.storageKey))) : [];
    await deps.db.delete(messages).where(and(eq(messages.orgId, orgId), inIds(messages.id, ids)));
    for (const r of part) { const b = (perBox[r.mailboxId] ??= { n: 0, bytes: 0 }); b.n++; b.bytes += Math.max(0, r.sizeBytes); }
    for (const b of blobs) if (b.key) await deps.bodyStore!.delete(b.key).catch((err) => deps.reportError?.(err, { where: "mail.retention.blob", orgId }));
  }
  for (const [id, b] of Object.entries(perBox)) {
    await deps.db.update(mailboxes).set({ usedBytes: sql`max(0, ${mailboxes.usedBytes} - ${b.bytes})` }).where(eq(mailboxes.id, id));
  }
  await deps.db.update(mailRetentionPolicies).set({ lastRunAt: now, lastRunDeleted: rows.length, totalDeleted: sql`${mailRetentionPolicies.totalDeleted} + ${rows.length}`, backlog: rows.length >= RETENTION_BATCH })
    .where(eq(mailRetentionPolicies.orgId, orgId));
  if (rows.length) {
    await audit(deps.db, {
      orgId, action: "mail.retention.deleted", targetType: "retention_policy", targetId: orgId,
      metadata: { count: rows.length, keepYears: row.keepYears, cutoff: cutoff.toISOString(), mailboxes: Object.fromEntries(Object.entries(perBox).map(([k, v]) => [k, v.n])), holdsActive: scope.active },
    });
  }
  return { deleted: rows.length };
}

/** The cron pass: workspaces with a policy on, past grace, due (a day since the last pass, or a backlog left). */
export async function runRetentionPass(deps: Deps, opts: { maxOrgs?: number } = {}) {
  if (!deps.config.mailArchive) return { orgs: 0, deleted: 0 };
  const now = deps.now();
  const due = await deps.db.select({ orgId: mailRetentionPolicies.orgId }).from(mailRetentionPolicies)
    .where(and(eq(mailRetentionPolicies.enabled, true), lte(mailRetentionPolicies.startsAt, now),
      or(isNull(mailRetentionPolicies.lastRunAt), lt(mailRetentionPolicies.lastRunAt, new Date(now.getTime() - RETENTION_INTERVAL_MS)), eq(mailRetentionPolicies.backlog, true))))
    // PRIV1b (P58): never run first, then the longest waiting, so a backlog or a failing workspace can't starve the rest.
    .orderBy(sql`${mailRetentionPolicies.lastRunAt} is not null`, asc(mailRetentionPolicies.lastRunAt))
    .limit(opts.maxOrgs ?? 5);
  let deleted = 0;
  for (const d of due) {
    // PRIV1b (P58): a failed or skipped pass still counts as a run, so the workspace goes to the back of the queue.
    let ran = false;
    try {
      const r = await runRetentionForOrg(deps, d.orgId);
      deleted += r.deleted; ran = !r.skipped;
    } catch (err) { deps.reportError?.(err, { where: "mail.retention", orgId: d.orgId }); }
    if (!ran) await deps.db.update(mailRetentionPolicies).set({ lastRunAt: now }).where(eq(mailRetentionPolicies.orgId, d.orgId)).catch(() => undefined);
  }
  return { orgs: due.length, deleted };
}

/** Guard for every person driven permanent delete: 409 when any (non draft) message is under a legal hold. */
export async function assertNotHeld(deps: Deps, orgId: string, rows: { mailboxId: string; folder: string; sentByUserId?: string | null }[]) {
  if (!deps.config.mailArchive) return;
  const kept = rows.filter((r) => r.folder !== "drafts");
  if (!kept.length) return;
  const s = await heldScope(deps, orgId);
  if (!s.active) return;
  if (kept.some((r) => s.mailboxIds.includes(r.mailboxId) || (!!r.sentByUserId && s.userIds.includes(r.sentByUserId)))) {
    throw new HttpError(409, "legal_hold", "This mail is on legal hold, so it can't be deleted. An admin can lift the hold in Settings, Archive and retention.");
  }
}
export async function assertMailboxNotHeld(deps: Deps, orgId: string, mailboxId: string) {
  if (!deps.config.mailArchive) return;
  const s = await heldScope(deps, orgId);
  if (s.mailboxIds.includes(mailboxId)) throw new HttpError(409, "legal_hold", "This mailbox is on legal hold, so it can't be deleted or removed. Lift the hold first.");
}

/* ---------- Legal holds ---------- */

async function labelTargets(deps: Deps, orgId: string, holds: { kind: string; targetId: string }[]) {
  const boxIds = holds.filter((h) => h.kind === "mailbox").map((h) => h.targetId);
  const userIds = holds.filter((h) => h.kind === "person").map((h) => h.targetId);
  const [boxes, people] = await Promise.all([
    boxIds.length ? deps.db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inIds(mailboxes.id, boxIds))) : Promise.resolve([]),
    userIds.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, userIds)) : Promise.resolve([]),
  ]);
  const map = new Map<string, string>();
  for (const b of boxes) map.set(`mailbox:${b.id}`, b.address);
  for (const p of people) map.set(`person:${p.id}`, p.name ? `${p.name} (${p.email})` : p.email);
  return map;
}
export async function listHolds(deps: Deps, auth: Actor): Promise<{ holds: LegalHoldView[] }> {
  requireArchiveAdmin(auth);
  const rows = await deps.db.select().from(mailLegalHolds).where(eq(mailLegalHolds.orgId, auth.orgId)).orderBy(desc(mailLegalHolds.createdAt)).limit(200);
  const names = await labelTargets(deps, auth.orgId, rows);
  const people = await labelTargets(deps, auth.orgId, rows.flatMap((r) => [r.createdBy, r.releasedBy].filter(Boolean).map((id) => ({ kind: "person", targetId: id! }))));
  const who = (id: string | null) => (id ? (people.get(`person:${id}`) ?? null) : null);
  return {
    holds: rows.map((r) => ({
      id: r.id, kind: r.kind, targetId: r.targetId, targetLabel: names.get(`${r.kind}:${r.targetId}`) ?? (r.kind === "mailbox" ? "Removed mailbox" : "Former member"),
      name: r.name, note: r.note, createdBy: who(r.createdBy), createdAt: iso(r.createdAt)!, releasedAt: iso(r.releasedAt), releasedBy: who(r.releasedBy),
    })),
  };
}
export async function placeHold(deps: Deps, auth: Actor, input: { kind: "mailbox" | "person"; targetId: string; name: string; note?: string | null }) {
  requireArchiveAdmin(auth);
  const name = input.name.trim();
  if (!name) throw badRequest("Give the hold a name, for example the matter or case it is for.");
  if (input.kind === "mailbox") {
    const mb = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, input.targetId), eq(mailboxes.orgId, auth.orgId))).get();
    if (!mb) throw notFound("Mailbox");
  } else {
    const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, auth.orgId), eq(members.userId, input.targetId), eq(members.kind, "human"))).get();
    if (!m) throw notFound("Person");
  }
  const active = await deps.db.select({ id: mailLegalHolds.id, kind: mailLegalHolds.kind, targetId: mailLegalHolds.targetId }).from(mailLegalHolds)
    .where(and(eq(mailLegalHolds.orgId, auth.orgId), isNull(mailLegalHolds.releasedAt)));
  if (active.some((h) => h.kind === input.kind && h.targetId === input.targetId)) throw conflict(input.kind === "mailbox" ? "This mailbox is already on hold." : "This person is already on hold.");
  if (active.length >= MAX_ACTIVE_HOLDS) throw conflict(`A workspace can have up to ${MAX_ACTIVE_HOLDS} active holds. Lift one you no longer need first.`);
  const id = newId("hold");
  await deps.db.insert(mailLegalHolds).values({ id, orgId: auth.orgId, kind: input.kind, targetId: input.targetId, name: name.slice(0, 120), note: input.note?.trim().slice(0, 1000) || null, createdBy: auth.userId || null, createdAt: deps.now() });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.hold.placed", targetType: "legal_hold", targetId: id, metadata: { kind: input.kind, target: input.targetId, name } });
  return (await listHolds(deps, auth)).holds.find((h) => h.id === id)!;
}
export async function releaseHold(deps: Deps, auth: Actor, id: string) {
  requireArchiveAdmin(auth);
  const h = await deps.db.select().from(mailLegalHolds).where(and(eq(mailLegalHolds.id, id), eq(mailLegalHolds.orgId, auth.orgId))).get();
  if (!h) throw notFound("Hold");
  if (h.releasedAt) throw conflict("This hold was already lifted.");
  await deps.db.update(mailLegalHolds).set({ releasedAt: deps.now(), releasedBy: auth.userId || null }).where(eq(mailLegalHolds.id, id));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.hold.released", targetType: "legal_hold", targetId: id, metadata: { kind: h.kind, target: h.targetId, name: h.name } });
  return (await listHolds(deps, auth)).holds.find((x) => x.id === id)!;
}

/* ---------- Search and cases ---------- */

/** LK1: a contains match with no 50 byte LIKE pattern limit. */
const like = (col: SQLWrapper, s: string) => containsText(col, s);
function dayStart(dateIso: string, tz: string) {
  const [y, m, d] = dateIso.split("-").map(Number);
  return zoneMidnight(y!, m!, d!, tz);
}
async function filterCond(deps: Deps, auth: Actor, f: ArchiveFilters): Promise<SQL | undefined> {
  const orgId = auth.orgId;
  const [tz, scope] = await Promise.all([orgZone(deps, orgId), scopeFor(deps.db, auth)]);
  // PRIV1a (MB-366): the archive search and case exports never reach someone else's personal mailbox. A logged,
  // owner notified compliance search is a later round.
  const c: (SQL | undefined)[] = [eq(messages.orgId, orgId), ne(messages.folder, "drafts"), scope ? inIds(messages.mailboxId, scope) : undefined];
  if (f.q) c.push(or(like(messages.subject, f.q), like(messages.snippet, f.q), like(messages.fromAddress, f.q), like(messages.fromName, f.q)));
  if (f.from) c.push(or(like(messages.fromAddress, f.from), like(messages.fromName, f.from)));
  if (f.to) c.push(or(like(messages.to, f.to), like(messages.cc, f.to)));
  if (f.mailboxId) c.push(eq(messages.mailboxId, f.mailboxId));
  if (f.folder) c.push(eq(messages.folder, f.folder));
  if (f.after) c.push(sql`${messages.date} >= ${dayStart(f.after, tz).getTime()}`);
  if (f.before) c.push(lt(messages.date, dayStart(f.before, tz)));
  if (f.hasAttachments) c.push(eq(messages.hasAttachments, true));
  return and(...c);
}
const parseAddrs = (json: string) => { try { return (JSON.parse(json) as (string | { address?: string })[]).map((a) => (typeof a === "string" ? a : a.address ?? "")).filter(Boolean); } catch { return []; } };

export async function searchArchive(deps: Deps, auth: Actor, filters: ArchiveFilters, cursor?: string) {
  requireArchiveAdmin(auth);
  const f = cleanFilters(filters);
  if (f.after && f.before && f.after >= f.before) throw badRequest("The start date must be before the end date.");
  let where = await filterCond(deps, auth, f);
  if (cursor) {
    const m = /^(\d{1,15})_([A-Za-z0-9_]{1,64})$/.exec(cursor);
    if (!m) throw badRequest("That page link is not valid. Search again.");
    const at = new Date(Number(m[1]));
    where = and(where, or(lt(messages.date, at), and(eq(messages.date, at), lt(messages.id, m[2]!))));
  }
  const rows = await deps.db.select({
    id: messages.id, mailboxId: messages.mailboxId, folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName, to: messages.to,
    subject: messages.subject, snippet: messages.snippet, date: messages.date, hasAttachments: messages.hasAttachments, sentByUserId: messages.sentByUserId, address: mailboxes.address,
  }).from(messages).innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId)).where(where).orderBy(desc(messages.date), desc(messages.id)).limit(ARCHIVE_PAGE + 1);
  const page = rows.slice(0, ARCHIVE_PAGE);
  const scope = await heldScope(deps, auth.orgId);
  const hits: ArchiveHit[] = page.map((r) => ({
    id: r.id, mailbox: r.address, folder: r.folder, fromAddress: r.fromAddress, fromName: r.fromName, to: parseAddrs(r.to), subject: r.subject, snippet: r.snippet,
    date: iso(r.date)!, hasAttachments: r.hasAttachments, held: scope.mailboxIds.includes(r.mailboxId) || (!!r.sentByUserId && scope.userIds.includes(r.sentByUserId)),
  }));
  const last = page[page.length - 1];
  const next = rows.length > ARCHIVE_PAGE && last ? `${new Date(last.date).getTime()}_${last.id}` : null;
  if (!cursor) {
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.archive.searched", targetType: "mail_archive", metadata: { filters: f, firstPage: hits.length } });
  }
  return { hits, next };
}

function caseView(r: typeof mailCases.$inferSelect, who: Map<string, string>): MailCaseView {
  let filters: ArchiveFilters = {};
  try { filters = JSON.parse(r.filters) as ArchiveFilters; } catch { /* stored by us; empty on damage */ }
  return { id: r.id, name: r.name, filters, createdBy: r.createdBy ? (who.get(`person:${r.createdBy}`) ?? null) : null, createdAt: iso(r.createdAt)!, lastExportedAt: iso(r.lastExportedAt), exportCount: r.exportCount };
}
export async function listCases(deps: Deps, auth: Actor) {
  requireArchiveAdmin(auth);
  const rows = await deps.db.select().from(mailCases).where(eq(mailCases.orgId, auth.orgId)).orderBy(desc(mailCases.createdAt)).limit(100);
  const who = await labelTargets(deps, auth.orgId, rows.filter((r) => r.createdBy).map((r) => ({ kind: "person", targetId: r.createdBy! })));
  return { cases: rows.map((r) => caseView(r, who)) };
}
export async function createCase(deps: Deps, auth: Actor, input: { name: string; filters: ArchiveFilters }) {
  requireArchiveAdmin(auth);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw badRequest("Give the case a name.");
  const f = cleanFilters(input.filters);
  if (f.mailboxId) {
    const mb = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, f.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
    if (!mb) throw notFound("Mailbox");
  }
  const id = newId("case");
  await deps.db.insert(mailCases).values({ id, orgId: auth.orgId, name, filters: JSON.stringify(f), createdBy: auth.userId || null, createdAt: deps.now() });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.case.created", targetType: "mail_case", targetId: id, metadata: { name, filters: f } });
  return (await listCases(deps, auth)).cases.find((c) => c.id === id)!;
}
export async function deleteCase(deps: Deps, auth: Actor, id: string) {
  requireArchiveAdmin(auth);
  const r = await deps.db.select().from(mailCases).where(and(eq(mailCases.id, id), eq(mailCases.orgId, auth.orgId))).get();
  if (!r) throw notFound("Case");
  await deps.db.delete(mailCases).where(eq(mailCases.id, id));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.case.deleted", targetType: "mail_case", targetId: id, metadata: { name: r.name } });
}

const enc = new TextEncoder();
const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const caseFileName = (name: string, day: string) => `case-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "export"}-${day}.zip`;

/** Loads a case for export (admin only, 404 for another workspace's case). */
export async function caseForExport(deps: Deps, auth: Actor, id: string) {
  requireArchiveAdmin(auth);
  const r = await deps.db.select().from(mailCases).where(and(eq(mailCases.id, id), eq(mailCases.orgId, auth.orgId))).get();
  if (!r) throw notFound("Case");
  return caseView(r, new Map());
}

/**
 * The case as a ZIP: mail.mbox (any desktop mail app opens it), messages.csv (one line per message), manifest.json
 * (filters, counts, who and when) and README.txt. Up to CASE_EXPORT_MAX messages, newest first; the manifest says
 * when there were more. Audit logged when it finishes.
 */
export function exportCase(deps: Deps, auth: Actor, kase: MailCaseView): ReadableStream<Uint8Array> {
  requireArchiveAdmin(auth);
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        zip = new Zip((err, chunk, final) => { if (err) { controller.error(err); return; } controller.enqueue(chunk); if (final) controller.close(); });
        const file = (name: string) => { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); return f; };
        const where = await filterCond(deps, auth, kase.filters);
        const total = await countWhere(deps, where);
        const mbox = file("mail.mbox");
        const csv = file("messages.csv");
        csv.push(enc.encode("date,mailbox,folder,from,to,cc,subject,message_id,attachments\r\n"));
        const boxes = new Map((await deps.db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.orgId, auth.orgId))).map((b) => [b.id, b.address]));
        let written = 0;
        let cursor: { date: Date; id: string } | null = null;
        while (written < CASE_EXPORT_MAX) {
          const page: (typeof messages.$inferSelect)[] = await deps.db.select().from(messages)
            .where(cursor ? and(where, or(lt(messages.date, cursor.date), and(eq(messages.date, cursor.date), lt(messages.id, cursor.id)))) : where)
            .orderBy(desc(messages.date), desc(messages.id)).limit(Math.min(100, CASE_EXPORT_MAX - written));
          if (!page.length) break;
          const atts = await deps.db.select({ messageId: attachments.messageId, filename: attachments.filename }).from(attachments).where(inIds(attachments.messageId, page.map((m) => m.id)));
          mbox.push(enc.encode(page.map((m) => toMboxEntry({ ...m, createdAt: m.date })).join("")));
          csv.push(enc.encode(page.map((m) => [
            new Date(m.date).toISOString(), boxes.get(m.mailboxId) ?? "", m.folder, m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
            parseAddrs(m.to).join("; "), parseAddrs(m.cc).join("; "), m.subject, m.messageIdHeader ?? "", atts.filter((a) => a.messageId === m.id).map((a) => a.filename).join("; "),
          ].map(csvCell).join(",")).join("\r\n") + "\r\n"));
          written += page.length;
          const last = page[page.length - 1]!;
          cursor = { date: new Date(last.date), id: last.id };
          if (page.length < 100) break;
        }
        mbox.push(new Uint8Array(0), true);
        csv.push(new Uint8Array(0), true);
        const at = deps.now();
        const manifest = file("manifest.json");
        manifest.push(enc.encode(JSON.stringify({
          case: kase.name, caseId: kase.id, filters: kase.filters, filtersInWords: describeFilters(kase.filters, (id) => boxes.get(id)),
          matched: total, exported: written, truncated: total > written, exportedAt: at.toISOString(), exportedBy: auth.email,
          files: { "mail.mbox": "Every message in mbox format, newest first.", "messages.csv": "One line per message: date, mailbox, folder, sender, recipients, subject, Message-ID and attachment names." },
        }, null, 2)), true);
        const readme = file("README.txt");
        readme.push(enc.encode(`Case export: ${kase.name}\r\n\r\nmail.mbox opens in any desktop mail app (import an mbox file).\r\nmessages.csv lists every message in the export.\r\nmanifest.json records the search, the counts, who exported it and when.\r\n${total > written ? `\r\nThis search matched ${total} messages; the first ${written} (newest first) are included. Narrow the search to export the rest.\r\n` : ""}`), true);
        await deps.db.update(mailCases).set({ lastExportedAt: at, exportCount: sql`${mailCases.exportCount} + 1` }).where(eq(mailCases.id, kase.id));
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "mail.case.exported", targetType: "mail_case", targetId: kase.id, metadata: { name: kase.name, matched: total, exported: written } });
        zip.end();
      } catch (err) {
        deps.reportError?.(err, { where: "mail.case.export" });
        controller.error(err);
      }
    },
    cancel() { zip?.terminate(); },
  });
}

/** Targets an admin can put on hold: the workspace's mailboxes and its people. */
export async function holdTargets(deps: Deps, auth: Actor) {
  requireArchiveAdmin(auth);
  const [boxes, people] = await Promise.all([
    deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName }).from(mailboxes).where(eq(mailboxes.orgId, auth.orgId)).orderBy(asc(mailboxes.address)).limit(500),
    deps.db.select({ id: users.id, name: users.name, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, auth.orgId), eq(members.kind, "human"))).orderBy(asc(users.name)).limit(500),
  ]);
  return { mailboxes: boxes, people };
}
