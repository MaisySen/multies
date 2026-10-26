import { useEffect } from "react";
import { useConfig } from "@/web/lib/queries";

/**
 * Cloudflare Web Analytics: cookieless, no personal data. Off unless a beacon token is set, from the
 * build (VITE_CF_BEACON) or from /api/config (cfBeaconToken). The CSP must allow
 * https://static.cloudflareinsights.com in script-src and https://cloudflareinsights.com in connect-src.
 */
export function AnalyticsBeacon() {
  const config = useConfig();
  const token = (import.meta.env.VITE_CF_BEACON as string | undefined) || (config.data as { cfBeaconToken?: string } | undefined)?.cfBeaconToken;
  useEffect(() => {
    if (!token || !/^[a-f0-9]{32}$/i.test(token) || document.getElementById("cf-beacon")) return;
    const s = document.createElement("script");
    s.id = "cf-beacon";
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token, spa: true }));
    document.head.appendChild(s);
  }, [token]);
  return null;
}
