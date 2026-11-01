/**
 * R96: the light chat plus fields every chat message read carries (a poll card's id and kind, the announcement mark).
 * Kept apart from chat-plus.ts so chat.ts can use it without an import cycle.
 */
import { inArray } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatAnnouncements, chatPolls } from "../../db/schema";
import { inChunks } from "../../lib/sql-chunks";

export type ChatPlusExtra = { poll?: { id: string; kind: string; question: string }; announcement?: boolean };

export async function chatPlusExtras(deps: Deps, ids: string[]): Promise<Map<string, ChatPlusExtra>> {
  const out = new Map<string, ChatPlusExtra>();
  if (!ids.length || deps.config.chatPlus === false) return out;
  const polls = await inChunks(ids, (part) => deps.db.select({ id: chatPolls.id, kind: chatPolls.kind, question: chatPolls.question, messageId: chatPolls.messageId }).from(chatPolls).where(inArray(chatPolls.messageId, part)));
  for (const p of polls) if (p.messageId) out.set(p.messageId, { ...out.get(p.messageId), poll: { id: p.id, kind: p.kind, question: p.question } });
  const ann = await inChunks(ids, (part) => deps.db.select({ messageId: chatAnnouncements.messageId }).from(chatAnnouncements).where(inArray(chatAnnouncements.messageId, part)));
  for (const a of ann) out.set(a.messageId, { ...out.get(a.messageId), announcement: true });
  return out;
}
