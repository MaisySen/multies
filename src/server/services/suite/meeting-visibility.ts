/**
 * Review Z1: who may see a meeting. A call started from a DM or a private channel belongs to that chat: only the
 * people in it see, edit, invite to, run the waiting room of or join it (an API or agent key never does, as for the
 * chat itself). Every other meeting is open to the whole workspace. One rule for the list (as SQL) and for each read
 * by id (a plain 404, never a hint that the call exists).
 */
import { and, eq, exists, isNull, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatChannels, chatMembers, meetings } from "../../db/schema";
import { notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";

const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);

/** For a WHERE on meetings: no chat, a public channel's call, or a chat this person is in. */
export function meetingVisibleTo(deps: Deps, a: SuiteActor) {
  const open = deps.db.select({ x: sql`1` }).from(chatChannels).where(and(
    eq(chatChannels.id, meetings.channelId), eq(chatChannels.orgId, a.orgId), isNull(chatChannels.deletedAt), ne(chatChannels.kind, "dm"), eq(chatChannels.isPrivate, false)));
  const inIt = a.userId && !isKey(a)
    ? exists(deps.db.select({ x: sql`1` }).from(chatMembers).innerJoin(chatChannels, eq(chatChannels.id, chatMembers.channelId))
      .where(and(eq(chatMembers.channelId, meetings.channelId), eq(chatMembers.userId, a.userId), eq(chatChannels.orgId, a.orgId), isNull(chatChannels.deletedAt))))
    : undefined;
  return or(isNull(meetings.channelId), exists(open), inIt);
}

/** For a meeting read by id: a 404 unless this actor can open the chat its call came from. */
export async function assertMeetingVisible(deps: Deps, a: SuiteActor, m: { channelId: string | null }) {
  if (!m.channelId) return;
  await (await import("./chat")).visibleChannel(deps, a, m.channelId).catch(() => { throw notFound("Meeting"); });
}
