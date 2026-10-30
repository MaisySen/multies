import { useEffect, useState, useSyncExternalStore } from "react";
import { secureStorage } from "./storage";

/**
 * Kept in step with app/src/shared/undo-send.ts (the web app's copy); the two repos ship apart.
 *
 * Undo send: the app holds a finished message for a few seconds before it
 * is posted, so a slip (wrong person, missing attachment, a typo in the first
 * line) can be taken back. Nothing reaches the server during the hold, so an
 * undone message leaves no trace and costs no database writes.
 *
 * This module is the timing core with no DOM or React in it, so it runs the
 * same on the phone, on the web and in unit tests.
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

// ---- Phone side: the chosen hold, the live queue, and putting a taken back message into Compose.


/** One queue for the app, so a held message keeps counting after Compose closes. */
export const sendHold = createSendHold();

let seconds: UndoSendSeconds = UNDO_SEND_DEFAULT;
let loaded: Promise<void> | null = null;
const secondsListeners = new Set<() => void>();
/** Reads the saved choice once; until then the default (10 seconds) applies. */
export function loadUndoSeconds() {
  loaded ??= secureStorage.get(UNDO_SEND_STORAGE_KEY).then((v) => { seconds = parseUndoSeconds(v); secondsListeners.forEach((l) => l()); }).catch(() => {});
  return loaded;
}
export function getUndoSeconds() { return seconds; }
export async function setUndoSeconds(s: UndoSendSeconds) {
  seconds = parseUndoSeconds(s);
  secondsListeners.forEach((l) => l());
  await secureStorage.set(UNDO_SEND_STORAGE_KEY, String(seconds)).catch(() => {});
}
export function useUndoSeconds(): [UndoSendSeconds, (s: UndoSendSeconds) => void] {
  useEffect(() => { void loadUndoSeconds(); }, []);
  const v = useSyncExternalStore((fn) => { secondsListeners.add(fn); return () => { secondsListeners.delete(fn); }; }, getUndoSeconds, getUndoSeconds);
  return [v, (s) => { void setUndoSeconds(s); }];
}

/** What a held message carries for the bar, and for Compose if it is taken back. */
export interface HeldDraft { mailboxId: string; to: string; cc: string; subject: string; text: string; inReplyToId?: string; forwardOf?: string; toolFiles?: { token: string; name: string; bytes?: number }[] }
export interface HeldItem { hold: HeldSend<unknown>; draft: HeldDraft; label: string }

let items: HeldItem[] = [];
const itemListeners = new Set<() => void>();
const emit = () => itemListeners.forEach((l) => l());
export function trackHeld(item: HeldItem) {
  items = [...items, item];
  emit();
  void item.hold.done.then(() => { items = items.filter((i) => i !== item); emit(); });
}
/** Messages inside their hold or on their way, oldest first. */
export function useHeldItems() {
  return useSyncExternalStore((fn) => { itemListeners.add(fn); return () => { itemListeners.delete(fn); }; }, () => items, () => items);
}

let restore: HeldDraft | null = null;
/** Parks a taken back message for Compose to pick up when it opens. */
export function parkDraft(d: HeldDraft) { restore = d; }
export function takeParkedDraft() { const d = restore; restore = null; return d; }

/** Whole seconds left on a hold, refreshed four times a second while it shows. */
export function useRemaining(h: HeldSend<unknown>) {
  const [left, setLeft] = useState(h.remaining());
  useEffect(() => {
    const t = setInterval(() => setLeft(h.remaining()), 250);
    return () => clearInterval(t);
  }, [h]);
  return left;
}

export function recipientsLabel(to: string[]) {
  if (!to.length) return "";
  return to.length === 1 ? `to ${to[0]}` : `to ${to.length} people`;
}
