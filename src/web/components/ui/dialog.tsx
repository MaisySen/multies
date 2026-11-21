import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "./icon";
import { cn } from "@/web/lib/cn";
// R58 (MB-245): an open dialog makes the page inert, so the "switched in another tab" strip shows inside it too.
import { WorkspaceSwitchedBanner } from "@/web/components/workspace-switched-banner-r58";

const FIRST_FIELD = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])';

/** Modal built on the native <dialog>: focus trapping, Esc and inert background come for free. */
export function Dialog({ open, onClose, title, description, children, footer, className, returnFocus }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string;
  /** F13: where focus goes on close when the opener is gone (a menu item that closed with its menu). */
  returnFocus?: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // OPS1: ids of this dialog's own title and description, so a dialog opened over another (a reason dialog over a
  // form) is named by its own title, not the first "dialog-title" in the page.
  const titleId = useId();
  const descriptionId = useId();
  // R115 (R99 low): the control that opened the dialog gets focus back on close, however it closed (Esc, Close, Done).
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      d.showModal();
      // R56 (MB-243): showModal() focuses the first focusable element, the Close button, after React's autoFocus already
      // ran on a field that was not yet shown. A field asking for focus (data-autofocus, set by Input and Textarea) gets it back.
      // POL2 (HQ MB-327): with no field asking, the first field to fill gets focus instead of Close.
      (d.querySelector<HTMLElement>("[data-autofocus]") ?? d.querySelector<HTMLElement>(FIRST_FIELD))?.focus();
    }
    if (!open && d.open) d.close();
    if (!open && wasOpen.current) {
      const saved = opener.current;
      opener.current = null;
      const back = saved?.isConnected ? saved : fallback.current?.() ?? null;
      const lost = !document.activeElement || document.activeElement === document.body || d.contains(document.activeElement);
      if (back && lost) back.focus();
    }
    wasOpen.current = open;
  }, [open]);
  return (
    <dialog
      ref={ref}
      // R41: only this dialog's own close counts; React passes a nested dialog's close (a picker sheet over a form) up
      // the tree, which used to close the form too.
      onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby={titleId}
      aria-describedby={open && description ? descriptionId : undefined}
      className={cn(
        // Centred card on larger screens; a bottom sheet on phones, the way iOS presents a form.
        "ds-dialog m-auto w-[calc(100%-2rem)] max-w-lg rounded-[var(--radius-r20)] border border-line bg-elevated p-0 text-fg elev-3 backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:animate-pop-in open:backdrop:animate-fade-in max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] max-sm:open:animate-sheet-up",
        className,
      )}
    >
      {open && (
        <div>
          <WorkspaceSwitchedBanner variant="dialog" />
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[17px] font-semibold">{title}</h2>
              {description && <p id={descriptionId} className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-mr-2 grid shrink-0 place-items-center rounded-full p-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11" aria-label="Close">
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
