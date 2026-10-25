/**
 * Reactions on chat messages, read side only: counts per emoji, worked out on read from
 * chat_reactions (no counter column on chat_messages). Kept apart from chat-reactions.ts so the
 * chat service can show reactions on every message it presents without an import cycle.
 */
import { asc, inArray } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatReactions } from "../../db/schema";

export interface ReactionSummary { emoji: string; count: number; reactors: { id: string; name: string }[] }

/** D1 takes at most 100 bound values in one query. */
const CHUNK = 90;
/** Names listed per emoji for "who reacted"; the count is always complete. */
const MAX_NAMES = 25;

/** Reactions per message id, each emoji in the order it was first used. One indexed read per 90 messages. */
export async function reactionsFor(deps: Deps, messageIds: string[]): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  const ids = [...new Set(messageIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await deps.db.select({ messageId: chatReactions.messageId, reactor: chatReactions.reactor, emoji: chatReactions.emoji, name: chatReactions.name })
      .from(chatReactions).where(inArray(chatReactions.messageId, ids.slice(i, i + CHUNK))).orderBy(asc(chatReactions.createdAt));
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      let s = list.find((x) => x.emoji === r.emoji);
      if (!s) { s = { emoji: r.emoji, count: 0, reactors: [] }; list.push(s); }
      s.count++;
      if (s.reactors.length < MAX_NAMES) s.reactors.push({ id: r.reactor, name: r.name });
      out.set(r.messageId, list);
    }
  }
  return out;
}
