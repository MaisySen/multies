import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { IconClose, IconCookie, IconMenu } from "@/web/components/ui/icon";
import { Logo } from "@/web/components/logo";
import { LegalLine } from "@/web/components/legal-line";
import { MarketingBottom } from "@/web/components/marketing-bottom";
import { ButtonLink } from "@/web/components/ui/button";
import { useSignedIn } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";

const links = [
  { to: "/#features", label: "Product" },
  { to: "/agents", label: "For agents" },
  { to: "/pricing", label: "Pricing" },
  { to: "/#faq", label: "FAQ" },
];

export function MarketingLayout() {
  const signedIn = useSignedIn();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname, loc.hash]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
    else window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);

  return (
    <div className="min-h-dvh overflow-x-clip">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-fg focus:px-3 focus:py-2 focus:text-bg">Skip to content</a>
      <header className={cn("fixed inset-x-0 top-0 z-50 transition-[background,border-color,backdrop-filter] duration-200", scrolled || open ? "border-b border-line bg-bg/75 backdrop-blur-xl" : "border-b border-transparent")}>
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5" aria-label="Main">
          <Link to="/" aria-label="Multies home"><Logo /></Link>
          <div className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-fg">{l.label}</NavLink>
            ))}
          </div>
          <div className="hidden items-center gap-2 md:flex">
            {signedIn ? (
              <ButtonLink to="/app" size="sm">Open dashboard</ButtonLink>
            ) : (
              <>
                <ButtonLink to="/login" variant="ghost" size="sm">Sign in</ButtonLink>
                <ButtonLink to="/signup" size="sm">Start free</ButtonLink>
              </>
            )}
          </div>
          <button className="rounded-md p-2 text-muted hover:text-fg md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"}>
            {open ? <IconClose className="h-5 w-5" /> : <IconMenu className="h-5 w-5" />}
          </button>
        </nav>
        {open && (
          <div className="animate-fade-in border-t border-line px-5 pb-5 pt-2 md:hidden">
            {links.map((l) => (
              <Link key={l.to} to={l.to} className="block rounded-md py-2.5 text-[15px] text-muted hover:text-fg">{l.label}</Link>
            ))}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {signedIn ? <ButtonLink to="/app" className="col-span-2">Open dashboard</ButtonLink> : (
                <>
                  <ButtonLink to="/login" variant="secondary">Sign in</ButtonLink>
                  <ButtonLink to="/signup">Start free</ButtonLink>
                </>
              )}
            </div>
          </div>
        )}
      </header>
      <main id="main"><Outlet /></main>
      <footer className="border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 md:grid-cols-5">
          <div className="space-y-3 md:col-span-2">
            <Logo />
            <p className="max-w-xs text-sm text-muted">Professional email on the domain you already own, with tasks, chat and agents built in.</p>
            <p className="text-sm text-muted">Questions? <Link to="/contact" className="font-medium text-brand-hover hover:underline">Contact us</Link></p>
          </div>
          <div>
            <h2 className="text-[13px] font-medium text-fg">Product</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><Link to="/#features" className="hover:text-fg">Features</Link></li>
              <li><Link to="/pricing" className="hover:text-fg">Pricing</Link></li>
              <li><Link to="/startups" className="hover:text-fg">Free for small teams</Link></li>
              <li><Link to="/switch" className="hover:text-fg">Move to Multies</Link></li>
              <li><Link to="/#faq" className="hover:text-fg">FAQ</Link></li>
              <li><Link to="/check" className="hover:text-fg">Check your domain</Link></li>
              <li><Link to="/status" className="hover:text-fg">System status</Link></li>
              <li><Link to="/changelog" className="hover:text-fg">What's new</Link></li>
              <li><Link to="/agents" className="hover:text-fg">Agent inboxes</Link></li>
              <li><a href="/api/v1/reference" className="hover:text-fg">API reference</a></li>
            </ul>
          </div>
          <div>
            <h2 className="text-[13px] font-medium text-fg">Account</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><Link to="/signup" className="hover:text-fg">Create account</Link></li>
              <li><Link to="/login" className="hover:text-fg">Sign in</Link></li>
              <li><Link to="/app" className="hover:text-fg">Dashboard</Link></li>
              <li><Link to="/contact" className="hover:text-fg">Contact</Link></li>
              <li><Link to="/support" className="hover:text-fg">Support</Link></li>
            </ul>
          </div>
          <div>
            <h2 className="text-[13px] font-medium text-fg">Legal</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><Link to="/privacy" className="hover:text-fg">Privacy</Link></li>
              <li><Link to="/terms" className="hover:text-fg">Terms</Link></li>
              <li><Link to="/acceptable-use" className="hover:text-fg">Acceptable use</Link></li>
              <li><Link to="/dpa" className="hover:text-fg">Data processing</Link></li>
              <li><Link to="/trust" className="hover:text-fg">Security and trust</Link></li>
            </ul>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-col gap-2 border-t border-line px-5 py-6 text-xs text-subtle max-sm:pb-28 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex flex-col gap-1">
            <span>© {new Date().getFullYear()} Multies. Built for small businesses and startups that own their domain.</span>
            <LegalLine />
          </span>
          <span data-testid="cookie-notice"><IconCookie className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />We use only essential cookies, to keep you signed in. No tracking or advertising cookies. <Link to="/privacy" className="underline underline-offset-2 hover:text-fg">Privacy</Link></span>
        </div>
      </footer>
      <MarketingBottom />
    </div>
  );
}
