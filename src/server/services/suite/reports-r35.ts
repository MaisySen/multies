/**
 * R35 (Apple guideline 1.2, user generated content): reports and blocks.
 *
 * Reports: anyone signed in can report a chat message (channel, thread, DM or meeting chat) or a person they share a
 * workspace with. A message report copies the text and author at report time, so a later edit or delete does not
 * change what the operator reviews. 20 reports per person per day. The operator queue lives in the operator console
 * (routes/reports-r35.ts, /api/admin/reports) and the operator is mailed at most once per 15 minutes.
 *
 * Blocks: A blocks B. Every chat read A makes leaves out B's messages on the server (notBlockedBy below is the one
 * SQL condition every read path adds), B cannot open or send a DM that has A in it (403 blocked), and B's mentions
 * and replies do not notify A. B is never told. A block covers every workspace they share.
 */
import { and, count, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Deps } from "../../context";
import { appSettings, chatChannels, chatMembers, chatMessages, contentReports, members, userBlocks, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { sortableId, type SuiteActor } from "./common";

export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "self_harm", "other"] as const;
export const REPORT_CONTEXTS = ["chat", "meeting", "dm"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORTS_PER_DAY = 20;
export const REPORT_MAIL_EVERY_MS = 15 * 60_000;
export const BLOCKED_DM_MESSAGE = "You can't message this person.";

const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);
const notFound = (what = "Not found") => new HttpError(404, "not_found", what === "Not found" ? what : `${what} not found.`);

function person(a: SuiteActor) {
  if (isKey(a) && !a.userId) throw new HttpError(403, "forbidden", "Reports and blocks belong to a person.");
  if (!a.userId) throw new HttpError(401, "unauthorized", "Sign in first.");
  return a.userId;
}

/**
 * The one condition every chat read adds: leave out messages whose author the viewer blocked. A subquery, so it
 * costs one index probe per row and keeps paging exact. Null viewer (API keys, guests): no condition.
 */
export function notBlockedBy(authorCol: AnySQLiteColumn, viewerId: string | null | undefined): SQL | undefined {
  if (!viewerId) return undefined;
  return sql`coalesce(${authorCol}, '') not in (select ${userBlocks.blockedUserId} from ${userBlocks} where ${userBlocks.blockerUserId} = ${viewerId})`;
}

/** The people this viewer blocked, as a set (small: one indexed read). */
export async function blockedIds(deps: Deps, viewerId: string | null | undefined): Promise<Set<string>> {
  if (!viewerId) return new Set();
  const rows = await deps.db.select({ id: userBlocks.blockedUserId }).from(userBlocks).where(eq(userBlocks.blockerUserId, viewerId));
  return new Set(rows.map((r) => r.id));
}

/** Of these people, the ones who blocked `authorId` (for notifications and DMs). */
export async function whoBlocked(deps: Deps, authorId: string | null | undefined, userIds: string[]): Promise<Set<string>> {
  if (!authorId || !userIds.length) return new Set();
  const rows = await deps.db.select({ id: userBlocks.blockerUserId }).from(userBlocks)
    .where(and(eq(userBlocks.blockedUserId, authorId), inArray(userBlocks.blockerUserId, userIds.slice(0, 90))));
  return new Set(rows.map((r) => r.id));
}

/** Everyone who blocked this author (small; the user_blocks_blocked_idx index). */
export async function blockersOf(deps: Deps, authorId: string | null | undefined): Promise<Set<string>> {
  if (!authorId) return new Set();
  const rows = await deps.db.select({ id: userBlocks.blockerUserId }).from(userBlocks).where(eq(userBlocks.blockedUserId, authorId));
  return new Set(rows.map((r) => r.id));
}

/** A DM (or a DM about to open) that has someone in it who blocked the sender: 403, and the sender is not told why beyond this. */
export async function assertNotBlockedInDm(deps: Deps, senderId: string | null | undefined, memberIds: string[]) {
  if (!senderId) return;
  const others = memberIds.filter((u) => u !== senderId);
  if ((await whoBlocked(deps, senderId, others)).size) throw new HttpError(403, "blocked", BLOCKED_DM_MESSAGE);
}

/** Members of a DM channel, then the same check. */
export async function assertCanPostInDm(deps: Deps, channel: { id: string; kind: string }, senderId: string | null | undefined) {
  if (channel.kind !== "dm" || !senderId) return;
  const ids = (await deps.db.select({ u: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, channel.id))).map((r) => r.u);
  await assertNotBlockedInDm(deps, senderId, ids);
}

