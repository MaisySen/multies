/**
 * Round 32: live chat in the browser. One WebSocket per tab to GET /api/chat/live while chat is
 * open. Pushed events are merged into the TanStack Query cache, so a new message shows in about
 * a second without a refetch. While the socket is open the chat polls slow down to a 60 second
 * safety net; when it closes, polling goes back to 4 seconds (messages) and 15 seconds
 * (channels) on the next render, and the socket reconnects with backoff and jitter.
 *
 * Heartbeat: the tab sends "ping" every 25 seconds and the server answers "pong" without waking
 * anything (Durable Object auto response). No answer in 10 seconds means the socket is dead.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { ChatOutbox, type SendResult } from "./chat-outbox";

export const LIVE_PATH = "/api/chat/live";
export const PING_EVERY_MS = 25_000;
export const PONG_WAIT_MS = 10_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A full hub (close 4013): poll for this long before trying again. */
export const FULL_RETRY_MS = 5 * 60_000;
/** Typing beats go out at most this often. */
export const TYPING_SEND_MS = 3_000;
/** "is typing" hides this long after the last beat. */
export const TYPING_SHOW_MS = 6_000;
/** Polling while the socket is open, as a safety net. */
export const LIVE_POLL_MS = 60_000;

export type LiveState = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

/** What the hub pushes (see src/server/realtime/hub.ts). */
export type LiveEvent =
  | { t: "message"; op: "created" | "updated"; channelId: string; message: LiveMessage; clientMsgId?: string }
  | { t: "reactions"; channelId: string; messageId: string; reactions: unknown[] }
  | { t: "typing"; channelId: string; userId: string; name: string }
  | { t: "read"; channelId: string; userId: string; at: string }
  /** R47 (MB-139): the workspace change feed moved (task lists follow it, see live-changes-r47.ts). */
  | { t: "changes"; cursor: number };
/** R33: the server's first frame on a socket (see src/server/realtime/hub.ts ChatHello). */
export interface LiveHello { t: "hello"; serverTime: string; seq: number }
export interface LiveMessage { id: string; channelId: string; parentId: string | null; createdAt: string; replyCount?: number; lastReplyAt?: string | null; reactions?: unknown[]; [k: string]: unknown }

/** The parts of a browser WebSocket the connection uses (tests pass a fake). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  random(): number;
}
const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as never),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as never),
  random: () => Math.random(), // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator (reconnect jitter only)
};

/** Delay before reconnect attempt n (0 based): doubling from 1 s up to 30 s, each with plus or minus 30% jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.7 + random() * 0.6));
}

/**
 * The socket and its state machine: idle -> connecting -> open, and on any close or error
 * reconnecting -> connecting again after backoff. stop() ends it for good.
 */
