import { useEffect, useRef, useState, type ReactNode, cloneElement, isValidElement } from "react";
import { cn } from "@/web/lib/cn";

/** Small accessible dropdown: click or Enter to open, Esc / outside click to close, arrow keys to move. */
export function Menu({ trigger, children, align = "end", label }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end"; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>
        {isValidElement<Record<string, unknown>>(trigger)
          ? cloneElement(trigger, { "aria-haspopup": "menu", "aria-expanded": open, ...(label && !trigger.props["aria-label"] ? { "aria-label": label } : {}) })
          : trigger}
      </div>
      {open && (
        <div role="menu" onClick={() => setOpen(false)} className={cn("absolute z-50 mt-1.5 min-w-48 animate-pop-in rounded-xl border border-line bg-elevated p-1 shadow-pop", align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left")}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onSelect, danger, icon }: { children: ReactNode; onSelect: () => void; danger?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button" role="menuitem" onClick={onSelect}
      className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-100 hover:bg-hover focus-visible:bg-hover max-sm:min-h-11 max-sm:text-[15px] [&_svg]:h-4 [&_svg]:w-4", danger ? "text-bad" : "text-fg/90")}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="truncate px-2.5 pb-1 pt-1.5 text-[12px] text-subtle">{children}</div>;
}
