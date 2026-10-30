import { useRouteError } from "react-router";
import { captureError } from "@/web/lib/sentry";
import { isStaleChunkError, reloadForNewVersion } from "@/web/lib/stale-chunk";

/** Route error screen: a page file from an older release reloads into the new one; anything else gets a calm message. */
export function RouteError() {
  const error = useRouteError();
  const stale = isStaleChunkError(error);
  if (stale && reloadForNewVersion()) return <div className="min-h-dvh" aria-busy="true" />;
  if (!stale) captureError(error);
  return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">{stale ? "Multies was updated" : "Something went wrong on this page"}</h1>
      <p className="text-sm opacity-70">{stale ? "Reload to get the latest version. Nothing you saved is lost." : "Reload to try again. If it keeps happening, tell us at support."}</p>
      <button type="button" className="rounded-lg bg-[#0071E3] px-4 py-2 text-sm font-medium text-white" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
