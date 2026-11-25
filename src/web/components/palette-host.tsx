/**
 * R31: the command menu loads on demand. This small host listens for Cmd+K and the open event, loads
 * the menu's code on first use (or when the browser is idle), and keeps the first keypress: the menu
 * opens as soon as its code arrives.
 */
import { Suspense, useEffect, useState } from "react";
import { OPEN_PALETTE_EVENT } from "@/web/lib/shortcut-events";
import { lazyPage } from "@/web/components/lazy-page";
import { shouldHoldBack } from "@/web/lib/prefetch";

const load = () => import("./command-palette");
const CommandPalette = lazyPage(load, "default", { quiet: true });

type IdleWin = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** R74: warms the menu's code once the page has loaded and gone idle; skipped on a slow connection. Returns a stop. */
export function warmPaletteWhenSettled(win: IdleWin = window, doc: Pick<Document, "readyState"> = document, nav = navigator as Parameters<typeof shouldHoldBack>[0], warm: () => unknown = load): () => void {
  if (shouldHoldBack(nav)) return () => undefined;
  let idle: number | undefined;
  let timer: number | undefined;
  const schedule = () => {
    // A further pause after load, so the page's own reads and images finish first.
    timer = win.setTimeout(() => {
      idle = win.requestIdleCallback ? win.requestIdleCallback(() => { void warm(); }, { timeout: 6000 }) : win.setTimeout(() => { void warm(); }, 1000);
    }, 3000);
  };
  if (doc.readyState === "complete") schedule();
  else win.addEventListener("load", schedule, { once: true });
  return () => {
    win.removeEventListener("load", schedule);
    if (timer !== undefined) win.clearTimeout(timer);
    if (idle !== undefined) { if (win.cancelIdleCallback) win.cancelIdleCallback(idle); else win.clearTimeout(idle); }
  };
}

export function PaletteHost({ onSignOut }: { onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setWanted(true);
        setPage(null);
        setOpen((v) => !v);
      }
    };
    const onOpen = (e: Event) => {
      setWanted(true);
      setPage((e as CustomEvent<{ page?: string }>).detail?.page ?? null);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    // Fetch the menu's code when the browser is idle, so the first Cmd+K opens at once.
    // R74: only after the page has finished loading, and not at all on a slow or data saving connection (there the
    // menu loads on first use), so its 25 KB never competes with the page someone is waiting for.
    const stopWarm = warmPaletteWhenSettled();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
      stopWarm();
    };
  }, []);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette open={open} onOpenChange={(v) => { setOpen(v); if (!v) setPage(null); }} onSignOut={onSignOut} page={page} onPage={setPage} />
    </Suspense>
  );
}
