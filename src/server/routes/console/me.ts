/**
 * OPS1: GET /api/console/me, who is using the console and what they may do. The web console's guard reads it first;
 * a 403 here (forbidden, two_factor_required, impersonating) is what it shows to someone who can't open the console.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../context";
import { isFreshSignIn, operatorSession, requireOperator } from "../../auth/operator";
import { operatorRoleLabel, permissionsOf } from "@/shared/operator-permissions";
import { isEnvManagedOperator } from "../../services/console/operators";

export function meRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("console.view"), (c) => {
      const { auth, deps } = c.var;
      const role = c.var.operator!.role;
      c.header("cache-control", "no-store");
      return c.json({
        user: { id: auth.userId, email: auth.email, name: auth.name },
        role, roleLabel: operatorRoleLabel(role), permissions: permissionsOf(role),
        twoFactor: !!auth.twoFactor, loginMethod: auth.loginMethod ?? null,
        signedInAt: auth.sessionCreatedAt?.toISOString() ?? null,
        freshMinutes: deps.config.operator.freshMinutes, fresh: isFreshSignIn(deps, auth),
        envManaged: isEnvManagedOperator(deps, { id: auth.userId, email: auth.email, emailVerified: !!auth.emailVerified }),
        environment: { mode: deps.config.mode, release: deps.config.release },
      });
    });
}