export class LiveChatConnection {
  state: LiveState = "idle";
  /** True once a socket has opened: only then is a drop worth showing ("Reconnecting"). */
  everOpened = false;
  /** R33: true once the current socket sent its hello frame; false while connecting or down. */
  ready = false;
  /** R33: the highest hello seq seen; a lower one means the hub restarted (read once to catch up). */
  private lastSeq = -1;
  private ws: SocketLike | null = null;
  private attempt = 0;
  private retry: unknown = null;
  private pinger: unknown = null;
  private pongWait: unknown = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: {
    url: string;
    makeSocket: (url: string) => SocketLike;
    onEvent: (e: LiveEvent) => void;
    /** Called after a reconnect, so missed events are caught up with one read. */
    onResync?: () => void;
    /** R33: hello arrived (true) or the socket went away (false). The outbox holds sends until true. */
    onReady?: (ready: boolean) => void;
    clock?: Clock;
  }) {}

  private get clock() { return this.opts.clock ?? realClock; }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private setReady(ready: boolean) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReady?.(ready);
  }
  private set(state: LiveState) {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.state !== "idle" && this.state !== "stopped") return;
    this.connect();
  }

  stop() {
    this.clearTimers();
    this.clock.clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(1000, "bye"); } catch { /* closed */ } }
    this.setReady(false);
    this.set("stopped");
  }

  private connect() {
    this.set(this.everOpened || this.attempt > 0 ? "reconnecting" : "connecting");
    let ws: SocketLike;
    try { ws = this.opts.makeSocket(this.opts.url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      const again = this.everOpened;
      this.attempt = 0;
      this.everOpened = true;
      this.set("open");
      this.startHeartbeat();
      if (again) this.opts.onResync?.();
    };
    ws.onmessage = (ev) => {
      this.clock.clearTimeout(this.pongWait);
      this.pongWait = null;
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let e: LiveEvent;
      try { e = JSON.parse(ev.data) as LiveEvent; } catch { return; }
      if (e && (e as unknown as { t?: unknown }).t === "hello") {
        const h = e as unknown as LiveHello;
        const seq = typeof h.seq === "number" ? h.seq : 0;
        if (seq < this.lastSeq) this.opts.onResync?.();
        this.lastSeq = seq;
        this.setReady(true);
        return;
      }
      if (e && typeof e === "object" && typeof (e as { t?: unknown }).t === "string") this.opts.onEvent(e);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.setReady(false);
      if (ev.code === 4001) { this.attempt = 0; this.set("reconnecting"); this.retry = this.clock.setTimeout(() => this.connect(), 200 + Math.round(this.clock.random() * 500)); return; }
      if (ev.code === 4013) { this.set("reconnecting"); this.retry = this.clock.setTimeout(() => this.connect(), FULL_RETRY_MS); return; }
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    this.set("reconnecting");
    const delay = backoffDelay(this.attempt++, () => this.clock.random());
    this.retry = this.clock.setTimeout(() => { this.retry = null; this.connect(); }, delay);
  }

  private startHeartbeat() {
    this.pinger = this.clock.setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      try { ws.send("ping"); } catch { /* closing */ }
      this.clock.clearTimeout(this.pongWait);
      this.pongWait = this.clock.setTimeout(() => {
        // No answer: treat the socket as dead.
        if (this.ws !== ws) return;
        try { ws.close(4000, "no pong"); } catch { /* closed */ }
        ws.onclose?.({ code: 4000 });
      }, PONG_WAIT_MS);
    }, PING_EVERY_MS);
  }

  private clearTimers() {
    this.clock.clearInterval(this.pinger);
    this.clock.clearTimeout(this.pongWait);
    this.pinger = null;
    this.pongWait = null;
  }

  /** Test hook: drop the socket and do not come back (the tab polls from then on). */
  kill() {
    const ws = this.ws;
    this.clearTimers();
    this.clock.clearTimeout(this.retry);
    this.retry = null;
    this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(1000, "killed"); } catch { /* closed */ } }
    this.setReady(false);
    this.set("reconnecting");
  }

  /** Test hook (R33): drop the socket as a network blip would; it reconnects with backoff. */
  drop() {
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(4000, "dropped"); } catch { /* closed */ }
    ws.onclose?.({ code: 4000 });
  }
}

// ---------------------------------------------------------------- cache merge

type Msg = LiveMessage;
type ThreadData = { message: Msg; replies: Msg[] };

/** The list with this message in place (replaced by id, or added in time order when it is new). */
export function upsertMessage<T extends Msg>(list: T[] | undefined, m: T, opts: { addIfMissing: boolean }): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = { ...list[i], ...m, reactions: m.reactions ?? list[i].reactions };
    return next;
  }
  if (!opts.addIfMissing) return list;
  const next = [...list, m];
  if (list.length && list[list.length - 1].createdAt > m.createdAt) next.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return next;
}

/** The list with one message's reactions replaced. */
export function patchReactions<T extends Msg>(list: T[] | undefined, messageId: string, reactions: unknown[]): T[] | undefined {
  if (!list || !list.some((x) => x.id === messageId)) return list;
  return list.map((x) => (x.id === messageId ? { ...x, reactions } : x));
}

/** What to refetch later (debounced), after merging an event into the cache. */
export type Followup = "channels" | "unread" | "messages" | "pins";

/**
 * Merges one pushed event into the chat queries. Returns the queries that still need a
 * (debounced) refetch: the channel list for unread counts and new DMs, and a channel's messages
 * when a reply arrives for a thread nobody has open.
 */