// ---------------------------------------------------------------- blocks

export async function listBlocks(deps: Deps, a: SuiteActor) {
  const me = person(a);
  const rows = await deps.db.select({ userId: userBlocks.blockedUserId, name: users.name, avatarUrl: users.image, createdAt: userBlocks.createdAt })
    .from(userBlocks).innerJoin(users, eq(users.id, userBlocks.blockedUserId))
    .where(eq(userBlocks.blockerUserId, me)).orderBy(desc(userBlocks.createdAt)).limit(500);
  return { blocks: rows.map((r) => ({ userId: r.userId, name: r.name, avatarUrl: r.avatarUrl ?? null, createdAt: r.createdAt.toISOString() })) };
}

/** Blocks a person. Essential write (one row). Idempotent: created false when already blocked. */
export async function addBlock(deps: Deps, a: SuiteActor, userId: string) {
  const me = person(a);
  if (userId === me) throw new HttpError(400, "validation_failed", "You can't block yourself.");
  const u = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("Person");
  const res = await deps.db.insert(userBlocks).values({ blockerUserId: me, blockedUserId: userId, createdAt: deps.now() }).onConflictDoNothing().returning({ id: userBlocks.blockedUserId });
  return { created: res.length > 0, ...(await listBlocks(deps, a)) };
}

/** Unblocks. Essential write. Unblocking someone not blocked is fine (204 either way). */
export async function removeBlock(deps: Deps, a: SuiteActor, userId: string) {
  const me = person(a);
  const [had] = await deps.db.select({ id: userBlocks.blockedUserId }).from(userBlocks).where(and(eq(userBlocks.blockerUserId, me), eq(userBlocks.blockedUserId, userId))).limit(1);
  if (!had) throw new HttpError(404, "not_found", "You haven't blocked this person.");
  await deps.db.delete(userBlocks).where(and(eq(userBlocks.blockerUserId, me), eq(userBlocks.blockedUserId, userId)));
  return { ok: true };
}

/** Adds blockedByMe to user shaped rows ({ id } or { userId }), for member lists and profile cards. */
export async function withBlockedByMe<T extends { id?: string; userId?: string }>(deps: Deps, viewerId: string | null | undefined, rows: T[]) {
  const set = await blockedIds(deps, viewerId);
  return rows.map((r) => ({ ...r, blockedByMe: set.has((r.userId ?? r.id ?? "").replace(/^member:/, "")) }));
}

// ---------------------------------------------------------------- reports

export interface ReportInput {
  targetType: "message" | "user"; messageId?: string; userId?: string; context?: (typeof REPORT_CONTEXTS)[number]; reason: ReportReason; note?: string;
}

async function sharesWorkspace(deps: Deps, me: string, other: string) {
  const row = await deps.db.select({ n: count() }).from(members)
    .where(and(eq(members.userId, other), sql`${members.organizationId} in (select ${members.organizationId} from ${members} where ${members.userId} = ${me})`)).get();
  return (row?.n ?? 0) > 0;
}

