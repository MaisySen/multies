/**
 * OPS1: /api/console/mobile, the phone app's remote config (R29b, routes/app-config-r29b.ts) for the console.
 * GET /api/console/mobile   { stored, effective, fields, updatedAt, updatedBy, updatedByEmail } (mobile.read)
 * PUT /api/console/mobile   { patch, reason } applies the patch (the same shape PUT /api/v1/app-config takes) and is
 *                           audited as app_config.updated with the stored overrides before and after (mobile.manage, recent sign in)
 *
 * The data layer is services/console/mobile-config.ts; it writes the same app_settings row the public
 * GET /api/v1/app-config reads, so phones pick a change up within that endpoint's one minute cache.
 * The effective config's telemetry block is left out: the form does not edit it.
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv, Deps } from "../../context";
import { users } from "../../db/schema";
import { parseBody } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { getMobileConfig, MOBILE_CONFIG_FIELDS, updateMobileConfig, type MobileConfigState } from "../../services/console/mobile-config";
import { APP_CONFIG_KEY } from "../app-config-r29b";

/** "console:usr_1" or "admin:usr_1" to the operator's email; "token" (the release scripts) stays as is. */
async function updatedByEmail(deps: Pick<Deps, "db">, by: string | null): Promise<string | null> {
  const m = by ? /^(?:console|admin):(.+)$/.exec(by) : null;
  if (!m) return null;
  const row = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, m[1]!)).get();
  return row?.email ?? null;
}

function view(s: MobileConfigState) {
  const { telemetry: _telemetry, ...effective } = s.effective;
  return { stored: s.stored, effective, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
}

export function mobileRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("mobile.read"), async (c) => {
      c.header("cache-control", "no-store");
      const v = await getMobileConfig(c.var.deps);
      return c.json({ ...view(v), fields: v.fields, updatedByEmail: await updatedByEmail(c.var.deps, v.updatedBy) });
    })
    .put("/", requireOperator("mobile.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, z.object({ patch: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length > 0, "Change at least one setting."), reason: reasonSchema }).strict());
      const auth = c.var.auth;
      type R = Awaited<ReturnType<typeof updateMobileConfig>>;
      const r = await operatorAction(c, {
        action: "app_config.updated", targetType: "app_config", targetId: APP_CONFIG_KEY, reason: body.reason,
        before: (x: R) => x.before.stored, after: (x: R) => x.after.stored, metadata: { keys: Object.keys(body.patch) },
      }, () => updateMobileConfig(c.var.deps, body.patch, { userId: auth.userId, email: auth.email }));
      return c.json({ ok: true, ...view(r.after), fields: MOBILE_CONFIG_FIELDS, updatedByEmail: auth.email ?? null });
    });
}
