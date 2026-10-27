/**
 * R40 (MB-204): keep an open task fresh when it changes elsewhere. Tabs of the same browser tell each other
 * through a BroadcastChannel the moment a save lands; other people's changes arrive when the tab comes back
 * into view (focus or visibility) and through the panel's regular refresh.
 */
import { useEffect, useRef } from "react";

const CHANNEL = "multies-task-sync";
let channel: BroadcastChannel | null | undefined;
function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  return channel;
}

/** Tell the other tabs that this task changed (after a successful save). */
export function announceTaskChange(id: string, version?: number): void {
  try { getChannel()?.postMessage({ type: "task", id, version }); } catch { /* closed channel */ }
}

/** Calls `onChange` when the task changes in another tab, and when this tab comes back into view. */
export function useTaskChanges(id: string | null | undefined, onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!id) return;
    const ch = getChannel();
    const onMessage = (e: MessageEvent) => { if (e.data?.type === "task" && e.data.id === id) cb.current(); };
    const onVisible = () => { if (document.visibilityState === "visible") cb.current(); };
    ch?.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      ch?.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [id]);
}

/**
 * Whether a text field may take the server's new value: when the person has not typed since the last value
 * we showed them, or their text already matches the server. Otherwise their text stays and the save reports a conflict instead.
 */
export function mayAdopt(local: string, lastShown: string, server: string): boolean {
  // Untouched since we last showed it, or already the same as the server (for example right after our own save).
  return local === lastShown || local === server;
}
