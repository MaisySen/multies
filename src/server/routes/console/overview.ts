/**
 * OPS1: GET /api/console/overview. What needs attention first (attention), then the platform totals, the newest
 * workspaces and the integrations (the same numbers /api/admin/overview has always answered).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession, requireOperator } from "../../auth/operator";
import { attentionList, platformOverview } from "../../services/console/overview";

export function overviewRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("overview.read"), async (c) => {
      const [attention, overview] = await Promise.all([attentionList(c.var.deps), platformOverview(c.var.deps)]);
      c.header("cache-control", "no-store");
      return c.json({ attention, ...overview });
    });
}
