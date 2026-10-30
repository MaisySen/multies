import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import { isAuthLayoutPath } from "@/web/lib/auth-providers";

/**
 * Cloudflare Web Analytics: cookieless, no personal data. Off unless a beacon token is set, from the
 * build (VITE_CF_BEACON) or from /api/config (cfBeaconToken). The CSP must allow
 * https://static.cloudflareinsights.com in script-src and https://cloudflareinsights.com in connect-src.
 */
export function AnalyticsBeacon({ subscribe }: { subscribe?: (fn: (path: string) => void) => () => void } = {}) {
  // R34: nothing on the sign in pages, not even the config read: they paint as early as possible.
  const [path, setPath] = useState(() => (typeof window === "undefined" ? "/" : window.location.pathname));
  useEffect(() => subscribe?.(setPath), [subscribe]);
  const onAuth = isAuthLayoutPath(path);
  const config = useQuery({ queryKey: qk.config, queryFn: () => api.get("/config"), staleTime: Infinity, enabled: !onAuth });
  const token = (import.meta.env.VITE_CF_BEACON as string | undefined) || (config.data as { cfBeaconToken?: string } | undefined)?.cfBeaconToken;
  useEffect(() => {
    if (onAuth || !token || !/^[a-f0-9]{32}$/i.test(token) || document.getElementById("cf-beacon")) return;
    const s = document.createElement("script");
    s.id = "cf-beacon";
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token, spa: true }));
    document.head.appendChild(s);
  }, [token, onAuth]);
  return null;
}
