/**
 * R33: the toast a bulk mail action shows, as a small state machine (pure, so tests/bulk-toast-r33.test.ts covers it).
 *
 * pending   the request is on its way: "Archiving 3 conversations" with Cancel (nothing is confirmed yet; Cancel
 *           puts it back the moment the server answers)
 * running   a select all job is working through a big folder: "Archiving 1,240 of 3,100" with Undo
 * applied   confirmed: "Archived 3 conversations" with Undo for UNDO_MS (8 s, from the moment it was confirmed)
 * undoing   "Undoing..." (stays until the server is done)
 * undone    "Undone" for UNDONE_MS (1.5 s), then the toast closes
 * failed    "Couldn't archive 3 conversations." with Retry (the list is already put back)
 * closed    nothing shows
 */
import type { BulkAction } from "./mail-selection";

export const UNDONE_MS = 1500;
export type ToastPhase = "pending" | "running" | "applied" | "undoing" | "undone" | "failed" | "closed";
export interface ToastState {
  phase: ToastPhase; action: BulkAction; count: number; done: number; total: number;
  /** Cancel was pressed before the server confirmed: undo as soon as it does. */
  cancelAsked: boolean; undoable: boolean; failedUndo: boolean; folderLabel?: string;
}
export type ToastEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "confirmed"; count?: number }
  | { type: "undo" }
  | { type: "undone" }
  | { type: "failed" }
  | { type: "retry" }
  | { type: "expire" };

export function startToast(action: BulkAction, count: number, undoable: boolean, folderLabel?: string): ToastState {
  return { phase: "pending", action, count, done: 0, total: count, cancelAsked: false, undoable, failedUndo: false, folderLabel };
}

export function toastReduce(s: ToastState, e: ToastEvent): ToastState {
  switch (e.type) {
    case "progress":
      if (s.phase !== "pending" && s.phase !== "running") return s;
      return { ...s, phase: e.done >= e.total ? s.phase : "running", done: e.done, total: e.total, count: Math.max(s.count, e.total) };
    case "confirmed":
      if (s.phase !== "pending" && s.phase !== "running") return s;
      return { ...s, phase: "applied", count: e.count ?? s.count, done: e.count ?? s.total };
    case "undo":
      if (s.phase === "pending") return { ...s, cancelAsked: true };
      if ((s.phase === "applied" || s.phase === "running") && s.undoable) return { ...s, phase: "undoing" };
      if (s.phase === "failed" && s.failedUndo) return { ...s, phase: "undoing", failedUndo: false };
      return s;
    case "undone":
      return s.phase === "undoing" || s.phase === "pending" ? { ...s, phase: "undone", cancelAsked: false } : s;
    case "failed":
      if (s.phase === "undoing") return { ...s, phase: "failed", failedUndo: true };
      if (s.phase === "pending" || s.phase === "running") return { ...s, phase: "failed", failedUndo: false };
      return s;
    case "retry":
      if (s.phase !== "failed") return s;
      return s.failedUndo ? { ...s, phase: "undoing", failedUndo: false } : { ...s, phase: "pending", cancelAsked: false };
    case "expire":
      return s.phase === "applied" || s.phase === "undone" ? { ...s, phase: "closed" } : s;
  }
}

const n = (x: number) => x.toLocaleString("en-US");
const what = (count: number) => (count === 1 ? "1 conversation" : `${n(count)} conversations`);
const ING: Record<BulkAction, string> = {
  archive: "Archiving", inbox: "Moving to Inbox", spam: "Marking as spam", trash: "Moving to Trash", delete: "Deleting",
  read: "Marking as read", unread: "Marking as unread", star: "Starring", unstar: "Unstarring", move: "Moving", snooze: "Snoozing", unsnooze: "Bringing back",
};
const ED: Record<BulkAction, (w: string, to?: string) => string> = {
  archive: (w) => `Archived ${w}`, inbox: (w) => `Moved ${w} to Inbox`, spam: (w) => `Marked ${w} as spam`, trash: (w) => `Moved ${w} to Trash`,
  delete: (w) => `Deleted ${w} forever`, read: (w) => `Marked ${w} as read`, unread: (w) => `Marked ${w} as unread`, star: (w) => `Starred ${w}`,
  unstar: (w) => `Unstarred ${w}`, move: (w, to) => `Moved ${w}${to ? ` to ${to}` : ""}`, snooze: (w, to) => `Snoozed ${w}${to ? ` ${to}` : ""}`, unsnooze: (w) => `Brought back ${w}`,
};
const VERB: Record<BulkAction, string> = {
  archive: "archive", inbox: "move", spam: "mark", trash: "move", delete: "delete", read: "mark", unread: "mark", star: "star", unstar: "unstar", move: "move", snooze: "snooze", unsnooze: "bring back",
};

export interface ToastView { text: string; button: "Cancel" | "Undo" | "Retry" | null; /** ms before it closes by itself, or null to stay. */ autoClose: number | null; tone: "info" | "success" | "error" }

/** What the toast says and which button it shows, for a state. `undoMs` is the Undo window (8 s). */
export function toastView(s: ToastState, undoMs: number): ToastView {
  switch (s.phase) {
    case "pending": return { text: `${ING[s.action]} ${what(s.count)}`, button: s.undoable ? "Cancel" : null, autoClose: null, tone: "info" };
    case "running": return { text: `${ING[s.action]} ${n(s.done)} of ${n(s.total)}`, button: s.undoable ? "Undo" : null, autoClose: null, tone: "info" };
    case "applied": return { text: ED[s.action](what(s.count), s.folderLabel), button: s.undoable ? "Undo" : null, autoClose: undoMs, tone: "success" };
    case "undoing": return { text: "Undoing...", button: null, autoClose: null, tone: "info" };
    case "undone": return { text: "Undone", button: null, autoClose: UNDONE_MS, tone: "success" };
    case "failed": return s.failedUndo
      ? { text: "Couldn't undo that. Check your connection and try again.", button: "Retry", autoClose: null, tone: "error" }
      : { text: `Couldn't ${VERB[s.action]} ${what(s.count)}. Nothing changed.`, button: "Retry", autoClose: null, tone: "error" };
    case "closed": return { text: "", button: null, autoClose: 0, tone: "info" };
  }
}
