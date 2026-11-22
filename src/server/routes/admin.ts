import { Hono } from "hono";
import type { AppEnv } from "../context";
import { operatorSession, requireOperator } from "../auth/operator";

/**
 * The older operator API. OPS1 security: only the reads something still calls are left (the deploy and smoke scripts
 * read /health, the runbooks /status); every change moved to the operator console (/api/console/*), which enforces
 * the reason, step up and target rules. Every other /api/admin path answers 404 (app.ts), for operators too: the
 * operator guard sits on each kept route (not on the whole prefix), so a retired path is 404 for everyone.
 */
export function adminRoutes() {
  return new Hono<AppEnv>()
    // QUAL1 (audit row 36): the health detail that used to be public: the release, pending migrations, the account's
    // D1 writes and reads with their budgets and shed levels, the production and staging split and the busiest
    // workspaces (counts only). The public /api/health answers { ok, db } only.
    .get("/health", operatorSession, requireOperator("system.read"), async (c) => {
      const r = await (await import("../services/health")).operatorHealth(c.var.deps);
      c.header("cache-control", "no-store");
      return c.json(r.body, r.status);
    })
    // QUAL1 (audit row 69): the status page with the last 24 hours of mail volume, which the public page no longer shows.
    .get("/status", operatorSession, requireOperator("system.read"), async (c) => {
      const { systemStatus } = await import("../services/status");
      c.header("cache-control", "no-store");
      return c.json(await systemStatus(c.var.deps));
    });
}
