/**
 * R47 (MB-139): open task lists (board, list, backlog) update in about a second without polling.
 *
 * While at least one paged task list is mounted, the tab keeps one socket to the workspace's live hub (the
 * same GET /api/chat/live the chat uses, with its heartbeat, backoff and 30 minute renewal). After any write,
 * the server pushes { t: "changes", cursor }: the change feed's new position, never task data. Each list whose
 * own feed position is behind it refreshes the cheap way (paged-tasks-r46.ts: the feed since its position,
 * then only the tasks it names, through the normal access checked API). Cursor 0 means a batch write whose
 * position the server did not read: every list refreshes.
 *
 * While the socket is open, the lists' 20 second poll slows to a 60 second safety net (writes from scheduled
 * jobs do not push); when it drops, the 20 second poll is back on the next render.
 */
import { useSyncExternalStore } from "react";
import { LiveChatConnection, LIVE_PATH, type SocketLike } from "./live-chat";

type Listener = (cursor: number) => void;

export const LIVE_LIST_POLL_MS = 60_000;
/** Pushes inside this window are folded into one refresh (a bulk move sends several). */
export const NUDGE_DEBOUNCE_MS = 300;

export class LiveChanges {
  private conn: LiveChatConnection | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<() => void>();
  private unsubState: (() => void) | null = null;
  constructor(private readonly make: () => LiveChatConnection | null) {}

  /** Adds a list; the first one opens the socket, the last one to leave closes it. */
  add(fn: Listener) {
    this.listeners.add(fn);
    if (!this.conn) {
      this.conn = this.make();
      if (this.conn) {
        this.unsubState = this.conn.subscribe(() => { for (const s of this.stateListeners) s(); });
        this.conn.start();
      }
    }
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size && this.conn) {
        this.unsubState?.();
        this.unsubState = null;
        this.conn.stop();
        this.conn = null;
        for (const s of this.stateListeners) s();
      }
    };
  }

  /** A pushed position (from the socket). */
  push(cursor: number) { for (const fn of this.listeners) fn(cursor); }
  /** Whether pushes are arriving now (the socket is open). */
  get live() { return this.conn?.state === "open"; }
  subscribeState = (fn: () => void) => { this.stateListeners.add(fn); return () => { this.stateListeners.delete(fn); }; };
  getLive = () => this.live;
  /** Test hook: the underlying connection. */
  get connection() { return this.conn; }
}

function socketUrl() {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${LIVE_PATH}`;
}

export const liveChanges: LiveChanges = new LiveChanges(() => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return new LiveChatConnection({
    url: socketUrl(),
    makeSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onEvent: (e) => { if (e.t === "changes") liveChanges.push(typeof e.cursor === "number" ? e.cursor : 0); },
    // After a reconnect pushes may have been missed: every list reads the feed once.
    onResync: () => liveChanges.push(0),
  });
});
if (typeof window !== "undefined") (window as unknown as { __MULTIES_LIVE_CHANGES__?: LiveChanges }).__MULTIES_LIVE_CHANGES__ = liveChanges;

/** Whether the live socket is open (lists slow their poll to the safety net). */
export function useLiveChangesOpen() {
  return useSyncExternalStore(liveChanges.subscribeState, liveChanges.getLive, () => false);
}

/** The poll interval for a paged list: the normal one while the socket is down, the safety net while it is open. */
export function listPollMs(live: boolean, normal: number) {
  const o = (globalThis as { __MULTIES_LIST_POLL_MS?: { live?: number; fallback?: number } }).__MULTIES_LIST_POLL_MS;
  if (live) return o?.live ?? Math.max(normal, LIVE_LIST_POLL_MS);
  return o?.fallback ?? normal;
}
