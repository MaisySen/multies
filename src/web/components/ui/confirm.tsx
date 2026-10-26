import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { Dialog } from "./dialog";
import { Field, Input, Textarea } from "./input";

/**
 * R33: a themed replacement for window.prompt. One field, a clear label, Enter to save, Esc to cancel,
 * and the input is checked before the dialog closes (window.prompt can't show an error or match dark mode).
 */
export function PromptDialog({ open, onClose, onSubmit, title, description, label, hint, initial = "", placeholder, confirmLabel = "Save", tone = "primary", multiline, inputMode, validate, busy }: {
  open: boolean; onClose: () => void; onSubmit: (value: string) => void; title: string; description?: ReactNode; label: string; hint?: ReactNode;
  initial?: string; placeholder?: string; confirmLabel?: string; tone?: "primary" | "danger"; multiline?: boolean;
  inputMode?: "text" | "numeric"; validate?: (value: string) => string | null; busy?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setValue(initial); setError(null); } }, [open, initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validate?.(value) ?? null;
    setError(problem);
    if (!problem) onSubmit(value);
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={submit} className="space-y-5 text-left">
        <Field label={label} hint={hint} error={error ?? undefined}>
          {(p) => multiline
            ? <Textarea {...p} autoFocus rows={3} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
            : <Input {...p} autoFocus value={value} placeholder={placeholder} inputMode={inputMode} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={busy}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * R33: a two-tap confirm for destructive row actions, where a second modal on top of a modal would be clumsy.
 * The first tap arms it ("Remove?"), the second does it; it disarms itself after 3 s or when focus leaves.
 */
export function ConfirmButton({ onConfirm, children, armedLabel, className, variant = "ghost", size = "sm", ...rest }: Omit<ButtonProps, "onClick"> & { onConfirm: () => void; armedLabel: string }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      {...rest}
      size={size}
      variant={armed ? "danger" : variant}
      className={className}
      aria-live="polite"
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm(); return; }
        setArmed(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setArmed(false), 3000);
      }}
    >
      {armed ? armedLabel : children}
    </Button>
  );
}