export function applyLiveEvent(qc: Pick<QueryClient, "getQueryData" | "setQueryData" | "setQueriesData">, e: LiveEvent): Followup[] {
  if (e.t === "typing" || e.t === "changes") return [];
  if (e.t === "read") return ["channels", "unread"];
  if (e.t === "reactions") {
    qc.setQueryData<Msg[]>(["chat", "messages", e.channelId], (l) => patchReactions(l, e.messageId, e.reactions));
    qc.setQueryData<Msg[]>(["chat", "pins", e.channelId], (l) => patchReactions(l, e.messageId, e.reactions));
    // The message may be a thread's first message or one of its replies: patch any open thread.
    qc.setQueriesData<ThreadData>({ queryKey: ["chat", "thread"] }, (t) => {
      if (!t?.message) return t;
      const top = t.message.id === e.messageId ? { ...t.message, reactions: e.reactions } : t.message;
      return { ...t, message: top, replies: patchReactions(t.replies, e.messageId, e.reactions) ?? t.replies };
    });
    return [];
  }
  const m = e.message;
  const out: Followup[] = [];
  if (!m.parentId) {
    qc.setQueryData<Msg[]>(["chat", "messages", e.channelId], (l) => upsertMessage(l, m, { addIfMissing: e.op === "created" }));
    qc.setQueryData<ThreadData>(["chat", "thread", m.id], (t) => (t ? { ...t, message: { ...t.message, ...m, reactions: m.reactions ?? t.message.reactions } } : t));
    const pins = qc.getQueryData<Msg[]>(["chat", "pins", e.channelId]);
    const wasPinned = !!pins?.some((x) => x.id === m.id);
    if (pins && wasPinned !== !!m.pinnedAt) out.push("pins");
    else qc.setQueryData<Msg[]>(["chat", "pins", e.channelId], (l) => upsertMessage(l, m, { addIfMissing: false }));
  } else {
    const thread = qc.getQueryData<ThreadData>(["chat", "thread", m.parentId]);
    if (thread) {
      const known = thread.replies.some((x) => x.id === m.id);
      qc.setQueryData<ThreadData>(["chat", "thread", m.parentId], (t) => (t ? { ...t, replies: upsertMessage(t.replies, m, { addIfMissing: e.op === "created" }) ?? t.replies } : t));
      if (e.op === "created" && !known) {
        qc.setQueryData<Msg[]>(["chat", "messages", e.channelId], (l) => l?.map((x) => (x.id === m.parentId ? { ...x, replyCount: (x.replyCount ?? 0) + 1, lastReplyAt: m.createdAt } : x)));
      }
    } else if (e.op === "created") {
      out.push("messages");
    }
  }
  if (e.op === "created") out.push("channels", "unread");
  return out;
}

// ---------------------------------------------------------------- typing

