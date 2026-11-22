/**
 * OPS1: the one dialog for operator changes. It says what will happen, asks for a reason (3 to 300 characters, kept in
 * the audit log) and handles "sign in again" for sensitive actions.
 *
 * Usage (every console change goes through this):
 *
 *   const suspend = useOperatorAction({
 *     title: (w: Workspace) => `Suspend ${w.name}?`,
 *     description: "Sending and API access stop straight away. Mail still arrives.",
 *     confirmLabel: "Suspend workspace", tone: "danger",
 *     run: (w, reason) => api.post(`/console/workspaces/${w.id}/suspend`, { reason }),
 *     success: "Workspace suspended",
 *   });
 *   <Button onClick={() => suspend.open(workspace)}>Suspend</Button>
 *   {suspend.dialog}
 *
 * Extra fields (a role picker, an amount) go in `fields`, rendered above the reason; read their state in `run`.
 * On success it toasts, invalidates every ["console", ...] query (or `invalidate`), and closes. Errors toast through
 * showError and keep the dialog open; step_up_required opens StepUpDialog instead.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { consoleKeys } from "@/web/lib/console-api";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Field, Textarea } from "@/web/components/ui/input";
import { StepUpDialog } from "./step-up-dialog";

export const REASON_MIN = 3;
/**
 * OPS1 security review: who sees a reason. Operator actions on a workspace also write the workspace's own activity
 * log with the reason, which its admins read, so every reason dialog says so (one generic line for every dialog).
 */
export const REASON_VISIBILITY = "Reasons are recorded. For actions on a workspace, its admins can see the reason.";
export const REASON_MAX = 300;

/** null when the reason is fine, else what to fix. */
export function reasonProblem(v: string): string | null {
  const t = v.trim();
  if (t.length < REASON_MIN) return "Give a short reason (at least 3 characters).";
  if (t.length > REASON_MAX) return "Keep the reason under 300 characters.";
  return null;
}

export function ReasonDialog({ open, onClose, onSubmit, title, description, confirmLabel = "Confirm", tone = "primary", busy, fields, reasonHint, canSubmit = true }: {
  open: boolean; onClose: () => void; onSubmit: (reason: string) => void; title: string; description?: ReactNode;
  confirmLabel?: string; tone?: "primary" | "danger"; busy?: boolean; fields?: ReactNode; reasonHint?: ReactNode; canSubmit?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setValue(""); setError(null); } }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = reasonProblem(value);
    setError(problem);
    if (!problem && canSubmit) onSubmit(value.trim());
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={submit} className="space-y-5 text-left" data-testid="reason-dialog">
        {fields}
        <div className="space-y-1">
          <Field label="Reason" hint={reasonHint ?? REASON_VISIBILITY} error={error ?? undefined}>
            {(p) => <Textarea {...p} ref={ref} rows={3} maxLength={REASON_MAX + 50} value={value} placeholder="Why you are doing this"
              onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />}
          </Field>
          {reasonHint ? <p className="text-xs text-subtle" data-testid="reason-dialog-visibility">{REASON_VISIBILITY}</p> : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={busy} disabled={!canSubmit}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

type Text<V> = string | ((target: V) => string);
const textOf = <V,>(t: Text<V> | undefined, v: V) => (typeof t === "function" ? t(v) : t);

export interface OperatorActionOptions<V, R> {
  title: Text<V>;
  description?: Text<V>;
  confirmLabel?: string;
  tone?: "primary" | "danger";
  /** Extra inputs above the reason. */
  fields?: ReactNode;
  /** False keeps the confirm button off (an extra field is not filled in yet). */
  canSubmit?: boolean;
  run: (target: V, reason: string) => Promise<R>;
  success?: Text<V>;
  /** Query keys to refresh after success. Default: every console query. */
  invalidate?: QueryKey[];
  onDone?: (result: R, target: V) => void;
}

export function useOperatorAction<V = void, R = unknown>(opts: OperatorActionOptions<V, R>) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<{ v: V } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<{ minutes?: number } | null>(null);
  const submit = async (reason: string) => {
    if (!target) return;
    setBusy(true);
    try {
      const out = await opts.run(target.v, reason);
      const msg = textOf(opts.success, target.v);
      if (msg) toast.success(msg);
      for (const key of opts.invalidate ?? [consoleKeys.all]) await qc.invalidateQueries({ queryKey: key });
      opts.onDone?.(out, target.v);
      setTarget(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") {
        setTarget(null);
        setStepUp({ minutes: (e.details as { freshMinutes?: number } | undefined)?.freshMinutes });
      } else {
        showError(e as Error);
      }
    } finally {
      setBusy(false);
    }
  };
  const dialog = (
    <>
      <ReasonDialog
        open={!!target} onClose={() => setTarget(null)} busy={busy}
        title={target ? textOf(opts.title, target.v) ?? "" : ""} description={target ? textOf(opts.description, target.v) : undefined}
        confirmLabel={opts.confirmLabel} tone={opts.tone} fields={opts.fields} canSubmit={opts.canSubmit}
        onSubmit={(r) => void submit(r)}
      />
      <StepUpDialog open={!!stepUp} onClose={() => setStepUp(null)} freshMinutes={stepUp?.minutes} />
    </>
  );
  return { open: (v: V) => setTarget({ v }), close: () => setTarget(null), busy, dialog, isOpen: !!target };
}
