/**
 * R32: a quiet strip at the top of the app while this browser has no connection. With the service worker the
 * shell still opens offline; this says why lists may be out of date, and goes away by itself on reconnect.
 * R33: when a list on screen is a stored copy (offline-lists.ts) the strip says from when.
 */
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { copyTimeLabel, useShownCopyAt } from "@/web/lib/offline-lists";

export function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const copyAt = useShownCopyAt();
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  if (!offline && copyAt === null) return null;
  return (
    <div role="status" data-testid="offline-banner" className="flex items-center justify-center gap-2 border-b border-line bg-surface px-4 py-2 text-[13px] text-muted">
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      {copyAt !== null
        ? <span data-testid="offline-copy-at">Offline. Showing your last copy from {copyTimeLabel(copyAt)}.</span>
        : <span>You are offline. Multies shows what it has and catches up when you reconnect.</span>}
    </div>
  );
}
