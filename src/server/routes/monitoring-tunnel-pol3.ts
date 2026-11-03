import type { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * POL3: the same origin tunnel for browser error reports. The signed in app's error tracking posts its envelopes
 * here (the SDK's tunnel option) instead of straight to the tracker's ingest host, so a browser extension, a
 * network filter or a cross site preflight can no longer drop them, and the page policy stays exactly as it was.
 * Only the route is registered at start up; the handler loads on the first report (Worker start up budget).
 * Registered before the limiters and the CSRF guard, like the CSP report route: it keeps its own per isolate
 * limits, writes no database rows and reads no cookie.
 */
export const MONITORING_TUNNEL_PATH = "/api/monitoring/tunnel";

export function installMonitoringTunnel(app: Hono<AppEnv>) {
  app.post(MONITORING_TUNNEL_PATH, async (c) => {
    const { handleMonitoringTunnel } = await import("./monitoring-tunnel-handler-pol3");
    return handleMonitoringTunnel(c);
  });
}
