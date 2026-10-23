import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../../db";
import { attachments, mailboxes, messages } from "../../db/schema";
import { newId, toB64 } from "../../lib/crypto";
import type { Address, AuthResults, Folder } from "@/shared/mail";
import { makeSnippet, type ParsedAttachment } from "./mime";

/** Attachments larger than this keep their metadata but not their bytes. */
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
}

/** Finds the thread a message belongs to by walking In-Reply-To / References within the mailbox. */
export async function resolveThreadId(db: DB, mailboxId: string, inReplyTo?: string, references?: string): Promise<string | null> {
  const ids = [inReplyTo, ...(references ?? "").split(/\s+/)].filter((x): x is string => !!x && x.length > 2).slice(0, 20);
  for (const id of ids) {
    const hit = await db.select({ threadId: messages.threadId }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, id))).get();
    if (hit) return hit.threadId;
  }
  return null;
}

export function estimateSize(i: Pick<StoreInput, "text" | "html" | "subject" | "attachments">): number {
  return (i.text?.length ?? 0) + (i.html?.length ?? 0) + i.subject.length + (i.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0) + 512;
}

export async function storeMessage(db: DB, i: StoreInput): Promise<string> {
  const id = newId("msg");
  const threadId = (await resolveThreadId(db, i.mailboxId, i.inReplyTo, i.references)) ?? newId("thr");
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
    snippet: makeSnippet(i.text, i.html),
    sizeBytes,
    isRead: i.isRead ?? false,
    hasAttachments: (i.attachments?.length ?? 0) > 0,
    authResults: i.authResults ? JSON.stringify(i.authResults) : null,
    sentByAgentId: i.sentByAgentId ?? null,
    sentByUserId: i.sentByUserId ?? null,
    date: i.date,
  });
  for (const a of i.attachments ?? []) {
    await db.insert(attachments).values({
      id: newId("att"),
      messageId: id,
      filename: a.filename.slice(0, 255),
      contentType: a.contentType.slice(0, 255),
      sizeBytes: a.content.byteLength,
      contentB64: a.content.byteLength <= MAX_INLINE_ATTACHMENT_BYTES ? toB64(a.content) : null,
    });
  }
  await db.update(mailboxes).set({ usedBytes: sql`${mailboxes.usedBytes} + ${sizeBytes}` }).where(eq(mailboxes.id, i.mailboxId));
  return id;
}
