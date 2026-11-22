/**
 * OPS1: the operator console API, /api/console/*. app.ts builds it on the first console request (one dynamic import)
 * and hands over its request context. Every sub-router applies operatorSession itself (it runs once per request) and
 * each route its own requireOperator(permission). Each area owns one file here; add routes there, not in this file.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { operatorSession } from "../../auth/operator";
import { meRoutes } from "./me";
import { overviewRoutes } from "./overview";
import { auditRoutes } from "./audit";
import { operatorsRoutes } from "./operators";
import { workspacesRoutes } from "./workspaces";
import { usersRoutes } from "./users";
import { impersonationRoutes } from "./impersonation";
import { billingRoutes } from "./billing";
import { mailRoutes } from "./mail";
import { agentsRoutes } from "./agents";
import { developerRoutes } from "./developer";
import { jobsRoutes } from "./jobs";
import { moderationRoutes } from "./moderation";
import { flagsRoutes } from "./flags";
import { systemRoutes } from "./system";
import { metricsRoutes } from "./metrics";
import { mobileRoutes } from "./mobile";
import { announcementsRoutes } from "./announcements";

/** OPS1 security (L4): `auth` is written back once the console resolved the session, so app.ts's access log names who asked. */
type ParentVars = { deps: AppEnv["Variables"]["deps"]; ip: string; requestId: string; log: AppEnv["Variables"]["log"]; auth?: AppEnv["Variables"]["auth"] };

/** The console's areas and where each is mounted under /api/console. */
export const CONSOLE_AREAS = {
  "/me": meRoutes,
  "/overview": overviewRoutes,
  "/audit": auditRoutes,
  "/operators": operatorsRoutes,
  "/workspaces": workspacesRoutes,
  "/users": usersRoutes,
  "/impersonation": impersonationRoutes,
  "/billing": billingRoutes,
  "/mail": mailRoutes,
  "/agents": agentsRoutes,
  "/developer": developerRoutes,
  "/jobs": jobsRoutes,
  "/moderation": moderationRoutes,
  "/flags": flagsRoutes,
  "/system": systemRoutes,
  "/metrics": metricsRoutes,
  "/mobile": mobileRoutes,
  "/announcements": announcementsRoutes,
} as const;

/** The console router. Paths are absolute (/api/console/...), as app.ts forwards the original request. */
export function consoleRoutes(parentVars?: WeakMap<Request, ParentVars>) {
  const app = new Hono<AppEnv>().basePath("/api/console");
  app.use("*", async (c, next) => {
    const p = parentVars?.get(c.req.raw);
    if (p) { c.set("deps", p.deps); c.set("ip", p.ip); c.set("requestId", p.requestId); c.set("log", p.log); }
    try {
      await next();
    } finally {
      if (p && c.var.auth) p.auth = c.var.auth; // OPS1 security (L4)
    }
  });
  // Unknown console paths answer 401 or 403 to someone who is not an operator, never a list of what exists.
  app.use("*", operatorSession);
  for (const [path, routes] of Object.entries(CONSOLE_AREAS)) app.route(path, routes());
  return app;
}
