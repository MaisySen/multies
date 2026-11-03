/**
 * T1G (T1-8): the plain "Couldn't load this" state with Retry, used where a page's main read failed and the page
 * has nothing loaded to show, and the strip the app frame shows while a failed read leaves skeletons up.
 * Data already on screen stays; the offline banner is its own thing and this strip stays out of its way.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconAlertCircle } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { cn } from "@/web/lib/cn";
import { ApiError } from "@/web/lib/api";
import { LOAD_ERROR_BODY, LOAD_ERROR_TITLE, isServerLoadError, retryFailedLoads, showLoadStrip, useHasFailedLoads, useMarkInlineLoadError, useOnScreenCounts } from "@/web/lib/load-errors-t1g";
import { tr } from "@/web/i18n"; // R104

function useRetrying(run: () => unknown) {
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await run(); } catch { /* the failed read shows itself again */ } finally { setBusy(false); } };
  return [busy, go] as const;
}

/** In place of a page's list or content when its read failed and nothing is loaded. */
export function LoadError({ onRetry, className, compact }: { onRetry: () => unknown; className?: string; compact?: boolean }) {
  useMarkInlineLoadError();
  const [busy, retry] = useRetrying(onRetry);
  return (
    <div role="alert" data-testid="load-error" className={cn("flex flex-col items-center justify-center text-center", compact ? "px-4 py-6" : "px-6 py-14", className)}>
      {!compact && (
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-fill text-muted" aria-hidden="true"><IconAlertCircle className="h-5 w-5" /></span>
      )}
      <h2 className={cn("font-semibold tracking-[-0.01em] text-fg", compact ? "text-[14px]" : "mt-3 text-[16px]")}>{tr("errors.couldnt_load_this", undefined, LOAD_ERROR_TITLE)}</h2>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{tr("errors.load_error_body", undefined, LOAD_ERROR_BODY)}</p>
      <Button className="mt-4" size="sm" variant="secondary" loading={busy} onClick={() => void retry()} data-testid="load-error-retry">{tr("common.retry")}</Button>
    </div>
  );
}

/** F12 (MB-299): the same words in one line, for a small panel, a list inside a dialog or a row of a page. */
export function LoadErrorInline({ onRetry, className }: { onRetry: () => unknown; className?: string }) {
  useMarkInlineLoadError();
  const [busy, retry] = useRetrying(onRetry);
  return (
    <div role="alert" data-testid="load-error-inline" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]", className)}>
      <IconAlertCircle className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="font-medium text-fg">{tr("errors.couldnt_load_this", undefined, LOAD_ERROR_TITLE)}.</span> <span className="text-muted">{tr("errors.load_error_body", undefined, LOAD_ERROR_BODY)}</span></span>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void retry()} data-testid="load-error-retry">{tr("common.retry")}</Button>
    </div>
  );
}

/**
 * F12 (MB-299): a read that failed on our side says the shared words with Retry; a read the server refused (4xx)
 * keeps the server's own words (for example "Connect this account first"), still with Retry.
 */
export function LoadFailure({ error, onRetry, className, block }: { error: unknown; onRetry: () => unknown; className?: string; block?: boolean }) {
  if (isServerLoadError(error) || !(error instanceof ApiError && error.message)) {
    return block ? <LoadError onRetry={onRetry} className={className} /> : <LoadErrorInline onRetry={onRetry} className={className} />;
  }
  return (
    <div role="alert" data-testid="load-refused" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]", className)}>
      <span className="min-w-0 flex-1 text-fg">{error.message}</span>
      <Button size="sm" variant="secondary" onClick={() => void onRetry()}>{tr("common.retry")}</Button>
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

/** In the app frame, under the other banners: only while a failed read leaves loading skeletons on screen. */
export function LoadErrorStrip() {
  const qc = useQueryClient();
  const failed = useHasFailedLoads(qc);
  const { skeletons, inline } = useOnScreenCounts();
  const online = useOnline();
  const [busy, retry] = useRetrying(() => retryFailedLoads(qc));
  if (!showLoadStrip({ online, failed, skeletons, inline })) return null;
  return (
    <div role="alert" data-testid="load-error-strip" className="flex items-center justify-center gap-3 border-b border-line bg-surface px-4 py-2 text-[13px] text-fg">
      <IconAlertCircle className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0"><span className="font-medium">{tr("errors.couldnt_load_this", undefined, LOAD_ERROR_TITLE)}.</span> <span className="text-muted">{tr("errors.load_error_body", undefined, LOAD_ERROR_BODY)}</span></span>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void retry()} data-testid="load-error-strip-retry">{tr("common.retry")}</Button>
    </div>
  );
}
