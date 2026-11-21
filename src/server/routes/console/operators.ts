/**
 * OPS1: platform operators.
 * GET    /api/console/operators          { items, nextCursor } (operators.read)
 * POST   /api/console/operators          { email, role, reason } grants a role to a confirmed account
 * PATCH  /api/console/operators/:id      { role, reason } changes the role
 * DELETE /api/console/operators/:id      { reason } removes operator access
 * Changes are owner only (operators.manage), need a recent sign in (step up) and are audited. 409 env_managed for an
 * operator set in PLATFORM_ADMIN_EMAILS, 409 last_owner for the only owner.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { changeOperatorRole, grantOperator, listOperators, removeOperator } from "../../services/console/operators";
import { OPERATOR_ROLES } from "@/shared/operator-permissions";

const role = z.enum(OPERATOR_ROLES);

export function operatorsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("operators.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await listOperators(c.var.deps, c.req.query()));
    })
    .post("/", requireOperator("operators.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, z.object({ email: z.string().trim().email("Enter an email address.").max(320), role, reason: reasonSchema }));
      type R = Awaited<ReturnType<typeof grantOperator>>;
      const r = await operatorAction(c, {
        action: "operator.granted", targetType: "user", targetId: (x: R) => x.user.id, reason: body.reason,
        before: (x: R) => x.before, after: (x: R) => ({ ...x.after, email: x.user.email }),
      }, () => grantOperator(c.var.deps, body.email, body.role));
      return c.json({ ok: true, id: r.user.id, role: body.role }, 201);
    })
    .patch("/:id", requireOperator("operators.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, z.object({ role, reason: reasonSchema }));
      const id = c.req.param("id");
      const out = await operatorAction(c, {
        action: "operator.role_changed", targetType: "user", targetId: id, reason: body.reason,
        before: (r: Awaited<ReturnType<typeof changeOperatorRole>>) => r.before, after: (r: Awaited<ReturnType<typeof changeOperatorRole>>) => ({ ...r.after, email: r.user.email }),
      }, () => changeOperatorRole(c.var.deps, id, body.role));
      return c.json({ ok: true, role: out.after.role });
    })
    .delete("/:id", requireOperator("operators.manage", { stepUp: true }), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      const id = c.req.param("id");
      await operatorAction(c, {
        action: "operator.removed", targetType: "user", targetId: id, reason: body.reason,
        before: (r: Awaited<ReturnType<typeof removeOperator>>) => r.before, after: (r: Awaited<ReturnType<typeof removeOperator>>) => ({ ...r.after, email: r.user.email }),
      }, () => removeOperator(c.var.deps, id));
      return c.json({ ok: true });
    });
}
