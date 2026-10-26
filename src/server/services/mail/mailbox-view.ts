import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "../../db";
import { attachments, mailboxes, mailConnections, messages } from "../../db/schema";
import { notFound } from "../../lib/errors";
import type { Address, Folder } from "@/shared/mail";
import { inIds } from "../../lib/sql-chunks";

type Row = typeof messages.$inferSelect;

export function presentListItem(m: Row) {
  return {
    id: m.id, mailboxId: m.mailboxId, folder: m.folder, threadId: m.threadId,
    from: { address: m.fromAddress, name: m.fromName || undefined },
    to: JSON.parse(m.to) as Address[],
    subject: m.subject, snippet: m.snippet, date: m.date, isRead: m.isRead, isStarred: m.isStarred, hasAttachments: m.hasAttachments,
    sentByAgentId: m.sentByAgentId ?? null,
    /** Round 19: the provider folder a connected mailbox's message is in (a folder key), or null. */
    remoteBox: m.remoteBox ?? null,
  };
}

export function presentMessage(m: Row, atts: (typeof attachments.$inferSelect)[] = []) {
  return {
    ...presentListItem(m),
    cc: JSON.parse(m.cc) as Address[],
    bcc: JSON.parse(m.bcc) as Address[],
    replyTo: m.replyTo,
    text: m.text,
    html: m.html,
    messageIdHeader: m.messageIdHeader,
    authResults: m.authResults ? JSON.parse(m.authResults) : null,
    sizeBytes: m.sizeBytes,
    attachments: atts.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, available: a.contentB64 !== null || a.storageKey !== null })),
  };
}

/** `scope` limits results to these mailbox ids (a member's grants); null means all. */
export type Scope = string[] | null;
const inScope = (scope: Scope) => (scope ? inIds(messages.mailboxId, scope) : undefined);

export async function mailboxOverview(db: DB, orgId: string, scope: Scope = null) {
  const boxes = (await db.select().from(mailboxes).where(eq(mailboxes.orgId, orgId)).orderBy(mailboxes.address))
    .filter((b) => !scope || scope.includes(b.id));
  const counts = await db
    .select({ mailboxId: messages.mailboxId, folder: messages.folder, total: sql<number>`count(*)`, unread: sql<number>`sum(case when ${messages.isRead} = 0 then 1 else 0 end)` })
    .from(messages).where(eq(messages.orgId, orgId)).groupBy(messages.mailboxId, messages.folder);
  const connected = new Map((await db.select({ mailboxId: mailConnections.mailboxId, id: mailConnections.id }).from(mailConnections).where(eq(mailConnections.orgId, orgId))).map((r) => [r.mailboxId, r.id]));
  return boxes.map((b) => {
    const folders: Record<string, { total: number; unread: number }> = {};
    for (const c of counts) if (c.mailboxId === b.id) folders[c.folder] = { total: Number(c.total), unread: Number(c.unread ?? 0) };
    return { id: b.id, address: b.address, displayName: b.displayName, usedBytes: b.usedBytes, quotaMb: b.quotaMb, kind: b.kind, folders, connected: connected.has(b.id), connectionId: connected.get(b.id) ?? null };
  });
}

const escapeLike = (s: string) => s.replace(/[!%_]/g, (ch) => `!${ch}`);

export async function listMessages(db: DB, orgId: string, q: { mailboxId?: string; folder?: Folder | "starred"; remote?: string; search?: string; cursor?: string; limit?: number; scope?: Scope; extra?: SQL }) {
  const limit = Math.min(q.limit ?? 50, 100);
  const conds = [eq(messages.orgId, orgId)];
  const s = inScope(q.scope ?? null);
  if (s) conds.push(s);
  if (q.mailboxId) conds.push(eq(messages.mailboxId, q.mailboxId));
  if (q.folder === "starred") conds.push(eq(messages.isStarred, true));
  else if (q.folder) conds.push(eq(messages.folder, q.folder));
  // A connected mailbox's own folder (round 19): filed under Archive, named by its provider path.
  if (q.remote) conds.push(eq(messages.folder, "archive"), eq(messages.remoteBox, q.remote));
  if (q.search?.trim()) {
    const term = `%${escapeLike(q.search.trim().toLowerCase())}%`;
    const fields = [messages.subject, messages.fromAddress, messages.fromName, messages.text, messages.to];
    conds.push(or(...fields.map((f) => sql`lower(${f}) like ${term} escape '!'`))!);
    if (!q.folder) conds.push(sql`${messages.folder} <> 'trash'`);
  }
  // Round 20: e.g. snoozed threads hidden from Inbox (services/mail/schedules.ts).
  if (q.extra) conds.push(q.extra);
  if (q.cursor) {
    const dot = q.cursor.indexOf(".");
    const t = new Date(Number(q.cursor.slice(0, dot)));
    const id = q.cursor.slice(dot + 1);
    conds.push(or(lt(messages.date, t), and(eq(messages.date, t), lt(messages.id, id)))!);
  }
  const rows = await db.select().from(messages).where(and(...conds)).orderBy(desc(messages.date), desc(messages.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    messages: page.map(presentListItem),
    nextCursor: rows.length > limit && last ? `${last.date.getTime()}.${last.id}` : null,
  };
}

export async function getMessage(db: DB, orgId: string, id: string, scope: Scope = null) {
  const m = await db.select().from(messages).where(and(eq(messages.id, id), eq(messages.orgId, orgId))).get();
  if (!m || (scope && !scope.includes(m.mailboxId))) throw notFound("Message");
  return m;
}

export async function getThread(db: DB, orgId: string, m: Row) {
  const rows = await db.select().from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.mailboxId, m.mailboxId), eq(messages.threadId, m.threadId), sql`${messages.folder} <> 'drafts'`))
    .orderBy(messages.date);
  const atts = rows.length
    ? await db.select().from(attachments).where(inIds(attachments.messageId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => presentMessage(r, atts.filter((a) => a.messageId === r.id)));
}

export async function deleteMessagesPermanently(db: DB, rows: Row[]) {
  for (const r of rows) {
    await db.delete(messages).where(eq(messages.id, r.id));
    await db.update(mailboxes).set({ usedBytes: sql`max(0, ${mailboxes.usedBytes} - ${r.sizeBytes})` }).where(eq(mailboxes.id, r.mailboxId));
  }
}

