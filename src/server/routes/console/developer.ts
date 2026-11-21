/**
 * OPS1: /api/console/developer, Developer platform. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 6 (Developer): API keys (never secrets), webhook endpoints, OAuth clients and grants.
 * Permissions: developer.read / developer.manage (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function developerRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("developer.read"), async (c) => ...)
}
