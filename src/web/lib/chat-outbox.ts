/**
 * Round 33: the chat outbox. Every message the tab sends gets a client id and waits here as a
 * pending bubble until the server's ack names that id; then the server's message takes its place.
 *
 * - Hold: while the live socket is connecting or reconnecting and has not sent its first frame
 *   ("hello"), sends wait in order. They go the moment hello arrives, or after HOLD_MAX_MS when
 *   the socket stays down (chat then works by polling, and sending must not stop with it).
 * - One at a time, in order, so messages land in the order they were written.
 * - A send that fails on the network goes back in the queue and is tried once more after the
 *   next hello (the server dedupes by client id, so the retry can never make a second message).
 *   A second failure, a refusal (4xx) or no answer in SEND_TIMEOUT_MS shows "Not sent, tap to
 *   retry". A tap queues it again.
 *
 * Pure logic with an injected sender and clock, so the tests drive it without a browser.
 */
import { randomFloat } from "@/shared/random";
export const HOLD_MAX_MS = 4_000;
export const SEND_TIMEOUT_MS = 12_000;
/** Automatic tries per client id: the first send and exactly one retry after a reconnect. */
export const AUTO_TRIES = 2;

export type OutboxState = "queued" | "sending" | "failed";
export interface OutboxItem {
  clientMsgId: string;
  channelId: string;
  parentId: string | null;
  /** R96: the topic a new message goes into. */
  topicId?: string | null;
  body: string;
  state: OutboxState;
  tries: number;
  createdAt: number;
  error?: string;
}
export interface Ack { type: "ack"; reply_to: string; ok: boolean; message?: { id: string; ts: string }; deduped?: boolean }
export type SendResult = { ok: true; ack: Ack; message: unknown } | { ok: false; retryable: boolean; error: string };
export type Sender = (item: OutboxItem) => Promise<SendResult>;

export interface OutboxClock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; random(): number }
const realClock: OutboxClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as never),
  random: randomFloat,
};

/** A client id: send time in base 36 (9 characters) and 12 random base 36 characters. */
export function newClientMsgId(now = Date.now(), random: () => number = randomFloat) {
  let rand = "";
  for (let i = 0; i < 12; i++) rand += Math.floor(random() * 36).toString(36);
  return now.toString(36).padStart(9, "0") + rand;
}

/** Whether held sends may go now: the socket said hello, or it has been down longer than the hold. */
export function canFlush(s: { ready: boolean; heldSince: number | null; now: number; holdMaxMs?: number }) {
  if (s.ready) return true;
  if (s.heldSince === null) return false;
  return s.now - s.heldSince >= (s.holdMaxMs ?? HOLD_MAX_MS);
}

/** The pending bubbles for one list (a channel's top level, or one thread), oldest first. */
export function pendingFor(items: readonly OutboxItem[], channelId: string, parentId: string | null) {
  return items.filter((i) => i.channelId === channelId && (i.parentId ?? null) === (parentId ?? null));
}

export class ChatOutbox {
  items: OutboxItem[] = [];
  /** Server messages by client id, kept briefly so a list that has not refetched yet can show them. */
  readonly acked = new Map<string, { id: string; message: unknown }>();
  private ready = false;
  private heldSince: number | null = null;
  private holdTimer: unknown = null;
  private flushing = false;
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private snapshot: OutboxItem[] = [];

  constructor(private readonly opts: { send: Sender; onAcked?: (clientMsgId: string, message: unknown) => void; clock?: OutboxClock }) {}
  private get clock() { return this.opts.clock ?? realClock; }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snapshot;
  private changed() {
    this.snapshot = this.items.slice();
    for (const fn of this.listeners) fn();
  }

  /** The live socket's state: true once hello arrived on the current socket, false while it is down. */
  setReady(ready: boolean) {
    const was = this.ready;
    this.ready = ready;
    if (ready) {
      this.heldSince = null;
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
      if (!was) this.flush();
    } else if (was || this.heldSince === null) {
      this.heldSince = this.clock.now();
    }
  }

