import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { IconSend, IconUndo } from "@/web/components/ui/icon";
import {
  createSendHold, parseUndoSeconds, UNDO_SEND_STORAGE_KEY,
  type HeldSend, type UndoSendSeconds,
} from "@/shared/undo-send";
import { Kbd } from "@/web/components/ui/misc";
import { buttonClass } from "@/web/components/ui/button";

/** One queue for the whole tab, so a held message keeps counting down after Compose closes or the page changes. */
export const sendHold = createSendHold();

// The choice lives on this device only: no account field, no migration, no database write.
const listeners = new Set<() => void>();
function readSeconds(): UndoSendSeconds {
  try { return parseUndoSeconds(localStorage.getItem(UNDO_SEND_STORAGE_KEY)); } catch { return parseUndoSeconds(null); }
}
export function setUndoSeconds(s: UndoSendSeconds) {
  try { localStorage.setItem(UNDO_SEND_STORAGE_KEY, String(s)); } catch { /* private mode: the default stays */ }
  listeners.forEach((l) => l());
}
export function useUndoSeconds(): [UndoSendSeconds, (s: UndoSendSeconds) => void] {
  const v = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      const onStorage = (e: StorageEvent) => { if (e.key === UNDO_SEND_STORAGE_KEY) fn(); };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
    },
    readSeconds,
    () => parseUndoSeconds(null),
  );
  return [v, setUndoSeconds];
}

/** True when the key press came from somewhere a person types, where Z and Cmd+Z belong to the text. */
export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
}

let wired = false;
/** Z (or Cmd/Ctrl+Z) outside a text field takes back the newest held message; leaving the page asks first. */
function wireGlobals() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("keydown", (e) => {
    if (!sendHold.pending().length || isTypingTarget(e.target) || e.altKey || e.shiftKey) return;
    const plain = !e.metaKey && !e.ctrlKey && (e.key === "z" || e.key === "Z");
    const combo = (e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z");
    if (!plain && !combo) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendHold.undo();
  }, { capture: true });
  window.addEventListener("beforeunload", (e) => {
    if (!sendHold.busy()) return;
    e.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    e.returnValue = "";
  });
}

export interface HoldMessageOptions<R> {
  seconds: number;
  /** Who it goes to, for the toast: "to ana@acme.com" or "to 3 people". */
  to: string[];
  send: () => Promise<R>;
  onSent: (r: R) => void;
  onError: (e: unknown) => void;
  onUndo: () => void;
}

export function recipientsLabel(to: string[]) {
  if (!to.length) return "";
  return to.length === 1 ? `to ${to[0]}` : `to ${to.length} people`;
}

/** Holds a message for the chosen seconds with a toast that counts down and offers Undo and Send now. */
export function holdMessage<R>(o: HoldMessageOptions<R>): HeldSend<R> {
  wireGlobals();
  const toastId = `undo-send-${crypto.randomUUID()}`;
  const h = sendHold.hold<R>({
    seconds: o.seconds,
    send: o.send,
    onSent: (r) => { toast.dismiss(toastId); o.onSent(r); },
    onError: (e) => { toast.dismiss(toastId); o.onError(e); },
    onUndo: () => { toast.dismiss(toastId); o.onUndo(); },
  });
  toast.custom(() => <HeldToast h={h} label={recipientsLabel(o.to)} />, { id: toastId, duration: Infinity, unstyled: true, dismissible: false });
  return h;
}

const coarsePointer = () => { try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; } };

function HeldToast({ h, label }: { h: HeldSend; label: string }) {
  const [left, setLeft] = useState(h.remaining());
  const [sending, setSending] = useState(h.state() === "sending");
  useEffect(() => {
    const t = setInterval(() => { setLeft(h.remaining()); setSending(h.state() === "sending"); }, 250);
    return () => clearInterval(t);
  }, [h]);
  const pct = h.seconds ? Math.min(100, Math.max(0, ((h.dueAt - Date.now()) / (h.seconds * 1000)) * 100)) : 0;
  return (
    <div className="w-[min(calc(100vw-32px),356px)] overflow-hidden rounded-xl border border-line bg-elevated font-sans text-[13px] text-fg shadow-pop" data-testid="undo-send-toast">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/10 text-brand" aria-hidden><IconSend className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          {/* The visible countdown ticks; screen readers hear the hold once, not every second. */}
          <div className="whitespace-nowrap font-medium" aria-hidden>{sending ? "Sending" : `Sending in ${left} s`}</div>
          {label && <div className="truncate text-[12px] text-muted">{label}</div>}
          {/* R73 (MB-272): the address is read once (above), and phones are not told about a keyboard key. */}
          {/* R82F (MB-272): no second number here; it disagreed with the countdown ("9 s" beside "10 seconds"). */}
          <span className="sr-only">{`Held for a few seconds before it sends. ${coarsePointer() ? "Tap Undo" : "Press Z or use Undo"} to take it back.`}</span>
        </div>
        {!sending && (
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className={buttonClass("ghost", "icon", "text-muted")} onClick={() => void h.sendNow()} aria-label="Send now" title="Send now">
              <IconSend className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={buttonClass("secondary", "sm", "gap-1.5 px-2.5 font-semibold text-brand")} onClick={() => h.undo()} aria-keyshortcuts="Z">
              <IconUndo className="h-3.5 w-3.5" />Undo<span className="hidden sm:inline-flex" aria-hidden><Kbd>Z</Kbd></span>
            </button>
          </div>
        )}
      </div>
      <div className="h-0.5 bg-fill" aria-hidden><div className="h-full bg-brand transition-[width] duration-200 ease-linear" style={{ width: `${sending ? 100 : pct}%` }} /></div>
    </div>
  );
}

// A message taken back goes back into Compose. The mail page listens; if it isn't open, it picks the draft up when it mounts.
type Reopen<D> = { draft: D; reason: "undo" | "failed" };
let reopenQueue: Reopen<unknown>[] = [];
const reopenListeners = new Set<() => void>();
export function reopenDraft<D>(draft: D, reason: Reopen<D>["reason"]) {
  reopenQueue.push({ draft, reason });
  reopenListeners.forEach((l) => l());
  if (!reopenListeners.size) void import("@/web/router").then((m) => m.router.navigate("/app/mail"));
}
/** Calls back with each message taken back, oldest first. */
export function useReopenedDrafts<D>(onDraft: (d: D, reason: Reopen<D>["reason"]) => void) {
  useEffect(() => {
    const drain = () => {
      const q = reopenQueue; reopenQueue = [];
      q.forEach((r) => onDraft(r.draft as D, r.reason));
    };
    reopenListeners.add(drain);
    drain();
    return () => { reopenListeners.delete(drain); };
  });
}
