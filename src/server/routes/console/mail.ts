/**
 * OPS1: /api/console/mail, Mail and deliverability. Mounted by routes/console/index.ts; add this area's routes here only.
 * Phase 6 (Mail): failures, bounce rates, suppressions, queued sends, domains.
 * Permissions: mail.read / mail.manage (src/shared/operator-permissions.ts).
 *
 * Every route takes requireOperator(permission) (the RBAC test fails a console route without one). Lists use
 * listParams (services/console/listing.ts) and answer { items, nextCursor }; every change takes a reason
 * (reasonSchema) and runs through operatorAction (services/console/audit.ts).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";

export function mailRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession);
  // Routes for this area go here, e.g. .get("/", requireOperator("mail.read"), async (c) => ...)
}
