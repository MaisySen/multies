/**
 * Round 32: after a chat write commits, tell the workspace's live hub. The audience comes from
 * the channel itself: public channels reach everyone in the workspace, private channels and DMs
 * reach their members only. A hub that is down or slow never fails the write: the error is
 * reported and open chats pick the change up on their next poll.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../context";
import { chatMembers, members } from "../db/schema";
import type { ChatAudience, ChatLiveEvent } from "./hub";

/** The parts of a channel row that decide its audience. */
export interface ChannelAudienceRow { id: string; orgId: string; kind: string; isPrivate: boolean }

/** How long a publish may take before the write moves on without it. */
export const PUBLISH_TIMEOUT_MS = 1500;

export async function audienceOf(deps: Deps, c: ChannelAudienceRow, members?: string[]): Promise<ChatAudience> {
  if (c.kind !== "dm" && !c.isPrivate) return { all: true };
  const ids = members ?? (await deps.db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, c.id))).map((r) => r.userId);
  return { userIds: ids };
}

/** Pushes one event to the people who can read the channel. Never throws. */
export async function publishChat(deps: Deps, c: ChannelAudienceRow, event: ChatLiveEvent, opts: { members?: string[]; audience?: ChatAudience } = {}) {
  const bus = deps.chatLive;
  if (!bus) return;
  try {
    const audience = opts.audience ?? (await audienceOf(deps, c, opts.members));
    if ("userIds" in audience && !audience.userIds.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS); });
    await Promise.race([bus.publish(c.orgId, audience, event), timeout]).finally(() => clearTimeout(timer));
  } catch (err) {
    deps.reportError?.(err, { where: "chat.live.publish", event: event.t });
  }
}

/**
 * OPS1 security (L2): closes the live sockets one session opened (an operator's impersonation that ended): the chat
 * hub's in every workspace the person belongs to (the same /kick the ban path uses, by session), and the doc rooms'
 * on this process (deps.collabLive, Node). Never throws.
 */
export async function closeSessionSockets(deps: Deps, userId: string, sessionId: string, orgIds?: string[]) {
  try { deps.collabLive?.kickSession(sessionId); } catch (err) { deps.reportError?.(err, { where: "collab.kick_session" }); }
  const bus = deps.chatLive;
  if (!bus?.kickSession) return;
  try {
    const ids = orgIds ?? (await deps.db.select({ o: members.organizationId }).from(members).where(eq(members.userId, userId))).map((r) => r.o);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS); });
    await Promise.race([Promise.all(ids.map((o) => bus.kickSession!(o, sessionId))), timeout]).finally(() => clearTimeout(timer));
  } catch (err) {
    deps.reportError?.(err, { where: "chat.live.kick_session" });
  }
}

/**
 * PRIV1b (P65): closes every live socket of one person, in the given workspaces or (none given) every workspace they
 * belong to. Used when they leave or are removed and when their sessions end; a socket was only checked when it
 * opened. Their other tabs reconnect through the session check. Never throws.
 */
export async function closeUserSockets(deps: Deps, userId: string, orgIds?: string[]) {
  const bus = deps.chatLive;
  if (!bus?.kick) return;
  try {
    const ids = orgIds ?? (await deps.db.select({ o: members.organizationId }).from(members).where(eq(members.userId, userId))).map((r) => r.o);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS); });
    await Promise.race([Promise.all(ids.map((o) => bus.kick!(o, userId))), timeout]).finally(() => clearTimeout(timer));
  } catch (err) {
    deps.reportError?.(err, { where: "chat.live.kick" });
  }
}
