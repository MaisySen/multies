/**
 * OPS1: the operator console shell at /console. Its own frame (not the workspace app's): a sidebar with five groups
 * filtered by the operator's permissions, a top bar with the environment, the operator's role and Back to app.
 * Everything inside is behind ConsoleGuard (pages/console/guard.tsx).
 */
import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "@/web/components/logo";
import { AppearanceControl } from "@/web/components/theme";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconArrowLeft, IconClose, IconMenu } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { consoleKeys, consoleRetry } from "@/web/lib/console-api";
import { ConsoleGuard, useConsoleMe } from "@/web/pages/console/guard";
import { navFor } from "@/web/pages/console/nav";

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const me = useConsoleMe();
  const groups = navFor(me.permissions);
  return (
    <nav aria-label="Operator console" className="flex flex-col gap-5 px-3 py-4" data-testid="console-sidebar">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-2 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-subtle">{g.label}</p>
          <ul className="space-y-0.5">
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink to={i.to} end={i.end} onClick={onNavigate}
                  className={({ isActive }) => cn("flex min-h-9 items-center gap-2.5 rounded-lg px-2 text-[13.5px] transition-colors duration-100",
                    isActive ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:bg-hover hover:text-fg")}>
                  <i.icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{i.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const me = useConsoleMe();
  const prod = me.environment.mode === "production";
  // Below md only the menu, the logo, the environment and an icon for Back to app fit (no sideways scroll at 360 px);
  // the theme switcher moves into the menu there.
  return (
    <header className="sticky top-0 z-20 flex h-14 min-w-0 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:gap-3 sm:px-4" data-testid="console-topbar">
      <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" aria-label="Open the console menu" onClick={onMenu}><IconMenu className="h-5 w-5" aria-hidden /></Button>
      <Link to="/console" className="flex shrink-0 items-center gap-2" aria-label="Operator console home">
        <Logo className="h-6" decorative />
        <span className="hidden text-sm font-semibold sm:inline">Operator console</span>
      </Link>
      <span className="shrink-0"><Badge tone={prod ? "bad" : "neutral"} dot>{prod ? "Production" : "Development"}</Badge></span>
      <span className="hidden text-xs text-subtle lg:inline" title="Release">{me.environment.release}</span>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="hidden min-w-0 text-right text-xs leading-tight md:block">
          <span className="block truncate font-medium text-fg">{me.user.email}</span>
          <span className="block text-subtle" data-testid="console-role">{me.roleLabel}</span>
        </span>
        <span className="sr-only md:hidden">{me.roleLabel}</span>
        <div className="hidden md:block"><AppearanceControl /></div>
        <Link to="/app/my-work" aria-label="Back to app" title="Back to app"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg">
          <IconArrowLeft className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">Back to app</span>
        </Link>
      </div>
    </header>
  );
}

function Frame() {
  const me = useConsoleMe();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg text-fg" data-testid="console-shell">
      <TopBar onMenu={() => setOpen(true)} />
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-line lg:block">
          <Sidebar />
        </aside>
        {open && (
          <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-modal="true" aria-label="Console menu">
            <button type="button" className="absolute inset-0 bg-black/30" aria-label="Close the console menu" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-surface">
              <div className="flex h-14 items-center justify-between px-4">
                <span className="text-sm font-semibold">Operator console</span>
                <Button variant="ghost" size="icon" aria-label="Close the console menu" onClick={() => setOpen(false)}><IconClose className="h-5 w-5" aria-hidden /></Button>
              </div>
              <Sidebar onNavigate={() => setOpen(false)} />
              <div className="border-t border-line px-5 py-4 md:hidden">
                <p className="truncate text-xs font-medium text-fg">{me.user.email}</p>
                <p className="mb-3 text-xs text-subtle">{me.roleLabel}</p>
                <AppearanceControl />
              </div>
            </div>
          </div>
        )}
        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Suspense fallback={<div className="space-y-4" aria-busy="true"><Skeleton className="h-9 w-56" /><Skeleton className="h-64 rounded-xl" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export function ConsoleLayout() {
  const qc = useQueryClient();
  // Every ["console", ...] read shows the server's answer straight away instead of retrying it (consoleRetry).
  useState(() => qc.setQueryDefaults(consoleKeys.all, { retry: consoleRetry }));
  return (
    <div className="min-h-dvh bg-bg">
      <ConsoleGuard><Frame /></ConsoleGuard>
    </div>
  );
}
