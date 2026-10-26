/**
 * R31: the command menu loads on demand. This small host listens for Cmd+K and the open event, loads
 * the menu's code on first use (or when the browser is idle), and keeps the first keypress: the menu
 * opens as soon as its code arrives.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { OPEN_PALETTE_EVENT } from "@/web/lib/shortcuts";

const load = () => import("./command-palette");
const CommandPalette = lazy(load);

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
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const idle = w.requestIdleCallback ? w.requestIdleCallback(() => { void load(); }, { timeout: 4000 }) : window.setTimeout(() => { void load(); }, 2500);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
      if (w.cancelIdleCallback) w.cancelIdleCallback(idle as number); else clearTimeout(idle as number);
    };
  }, []);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette open={open} onOpenChange={(v) => { setOpen(v); if (!v) setPage(null); }} onSignOut={onSignOut} page={page} onPage={setPage} />
    </Suspense>
  );
}
