import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setValue(initial); setError(null); } }, [open, initial]);
  useInitialFocus(open, fieldRef);
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
            ? <Textarea {...p} ref={fieldRef} autoFocus rows={3} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
            : <Input {...p} ref={fieldRef} autoFocus value={value} placeholder={placeholder} inputMode={inputMode} onChange={(e) => setValue(e.target.value)} />}
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

/**
 * R34: a themed replacement for window.confirm. The dialog names the thing ("Delete the doc Q4 plan?"),
 * a destructive confirm is red, Enter confirms (the confirm button takes focus), Esc or Cancel backs out,
 * and the native <dialog> hands focus back to whatever opened it.
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "Delete", tone = "danger", busy }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; description?: ReactNode; confirmLabel?: string; tone?: "primary" | "danger"; busy?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useInitialFocus(open, confirmRef);
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(); }} className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end" data-testid="confirm-dialog">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button ref={confirmRef} type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={busy}>{confirmLabel}</Button>
      </form>
    </Dialog>
  );
}

/**
 * R34: showModal() runs after React's autoFocus and moves focus to the dialog's first control (the close button),
 * so the field or confirm button is focused once the dialog is open. Enter then submits; the native dialog
 * returns focus to the trigger when it closes.
 */
function useInitialFocus(open: boolean, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, ref]);
}

export type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; tone?: "primary" | "danger" };
export type PromptOptions = {
  title: string; label: string; description?: ReactNode; hint?: ReactNode; initial?: string; placeholder?: string; confirmLabel?: string;
  multiline?: boolean; inputMode?: "text" | "numeric"; validate?: (value: string) => string | null;
};

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (value: string | null) => void };

/** A required, trimmed value: the default check for prompts. */
export const requireText = (what: string) => (v: string) => (v.trim() ? null : `Enter ${what}.`);

/**
 * R34: drop-in async versions of window.confirm and window.prompt for the themed dialogs.
 *   const { confirm, prompt, dialogs } = useDialogs();
 *   if (!(await confirm({ title: "Delete the doc Q4 plan?" }))) return;
 *   const name = await prompt({ title: "Save view", label: "Name", validate: requireText("a name") });
 * Render {dialogs} once in the component. A second ask while one is open resolves the first as cancelled.
 */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const settle = useCallback((value: boolean | string | null) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!p) return;
    if (p.kind === "confirm") p.resolve(value === true);
    else p.resolve(typeof value === "string" ? value : null);
  }, []);
  const open = useCallback((next: Pending) => {
    const prev = pendingRef.current;
    if (prev) { if (prev.kind === "confirm") prev.resolve(false); else prev.resolve(null); }
    pendingRef.current = next;
    setPending(next);
  }, []);
  // Never leave a caller awaiting forever if the component goes away mid-ask.
  useEffect(() => () => { const p = pendingRef.current; if (p) { if (p.kind === "confirm") p.resolve(false); else p.resolve(null); } }, []);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => open({ kind: "confirm", opts, resolve })), [open]);
  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => open({ kind: "prompt", opts, resolve })), [open]);
  const dialogs = (
    <>
      <ConfirmDialog
        open={pending?.kind === "confirm"}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        title={pending?.kind === "confirm" ? pending.opts.title : ""}
        description={pending?.kind === "confirm" ? pending.opts.description : undefined}
        confirmLabel={pending?.kind === "confirm" ? pending.opts.confirmLabel : undefined}
        tone={pending?.kind === "confirm" ? pending.opts.tone : undefined}
      />
      <PromptDialog
        open={pending?.kind === "prompt"}
        onClose={() => settle(null)}
        onSubmit={(v) => settle(v)}
        title={pending?.kind === "prompt" ? pending.opts.title : ""}
        label={pending?.kind === "prompt" ? pending.opts.label : ""}
        description={pending?.kind === "prompt" ? pending.opts.description : undefined}
        hint={pending?.kind === "prompt" ? pending.opts.hint : undefined}
        initial={pending?.kind === "prompt" ? pending.opts.initial ?? "" : ""}
        placeholder={pending?.kind === "prompt" ? pending.opts.placeholder : undefined}
        confirmLabel={pending?.kind === "prompt" ? pending.opts.confirmLabel : undefined}
        multiline={pending?.kind === "prompt" ? pending.opts.multiline : undefined}
        inputMode={pending?.kind === "prompt" ? pending.opts.inputMode : undefined}
        validate={pending?.kind === "prompt" ? pending.opts.validate : undefined}
      />
    </>
  );
  return { confirm, prompt, dialogs };
}