type Typer = { userId: string; name: string; until: number };
/** Who is typing where, for the "is typing" line. Entries expire on their own. */
export class TypingStore {
  private byChannel = new Map<string, Typer[]>();
  private readonly listeners = new Set<() => void>();
  private snapshots = new Map<string, Typer[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { this.snapshots.clear(); for (const fn of this.listeners) fn(); }
  add(channelId: string, userId: string, name: string) {
    const until = this.now() + TYPING_SHOW_MS;
    const list = (this.byChannel.get(channelId) ?? []).filter((x) => x.userId !== userId && x.until > this.now());
    list.push({ userId, name, until });
    this.byChannel.set(channelId, list);
    this.emit();
  }
  /** A message from someone ends their typing at once. */
  remove(channelId: string, userId: string) {
    const list = this.byChannel.get(channelId);
    if (!list?.some((x) => x.userId === userId)) return;
    this.byChannel.set(channelId, list.filter((x) => x.userId !== userId));
    this.emit();
  }
  prune() {
    const now = this.now();
    let changed = false;
    for (const [k, list] of this.byChannel) {
      const keep = list.filter((x) => x.until > now);
      if (keep.length !== list.length) { changed = true; if (keep.length) this.byChannel.set(k, keep); else this.byChannel.delete(k); }
    }
    if (changed) this.emit();
  }
  /** A stable array per channel between changes (for useSyncExternalStore). */
  get(channelId: string): Typer[] {
    let s = this.snapshots.get(channelId);
    if (!s) { s = (this.byChannel.get(channelId) ?? []).filter((x) => x.until > this.now()); this.snapshots.set(channelId, s); }
    return s;
  }
}

/** "Maya is typing", "Maya and Sam are typing", "Several people are typing". */
export function typingText(names: string[]) {
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return "Several people are typing";
}

/** Sends a typing beat at most once per 3 seconds per channel. */
export function typingThrottle(send: (channelId: string) => void, now: () => number = () => Date.now()) {
  const last = new Map<string, number>();
  return (channelId: string) => {
    const t = now();
    if (t - (last.get(channelId) ?? -Infinity) < TYPING_SEND_MS) return false;
    last.set(channelId, t);
    send(channelId);
    return true;
  };
}

// ---------------------------------------------------------------- polling

/**
 * The poll interval for a chat query: the normal one while the socket is down, the 60 second
 * safety net while it is open. E2E can stretch both (window.__MULTIES_CHAT_POLL_MS).
 */
export function chatPollMs(live: boolean, normal: number) {
  const o = (globalThis as { __MULTIES_CHAT_POLL_MS?: { live?: number; fallback?: number } }).__MULTIES_CHAT_POLL_MS;
  if (live) return o?.live ?? Math.max(normal, LIVE_POLL_MS);
  return o?.fallback ?? normal;
}

// ---------------------------------------------------------------- React

function socketUrl() {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${LIVE_PATH}`;
}

/**
 * Opens the live socket while chat is mounted. Returns whether it is open (polling slows down),
 * whether to show "Reconnecting", the typing store and the throttled typing beat.
 */
export function useLiveChat(myId: string | undefined) {
  const qc = useQueryClient();
  const typing = useMemo(() => new TypingStore(), []);
  const conn = useRef<LiveChatConnection | null>(null);
  const [, force] = useState(0);
  const pending = useRef(new Set<Followup>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const me = useRef(myId);
  me.current = myId;
  // R33: sends wait in the outbox until the socket's hello (or the hold), then carry a client id.
  const outbox = useMemo(() => new ChatOutbox({
    send: async (item): Promise<SendResult> => {
      try {
        const r = await api.post<{ message: unknown; ack?: { type: "ack"; reply_to: string; ok: boolean; message?: { id: string; ts: string }; deduped?: boolean } }>(
          `/chat/channels/${encodeURIComponent(item.channelId)}/messages`, { body: item.body, parentId: item.parentId ?? undefined, topicId: item.topicId ?? undefined, clientMsgId: item.clientMsgId });
        return { ok: true, ack: r.ack ?? { type: "ack", reply_to: item.clientMsgId, ok: true, message: { id: (r.message as { id: string }).id, ts: "" } }, message: r.message };
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        return { ok: false, retryable: status === 0 || status >= 500 || status === 429, error: (e as Error).message };
      }
    },
    onAcked: (_id, message) => {
      // The server's copy goes straight into the list (no gap between the pending bubble and the row).
      const m = message as LiveMessage | undefined;
      if (m?.id && m.channelId) applyLiveEvent(qc, { t: "message", op: "created", channelId: m.channelId, message: m });
      void qc.invalidateQueries({ queryKey: ["chat", "channels"] });
    },
  }), [qc]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") { outbox.setReady(true); return; }
    const flush = () => {
      flushTimer.current = null;
      const keys = [...pending.current];
      pending.current.clear();
      for (const k of keys) {
        if (k === "channels") void qc.invalidateQueries({ queryKey: ["chat", "channels"] });
        if (k === "unread") void qc.invalidateQueries({ queryKey: ["chat", "unread"] });
        if (k === "messages") void qc.invalidateQueries({ queryKey: ["chat", "messages"] });
        if (k === "pins") void qc.invalidateQueries({ queryKey: ["chat", "pins"] });
      }
    };
    const c = new LiveChatConnection({
      url: socketUrl(),
      makeSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onEvent: (e) => {
        if (e.t === "changes") return; // R47: task lists listen on their own (live-changes-r47.ts)
        if (e.t === "typing") { if (e.userId !== me.current) typing.add(e.channelId, e.userId, e.name); return; }
        if (e.t === "message" && e.op === "created" && e.clientMsgId) outbox.settle(e.clientMsgId, e.message);
        if (e.t === "message" && e.op === "created") {
          const author = (e.message.author as { id?: string; type?: string } | undefined);
          if (author?.id) typing.remove(e.channelId, author.type === "agent" ? `agent:${author.id}` : author.id);
        }
        for (const f of applyLiveEvent(qc, e)) pending.current.add(f);
        if (pending.current.size && !flushTimer.current) flushTimer.current = setTimeout(flush, 1500);
      },
      onResync: () => { void qc.invalidateQueries({ queryKey: ["chat"] }); },
      onReady: (ready) => outbox.setReady(ready),
    });
    conn.current = c;
    const unsub = c.subscribe(() => force((n) => n + 1));
    c.start();
    const pruner = setInterval(() => typing.prune(), 1000);
    if ((globalThis as { __MULTIES_CHAT_POLL_MS?: unknown }).__MULTIES_CHAT_POLL_MS) {
      (window as unknown as { __MULTIES_LIVE_CHAT__?: LiveChatConnection }).__MULTIES_LIVE_CHAT__ = c;
      (window as unknown as { __MULTIES_CHAT_OUTBOX__?: ChatOutbox }).__MULTIES_CHAT_OUTBOX__ = outbox;
    }
    return () => { unsub(); clearInterval(pruner); if (flushTimer.current) clearTimeout(flushTimer.current); c.stop(); conn.current = null; };
  }, [qc, typing, outbox]);

  const beat = useMemo(() => typingThrottle((channelId) => { void api.post(`/chat/channels/${encodeURIComponent(channelId)}/typing`, {}).catch(() => undefined); }), []);
  const state = conn.current?.state ?? "idle";
  return {
    live: state === "open",
    degraded: !!conn.current?.everOpened && state !== "open" && state !== "stopped",
    typing,
    /** R33: the outbox (pending bubbles, retry). */
    outbox,
    /** Call on every keystroke; only sends while live chat works on this host. */
    onType: (channelId: string) => { if (conn.current?.everOpened) beat(channelId); },
  };
}

/** R33: the outbox's pending sends, re-rendered on every change. */
export function useOutbox(outbox: ChatOutbox) {
  return useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot);
}

/** The names typing in a channel right now. */
export function useTyping(store: TypingStore, channelId: string | undefined) {
  return useSyncExternalStore(store.subscribe, () => (channelId ? store.get(channelId) : EMPTY), () => EMPTY);
}
const EMPTY: Typer[] = [];
