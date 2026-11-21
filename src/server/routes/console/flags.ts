/**
 * OPS1: /api/console/flags, Feature flags. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 4 (Feature flags): registry, global and workspace overrides, locks.
 * Permissions: flags.read / flags.workspace / flags.global (stepUp) (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function flagsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("flags.read"), async (c) => ...)
}
