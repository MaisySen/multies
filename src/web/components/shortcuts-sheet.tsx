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
import { useQuery, useQueryClient } from "@tanstack/react-query"; // TD10
import { useConfig } from "@/web/lib/queries"; // TD10
import { api } from "@/web/lib/api"; // TD10
import { showError } from "@/web/lib/show-error"; // TD10
import { Switch } from "@/web/components/ui/misc"; // TD10
import { inKeyWidget, isSingleKey, setCrmScopeOn, setSingleKeysOff, singleKeysOff } from "@/web/lib/shortcut-pref-td10"; // TD10

/** POL3 (MB-314): an element marked data-keys-own takes plain keys itself; no shortcut reads them. */
const ownsKeys = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && typeof el.closest === "function" && !!el.closest("[data-keys-own]"); };

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
      <div className="mt-4 max-h-[min(64vh,560px)] gap-4 overflow-y-auto pr-1 md:columns-2 [&>section]:mb-4 [&>section]:break-inside-avoid" data-testid="shortcuts-sheet" tabIndex={0} role="group" aria-label="All shortcuts">
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
      <SingleKeysSwitch />
    </Dialog>
  );
}

/** TD10: the per person switch for single key shortcuts (stored on the server, so it follows the person). */
function SingleKeysSwitch() {
  const on = !!useConfig().data?.crmTd10;
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["crm-td10-prefs"], enabled: on, staleTime: 300_000, queryFn: () => api.get<{ shortcutsOff: boolean }>("/crm-td10/prefs") });
  if (!on || !prefs.data) return null;
  const set = async (enabled: boolean) => {
    try {
      const r = await api.put<{ shortcutsOff: boolean }>("/crm-td10/prefs", { shortcutsOff: !enabled });
      setSingleKeysOff(r.shortcutsOff);
      qc.setQueryData(["crm-td10-prefs"], r);
    } catch (e) { showError(e as Error); }
  };
  return (
    <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-3" data-testid="single-keys-switch">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg">Single key shortcuts</div>
        <p className="text-[12.5px] text-muted">Turn off if you use a screen reader or speech input. Ctrl K and the menus still work.</p>
      </div>
      <Switch checked={!prefs.data.shortcutsOff} onChange={set} label="Single key shortcuts" />
    </div>
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
  // TD10: CRM keys and the single key switch, only while CRM_TD10 is on.
  const crmOn = !!useConfig().data?.crmTd10;
  const prefs = useQuery({ queryKey: ["crm-td10-prefs"], enabled: crmOn, staleTime: 300_000, retry: false, queryFn: () => api.get<{ shortcutsOff: boolean }>("/crm-td10/prefs") });
  setCrmScopeOn(crmOn);
  useEffect(() => { setSingleKeysOff(crmOn && !!prefs.data?.shortcutsOff); }, [crmOn, prefs.data?.shortcutsOff]);
  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const ctx: CommandContext = {
      navigate, openSheet: () => setOpen(true), openPalette,
      toggleTheme: () => theme.current.set(theme.current.resolved === "dark" ? "light" : "dark"),
    };
    const reset = () => { state.current = idleKeys(); setHint(null); };
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      // POL3 (MB-314): a control that owns the keys for a moment (Row while its new row is made) is skipped like a field.
      if (e.defaultPrevented || isTypingTarget(e.target) || ownsKeys(e.target) || document.querySelector("dialog[open], [role=dialog]:not([data-keys-pass])")) { reset(); return; }
      // TD10: single keys switched off for this person: nothing (here or on a page) reads them; chords still work.
      if (singleKeysOff() && isSingleKey(e)) { if (!inKeyWidget(e.target)) e.stopPropagation(); reset(); return; }
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
