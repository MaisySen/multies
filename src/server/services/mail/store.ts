import { and, eq, ne, sql } from "drizzle-orm";
import type { DB } from "../../db";
import { attachments, mailboxes, messages } from "../../db/schema";
import { fromB64, newId, toB64 } from "../../lib/crypto";
import { chunkIds, inIds } from "../../lib/sql-chunks";
import { attachmentKey, type BodyStore } from "../storage/body-store";
import type { Address, AuthResults, Folder } from "@/shared/mail";
import { makeSnippet, type ParsedAttachment } from "./mime";

/** Attachments larger than this go to the body store, or keep only their metadata without one. */
export const MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;

export interface StoreInput {
  orgId: string;
  mailboxId: string;
  folder: Folder;
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string;
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  date: Date;
  isRead?: boolean;
  authResults?: AuthResults;
  attachments?: ParsedAttachment[];
  sizeBytes?: number;
  sentByAgentId?: string | null;
  sentByUserId?: string | null;
  /** Round 22: put the message in this thread (a draft reply) instead of resolving it from the headers. */
  threadId?: string;
  /** Large attachments go here instead of being dropped, when a body store is configured. */
  bodyStore?: BodyStore;
  /** R31: bulk mail by its headers (split inbox). */
  isBulk?: boolean;
  /** AIS1 (row 32): the list preview, when it must not be cut from the text (the platform's own mail, links taken out). */
  snippet?: string;
}

/** An attachment's bytes, from the database or the body store; null when it wasn't kept. */
export async function attachmentBytes(row: { contentB64: string | null; storageKey: string | null }, store: BodyStore | undefined) {
  if (row.contentB64 !== null) return fromB64(row.contentB64);
  if (row.storageKey && store) return store.get(row.storageKey);
  return null;
}

export const attachmentAvailable = (row: { contentB64: string | null; storageKey: string | null }) => row.contentB64 !== null || row.storageKey !== null;

/**
 * Finds the thread a message belongs to by walking In-Reply-To / References. Each id is matched against
 * our own Message-ID and the one the sending provider gave a sent copy (Resend replaces ours). The
 * receiving mailbox is searched first; with `orgId`, the workspace's other mailboxes next (a reply sent
 * to a mailbox's reply-to address lands in another mailbox), never another workspace's. Both lookups
 * ride the (mailbox_id, header) indexes, so this adds no index and no writes.
 */
export async function resolveThreadId(db: DB, mailboxId: string, inReplyTo?: string, references?: string, orgId?: string): Promise<string | null> {
  const ids = [inReplyTo, ...(references ?? "").split(/\s+/)].filter((x): x is string => !!x && x.length > 2).slice(0, 20);
  if (!ids.length) return null;
  const find = async (boxes: string[], id: string) => {
    for (const col of [messages.messageIdHeader, messages.providerMessageIdHeader]) {
      const hit = await db.select({ threadId: messages.threadId }).from(messages)
        .where(and(boxes.length === 1 ? eq(messages.mailboxId, boxes[0]!) : inIds(messages.mailboxId, boxes), eq(col, id), orgId ? eq(messages.orgId, orgId) : undefined)).get();
      if (hit) return hit.threadId;
    }
    return null;
  };
  for (const id of ids) {
    const hit = await find([mailboxId], id);
    if (hit) return hit;
  }
  if (!orgId) return null;
  const others = (await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), ne(mailboxes.id, mailboxId)))).map((r) => r.id);
  for (const id of ids) {
    for (const chunk of chunkIds(others)) {
      const hit = await find(chunk, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function estimateSize(i: Pick<StoreInput, "text" | "html" | "subject" | "attachments">): number {
  return (i.text?.length ?? 0) + (i.html?.length ?? 0) + i.subject.length + (i.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0) + 512;
}

/**
 * W4: gives a mailbox back the storage of messages deleted outside deleteMessagesPermanently (a draft replaced by its
 * newer copy, a draft that was sent or scheduled, a copy taken back out). Never below 0. One row update, none for 0.
 */
export async function releaseBytes(db: DB, mailboxId: string, rows: { sizeBytes: number | null }[]) {
  const bytes = rows.reduce((n, r) => n + Math.max(0, r.sizeBytes ?? 0), 0);
  if (bytes > 0) await db.update(mailboxes).set({ usedBytes: sql`max(0, ${mailboxes.usedBytes} - ${bytes})` }).where(eq(mailboxes.id, mailboxId));
}

export async function storeMessage(db: DB, i: StoreInput): Promise<string> {
  const id = newId("msg");
  const threadId = i.threadId ?? (await resolveThreadId(db, i.mailboxId, i.inReplyTo, i.references, i.orgId)) ?? newId("thr");
  const sizeBytes = i.sizeBytes ?? estimateSize(i);
  await db.insert(messages).values({
    id,
    orgId: i.orgId,
    mailboxId: i.mailboxId,
    folder: i.folder,
    messageIdHeader: i.messageIdHeader ?? null,
    inReplyTo: i.inReplyTo ?? null,
    references: i.references ?? null,
    threadId,
    fromAddress: i.from.address,
    fromName: i.from.name ?? "",
    to: JSON.stringify(i.to),
    cc: JSON.stringify(i.cc ?? []),
    bcc: JSON.stringify(i.bcc ?? []),
    replyTo: i.replyTo ?? null,
    subject: i.subject,
    text: i.text,
    html: i.html ?? null,
    snippet: i.snippet ?? makeSnippet(i.text, i.html),
    sizeBytes,
    isRead: i.isRead ?? false,
    hasAttachments: (i.attachments?.length ?? 0) > 0,
    authResults: i.authResults ? JSON.stringify(i.authResults) : null,
    sentByAgentId: i.sentByAgentId ?? null,
    sentByUserId: i.sentByUserId ?? null,
    isBulk: i.isBulk ?? null,
    date: i.date,
  });
  for (const a of i.attachments ?? []) {
    const attId = newId("att");
    const inline = a.content.byteLength <= MAX_INLINE_ATTACHMENT_BYTES;
    let storageKey: string | null = null;
    if (!inline && i.bodyStore) {
      storageKey = attachmentKey(i.orgId, attId);
      await i.bodyStore.put(storageKey, a.content, a.contentType);
    }
    await db.insert(attachments).values({
      id: attId,
      messageId: id,
      filename: a.filename.slice(0, 255),
      contentType: a.contentType.slice(0, 255),
      sizeBytes: a.content.byteLength,
      contentB64: inline ? toB64(a.content) : null,
      storageKey,
    });
  }
  await db.update(mailboxes).set({ usedBytes: sql`${mailboxes.usedBytes} + ${sizeBytes}` }).where(eq(mailboxes.id, i.mailboxId));
  return id;
}
