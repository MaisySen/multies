/**
 * OPS1: /api/console/workspaces, Workspaces. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 1 (Workspaces and Users): paged workspace list, detail tabs, notes, suspend and limits.
 * Permissions: workspaces.read / workspaces.suspend / workspaces.limits / workspaces.notes / flags.workspace (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function workspacesRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("workspaces.read"), async (c) => ...)
}
