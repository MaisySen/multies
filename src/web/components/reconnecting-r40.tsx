/**
 * R40 (MB-200, MB-205): calm states for "Multies did not answer". A failed account check keeps the app on screen
 * with a small Reconnecting pill while it retries in the background; only when there is no saved copy at all does
 * the page show the full card, and that card keeps the shell's frame and offers Retry.
 */
import { IconRefresh, IconWifiOff } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { AppSkeleton } from "@/web/layouts/app-skeleton";
import { errorMessage, isTransientError } from "@/web/lib/api";
import { tr } from "@/web/i18n"; // R104

export function ReconnectingPill({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="status" aria-live="polite" data-testid="reconnecting-pill"
      className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),0.75rem)] z-50 flex justify-center px-4 motion-safe:animate-[fade-in_180ms_ease-out]">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-elevated/95 py-1.5 pl-3 pr-1.5 text-[13px] text-muted shadow-pop backdrop-blur">
        <IconRefresh className="h-3.5 w-3.5 motion-safe:animate-spin [animation-duration:1.6s]" aria-hidden="true" />
        <span>{tr("errors.reconnecting")}</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="rounded-full px-2.5 py-1 font-medium text-fg transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
            {tr("common.retry")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown only when the account check failed after its retries and no saved copy exists. */
export function ReconnectScreen({ onRetry, retrying }: { onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="relative min-h-dvh" data-testid="reconnect-screen">
      <div aria-hidden="true" className="opacity-60"><AppSkeleton /></div>
      <div className="absolute inset-0 grid place-items-center p-6">
        <div role="alert" className="w-full max-w-sm rounded-2xl border border-line bg-surface/95 p-6 text-center shadow-pop backdrop-blur">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand" aria-hidden="true">
            <IconWifiOff className="h-5 w-5" />
          </span>
          <h1 className="mt-4 text-[17px] font-semibold tracking-[-0.01em]">{tr("errors.couldn_t_reach_multies")}</h1>
          <p className="mt-1 text-sm text-muted">{tr("errors.your_work_is_safe_we_keep_trying_in_the_backgrou")}</p>
          <Button className="mt-5 w-full" loading={retrying} onClick={onRetry}>{tr("common.retry")}</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * R40 (MB-205): one plain line for a failed action, never a status code. When Multies could not be reached the
 * line offers Retry; the caller keeps what the person chose (the file, the form) so Retry needs nothing new.
 */
export function ErrorRetry({ error, onRetry, retrying, fallback, className }: { error: unknown; onRetry?: () => void; retrying?: boolean; fallback?: string; className?: string }) {
  if (!error) return null;
  const transient = isTransientError(error);
  return (
    <div role="alert" data-testid="error-retry"
      className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${transient ? "border-line bg-elevated/70 text-fg" : "border-bad/25 bg-bad-soft text-bad"} ${className ?? ""}`}>
      {transient && <IconWifiOff className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
      <span className="min-w-0 flex-1">{errorMessage(error, fallback)}</span>
      {onRetry && transient && (
        <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>{tr("common.retry")}</Button>
      )}
    </div>
  );
}
