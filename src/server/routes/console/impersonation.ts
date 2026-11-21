/**
 * OPS1: /api/console/impersonation, Impersonation. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 2 (Impersonation): start and stop viewing or acting as a person.
 * Permissions: impersonation.read / impersonation.view / impersonation.act (stepUp) (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function impersonationRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("impersonation.read"), async (c) => ...)
}
