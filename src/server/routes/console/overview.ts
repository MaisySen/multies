/**
 * OPS1: GET /api/console/overview, the console's first page in one request: what needs attention (each item links to
 * the already filtered page), the platform totals and the five newest workspaces with their owners.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession, requireOperator } from "../../auth/operator";
import { consoleOverview } from "../../services/console/overview";

export function overviewRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("overview.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await consoleOverview(c.var.deps));
    });
}