/** Files a report. Essential write (one row, plus at most one app_settings row per 15 minutes for the operator mail). */
export async function createReport(deps: Deps, a: SuiteActor, input: ReportInput, opts: { id?: string; retry?: boolean } = {}) {
  const me = person(a);
  // R54 (MB-239): a retry under the same Idempotency-Key whose first attempt filed the report answers as the first
  // attempt would have, with no second report and no second mail to the team (one read, only on a retry).
  if (opts.id && opts.retry && await deps.db.select({ id: contentReports.id }).from(contentReports).where(and(eq(contentReports.id, opts.id), eq(contentReports.reporterUserId, me))).get()) return { id: opts.id, status: "open" as const };
  const now = deps.now();
  const recent = await deps.db.select({ n: count() }).from(contentReports)
    .where(and(eq(contentReports.reporterUserId, me), gt(contentReports.createdAt, new Date(now.getTime() - 24 * 3600_000)))).get();
  if ((recent?.n ?? 0) >= REPORTS_PER_DAY) throw new HttpError(429, "rate_limited", "You've sent a lot of reports today. Our team is on them; try again tomorrow, or write to contact@fintex.au.");
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  let row: typeof contentReports.$inferInsert;
  const id = opts.id ?? sortableId("rpt", now.getTime());
  if (input.targetType === "message") {
    if (!input.messageId) throw new HttpError(422, "validation_failed", "Say which message.");
    const m = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.orgId, a.orgId), eq(chatMessages.id, input.messageId))).get();
    if (!m) throw notFound("Message");
    const { visibleChannel } = await import("./chat");
    let channel: typeof chatChannels.$inferSelect;
    try { channel = await visibleChannel(deps, a, m.channelId); } catch { throw notFound("Message"); }
    if (m.authorType === "member" && m.authorId === me) throw notFound("Message");
    const context = input.context ?? (channel.kind === "dm" ? "dm" : "chat");
    row = {
      id, reporterUserId: me, orgId: a.orgId, targetType: "message", messageId: m.id, targetUserId: m.authorType === "member" ? m.authorId : null, context, reason: input.reason, note,
      snapshotText: m.body.slice(0, 4000), snapshotAuthorId: m.authorId ?? null, createdAt: now,
    };
  } else {
    if (!input.userId || input.userId === me) throw notFound("Person");
    if (!(await sharesWorkspace(deps, me, input.userId))) throw notFound("Person");
    row = { id, reporterUserId: me, orgId: a.orgId, targetType: "user", targetUserId: input.userId, context: input.context ?? null, reason: input.reason, note, createdAt: now };
  }
  await deps.db.insert(contentReports).values(row);
  await mailOperator(deps).catch((err) => deps.log?.warn("reports.mail_failed", { error: err instanceof Error ? err.message : String(err) }));
  return { id, status: "open" as const };
}

/**
 * Tells the operator inbox about open reports, at most once per 15 minutes for the whole deployment. The slot is one
 * app_settings row per 15 minute bucket claimed with INSERT OR IGNORE (deferrable in spirit, but tiny: at most 96 a
 * day and only on days with reports). The cron sweep calls this too, so a report inside a used slot is mailed in the next one.
 */
export async function mailOperator(deps: Deps): Promise<boolean> {
  const open = await deps.db.select({ n: count(), oldest: sql<number>`min(${contentReports.createdAt})` }).from(contentReports).where(eq(contentReports.status, "open")).get();
  if (!open?.n) return false;
  const now = deps.now().getTime();
  const bucket = Math.floor(now / REPORT_MAIL_EVERY_MS);
  const last = await deps.db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, "ugc_report_mail_last")).get();
  const lastAt = last ? Number(last.v) : 0;
  const newest = await deps.db.select({ at: sql<number>`max(${contentReports.createdAt})` }).from(contentReports).where(eq(contentReports.status, "open")).get();
  if (lastAt && Number(newest?.at ?? 0) <= lastAt) return false; // nothing new since the last mail
  const claimed = await deps.db.insert(appSettings).values({ key: `ugc_report_mail:${bucket}`, value: String(now) }).onConflictDoNothing().returning({ k: appSettings.key });
  if (!claimed.length) return false;
  await deps.db.insert(appSettings).values({ key: "ugc_report_mail_last", value: String(now) }).onConflictDoUpdate({ target: appSettings.key, set: { value: String(now) } });
  const to = deps.config.supportEmail;
  if (!to) return false;
  const hours = Math.max(0, Math.round((now - Number(open.oldest)) / 360_000) / 10);
  const base = deps.config.appUrl;
  const text = [
    `${open.n} open report${open.n === 1 ? "" : "s"} in the moderation queue. The oldest is ${hours} hours old.`,
    "Apple's rule for apps with user content: act on every report within 24 hours (remove the message, suspend the person, or dismiss).",
    "How: docs/runbooks/support-inbox.md, section \"Reports and blocks (Apple 1.2)\".",
  ].join("\n\n");
  const { sendSystemEmail } = await import("../system-mail");
  await sendSystemEmail(deps, { to, subject: `${open.n} report${open.n === 1 ? "" : "s"} to review`, text, template: "ugc-reports", action: { label: "Open the queue", url: `${base}/app/admin/reports` } } as never);
  return true;
}

// ---------------------------------------------------------------- operator queue


