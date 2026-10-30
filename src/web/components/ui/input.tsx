import { forwardRef, useEffect, useId, useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "@/web/lib/cn";
import { PhoneSelectButton, PhoneTimeButton } from "./phone-picker";
import { IconCalendar } from "./icon";
import { dateOrder, datePattern, formatDateValue, parseDateValue } from "@/web/lib/date-input";

// 16 px text on phones stops iOS Safari zooming into a focused field.
const field = "w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-subtle transition-[border-color,box-shadow] duration-150 ease-out focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 disabled:opacity-60 aria-[invalid=true]:border-bad aria-[invalid=true]:focus:ring-bad/15 max-sm:text-base";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  // R67 (MB-250): every date field shows and takes the workspace's order (dd/mm/yyyy in Australia).
  if (rest.type === "date") return <DateInput ref={ref} className={className} {...rest} />;
  // R56 (MB-243): the mark lets a native <dialog> put focus back on this field after showModal() takes it to Close.
  return <input ref={ref} className={cn(field, "h-10 max-sm:h-11", className)} data-autofocus={rest.autoFocus ? "" : undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "py-2.5 leading-relaxed", className)} data-autofocus={rest.autoFocus ? "" : undefined} {...rest} />;
});

/**
 * `bare` (R42): keep the caller's own classes on desktop (compact chips, icon overlays, segmented controls) instead of
 * the form field look; on phones the select still hands off to the bottom sheet, drawn with `phoneClassName`.
 */
/** R42: a bordered phone picker button for compact `bare` selects (size and width come from the caller). */
export const PHONE_PICK = "flex min-w-0 items-center rounded-lg border border-line-strong bg-surface pr-8 text-left text-base text-fg bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%238e8e93' stroke-width='1.6'><path d='M3 4.5 6 7.5 9 4.5'/></svg>\")] bg-[right_10px_center] bg-no-repeat";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { bare?: boolean; phoneClassName?: string };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, children, bare, phoneClassName, ...rest }, ref) {
  const inner = useRef<HTMLSelectElement | null>(null);
  const setRefs = (el: HTMLSelectElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el); else if (ref) ref.current = el;
  };
  // R41 (MB-209): on phones a single choice select opens the app's bottom sheet; the real select stays for forms and desktop.
  const phone = !rest.multiple && !rest.size;
  const look = bare ? className : cn(field, "h-10 max-sm:h-11 appearance-none bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%238e8e93' stroke-width='1.6'><path d='M3 4.5 6 7.5 9 4.5'/></svg>\")] bg-[right_12px_center] bg-no-repeat pr-9", className);
  return (
    <>
      <select ref={setRefs} className={cn(look, phone && "max-sm:sr-only")} {...rest}>
        {children}
      </select>
      {phone && <PhoneSelectButton selectRef={inner} className={bare ? phoneClassName : className} bare={bare} disabled={rest.disabled} />}
    </>
  );
});

/** R41 (MB-209): a time field; desktop keeps the browser's time input, phones get a sheet of 15 minute slots. */
export const TimeInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function TimeInput({ className, ...rest }, ref) {
  const inner = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el); else if (ref) ref.current = el;
  };
  return (
    <>
      <input ref={setRefs} type="time" className={cn(field, "h-10 max-sm:h-11 max-sm:sr-only", className)} {...rest} />
      <PhoneTimeButton inputRef={inner} value={typeof rest.value === "string" ? rest.value : undefined} className={className} disabled={rest.disabled} />
    </>
  );
});

export function Field({ label, hint, error, children, className }: {
  label: string; hint?: ReactNode; error?: string; className?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-fg/90">{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? descId : undefined })}
      {(error || hint) && (
        <p id={descId} role={error ? "alert" : undefined} className={cn("flex items-start gap-1 text-xs", error ? "text-bad" : "text-subtle")}>{error ?? hint}</p>
      )}
    </div>
  );
}

/** Classes that size or place the field go on the wrapper; the rest style the text box. */
const OUTER = /^(?:[a-z-]+:)*(?:w-|min-w-|max-w-|m[trblxy]?-|-m[trblxy]?-|flex-|basis-|shrink|grow|self-|col-|row-|order-)/;
const changeEvent = (value: string) => ({ target: { value }, currentTarget: { value } }) as unknown as ChangeEvent<HTMLInputElement>;

/**
 * R67 (MB-250): a date field in the workspace's order. Typed as text ("23/11/2026", "23.11.26" or ISO) with the
 * browser's calendar one tap away; the value and onChange stay ISO yyyy-mm-dd, like a native date input.
 */
export const DateInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function DateInput({ className, value, defaultValue, onChange, onBlur, min, max, type: _type, disabled, placeholder, ...rest }, ref) {
  const order = dateOrder();
  const controlled = value !== undefined;
  const [own, setOwn] = useState(String(defaultValue ?? ""));
  const current = controlled ? String(value ?? "") : own;
  const [text, setText] = useState(() => formatDateValue(current, order));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(formatDateValue(current, order)); }, [current, order]);
  const picker = useRef<HTMLInputElement>(null);
  const emit = (v: string) => { if (!controlled) setOwn(v); onChange?.(changeEvent(v)); };
  const typed = (t: string) => {
    setText(t);
    editing.current = true;
    if (!t.trim()) { if (current) emit(""); return; }
    const iso = parseDateValue(t, order);
    if (iso && iso !== current) emit(iso);
  };
  const blur = (e: FocusEvent<HTMLInputElement>) => {
    editing.current = false;
    const iso = text.trim() ? parseDateValue(text, order) : "";
    const v = iso ?? current;
    setText(formatDateValue(v, order));
    onBlur?.({ ...e, target: { ...e.target, value: v }, currentTarget: { ...e.currentTarget, value: v } } as FocusEvent<HTMLInputElement>);
  };
  const outOfRange = !!current && ((!!min && current < String(min)) || (!!max && current > String(max)));
  const tokens = (className ?? "").split(/\s+/).filter(Boolean);
  const outer = tokens.filter((t) => OUTER.test(t)).join(" ");
  const inner = tokens.filter((t) => !OUTER.test(t)).join(" ");
  const openPicker = () => {
    const el = picker.current;
    if (!el || disabled) return;
    try { el.showPicker(); } catch { el.focus(); el.click(); }
  };
  return (
    <span className={cn("relative block", outer)} data-date-input="">
      <input {...rest} ref={ref} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} disabled={disabled}
        placeholder={placeholder ?? datePattern(order)} value={text} onChange={(e) => typed(e.target.value)} onBlur={blur}
        aria-invalid={rest["aria-invalid"] ?? (outOfRange || undefined)}
        className={cn(field, "h-10 pr-10 tabular-nums max-sm:h-11", inner)} data-autofocus={rest.autoFocus ? "" : undefined} />
      <button type="button" tabIndex={-1} disabled={disabled} onClick={openPicker} aria-label="Pick a date"
        className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-muted hover:text-fg disabled:opacity-50 max-sm:w-11">
        <IconCalendar className="h-4 w-4" aria-hidden />
      </button>
      <input ref={picker} type="date" tabIndex={-1} aria-hidden="true" value={current} min={min} max={max} disabled={disabled}
        onChange={(e) => { editing.current = false; setText(formatDateValue(e.target.value, order)); emit(e.target.value); }}
        className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0" />
    </span>
  );
});
