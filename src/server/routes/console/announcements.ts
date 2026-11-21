/**
 * OPS1: /api/console/announcements, Announcements. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 6 (Announcements): one in-app banner served on /api/config.
 * Permissions: announcements.read / announcements.manage (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function announcementsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("announcements.read"), async (c) => ...)
}
