import { useEffect } from "react";
import { useRouteError } from "react-router";
import { captureError, captureWarning } from "@/web/lib/sentry";
import { isPageLoadFailure } from "@/web/lib/page-load";
import { PageLoadFailed } from "./lazy-page";
import { tr } from "@/web/i18n"; // R104

/**
 * Route error screen. R73: a page file that could not load (offline, a flaky network) gets the same calm Retry note
 * the pages show, reported as a warning, and reloads by itself when the connection returns. It never reloads on its
 * own otherwise: the page loader (lib/page-load.ts) already reloaded once if a newer release is live. Anything else
 * gets a calm message and is reported as an error.
 */
export function RouteError() {
  const error = useRouteError();
  const loadFailure = isPageLoadFailure(error);
  useEffect(() => {
    if (loadFailure) captureWarning(error, { page_load: "route" });
    else captureError(error);
  }, [error, loadFailure]);
  useEffect(() => {
    if (!loadFailure) return;
    const onOnline = () => window.location.reload();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [loadFailure]);
  if (loadFailure) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center p-8">
        <PageLoadFailed offline={typeof navigator !== "undefined" && navigator.onLine === false} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">{tr("errors.something_went_wrong_on_this_page")}</h1>
      <p className="text-sm opacity-70">{tr("errors.reload_to_try_again_if_it_keeps_happening_tell_u")}</p>
      <button type="button" className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white" onClick={() => window.location.reload()}>{tr("errors.reload")}</button>
    </div>
  );
}
