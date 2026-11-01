import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import { isAuthLayoutPath } from "@/web/lib/auth-providers";
import { createProductAnalytics, flushOnPageHide } from "@/web/lib/product-analytics";

/**
 * ANALYTICS-PH: reports app area and tool opens when the server turns it on (ANALYTICS_PH). Loads nothing extra,
 * sets no cookies, and does nothing at all with Do Not Track or Global Privacy Control on.
 */
export function ProductAnalytics({ subscribe }: { subscribe?: (fn: (path: string) => void) => () => void } = {}) {
  const [path, setPath] = useState(() => (typeof window === "undefined" ? "/" : window.location.pathname));
  useEffect(() => subscribe?.(setPath), [subscribe]);
  const onApp = path.startsWith("/app") && !isAuthLayoutPath(path);
  const config = useQuery({ queryKey: qk.config, queryFn: () => api.get("/config"), staleTime: Infinity, enabled: onApp });
  const enabled = onApp && (config.data as { analyticsPh?: boolean } | undefined)?.analyticsPh === true;
  const pa = useRef<ReturnType<typeof createProductAnalytics> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    pa.current ??= createProductAnalytics();
    pa.current.pageOpened(path);
  }, [enabled, path]);
  useEffect(() => {
    // R111: pagehide as well as visibilitychange, so events queued just before a close still leave.
    return flushOnPageHide({ flush: (k) => pa.current?.flush(k) });
  }, []);
  return null;
}
