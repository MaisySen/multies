/**
 * Round 20 chat polish: emoji reactions, search inside chat, jump to the first unread message,
 * and a Call button that starts a meeting for a channel or DM and posts a join card.
 *
 * Write costs (D1 rows, one per table row plus one per index):
 * - a reaction add or remove: 2 (the chat_reactions row and its primary key, which leads with
 *   message_id and so is also the lookup index). Nothing on chat_messages changes: other people
 *   see the reaction on their next chat poll, which already reads the last 100 messages.
 * - a call: one meetings row and one chat message, plus what any meeting and any post write
 *   (activity, read marker). tests/write-cost.test.ts holds the ceilings.
 * - search and first unread: reads only.
 *
 * Who may react: whoever can read the message. People and API keys go through visibleChannel
 * (keys see public channels only); guests only in channels shared with their project.
 */
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatChannels, chatMembers, chatMessages, chatReactions } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { actorOf, assertWritable, type SuiteActor } from "./common";
import { getChannel, guestChannel, plainText, postMessage, visibleChannel, type ChatLink, type GuestViewer, type Mention } from "./chat";
import { reactionsFor, type ReactionSummary } from "./chat-reaction-summary";

/** Distinct emoji one message can carry. */
export const MAX_EMOJI_PER_MESSAGE = 20;
/** Longest emoji accepted, in UTF-16 code units (a family or a flag with modifiers fits). */
export const MAX_EMOJI_LENGTH = 32;

const EMOJI_CHARS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3|[#*0-9])+$/u;
const EMOJI_CORE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/** The emoji as stored, or a 422: one short emoji, no words, spaces or markup. */
export function cleanEmoji(raw: unknown): string {
  const e = typeof raw === "string" ? raw.trim() : "";
  if (!e || e.length > MAX_EMOJI_LENGTH || !EMOJI_CHARS.test(e) || !EMOJI_CORE.test(e)) throw new HttpError(422, "validation_failed", "React with one emoji.");
  return e;
}

const notFound = () => new HttpError(404, "not_found", "Message not found.");
const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);

async function liveMessage(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.id, id))).get();
  if (!m || m.deletedAt) throw notFound();
  return m;
}

async function applyToggle(deps: Deps, m: typeof chatMessages.$inferSelect, archived: boolean, reactor: string, name: string, emoji: string) {
  if (archived) throw new HttpError(409, "archived", "This channel is archived. Unarchive it to react.");
  const key = and(eq(chatReactions.messageId, m.id), eq(chatReactions.reactor, reactor), eq(chatReactions.emoji, emoji));
  const mine = await deps.db.select({ e: chatReactions.emoji }).from(chatReactions).where(key).get();
  let added: boolean;
  if (mine) {
    await deps.db.delete(chatReactions).where(key);
    added = false;
  } else {
    const used = (await deps.db.selectDistinct({ e: chatReactions.emoji }).from(chatReactions).where(eq(chatReactions.messageId, m.id))).map((r) => r.e);
    if (!used.includes(emoji) && used.length >= MAX_EMOJI_PER_MESSAGE) throw new HttpError(422, "validation_failed", `A message can have up to ${MAX_EMOJI_PER_MESSAGE} different reactions.`);
    await deps.db.insert(chatReactions).values({ messageId: m.id, reactor, emoji, orgId: m.orgId, name: name.slice(0, 120), createdAt: deps.now() }).onConflictDoNothing();
    added = true;
  }
  const reactions: ReactionSummary[] = (await reactionsFor(deps, [m.id])).get(m.id) ?? [];
  return { messageId: m.id, emoji, added, reactions };
}

/** Adds the emoji, or takes it off when this person (or agent) already reacted with it. */
export async function toggleReaction(deps: Deps, a: SuiteActor, messageId: string, emoji: string) {
  assertWritable(a);
  const e = cleanEmoji(emoji);
  const m = await liveMessage(deps, a.orgId, messageId);
  const c = await visibleChannel(deps, a, m.channelId);
  const who = actorOf(a);
  if (who.type === "system" || !who.id) throw new HttpError(403, "forbidden", "Only people and agents react to messages.");
  return applyToggle(deps, m, c.archived, `${who.type}:${who.id}`, who.name || "Someone", e);
}

/** The same toggle for a guest, only on messages in channels shared with their project. */
export async function guestToggleReaction(deps: Deps, g: GuestViewer, messageId: string, emoji: string) {
  const e = cleanEmoji(emoji);
  const m = await liveMessage(deps, g.orgId, messageId);
  const c = await guestChannel(deps, g, m.channelId).catch(() => { throw notFound(); });
  return applyToggle(deps, m, c.archived, `guest:${g.guestId}`, `${g.name} (guest)`, e);
}

// ---------------------------------------------------------------- search

