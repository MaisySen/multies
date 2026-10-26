import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { IconClose, IconCookie } from "@/web/components/ui/icon";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { useSignedIn } from "@/web/lib/queries";

/** Marketing pages that get the phone's sticky call to action. Legal, contact and account pages don't. */
const STICKY_PAGES = new Set(["/", "/pricing", "/agents", "/check", "/trust", "/status", "/support"]);
const COOKIE_KEY = "multies.cookie-notice";

function readAck(): boolean {
  try { return localStorage.getItem(COOKIE_KEY) === "ok"; } catch { return true; }
}

/**
 * The bottom of public pages: a small, honest cookie notice (shown once, remembered on this device)
 * and, on phones, a sticky call to action once the page's own hero button has scrolled away.
 */
export function MarketingBottom() {
  const { pathname } = useLocation();
  const signedIn = useSignedIn();
  const [ack, setAck] = useState(true);
  const [heroGone, setHeroGone] = useState(false);
  useEffect(() => setAck(readAck()), []);
  const stickyPage = STICKY_PAGES.has(pathname.replace(/\/+$/, "") || "/") && !signedIn;

  useEffect(() => {
    setHeroGone(false);
    if (!stickyPage) return;
    // The page marks its own hero button with data-hero-cta. Without one, the bar appears after a screen of scrolling.
    const on = () => {
      const hero = document.querySelector("[data-hero-cta]");
      setHeroGone(hero ? hero.getBoundingClientRect().bottom < 64 : window.scrollY > window.innerHeight * 0.6);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); };
  }, [pathname, stickyPage]);

  const showSticky = stickyPage && heroGone;
  const dismiss = () => {
    try { localStorage.setItem(COOKIE_KEY, "ok"); } catch { /* private mode: hide for this visit only */ }
    setAck(true);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-stretch gap-2 sm:items-start sm:p-4">
      {!ack && (
        <div role="region" aria-label="Cookie notice" data-testid="cookie-banner"
          className="pointer-events-auto mx-3 mb-1 animate-fade-in rounded-2xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur-xl sm:mx-0 sm:mb-0 sm:max-w-sm">
          <div className="flex items-start gap-3">
            <IconCookie className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <p className="flex-1 text-[13px] leading-snug text-muted">
              We use only essential cookies to keep you signed in, and cookieless analytics. No tracking or advertising. <Link to="/privacy#cookies" className="font-medium text-fg underline underline-offset-2">Privacy</Link>
            </p>
            <button type="button" onClick={dismiss} aria-label="Close cookie notice" className="-m-1 inline-flex items-center justify-center rounded-md p-1 text-subtle hover:text-fg max-sm:-m-2.5 max-sm:h-10 max-sm:w-10"><IconClose className="h-4 w-4" aria-hidden /></button>
          </div>
          <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={dismiss} data-testid="cookie-ok">OK</Button>
        </div>
      )}
      <div data-testid="sticky-cta" aria-hidden={!showSticky}
        className={`border-t border-line bg-bg/85 px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 backdrop-blur-xl backdrop-saturate-150 transition-[transform,opacity] duration-250 ease-out sm:hidden ${showSticky ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none absolute inset-x-0 bottom-0 translate-y-full opacity-0"}`}>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-muted">Free for 1 domain and 3 mailboxes. No card.</p>
          <ButtonLink to="/signup" tabIndex={showSticky ? 0 : -1}>Start free</ButtonLink>
        </div>
      </div>
    </div>
  );
}
