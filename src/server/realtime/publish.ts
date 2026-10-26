/**
 * Round 32: after a chat write commits, tell the workspace's live hub. The audience comes from
 * the channel itself: public channels reach everyone in the workspace, private channels and DMs
 * reach their members only. A hub that is down or slow never fails the write: the error is
 * reported and open chats pick the change up on their next poll.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../context";
import { chatMembers } from "../db/schema";
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
