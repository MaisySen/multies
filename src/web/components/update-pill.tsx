/**
 * R32: the quiet "new version" pill, bottom centre. Reload, or dismiss for this release.
 * A critical release reloads on the next route change, after a short notice.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useIsMutating } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconClose, IconRotate } from "@/web/components/ui/icon";
import { DISMISS_KEY, fetchVersion, watchRelease, type VersionInfo } from "@/web/lib/update-check";
import { applyServiceWorkerUpdate, serviceWorkerUpdateWaiting, SW_UPDATE_EVENT } from "@/web/lib/sw-client";

/** R32: with the service worker, a waiting worker takes over first so the reload opens the new release. */
const reloadApp = () => { if (serviceWorkerUpdateWaiting()) applyServiceWorkerUpdate(); else window.location.reload(); };

const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } };

export function UpdatePill() {
  const [state, setState] = useState<"none" | "prompt" | "critical">("none");
  const [latest, setLatest] = useState<VersionInfo | null>(null);
  const location = useLocation();
  const first = useRef(location.key);
  // Never reload while a change is still being saved (it would be lost); wait for the next page change after it lands.
  const saving = useIsMutating() > 0;

  useEffect(() => watchRelease({
    fetchVersion, isHidden: () => document.visibilityState === "hidden", dismissed: readDismissed,
    setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: (id) => window.clearInterval(id as number),
    onFocus: (fn) => { window.addEventListener("focus", fn); return () => window.removeEventListener("focus", fn); },
    onChange: (s, v) => {
      setState(s); setLatest(v);
      if (s === "critical") toast("Multies has an important update. It will load when you next change page.", { id: "update-critical", duration: 8000 });
    },
  }), []);

  // The service worker found a new release before the version check did: offer the same pill.
  useEffect(() => {
    const onWaiting = () => {
      setLatest((v) => v ?? { release: "service-worker", critical: false });
      setState((s) => (s === "none" ? "prompt" : s));
    };
    window.addEventListener(SW_UPDATE_EVENT, onWaiting);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onWaiting);
  }, []);

  useEffect(() => {
    if (state === "critical" && location.key !== first.current && !saving) reloadApp();
    first.current = location.key;
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state !== "prompt" || !latest) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, latest.release); } catch { /* private mode */ } setState("none"); };
  return (
    <div role="status" aria-live="polite" data-testid="update-pill"
      className="fixed inset-x-0 bottom-[calc(1.25rem+var(--tabbar-h,0px))] z-50 mx-auto flex w-max max-w-[calc(100vw-2rem)] items-center gap-1 rounded-full border border-line bg-surface/95 py-1 pl-4 pr-1 text-[13px] text-fg shadow-lg backdrop-blur motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      <span>A new version of Multies is ready</span>
      <button type="button" onClick={reloadApp}
        className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-[#0071E3] px-3 py-1 font-medium text-white transition-colors duration-150 hover:bg-[#0077ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] focus-visible:ring-offset-2">
        <IconRotate className="h-3.5 w-3.5" aria-hidden />Reload
      </button>
      <button type="button" onClick={dismiss} aria-label="Dismiss until the next version"
        className="grid h-7 w-7 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]">
        <IconClose className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
