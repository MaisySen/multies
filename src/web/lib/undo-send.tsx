import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { IconSend, IconUndo } from "@/web/components/ui/icon";
import {
  createSendHold, parseUndoSeconds, UNDO_SEND_STORAGE_KEY,
  type HeldSend, type UndoSendSeconds,
} from "@/shared/undo-send";
import { Kbd } from "@/web/components/ui/misc";
import { buttonClass } from "@/web/components/ui/button";
import { readMeCache } from "./me-cache"; // PRIV1b (P52)
import { scopeOf } from "./offline-lists"; // PRIV1b (P52)

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
  // R111: closing the tab during the hold no longer loses the message. On pagehide each held message is handed to the
  // server with a request that outlives the page (same Idempotency-Key as the normal send); if the page comes back from
  // the back/forward cache the hold posts again under that key and the server replays the first answer, so it goes once.
  window.addEventListener("pagehide", () => { sendHold.leave(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) sendHold.resume(); });
  window.addEventListener("beforeunload", (e) => {
    // Only a message that can't be handed over (its files are too big for a request that outlives the page) asks first.
    if (!sendHold.atRisk()) return;
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
  /**
   * R111: the same request `send` makes, for handing the message over if the page closes during the hold.
   * `body` returns undefined until it is built (files still being read). `draft` is what goes back into Compose
   * on the next visit if the page closed before the request could leave.
   */
  handoff?: { path: string; key: string; body: () => unknown; draft: unknown; hadFiles?: boolean };
}

export function recipientsLabel(to: string[]) {
  if (!to.length) return "";
  return to.length === 1 ? `to ${to[0]}` : `to ${to.length} people`;
}

/** Holds a message for the chosen seconds with a toast that counts down and offers Undo and Send now. */
export function holdMessage<R>(o: HoldMessageOptions<R>): HeldSend<R> {
  wireGlobals();
  const toastId = `undo-send-${crypto.randomUUID()}`;
  const ho = o.handoff;
  const dueAt = Date.now() + Math.max(0, o.seconds) * 1000;
  if (ho) rescueAdd({ key: ho.key, dueAt, label: recipientsLabel(o.to), draft: ho.draft, hadFiles: !!ho.hadFiles });
  const done = () => { if (ho) rescueRemove(ho.key); };
  const h = sendHold.hold<R>({
    seconds: o.seconds,
    send: o.send,
    onSent: (r) => { done(); toast.dismiss(toastId); o.onSent(r); },
    onError: (e) => { done(); toast.dismiss(toastId); o.onError(e); },
    onUndo: () => { done(); toast.dismiss(toastId); o.onUndo(); },
    exit: ho ? keepaliveExit(ho.path, ho.key, ho.body) : undefined,
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

// ---------------------------------------------------------------- R111: undo send survives tab close

/** Browsers cap the bodies of requests that outlive the page (keepalive) at 64 KB in total; stay under it. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/** A keepalive POST of the same request the hold would make, with the same Idempotency-Key. */
export function keepaliveExit(path: string, key: string, body: () => unknown, doFetch: typeof fetch = (...a) => fetch(...a)) {
  let json: string | null = null;
  const build = () => {
    if (json !== null) return json;
    const b = body();
    if (b === undefined) return null;
    json = JSON.stringify(b);
    return json;
  };
  return {
    ready: () => { const j = build(); return j !== null && new TextEncoder().encode(j).length <= KEEPALIVE_MAX_BYTES; },
    fire: () => {
      const j = build();
      if (j === null) return;
      void doFetch(`/api${path}`, {
        method: "POST", keepalive: true, credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": key }, body: j,
      }).catch(() => { /* the copy on this device brings it back next visit */ });
    },
  };
}

/**
 * A copy of each held message on this device, written when the hold starts and removed when it is sent, undone or
 * fails in this page. A copy still here after its hold time means the page closed first: the next visit asks the
 * server whether it went (by its key) and, if it did not, puts it back in Compose. Files are not kept (only that
 * there were some), so nothing large or private sits in storage.
 */
export const HELD_RESCUE_KEY = "multies-held-sends";
/** PRIV1b (P52): each copy names the person and workspace it belongs to; clearOfflineData drops the key at sign out. */
export interface HeldRescue { key: string; dueAt: number; label: string; draft: unknown; hadFiles: boolean; userId?: string; orgId?: string }
/** PRIV1b (P52): who is signed in here: the saved /account/me copy, which follows sign in, sign out and workspace switch. */
const currentOwner = () => scopeOf(readMeCache());
function rescueRead(): HeldRescue[] {
  try { const v = JSON.parse(localStorage.getItem(HELD_RESCUE_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rescueWrite(list: HeldRescue[]) {
  try { if (list.length) localStorage.setItem(HELD_RESCUE_KEY, JSON.stringify(list)); else localStorage.removeItem(HELD_RESCUE_KEY); } catch { /* private mode */ }
}
/** Strips File objects (they can't be stored) and keeps the rest of the draft. */
function storableDraft(d: unknown): unknown {
  if (!d || typeof d !== "object") return d;
  return { ...(d as Record<string, unknown>), files: [] };
}
export function rescueAdd(r: HeldRescue) {
  const o = r.userId ? { userId: r.userId, orgId: r.orgId } : currentOwner() ?? {};
  rescueWrite([...rescueRead().filter((x) => x.key !== r.key), { ...r, ...o, draft: storableDraft(r.draft) }]);
}
export function rescueRemove(key: string) { rescueWrite(rescueRead().filter((x) => x.key !== key)); }

export type HeldStatus = "sent" | "pending" | "failed" | "unknown";
/** A copy is only looked at well after its hold ended, so a live hold in another tab is never mistaken for a closed one. */
export const RESCUE_GRACE_MS = 20_000;
/** A handed over send still "pending" after this long was cut off; it goes back to Compose instead of waiting forever. */
export const RESCUE_PENDING_MAX_MS = 10 * 60_000;

/** What to do with each leftover copy, given the server's answer. Pure, for tests. */
export function rescueDecision(r: HeldRescue, status: HeldStatus, now: number): "sent" | "wait" | "reopen" {
  if (status === "sent") return "sent";
  if (status === "pending" && now - r.dueAt < RESCUE_PENDING_MAX_MS) return "wait";
  return "reopen";
}

let recovering = false;
/**
 * Runs once when the app opens: each message whose page closed during its hold is either confirmed as sent or put
 * back in Compose. Never sends anything itself, so nothing can go twice.
 */
export async function recoverHeldSends(opts: {
  now?: number;
  /** PRIV1b (P52): the signed in person and workspace; nothing is looked at until they are known. */
  owner?: { userId: string; orgId: string } | null;
  status?: (key: string) => Promise<HeldStatus>;
  reopen?: (draft: unknown) => void;
  notify?: (kind: "sent" | "reopen", r: HeldRescue) => void;
} = {}) {
  if (recovering) return;
  recovering = true;
  try {
    const now = opts.now ?? Date.now();
    const owner = opts.owner === undefined ? currentOwner() : opts.owner;
    if (!owner) return;
    // PRIV1b (P52): a copy of another person (or one with no owner) is dropped, never reopened: on a shared computer it
    // would show the last person's message to the next one. Another workspace of the same person waits for it.
    const all = rescueRead();
    const mine = all.filter((r) => r.userId === owner.userId);
    if (mine.length !== all.length) rescueWrite(mine);
    const due = mine.filter((r) => r.orgId === owner.orgId && now - r.dueAt > RESCUE_GRACE_MS);
    const status = opts.status ?? (async (key: string) => {
      const { api } = await import("@/web/lib/api");
      return (await api.get<{ state: HeldStatus }>(`/mail/held-status?key=${encodeURIComponent(key)}`)).state;
    });
    for (const r of due) {
      let st: HeldStatus;
      try { st = await status(r.key); } catch { continue; } // offline: try again next visit
      const d = rescueDecision(r, st, now);
      if (d === "wait") continue;
      rescueRemove(r.key);
      if (d === "sent") { (opts.notify ?? notifyRescue)("sent", r); continue; }
      (opts.notify ?? notifyRescue)("reopen", r);
      (opts.reopen ?? ((x) => reopenDraft(x, "failed")))(r.draft);
    }
  } finally { recovering = false; }
}
function notifyRescue(kind: "sent" | "reopen", r: HeldRescue) {
  if (kind === "sent") toast.success(`Sent ${r.label}`.trim(), { description: "The page closed while it was held, so it went when you left." });
  else toast.error("The page closed before your message could send.", { description: r.hadFiles ? "It's back in Compose. Attach the files again, then send." : "It's back in Compose, ready to send." });
}