export async function listReports(deps: Deps, q: { status?: "open" | "resolved" | "dismissed" | "all"; limit?: number } = {}) {
  const status = q.status ?? "open";
  const rows = await deps.db.select({
    r: contentReports,
    reporterName: sql<string | null>`(select u."name" from "users" u where u."id" = "content_reports"."reporter_user_id")`,
    reporterEmail: sql<string | null>`(select u."email" from "users" u where u."id" = "content_reports"."reporter_user_id")`,
    targetName: sql<string | null>`(select u."name" from "users" u where u."id" = "content_reports"."target_user_id")`,
    targetEmail: sql<string | null>`(select u."email" from "users" u where u."id" = "content_reports"."target_user_id")`,
    targetBanned: sql<number | null>`(select u."banned" from "users" u where u."id" = "content_reports"."target_user_id")`,
  }).from(contentReports).where(status === "all" ? undefined : eq(contentReports.status, status))
    .orderBy(desc(contentReports.createdAt)).limit(Math.min(q.limit ?? 100, 200));
  const now = deps.now().getTime();
  return {
    reports: rows.map(({ r, ...x }) => ({
      id: r.id, status: r.status, action: r.action, targetType: r.targetType, context: r.context, reason: r.reason, note: r.note, workspaceId: r.orgId,
      messageId: r.messageId, snapshotText: r.snapshotText, snapshotAuthorId: r.snapshotAuthorId,
      reporter: { id: r.reporterUserId, name: x.reporterName, email: x.reporterEmail },
      target: r.targetUserId ? { id: r.targetUserId, name: x.targetName, email: x.targetEmail, suspended: !!x.targetBanned } : null,
      createdAt: r.createdAt.toISOString(), ageHours: Math.floor((now - r.createdAt.getTime()) / 3600_000),
      resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote,
    })),
  };
}

export async function openReportCount(deps: Deps) {
  const row = await deps.db.select({ n: count(), oldest: sql<number | null>`min(${contentReports.createdAt})` }).from(contentReports).where(eq(contentReports.status, "open")).get();
  return { open: row?.n ?? 0, oldestAt: row?.oldest ? new Date(Number(row.oldest)).toISOString() : null };
}

export type ReportAction = "dismiss" | "resolve" | "remove_message" | "suspend_user";

/**
 * The operator acts on a report. remove_message soft deletes through the normal chat delete (clients update live);
 * suspend_user bans the account (the sign in plugin's ban: sign in refused) and ends its sessions. Essential writes.
 */
export async function actOnReport(deps: Deps, operator: { userId: string }, id: string, input: { action: ReportAction; note?: string }) {
  const r = await deps.db.select().from(contentReports).where(eq(contentReports.id, id)).get();
  if (!r) throw notFound("Report");
  const now = deps.now();
  const note = (input.note ?? "").trim().slice(0, 1000) || null;
  let status: "resolved" | "dismissed" = "resolved";
  let action: typeof contentReports.$inferSelect.action = "none";
  if (input.action === "dismiss") status = "dismissed";
  else if (input.action === "remove_message") {
    if (!r.messageId || !r.orgId) throw new HttpError(422, "validation_failed", "This report is about a person, not a message.");
    const m = await deps.db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.id, r.messageId), eq(chatMessages.orgId, r.orgId))).get();
    if (m) { const { moderationDelete } = await import("./chat"); await moderationDelete(deps, r.orgId, m.id); }
    action = "message_removed";
  } else if (input.action === "suspend_user") {
    if (!r.targetUserId) throw new HttpError(422, "validation_failed", "No person to suspend on this report.");
    if (r.targetUserId === operator.userId) throw new HttpError(422, "validation_failed", "You can't suspend yourself.");
    const { sessions } = await import("../../db/schema");
    await deps.db.update(users).set({ banned: true, banReason: `Suspended after a content report (${r.reason}).` }).where(eq(users.id, r.targetUserId));
    await deps.db.delete(sessions).where(eq(sessions.userId, r.targetUserId));
    // PRIV1b (CB2): as a ban: their apps' OAuth grants end and live sockets close now, not at the next check.
    await (await import("../developer/oauth")).revokeUserGrants(deps, r.targetUserId);
    await (await import("../../realtime/publish")).closeUserSockets(deps, r.targetUserId);
    action = "user_suspended";
  }
  await deps.db.update(contentReports).set({ status, action, resolutionNote: note, resolvedBy: operator.userId, resolvedAt: now }).where(eq(contentReports.id, id));
  // Other open reports on the same message are settled with it.
  if (action === "message_removed" && r.messageId) {
    await deps.db.update(contentReports).set({ status: "resolved", action, resolvedBy: operator.userId, resolvedAt: now, resolutionNote: note })
      .where(and(eq(contentReports.messageId, r.messageId), eq(contentReports.status, "open")));
  }
  return (await listReports(deps, { status: "all", limit: 200 })).reports.find((x) => x.id === id)!;
}

