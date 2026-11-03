/**
 * Chat message actions on phones and touch screens (R25 wave 2). The inline action row takes about
 * 120 px beside every message on a 390 px screen, so there the actions live in one sheet opened from
 * a single More button or a long press. Kept free of React so the rules are unit tested
 * (tests/phone2-r25.test.ts); the hooks that use them are in ./use-compact.ts.
 */

export type MessageActionId = "react" | "thread" | "copy" | "translate" | "read" | "triage" | "task" | "pin" | "unpin" | "edit" | "delete" | "report" | "block";
export interface MessageAction { id: MessageActionId; label: string; danger?: boolean }

export interface MessageActionInput {
  deleted: boolean;
  /** The message is shown inside an open thread (replies have no "Reply in thread"). */
  inThread: boolean;
  /** I wrote it: only the author edits. */
  mine: boolean;
  /** My role in the workspace: an owner or admin may delete anyone's message (the server rule). */
  role?: string | null;
  /** Pinning exists in channels, not direct messages, and only for top level messages. */
  canPin: boolean;
  isReply: boolean;
  pinned: boolean;
  canTriage: boolean;
  hasText: boolean;
  /** R35: someone else's message from a person (not an agent or the system): Report message and Block. */
  canReport?: boolean;
  authorName?: string;
  /** R116: Translate and Read aloud (TRANSLATE_R116). */
  lang?: boolean;
}

/** The actions a person may take on one message, in the order the sheet lists them. */
export function messageActions(i: MessageActionInput): MessageAction[] {
  if (i.deleted) return [];
  const out: MessageAction[] = [{ id: "react", label: "React" }];
  if (!i.inThread) out.push({ id: "thread", label: "Reply in thread" });
  if (i.hasText) out.push({ id: "copy", label: "Copy text" });
  if (i.lang && i.hasText) out.push({ id: "translate", label: "Translate" }, { id: "read", label: "Read aloud" }); // R116
  if (i.canTriage) out.push({ id: "triage", label: "Send to triage" });
  out.push({ id: "task", label: "Make task" });
  if (i.canPin && !i.isReply) out.push(i.pinned ? { id: "unpin", label: "Unpin" } : { id: "pin", label: "Pin to channel" });
  if (i.mine) out.push({ id: "edit", label: "Edit" });
  if (i.mine || i.role === "owner" || i.role === "admin") out.push({ id: "delete", label: "Delete", danger: true });
  if (i.canReport && !i.mine) {
    out.push({ id: "report", label: "Report message" });
    out.push({ id: "block", label: i.authorName ? `Block ${i.authorName}` : "Block", danger: true });
  }
  return out;
}

/** How long a finger rests before the actions open, and how far it may drift (a scroll cancels). */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressTimers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const realTimers: LongPressTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * A long press recogniser for one element: start on touch down, move on touch move, end on touch up
 * or cancel. It fires once the finger has rested LONG_PRESS_MS without moving more than the slop;
 * a second finger, a scroll or lifting early cancels. `consumeClick()` answers whether the click the
 * browser sends after the finger lifts belongs to the long press (so a press on a link chip opens the
 * actions without also following the link).
 */
export function createLongPress(onLongPress: () => void, opts: { ms?: number; slop?: number; timers?: LongPressTimers } = {}) {
  const ms = opts.ms ?? LONG_PRESS_MS;
  const slop = opts.slop ?? LONG_PRESS_SLOP_PX;
  const timers = opts.timers ?? realTimers;
  let handle: unknown = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = () => { if (handle !== null) timers.clear(handle); handle = null; origin = null; };
  return {
    start(x: number, y: number, touches = 1) {
      cancel();
      fired = false;
      if (touches !== 1) return;
      origin = { x, y };
      handle = timers.set(() => { handle = null; origin = null; fired = true; onLongPress(); }, ms);
    },
    move(x: number, y: number) {
      if (!origin) return;
      if (Math.hypot(x - origin.x, y - origin.y) > slop) cancel();
    },
    end() { cancel(); },
    cancel,
    /** True once for the click that follows a long press. */
    consumeClick() { const f = fired; fired = false; return f; },
    get pending() { return handle !== null; },
    get fired() { return fired; },
  };
}
export type LongPress = ReturnType<typeof createLongPress>;
