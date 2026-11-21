/**
 * OPS1: /api/console/users, Users. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 1 (Workspaces and Users): paged user list and detail, sessions, ban, unlock, verify, delete.
 * Permissions: users.read / users.sessions / users.unlock / users.verify / users.ban / users.delete (stepUp) (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function usersRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("users.read"), async (c) => ...)
}