/** LIKE pattern for a contains search, with %, _ and the escape character taken literally. */
export function likeContains(q: string) {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export const SEARCH_LIMIT = 50;

/**
 * Messages whose text contains q, newest first, in one channel or across every channel this
 * actor can read (public channels, plus private channels and DMs they belong to; keys see
 * public channels only). Thread replies are included and carry their parentId.
 */
export async function searchChat(deps: Deps, a: SuiteActor, input: { q: string; channelId?: string; limit?: number }) {
  const q = (input.q ?? "").trim();
  if (q.length < 2) throw new HttpError(422, "validation_failed", "Search for at least 2 characters.");
  if (q.length > 100) throw new HttpError(422, "validation_failed", "Search for up to 100 characters.");
  const limit = Math.min(Math.max(input.limit ?? 20, 1), SEARCH_LIMIT);
  let where;
  if (input.channelId) {
    const c = await visibleChannel(deps, a, input.channelId);
    where = eq(chatMessages.channelId, c.id);
  } else {
    const userId = isKey(a) || !a.userId ? null : a.userId;
    where = userId
      ? sql`${chatMessages.channelId} in (select ${chatChannels.id} from ${chatChannels} where ${chatChannels.orgId} = ${a.orgId} and ${chatChannels.deletedAt} is null and ((${chatChannels.kind} = 'channel' and ${chatChannels.isPrivate} = 0) or ${chatChannels.id} in (select ${chatMembers.channelId} from ${chatMembers} where ${chatMembers.userId} = ${userId})))`
      : sql`${chatMessages.channelId} in (select ${chatChannels.id} from ${chatChannels} where ${chatChannels.orgId} = ${a.orgId} and ${chatChannels.deletedAt} is null and ${chatChannels.kind} = 'channel' and ${chatChannels.isPrivate} = 0)`;
  }
  const rows = await deps.db.select({
    id: chatMessages.id, channelId: chatMessages.channelId, parentId: chatMessages.parentId, authorName: chatMessages.authorName, body: chatMessages.body,
    mentions: chatMessages.mentions, links: chatMessages.links, createdAt: chatMessages.createdAt, channelName: chatChannels.name, channelKind: chatChannels.kind,
  }).from(chatMessages).innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(and(eq(chatMessages.orgId, a.orgId), isNull(chatMessages.deletedAt), where, sql`${chatMessages.body} like ${likeContains(q)} escape '\\'`))
    .orderBy(desc(chatMessages.createdAt)).limit(limit);
  return {
    results: rows.map((r) => ({
      id: r.id, channelId: r.channelId, parentId: r.parentId, authorName: r.authorName,
      channel: r.channelKind === "dm" ? "Direct message" : `#${r.channelName}`, channelKind: r.channelKind,
      preview: plainText(r.body, JSON.parse(r.mentions) as Mention[], JSON.parse(r.links) as ChatLink[]).slice(0, 200),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------- first unread

/** The first top level message after this person's read marker, and how many there are. Read only. */
export async function firstUnread(deps: Deps, a: SuiteActor, channelId: string) {
  const c = await visibleChannel(deps, a, channelId);
  const none = { messageId: null as string | null, createdAt: null as string | null, unread: 0 };
  if (isKey(a) || !a.userId) return none;
  const mem = await deps.db.select({ lastReadAt: chatMembers.lastReadAt }).from(chatMembers).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, a.userId))).get();
  if (!mem) return none;
  const cond = and(eq(chatMessages.channelId, c.id), isNull(chatMessages.parentId), isNull(chatMessages.deletedAt),
    mem.lastReadAt ? gt(chatMessages.createdAt, mem.lastReadAt) : undefined, sql`coalesce(${chatMessages.authorId}, '') <> ${a.userId}`);
  const first = await deps.db.select({ id: chatMessages.id, createdAt: chatMessages.createdAt }).from(chatMessages).where(cond).orderBy(asc(chatMessages.createdAt)).limit(1).get();
  if (!first) return none;
  const n = await deps.db.select({ n: count() }).from(chatMessages).where(cond).get();
  return { messageId: first.id, createdAt: first.createdAt.toISOString(), unread: n?.n ?? 1 };
}

// ---------------------------------------------------------------- calls

export const CALL_PREFIX = "Started a call. Join: ";

/**
 * One tap call for a channel or DM: one meeting through the meetings service, titled after the
 * channel, and one message in the channel that the app shows as a join card. People only.
 */
export async function startChannelCall(deps: Deps, a: SuiteActor, channelId: string) {
  assertWritable(a);
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "People start calls from chat. Agents can schedule meetings with create_meeting.");
  const c = await visibleChannel(deps, a, channelId);
  if (c.archived) throw new HttpError(409, "archived", "This channel is archived. Unarchive it to start a call.");
  const title = c.kind === "dm" ? `Call with ${(await getChannel(deps, a, c.id)).name}` : `#${c.name} call`;
  const { createMeeting } = await import("./meetings");
  const { meeting } = await createMeeting(deps, a, { title, durationMin: 60 });
  // Guests of a shared channel can't open the app's meeting page, so their link rides along.
  const body = `${CALL_PREFIX}${meeting.joinUrl}${c.guestAccess ? `\nGuests join here: ${meeting.guestUrl}` : ""}`;
  const message = await postMessage(deps, a, c.id, { body });
  return { meeting: { id: meeting.id, title: meeting.title, joinUrl: meeting.joinUrl, videoEnabled: meeting.videoEnabled }, message };
}
