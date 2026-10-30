/**
 * R30: the keyboard shortcuts sheet ("?"). R31: the global key handler reads the one command
 * registry (lib/commands): single keys, G then a letter, and keys on the focused task or message.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { IconSearch } from "@/web/components/ui/icon";
import { Dialog } from "@/web/components/ui/dialog";
import { Kbd } from "@/web/components/ui/misc";
import { OPEN_SHORTCUTS_EVENT, displayKeys, filterShortcuts, groupForPath, groupShortcuts, isTypingTarget, openPalette, sheetShortcuts } from "@/web/lib/shortcuts";
import { SEQUENCE_MS, activeScopes, commandById, getFocus, idleKeys, readKeys, runCommand, type CommandContext, type KeyState } from "@/web/lib/commands";
import { useAppearance } from "@/web/components/theme";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const { pathname } = useLocation();
  useEffect(() => { if (!open) setQ(""); }, [open]);
  // R31: read from the one command registry; the current page's keys come first.
  const groups = useMemo(() => groupShortcuts(filterShortcuts(sheetShortcuts(), q), groupForPath(pathname)), [q, pathname]);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description={`Press ? anywhere to see this again. Keys shown for ${isMac ? "Mac" : "Windows and Linux"}.`} className="max-w-3xl">
      <label className="flex items-center gap-2 rounded-lg border border-line bg-fill px-3">
        <IconSearch className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts"
          className="h-9 w-full bg-transparent text-[13.5px] text-fg outline-none placeholder:text-subtle" />
      </label>
      {/* R36: two columns of grouped cards on wide screens (the leading tracker's sheet layout), one column on a phone. */}
      <div className="mt-4 max-h-[min(64vh,560px)] gap-4 overflow-y-auto pr-1 md:columns-2 [&>section]:mb-4 [&>section]:break-inside-avoid" data-testid="shortcuts-sheet">
        {groups.length === 0 && <p className="py-6 text-center text-sm text-muted">No shortcut matches “{q}”.</p>}
        {groups.map(({ group, items }) => (
          <section key={group} aria-label={group}>
            <h3 className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-subtle"><span>{group}</span><span className="font-normal normal-case tracking-normal">{items.length}</span></h3>
            <ul className="divide-y divide-line rounded-xl border border-line bg-fill/40 px-3 elev-1">
              {items.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-[13.5px]" data-testid="shortcut-row">
                  <span className="text-fg">{s.label}</span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-subtle">
                    {displayKeys(s, isMac).map((k, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span aria-hidden>{s.sequence ? "then" : ""}</span>}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** Mounted once in the app layout: every single key and sequence from the command registry, and the open event from menus. */
export function ShortcutsHost() {
  const navigate = useNavigate();
  const location = useLocation();
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string[] | null>(null);
  const state = useRef<KeyState>(idleKeys());
  const path = useRef(location.pathname);
  path.current = location.pathname;
  const theme = useRef(appearance);
  theme.current = appearance;
  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const ctx: CommandContext = {
      navigate, openSheet: () => setOpen(true), openPalette,
      toggleTheme: () => theme.current.set(theme.current.resolved === "dark" ? "light" : "dark"),
    };
    const reset = () => { state.current = idleKeys(); setHint(null); };
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector("dialog[open], [role=dialog]:not([data-keys-pass])")) { reset(); return; }
      if (e.key === "Escape") {
        const close = commandById("mail-close");
        if (close && getFocus().kind === "mail" && runCommand(close, ctx)) e.preventDefault();
        return;
      }
      const r = readKeys(state.current, e, Date.now(), activeScopes(path.current, getFocus()));
      state.current = r.state;
      clearTimeout(hintTimer);
      if (r.result.kind === "pending") {
        e.preventDefault();
        setHint(r.result.keys);
        hintTimer = setTimeout(reset, SEQUENCE_MS);
        return;
      }
      setHint(null);
      // The key belongs to the command, not to the page (C on Mail after G would otherwise also compose).
      if (r.result.kind === "run" && runCommand(r.result.command, ctx)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    window.addEventListener("keydown", onKey, true);
    return () => { clearTimeout(hintTimer); window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen); window.removeEventListener("keydown", onKey, true); };
  }, [navigate]);
  return (
    <>
      <ShortcutsSheet open={open} onClose={() => setOpen(false)} />
      {hint && (
        <div role="status" aria-live="polite" data-testid="sequence-hint"
          className="pointer-events-none fixed bottom-4 left-4 z-[95] flex items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-3 py-2 text-[12.5px] text-muted shadow-pop backdrop-blur animate-fade-in motion-reduce:animate-none">
          {hint.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
          <span>then ...</span>
        </div>
      )}
    </>
  );
}