  /** Adds a send; it goes now when the socket is ready, else after hello or the hold. */
  enqueue(input: { channelId: string; parentId?: string | null; body: string; clientMsgId?: string; topicId?: string | null }) {
    const item: OutboxItem = {
      clientMsgId: input.clientMsgId ?? newClientMsgId(this.clock.now(), () => this.clock.random()),
      channelId: input.channelId, parentId: input.parentId ?? null, topicId: input.topicId ?? null, body: input.body,
      state: "queued", tries: 0, createdAt: this.clock.now(),
    };
    this.items.push(item);
    this.changed();
    this.flush();
    return item.clientMsgId;
  }

  /** "Tap to retry": queues a failed send again (same client id, so it can never land twice). */
  retry(clientMsgId: string) {
    const item = this.items.find((i) => i.clientMsgId === clientMsgId);
    if (!item || item.state !== "failed") return;
    item.state = "queued";
    item.tries = 0;
    item.error = undefined;
    this.changed();
    this.flush();
  }

  /** Drops a failed send for good. */
  discard(clientMsgId: string) {
    this.items = this.items.filter((i) => i.clientMsgId !== clientMsgId);
    this.changed();
  }

  /** A live event or a list read showed the server's copy: the pending bubble is done. */
  settle(clientMsgId: string, message?: { id: string }) {
    const had = this.items.some((i) => i.clientMsgId === clientMsgId);
    if (message) this.acked.set(clientMsgId, { id: message.id, message });
    if (!had) return;
    this.clock.clearTimeout(this.timers.get(clientMsgId));
    this.timers.delete(clientMsgId);
    this.items = this.items.filter((i) => i.clientMsgId !== clientMsgId);
    this.changed();
  }

  flush() {
    if (this.flushing) return;
    const now = this.clock.now();
    if (!canFlush({ ready: this.ready, heldSince: this.heldSince, now })) {
      if (!this.items.some((i) => i.state === "queued")) return;
      if (this.heldSince === null) this.heldSince = now;
      if (!this.holdTimer) {
        const wait = Math.max(0, HOLD_MAX_MS - (now - this.heldSince));
        this.holdTimer = this.clock.setTimeout(() => { this.holdTimer = null; this.flush(); }, wait);
      }
      return;
    }
    const next = this.items.find((i) => i.state === "queued");
    if (!next) return;
    this.flushing = true;
    void this.sendOne(next).finally(() => { this.flushing = false; this.flush(); });
  }

  private async sendOne(item: OutboxItem) {
    item.state = "sending";
    item.tries++;
    this.changed();
    const id = item.clientMsgId;
    this.timers.set(id, this.clock.setTimeout(() => {
      // No answer in time: show "Not sent". A late ack still settles it.
      const it = this.items.find((i) => i.clientMsgId === id);
      if (it && it.state === "sending") { it.state = "failed"; it.error = "timeout"; this.changed(); }
    }, SEND_TIMEOUT_MS));
    let r: SendResult;
    try { r = await this.opts.send(item); } catch (e) { r = { ok: false, retryable: true, error: (e as Error).message || "network" }; }
    this.clock.clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const it = this.items.find((i) => i.clientMsgId === id);
    if (r.ok && r.ack.ok && r.ack.reply_to === id) {
      this.opts.onAcked?.(id, r.message);
      this.settle(id, r.ack.message ? { ...(r.message as object), id: r.ack.message.id } : undefined);
      return;
    }
    if (!it) return;
    const retryable = !r.ok && r.retryable;
    if (retryable && it.tries < AUTO_TRIES) {
      // Back in line; it goes again after the next hello (or the hold), exactly once more.
      it.state = "queued";
      this.ready = false;
      if (this.heldSince === null) this.heldSince = this.clock.now();
    } else {
      it.state = "failed";
      it.error = r.ok ? "not acknowledged" : r.error;
    }
    this.changed();
  }
}
