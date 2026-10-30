/**
 * Undo send: the browser holds a finished message for a few seconds before it
 * is posted, so a slip (wrong person, missing attachment, a typo in the first
 * line) can be taken back. Nothing reaches the server during the hold, so an
 * undone message leaves no trace and costs no database writes.
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
      if (s !== "holding" && s !== "sending") { held.delete(id); settle(s); }
      notify();
    };

    const fire = async (): Promise<R | undefined> => {
      if (state !== "holding") return undefined;
      if (timer !== null) { clock.clearTimeout(timer); timer = null; }
      set("sending");
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
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type SendHold = ReturnType<typeof createSendHold>;
