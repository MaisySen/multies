import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/web/lib/cn";

/** Modal built on the native <dialog>: focus trapping, Esc and inert background come for free. */
export function Dialog({ open, onClose, title, description, children, footer, className }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-line-strong bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/60 backdrop:backdrop-blur-sm open:animate-pop-in",
        className,
      )}
    >
      {open && (
        <div>
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-mr-2 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="px-6 py-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
