/**
 * Undo send: the browser holds a finished message for a few seconds before it
 * is posted, so a slip (wrong person, missing attachment, a typo in the first
 * line) can be taken back. Nothing reaches the server during the hold, so an
 * undone message leaves no trace and costs no database writes. R111: if the page
 * is closed during the hold, the message is handed to the server at that moment
 * (a request that outlives the page, same Idempotency-Key), so it is never lost
 * and never sent twice.
 *
 * This module is the timing core with no DOM or React in it, so it runs the
 * same in the web app, in the Expo app and in unit tests.
 */

/** The hold lengths a person can pick, in seconds. */
export const UNDO_SEND_CHOICES = [5, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];
export const UNDO_SEND_DEFAULT: UndoSendSeconds = 10;
/** Where the choice is kept on the device (localStorage on the web, AsyncStorage on mobile). */
export const UNDO_SEND_STORAGE_KEY = "multies-undo-send-seconds";

/** Reads a stored value back, falling back to the default for anything unknown. */
export function parseUndoSeconds(raw: unknown): UndoSendSeconds {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return (UNDO_SEND_CHOICES as readonly number[]).includes(n) ? (n as UndoSendSeconds) : UNDO_SEND_DEFAULT;
}

export type HeldState = "holding" | "sending" | "sent" | "undone" | "failed";

export interface HeldSend<R = unknown> {
  id: string;
  /** Epoch ms when the message is posted if nobody undoes it. */
  dueAt: number;
  seconds: number;
  state: () => HeldState;
  /** Whole seconds left in the hold, never below 0. */
  remaining: () => number;
  /** Takes the message back. True when it was still held; false once it has started sending. */
  undo: () => boolean;
  /** Skips the rest of the hold and posts now. */
  sendNow: () => Promise<R | undefined>;
  /** Settles when the message is sent, undone or has failed. */
  done: Promise<HeldState>;
}

export interface HoldOptions<R> {
  seconds: number;
  /** Posts the message. Called at most once per hold. */
  send: () => Promise<R>;
  onSent?: (result: R) => void;
  onError?: (error: unknown) => void;
  onUndo?: () => void;
  /** Any change of state, for screens that show the queue. */
  onChange?: (state: HeldState) => void;
  /**
   * R111 (undo send survives tab close): how to hand the message to the server when the page goes away during the
   * hold. `ready` says whether it can be handed over right now (its request is built and small enough for a request
   * that outlives the page); `fire` sends that request. The request carries the same Idempotency-Key as `send`, so if
   * the page comes back (back/forward cache) and the hold resumes, the server replays the first answer and the
   * message still goes exactly once.
   */
  exit?: { ready: () => boolean; fire: () => void };
}

export interface Clock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * A queue of held messages. Each message keeps its own timer, so two quick
 * sends are two holds, and "undo" with no id takes back the newest one.
 */
export function createSendHold(clock: Clock = realClock) {
  const held = new Map<string, HeldSend<unknown>>();
  /** R111: per hold, how to hand it over when the page goes and how to pick it up again if the page comes back. */
  const controls = new Map<string, { leave: () => boolean; resume: () => void; safe: () => boolean }>();
  const listeners = new Set<() => void>();
  let seq = 0;
  const notify = () => listeners.forEach((l) => l());

  function hold<R>(opts: HoldOptions<R>): HeldSend<R> {
    const id = `hold_${++seq}`;
    const seconds = Math.max(0, opts.seconds);
    const dueAt = clock.now() + seconds * 1000;
    let state: HeldState = "holding";
    let timer: unknown = null;
    let settle!: (s: HeldState) => void;
    const done = new Promise<HeldState>((r) => { settle = r; });
    const set = (s: HeldState) => {
      state = s;
      opts.onChange?.(s);
      if (s !== "holding" && s !== "sending") { held.delete(id); controls.delete(id); settle(s); }
      notify();
    };

    /** R111: true once the message was handed to the server as the page went away. */
    let handedOff = false;
    const post = async (): Promise<R | undefined> => {
      try {
        const r = await opts.send();
        set("sent");
        opts.onSent?.(r);
        return r;
      } catch (e) {
        set("failed");
        opts.onError?.(e);
        return undefined;
      }
    };
    const fire = async (): Promise<R | undefined> => {
      if (state !== "holding") return undefined;
      if (timer !== null) { clock.clearTimeout(timer); timer = null; }
      set("sending");
      return post();
    };

    const h: HeldSend<R> = {
      id, dueAt, seconds, done,
      state: () => state,
      remaining: () => Math.max(0, Math.ceil((dueAt - clock.now()) / 1000)),
      undo: () => {
        if (state !== "holding") return false;
        if (timer !== null) { clock.clearTimeout(timer); timer = null; }
        set("undone");
        opts.onUndo?.();
        return true;
      },
      sendNow: fire,
    };
    held.set(id, h as HeldSend<unknown>);
    controls.set(id, {
      // The page is going away: hand the message over now (the person can no longer undo it), never twice.
      leave: () => {
        if (state !== "holding" || !opts.exit?.ready()) return false;
        if (timer !== null) { clock.clearTimeout(timer); timer = null; }
        handedOff = true;
        set("sending");
        try { opts.exit.fire(); } catch { /* the rescue copy on the device covers a request that never left */ }
        return true;
      },
      // The page came back (back/forward cache): post again under the same key; the server answers with the first send.
      resume: () => {
        if (!handedOff || state !== "sending") return;
        handedOff = false;
        void post();
      },
      safe: () => state !== "holding" || !!opts.exit?.ready(),
    });
    timer = clock.setTimeout(() => { void fire(); }, seconds * 1000);
    notify();
    return h;
  }

  return {
    hold,
    /** Messages still inside their hold, oldest first. */
    pending: () => [...held.values()].filter((h) => h.state() === "holding"),
    /** Undoes one message by id, or the newest held one. */
    undo: (id?: string) => {
      const list = [...held.values()].filter((h) => h.state() === "holding");
      const target = id ? list.find((h) => h.id === id) : list[list.length - 1];
      return target ? target.undo() : false;
    },
    /** True while any message is held or on its way, so leaving the page would lose it. */
    busy: () => [...held.values()].some((h) => h.state() === "holding" || h.state() === "sending"),
    /** R111: the page is going away. Hands every held message that can be handed over to the server; returns how many were. */
    leave: () => [...controls.values()].filter((c) => c.leave()).length,
    /** R111: the page came back from the back/forward cache; handed over messages are confirmed under the same key. */
    resume: () => { [...controls.values()].forEach((c) => c.resume()); },
    /** R111: true while a held message could not be handed over if the page closed now (so the page asks first). */
    atRisk: () => [...controls.values()].some((c) => !c.safe()),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type SendHold = ReturnType<typeof createSendHold>;
