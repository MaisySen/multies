/**
 * OPS1 impersonation: the bar at the very top of the app while an operator views or acts as someone
 * (/api/account/me session.impersonation). Fixed, high contrast and not dismissible: who you are viewing as, the mode,
 * a live countdown to the 30 minute limit, and Stop. Stop (and the limit running out) goes back to the operator's own
 * session and that person's page in the console. Nothing renders for anyone else.
 */
import { useEffect, useRef, useState } from "react";
import { IconEye, IconShieldAlert } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { clearOfflineData } from "@/web/lib/sw-client";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";

/** The bar's fixed height, and the room the app leaves for it: taller on phones, where Stop is a 44 px touch target. */
const BAR_HEIGHT = "2.75rem";
const BAR_HEIGHT_PHONE = "3.5rem";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ends the session: drops this person's copies kept in the browser, then asks the server to switch back. */
async function stopSession(userId: string): Promise<string> {
  const fallback = `/console/users/${encodeURIComponent(userId)}`;
  await clearOfflineData();
  try {
    const r = await api.post<{ ok: true; signedOut: boolean; returnTo: string }>("/console/impersonation/stop");
    return r.signedOut ? `/login?next=${encodeURIComponent(fallback)}` : (r.returnTo || fallback);
  } catch (e) {
    // Already over on the server (ended from the console, or expired): the operator signs in again.
    if (e instanceof ApiError && (e.status === 401 || e.status === 400)) return `/login?next=${encodeURIComponent(fallback)}`;
    throw e;
  }
}

export function ImpersonationBanner() {
  const me = useMe();
  const imp = me.data?.session?.impersonation ?? null;
  const user = me.data?.user;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const fired = useRef(false);
  // The server says how many seconds were left when /me answered, so a wrong clock on this computer does not matter.
  // After a reload the first /me is the copy saved in the browser (painted with updatedAt 0, queries.ts): its
  // secondsLeft is old and its time unknown, so there is no countdown (and no automatic Stop) until the fresh answer.
  const answered = me.dataUpdatedAt > 0;
  const deadline = imp && answered ? me.dataUpdatedAt + imp.secondsLeft * 1000 : 0;
  const left = answered ? Math.max(0, Math.round((deadline - now) / 1000)) : null;

  useEffect(() => {
    if (!imp) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [imp]);

  const stop = async (auto: boolean) => {
    if (!user || busy) return;
    setBusy(true);
    try {
      const to = await stopSession(user.id);
      if (auto) { setEnded(true); await new Promise((r) => window.setTimeout(r, 2500)); }
      window.location.assign(to);
    } catch (e) {
      setBusy(false);
      fired.current = false;
      showError(e as Error);
    }
  };

  useEffect(() => {
    if (!imp || fired.current || left === null || left > 3) return;
    fired.current = true;
    void stop(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imp, left]);

  if (!imp || !user) return null;
  const acting = imp.mode === "act";
  return (
    <>
      {/* Pushes the whole app down by the bar's height, so nothing hides behind it. */}
      <style>{`.app-shell{padding-top:${BAR_HEIGHT}}@media (max-width:639.98px){.app-shell{padding-top:${BAR_HEIGHT_PHONE}}}`}</style>
      <div role="region" aria-label="Viewing as another person" data-testid="impersonation-banner" data-mode={imp.mode}
        className={cn(
          "fixed inset-x-0 top-0 z-[90] flex h-14 items-center gap-2 overflow-hidden bg-fg px-3 text-bg shadow-[var(--shadow-e1)] sm:h-11 sm:gap-3 sm:px-4",
          // Acting changes things in their name: a warning edge sets it apart from view only at a glance.
          acting && "border-b-[3px] border-warn",
        )}>
        {acting ? <IconShieldAlert className="h-4 w-4 shrink-0" aria-hidden /> : <IconEye className="h-4 w-4 shrink-0" aria-hidden />}
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug max-sm:line-clamp-2 sm:truncate" aria-live="polite" data-testid="impersonation-banner-text">
          {ended
            ? "Your 30 minute session ended. Going back to the console."
            : <>{acting ? "Acting as" : "Viewing as"} <span className="font-semibold">{user.name}</span><span className="max-sm:hidden"> ({user.email})</span>{acting ? ". Changes are made in their name and recorded." : ", view only"}</>}
        </p>
        {!ended && left !== null && (
          <span className="shrink-0 font-mono text-[13px] tabular-nums" title={`Time left. Ends at ${new Date(deadline).toLocaleTimeString()}`} data-testid="impersonation-banner-countdown">
            {clock(left)}
          </span>
        )}
        <button type="button" onClick={() => void stop(false)} disabled={busy}
          className="h-8 shrink-0 rounded-md bg-bg px-3 text-[13px] font-semibold text-fg transition-opacity hover:opacity-90 disabled:opacity-60 max-sm:min-h-11"
          data-testid="impersonation-banner-stop">
          {busy ? "Stopping" : "Stop"}
        </button>
      </div>
    </>
  );
}
