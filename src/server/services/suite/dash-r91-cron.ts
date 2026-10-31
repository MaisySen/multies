/** R91: the maintenance step for emailed reports, alerts and data source refreshes (DASHBOARDS_PLUS only). */
import type { Deps } from "../../context";
import { plusEnabled } from "./dash-r91-common";

export async function runDashboardsPlus(deps: Deps) {
  if (!plusEnabled(deps)) return { skipped: true };
  const { runDueReports } = await import("./dash-r91-reports");
  const { runDueAlerts } = await import("./dash-r91-alerts");
  const { runDueSources } = await import("./dash-r91-sources");
  const sources = await runDueSources(deps);
  const alerts = await runDueAlerts(deps);
  const reports = await runDueReports(deps);
  return { sources, alerts, reports };
}
