import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/web/lib/cn";

/**
 * R75: a small panel that opens under a button and holds controls (selects, toggles), unlike Menu, which holds actions.
 * Click or Enter opens it; Esc or a click outside closes it and puts focus back on the button.
 */
export function Popover({ label, button, children, align = "start", className, testId }: { label: string; button: (p: { open: boolean }) => ReactNode; children: ReactNode; align?: "start" | "end"; className?: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button ref={btn} type="button" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} data-testid={testId}
        className="rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        {button({ open })}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} data-testid={testId ? `${testId}-panel` : undefined}
          className={cn("absolute z-50 mt-2 w-72 animate-pop-in rounded-[var(--radius-r14)] border border-line bg-elevated p-4 shadow-pop", align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left", className)}>
          {children}
        </div>
      )}
    </div>
  );
}
