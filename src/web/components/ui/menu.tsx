import { useEffect, useRef, useState, type ReactNode, cloneElement, isValidElement } from "react";
import { cn } from "@/web/lib/cn";

/** Small accessible dropdown: click or Enter to open, Esc / outside click to close, arrow keys to move. */
/** sheet: on a phone the menu opens as a sheet from the bottom of the screen instead of a small dropdown. */
export function Menu({ trigger, children, align = "end", label, sheet }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end"; label?: string; sheet?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      // R82F (MB-282): Escape puts focus back on the button that opened the menu, so keyboard users keep their place.
      if (e.key === "Escape") { setOpen(false); ref.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>
        {isValidElement<Record<string, unknown>>(trigger)
          ? cloneElement(trigger, { "aria-haspopup": "menu", "aria-expanded": open, ...(label && !trigger.props["aria-label"] ? { "aria-label": label } : {}) })
          : trigger}
      </div>
      {open && sheet && <div className="fixed inset-0 z-40 bg-black/30 sm:hidden" aria-hidden onClick={() => setOpen(false)} />}
      {open && (
        <div role="menu" onClick={() => setOpen(false)} className={cn("absolute z-50 mt-1.5 min-w-48 animate-pop-in rounded-[var(--radius-r14)] border border-line bg-elevated p-1 shadow-pop", align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
          sheet && "max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:left-2 max-sm:right-2 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[70dvh] max-sm:overflow-y-auto max-sm:animate-sheet-up max-sm:rounded-2xl max-sm:p-2 max-sm:pb-[max(8px,env(safe-area-inset-bottom))]")}>
          {children}
        </div>
      )}
    </div>
  );
}

/** R79: checked makes the item one choice of a set (a radio in a menu, read out as checked or not). */
export function MenuItem({ children, onSelect, danger, icon, checked, hint }: { children: ReactNode; onSelect: () => void; danger?: boolean; icon?: ReactNode; checked?: boolean; hint?: ReactNode }) {
  return (
    <button
      type="button" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked} onClick={onSelect}
      className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-100 hover:bg-hover focus-visible:bg-hover max-sm:min-h-11 max-sm:text-[15px] [&_svg]:h-4 [&_svg]:w-4", danger ? "text-bad" : "text-fg/90")}
    >
      {icon}
      {children}
      {hint && <span className="ml-auto pl-3 text-[11.5px] text-subtle">{hint}</span>}
      {checked && <svg aria-hidden viewBox="0 0 16 16" className={cn("h-4 w-4 shrink-0 text-brand-hover", !hint && "ml-auto")}><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="truncate px-2.5 pb-1 pt-1.5 text-[12px] text-subtle">{children}</div>;
}
