import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { IconCheck } from "@/web/components/ui/icon";
import { Dialog } from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/cn";

/**
 * R41 (MB-209): pickers on a phone. Below the sm breakpoint a Select or time field shows a button in the field style;
 * tapping it opens the app's bottom sheet with every choice as a 48 px row. The real <select> or <input type="time">
 * stays in the page (visually hidden on phones, normal on desktop), so forms, labels, tests and onChange handlers
 * keep working: picking a row sets the element's value and fires a real change event.
 */

export interface SheetChoice { value: string; label: string; disabled?: boolean; group?: string }

/** Sets a form element's value the way a person would, so React's onChange runs (controlled or not). */
export function setNativeValue(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function choicesFromSelect(el: HTMLSelectElement): SheetChoice[] {
  return Array.from(el.options).map((o) => ({
    value: o.value, label: o.text, disabled: o.disabled,
    group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : undefined,
  }));
}

/** Every quarter hour of the day as HH:MM, the slots a phone time sheet offers. */
export function quarterHourSlots(step = 15): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

/** "09:30" -> "9:30 am" in the person's locale (falls back to the raw value). */
export function formatSlot(v: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return v;
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  try { return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch { return v; }
}

/** Accessible name for the phone button: aria-label, then the linked <label>. */
function nameOf(el: HTMLSelectElement | HTMLInputElement | null): string {
  if (!el) return "";
  return el.getAttribute("aria-label") || el.labels?.[0]?.textContent?.trim() || "";
}

export function PickerSheet({ open, title, choices, value, onPick, onClose }: {
  open: boolean; title: string; choices: SheetChoice[]; value: string; onPick: (v: string) => void; onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Bring the chosen row into view, the way a wheel opens on the current value.
    const t = setTimeout(() => listRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.scrollIntoView({ block: "center" }), 30);
    return () => clearTimeout(t);
  }, [open]);
  let lastGroup: string | undefined;
  return (
    <Dialog open={open} onClose={onClose} title={title || "Choose"} className="sm:hidden">
      <div ref={listRef} role="radiogroup" aria-label={title || "Choose"} data-testid="picker-sheet"
        className="-mx-6 -my-5 max-h-[60vh] overflow-y-auto overscroll-contain py-1">
        {choices.map((c, i) => {
          const header = c.group && c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          const on = c.value === value;
          return (
            <div key={`${c.value}-${i}`}>
              {header && <div className="px-6 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">{header}</div>}
              <button type="button" role="radio" aria-checked={on} disabled={c.disabled} onClick={() => onPick(c.value)}
                className={cn("flex min-h-12 w-full items-center gap-3 px-6 text-left text-[16px] transition-colors duration-150 active:bg-hover disabled:opacity-40 motion-reduce:transition-none",
                  on ? "font-semibold text-brand-hover" : "text-fg")}>
                <span className="min-w-0 flex-1 truncate">{c.label || "None"}</span>
                {on && <IconCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />}
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

const chevron = "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%238e8e93' stroke-width='1.6'><path d='M3 4.5 6 7.5 9 4.5'/></svg>\")] bg-[right_12px_center] bg-no-repeat";
export const phoneButtonClass = cn("flex h-11 w-full items-center rounded-lg border border-line-strong bg-surface pl-3 pr-9 text-left text-base text-fg transition-[border-color,box-shadow] duration-150 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 disabled:opacity-60 sm:hidden", chevron);

/** The phone half of an adaptive Select: reads options from the real select each time it opens. */
export function PhoneSelectButton({ selectRef, className, disabled }: {
  selectRef: RefObject<HTMLSelectElement | null>; className?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [choices, setChoices] = useState<SheetChoice[]>([]);
  const [value, setValue] = useState("");
  // Keep the shown label in step with the real select after every render (cheap: one DOM read; each set is guarded by
  // a compare, so it settles after one pass).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const s = selectRef.current;
    if (!s) return;
    const t = s.selectedOptions[0]?.text ?? "";
    if (t !== label) setLabel(t);
    const n = nameOf(s);
    if (n !== name) setName(n);
  });
  const show = () => {
    const s = selectRef.current;
    if (!s) return;
    setChoices(choicesFromSelect(s)); setValue(s.value); setOpen(true);
  };
  return (
    <>
      {/* The real select (visually hidden on phones) stays the accessible control, so screen readers, keyboards and
          tests find one labelled field; this button is the touch surface and is hidden from assistive tech. */}
      <button type="button" onClick={show} disabled={disabled} aria-hidden="true" tabIndex={-1} data-name={name}
        data-testid="phone-select" className={cn(phoneButtonClass, className, "max-sm:h-11")}>
        <span className="min-w-0 flex-1 truncate">{label || "Choose"}</span>
      </button>
      <PickerSheet open={open} title={name} choices={choices} value={value} onClose={() => setOpen(false)}
        onPick={(v) => { const s = selectRef.current; setOpen(false); if (s && s.value !== v) setNativeValue(s, v); setLabel(s?.selectedOptions[0]?.text ?? ""); }} />
    </>
  );
}

/** The phone half of a time field: a button with the time, opening a sheet of 15 minute slots. */
export function PhoneTimeButton({ inputRef, value, className, disabled }: {
  inputRef: RefObject<HTMLInputElement | null>; value?: string; className?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [current, setCurrent] = useState(value ?? "");
  // Same guarded per render read as the select button above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (el.value !== current) setCurrent(el.value);
    const n = nameOf(el);
    if (n !== name) setName(n);
  });
  const slots = quarterHourSlots();
  const choices: SheetChoice[] = (current && !slots.includes(current) ? [current, ...slots].sort() : slots).map((v) => ({ value: v, label: formatSlot(v) }));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} aria-hidden="true" tabIndex={-1} data-name={name}
        data-testid="phone-time" className={cn(phoneButtonClass, className, "max-sm:h-11")}>
        <span className="min-w-0 flex-1 truncate tabular-nums">{current ? formatSlot(current) : "Set time"}</span>
      </button>
      <PickerSheet open={open} title={name || "Time"} choices={choices} value={current} onClose={() => setOpen(false)}
        onPick={(v) => { const el = inputRef.current; setOpen(false); if (el) setNativeValue(el, v); setCurrent(v); }} />
    </>
  );
}

