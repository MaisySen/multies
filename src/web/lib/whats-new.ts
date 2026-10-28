import { useCallback, useSyncExternalStore } from "react";
import { hasUnreadWhatsNew, latestWhatsNewId } from "@/shared/whats-new";

/**
 * R53 (MB-133): which "What's new" entry this browser last opened. localStorage only: no server write, no API.
 * Every hook instance (sidebar and phone top bar) hears a change at once through one in memory listener set.
 */
export const WHATS_NEW_SEEN_KEY = "multies-whats-new-seen";
const listeners = new Set<() => void>();

function read(): string | null {
  try { return localStorage.getItem(WHATS_NEW_SEEN_KEY); } catch { return null; }
}

export function markWhatsNewSeen() {
  const latest = latestWhatsNewId();
  if (!latest) return;
  try { localStorage.setItem(WHATS_NEW_SEEN_KEY, latest); } catch { /* storage blocked: the dot stays, nothing breaks */ }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === WHATS_NEW_SEEN_KEY) l(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
}

/** { unread, markSeen }: unread is true while the newest entry differs from the last one opened here. */
export function useWhatsNew() {
  const seen = useSyncExternalStore(subscribe, read, () => null);
  const markSeen = useCallback(() => markWhatsNewSeen(), []);
  return { unread: hasUnreadWhatsNew(seen), markSeen };
}
