/**
 * Round 32: live chat. One hub per workspace pushes chat changes to every open chat tab, so a
 * new message shows in about a second instead of on the next 4 second poll.
 *
 * The hub never decides who may read a channel: the writer does. Each event travels with its
 * audience, worked out from the channel's member list right after the D1 write (public channels:
 * everyone in the workspace; private channels and DMs: their members only). A socket only ever
 * receives events whose audience includes its own person.
 *
 * On Workers the hub is the ChatHub Durable Object (chat-hub-do.ts, WebSocket Hibernation, one
 * object per workspace). On Node (dev, self host, E2E) it is MemoryChatHub below, in this process.
 * Nothing is stored: a socket that missed an event catches up on the next poll.
 */

/** The socket path. The upgrade checks the session cookie and the Origin. */
export const CHAT_LIVE_PATH = "/api/chat/live";
/** The Durable Object name for a workspace's hub. */
export const hubName = (orgId: string) => `chat:${orgId}`;
/** A socket is closed (code 4001) once it is this old, so a removed person cannot keep listening. The client reconnects with a fresh session check. */
export const SOCKET_MAX_AGE_MS = 30 * 60_000;
/** Open sockets per workspace hub. Over this, new sockets are refused and those tabs keep polling. */
export const MAX_SOCKETS = 500;
/** Close code for an expired socket (reconnect at once). */
export const CLOSE_EXPIRED = 4001;
/** Close code for a full hub (poll instead; try again later). */
export const CLOSE_FULL = 4013;
/** PRIV1b (P65): close code for a socket whose person left the workspace or had their sessions ended (reconnect runs the session check). */
export const CLOSE_REVOKED = 4003;

/**
 * R33: the first frame on every socket. The browser holds its outgoing sends until it arrives
 * (so nothing is sent into a socket the server has not taken yet), then flushes them in order.
 * `seq` counts the events this hub has published since it started; it starts again at 0 when a
 * hub restarts (an evicted Durable Object), which tells a tab that saw a higher number to read
 * once to catch up. Nothing is stored for it.
 */
export type ChatHello = { t: "hello"; serverTime: string; seq: number };
export function helloFrame(seq: number, now: number): ChatHello {
  return { t: "hello", serverTime: new Date(now).toISOString(), seq };
}

/** Who may receive an event: everyone in the workspace, or exactly these people. */
export type ChatAudience = { all: true } | { userIds: string[] };

/** What the hub pushes. Messages carry the same row the chat list renders. */
export type ChatLiveEvent =
  | { t: "message"; op: "created" | "updated"; channelId: string; message: { id: string; channelId: string; parentId: string | null } & Record<string, unknown>; /** R33: the sender's client id, so the sending tab swaps its pending bubble for this one. */ clientMsgId?: string }
  | { t: "reactions"; channelId: string; messageId: string; reactions: unknown[] }
  | { t: "typing"; channelId: string; userId: string; name: string }
  | { t: "read"; channelId: string; userId: string; at: string }
  /** R47 (MB-139): the workspace change feed moved to `cursor`. No data: open task lists read the feed themselves (their own access rules). */
  | { t: "changes"; cursor: number };

/** One open socket, as the hub sees it. */
export interface HubConn { userId: string; openedAt: number; send(data: string): void; close(code: number, reason: string): void }

export function inAudience(audience: ChatAudience, userId: string) {
  return "all" in audience ? true : audience.userIds.includes(userId);
}

/**
 * Sends one event to every socket whose person is in the audience. Typing never goes back to
 * the person typing. Sockets past their age are closed instead (the client reconnects).
 * Returns how many sockets received it.
 */
export function deliver(conns: Iterable<HubConn>, audience: ChatAudience, event: ChatLiveEvent, now: number) {
  const data = JSON.stringify(event);
  let sent = 0;
  for (const c of conns) {
    if (now - c.openedAt >= SOCKET_MAX_AGE_MS) { try { c.close(CLOSE_EXPIRED, "expired"); } catch { /* gone */ } continue; }
    if (!inAudience(audience, c.userId)) continue;
    if (event.t === "typing" && event.userId === c.userId) continue;
    try { c.send(data); sent++; } catch { /* a dead socket is dropped by its close handler */ }
  }
  return sent;
}

/** What the chat services call after a write. Failures are swallowed by publishChat. */
export interface ChatLiveBus {
  publish(orgId: string, audience: ChatAudience, event: ChatLiveEvent): Promise<void>;
  /** PRIV1b (P65): closes every socket of one person in this workspace's hub. */
  kick?(orgId: string, userId: string): Promise<void>;
}

/** PRIV1b (P65): closes the sockets of one person. Returns how many. */
export function kickUser(conns: Iterable<HubConn>, userId: string) {
  let n = 0;
  for (const c of conns) if (c.userId === userId) { try { c.close(CLOSE_REVOKED, "revoked"); n++; } catch { /* gone */ } }
  return n;
}

/** The same hub in this process (Node entry and tests): one set of sockets per workspace. */
export class MemoryChatHub implements ChatLiveBus {
  readonly hubs = new Map<string, Set<HubConn>>();
  /** R33: events published per workspace since this process started (the hello frame's seq). */
  readonly seqs = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Adds a socket. False when the workspace hub is full. */
  join(orgId: string, conn: HubConn) {
    let set = this.hubs.get(orgId);
    if (!set) { set = new Set(); this.hubs.set(orgId, set); }
    if (set.size >= MAX_SOCKETS) return false;
    set.add(conn);
    return true;
  }

  leave(orgId: string, conn: HubConn) {
    const set = this.hubs.get(orgId);
    if (!set) return;
    set.delete(conn);
    if (!set.size) this.hubs.delete(orgId);
  }

  /** The hello frame for a new socket in this workspace. */
  hello(orgId: string): ChatHello { return helloFrame(this.seqs.get(orgId) ?? 0, this.now()); }

  async publish(orgId: string, audience: ChatAudience, event: ChatLiveEvent) {
    this.seqs.set(orgId, (this.seqs.get(orgId) ?? 0) + 1);
    const set = this.hubs.get(orgId);
    if (set) deliver([...set], audience, event, this.now());
  }

  async kick(orgId: string, userId: string) {
    const set = this.hubs.get(orgId);
    if (!set) return;
    const mine = [...set].filter((c) => c.userId === userId);
    for (const c of mine) this.leave(orgId, c); // PRIV1b (P65): off the list at once, before the close event arrives
    kickUser(mine, userId);
  }
}
