import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "./icon";
import { cn } from "@/web/lib/cn";

/** Modal built on the native <dialog>: focus trapping, Esc and inert background come for free. */
export function Dialog({ open, onClose, title, description, children, footer, className }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // R56 (MB-243): showModal() focuses the first focusable element, the Close button, after React's autoFocus already
      // ran on a field that was not yet shown. A field asking for focus (data-autofocus, set by Input and Textarea) gets it back.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      // R41: only this dialog's own close counts; React passes a nested dialog's close (a picker sheet over a form) up
      // the tree, which used to close the form too.
      onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="dialog-title"
      className={cn(
        // Centred card on larger screens; a bottom sheet on phones, the way iOS presents a form.
        "m-auto w-[calc(100%-2rem)] max-w-lg rounded-[var(--radius-r20)] border border-line bg-elevated p-0 text-fg elev-3 backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:animate-pop-in open:backdrop:animate-fade-in max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] max-sm:open:animate-sheet-up",
        className,
      )}
    >
      {open && (
        <div>
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 id="dialog-title" className="text-[17px] font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-mr-2 grid place-items-center rounded-full p-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11" aria-label="Close">
              <IconClose className="h-4 w-4" />
            </button>
          </div>
          <div className="px-6 py-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
