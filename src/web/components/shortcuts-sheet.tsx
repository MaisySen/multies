/**
 * R30: the keyboard shortcuts sheet ("?") and the global keys (? and G then a letter).
 * Everything it shows comes from the registry in lib/shortcuts.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { Dialog } from "@/web/components/ui/dialog";
import { Kbd } from "@/web/components/ui/misc";
import { OPEN_SHORTCUTS_EVENT, SHORTCUTS, displayKeys, filterShortcuts, groupShortcuts, isTypingTarget, readKey, type KeyState } from "@/web/lib/shortcuts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const groups = useMemo(() => groupShortcuts(filterShortcuts(SHORTCUTS, q)), [q]);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Press ? anywhere to see this again." className="max-w-xl">
      <label className="flex items-center gap-2 rounded-lg border border-line bg-fill px-3">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts"
          className="h-9 w-full bg-transparent text-[13.5px] text-fg outline-none placeholder:text-subtle" />
      </label>
      <div className="mt-4 max-h-[min(60vh,520px)] space-y-5 overflow-y-auto pr-1" data-testid="shortcuts-sheet">
        {groups.length === 0 && <p className="py-6 text-center text-sm text-muted">No shortcut matches “{q}”.</p>}
        {groups.map(({ group, items }) => (
          <section key={group} aria-label={group}>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{group}</h3>
            <ul className="divide-y divide-line">
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

/** Mounted once in the app layout: listens for ? and G then a letter, and for the open event from menus. */
export function ShortcutsHost() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const state = useRef<KeyState>({ pendingG: null });
  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector("dialog[open], [role=dialog]")) { state.current = { pendingG: null }; return; }
      const r = readKey(state.current, e, Date.now());
      state.current = r.state;
      if (r.action.kind === "sheet") { e.preventDefault(); setOpen(true); }
      else if (r.action.kind === "go") {
        // The second key belongs to the go to, not to the page (C on Mail would otherwise also compose).
        e.preventDefault(); e.stopImmediatePropagation();
        navigate(r.action.to);
      }
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen); window.removeEventListener("keydown", onKey, true); };
  }, [navigate]);
  return <ShortcutsSheet open={open} onClose={() => setOpen(false)} />;
}
